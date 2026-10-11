// Song preparation: download, separate, transcribe.
//
// The old shape was one Python process per song doing everything end to end,
// behind a single `pipelineBusy` flag. That flag also covered the download,
// which is network-bound and touches no GPU at all -- so the 4070 sat idle for
// most of every song's preparation.
//
// Now there are two independent resources:
//
//   downloads  network-bound, runs DOWNLOAD_CONCURRENCY at a time
//   the GPU    one job at a time, served by a long-lived worker.py
//
// and one song's DAG looks like:
//
//   audio ─┬─────────────► GPU (separate → transcribe → correct) ─┐
//          └─► lyrics ────┘                                       ├─► json
//   video ────────────────────────────────────────────────────────┘
//
// The GPU stage waits only on the audio (a few MB) and the lrclib lookup, not
// on the full video, so transcription starts while the mp4 is still coming down.

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');

const VIDEOS_DIR = path.join(__dirname, 'videos');
const PYTHON = process.env.PYTHON || 'python';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'large-v3';
const DOWNLOAD_CONCURRENCY = parseInt(process.env.DOWNLOAD_CONCURRENCY || '3', 10);
const LYRICS_TIMEOUT_MS = parseInt(process.env.LYRICS_TIMEOUT_MS || '15000', 10);
// lrclib does go down (observed 504ing for a while). Once it has timed out a
// few songs in a row, stop paying the wait on every subsequent one.
const LYRICS_MUTE_AFTER = 3;
const LYRICS_MUTE_MS = 10 * 60 * 1000;
// A song that failed is worth retrying later -- a flaky network or an expired
// bot-check cookie is not a permanent verdict.
const FAIL_TTL_MS = parseInt(process.env.FAIL_TTL_MS || '300000', 10);

// ─── Small async primitives ──────────────────────────────────────────────────

class Semaphore {
    constructor(limit) {
        this.limit = Math.max(1, limit);
        this.active = 0;
        this.waiting = [];
    }
    run(fn) {
        return new Promise((resolve, reject) => {
            const attempt = () => {
                this.active++;
                Promise.resolve().then(fn).then(
                    v => { this._release(); resolve(v); },
                    e => { this._release(); reject(e); }
                );
            };
            // FIFO, so a queue prepares in the order people actually queued it
            if (this.active < this.limit) attempt();
            else this.waiting.push(attempt);
        });
    }
    _release() {
        this.active--;
        const next = this.waiting.shift();
        if (next) next();
    }
}

const downloadSem = new Semaphore(DOWNLOAD_CONCURRENCY);
const gpuSem = new Semaphore(1);

// Tag a child's stderr one *line* at a time. Prefixing each raw chunk instead
// splits a line across two tags whenever the pipe happens to break mid-message.
function tagStderr(proc, tag, onChunk) {
    let buf = '';
    proc.stderr.on('data', (d) => {
        onChunk?.(d);
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop();                  // hold the partial line for the next chunk
        for (const l of lines) if (l.trim()) process.stderr.write(`${tag} ${l.trimEnd()}\n`);
    });
    proc.on('close', () => { if (buf.trim()) process.stderr.write(`${tag} ${buf.trim()}\n`); });
}

// ─── The GPU worker ──────────────────────────────────────────────────────────

class GpuWorker {
    constructor() {
        this.proc = null;
        this.ready = null;
        this.pending = new Map();   // request id -> { resolve, reject, onStatus }
        this.seq = 0;
    }

    // Spawned lazily and respawned freely: worker.py retires itself once the
    // room goes quiet so the VRAM comes back for whatever else uses this GPU.
    start() {
        if (this.ready) return this.ready;

        const proc = spawn(PYTHON, ['-u', path.join(__dirname, 'worker.py')], {
            cwd: __dirname,
            env: { ...process.env, WHISPER_MODEL, PYTHONIOENCODING: 'utf-8' },
        });
        this.proc = proc;

        readline.createInterface({ input: proc.stdout }).on('line', (line) => {
            if (!line.trim()) return;
            let msg;
            try { msg = JSON.parse(line); } catch { return console.error(`[worker] ${line}`); }
            this._dispatch(msg);
        });

        tagStderr(proc, '[worker]');

        const die = (why) => {
            if (this.proc === proc) { this.proc = null; this.ready = null; }
            for (const [, p] of this.pending) p.reject(new Error(why));
            this.pending.clear();
        };
        proc.on('exit', (code) => die(`GPU worker exited (code ${code})`));
        proc.on('error', (err) => die(`GPU worker failed to start: ${err.message}`));

        this.ready = new Promise((resolve, reject) => {
            this._onReady = resolve;
            proc.once('exit', () => reject(new Error('GPU worker exited before becoming ready')));
            proc.once('error', reject);
        });
        return this.ready;
    }

    _dispatch(msg) {
        if (msg.event === 'ready') {
            console.log(`GPU worker ready (${msg.model} on ${msg.device})`);
            if (this._onReady) this._onReady(msg);
            return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.event === 'status') return p.onStatus?.(msg.status);
        this.pending.delete(msg.id);
        if (msg.event === 'error') p.reject(new Error(msg.error || 'transcription failed'));
        else p.resolve(msg);
    }

    // One at a time -- this is the GPU lock.
    transcribe(job, onStatus) {
        return gpuSem.run(async () => {
            await this.start();
            const id = String(++this.seq);
            return new Promise((resolve, reject) => {
                this.pending.set(id, { resolve, reject, onStatus });
                try {
                    this.proc.stdin.write(JSON.stringify({ id, cmd: 'transcribe', ...job }) + '\n');
                } catch (e) {
                    this.pending.delete(id);
                    reject(e);
                }
            });
        });
    }

    stop() {
        try { this.proc?.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n'); } catch {}
    }
}

const worker = new GpuWorker();

// ─── Python helpers ──────────────────────────────────────────────────────────

// Runs a Python script that streams {"status": ...} lines and finishes with one
// JSON result object.
function runPython(args, onStatus) {
    return new Promise((resolve, reject) => {
        const proc = spawn(PYTHON, args, {
            cwd: __dirname,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
        let last = null;
        let stderr = '';

        readline.createInterface({ input: proc.stdout }).on('line', (line) => {
            if (!line.trim()) return;
            let parsed;
            try { parsed = JSON.parse(line); } catch { return; }
            if (parsed.status && parsed.success === undefined) onStatus?.(parsed.status);
            else last = parsed;
        });

        tagStderr(proc, '[python]', (d) => { stderr += d; });

        proc.on('error', reject);
        proc.on('close', (code) => {
            if (last && last.success) return resolve(last);
            reject(new Error(last?.error || `${path.basename(args[0])} failed (code ${code})` +
                (stderr ? `: ${stderr.trim().slice(-300)}` : '')));
        });
    });
}

// lrclib is slow (7-10s even for a clean miss) but it is pure network, so it
// runs alongside the downloads instead of stalling the GPU the way it used to.
let lyricsTimeouts = 0;
let lyricsMutedUntil = 0;

function fetchLyrics(meta) {
    if (Date.now() < lyricsMutedUntil) return Promise.resolve({});

    const args = [path.join(__dirname, 'lyrics_correct.py'), '--fetch',
        '--title', meta?.title || ''];
    if (meta?.artist) args.push('--artist', meta.artist);
    if (meta?.track) args.push('--track', meta.track);
    if (meta?.duration) args.push('--duration', String(meta.duration));

    return new Promise((resolve) => {
        const proc = spawn(PYTHON, args, {
            cwd: __dirname,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
        let out = '';
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

        const timer = setTimeout(() => {
            try { proc.kill(); } catch {}
            // Only a timeout counts against lrclib. A clean "no match for this
            // song" is a perfectly healthy answer and must not trip the breaker.
            if (++lyricsTimeouts >= LYRICS_MUTE_AFTER) {
                lyricsMutedUntil = Date.now() + LYRICS_MUTE_MS;
                lyricsTimeouts = 0;
                console.warn(`lrclib unresponsive - skipping lyrics lookups for ${LYRICS_MUTE_MS / 60000} min`);
            }
            finish({});
        }, LYRICS_TIMEOUT_MS);

        proc.stdout.on('data', d => out += d);
        tagStderr(proc, '[lyrics]');
        proc.on('error', () => { clearTimeout(timer); finish({}); });
        proc.on('close', () => {
            clearTimeout(timer);
            lyricsTimeouts = 0;
            try {
                const lines = out.trim().split('\n').filter(l => l.trim());
                finish(JSON.parse(lines[lines.length - 1]) || {});
            } catch { finish({}); }
        });
    });
}

// ─── Cache helpers ───────────────────────────────────────────────────────────

const p = (id, ext) => path.join(VIDEOS_DIR, `${id}${ext}`);

function isVideoReady(videoId) {
    return fs.existsSync(p(videoId, '.mp4')) && fs.existsSync(p(videoId, '.json'));
}

function readJson(file) {
    try {
        let raw = fs.readFileSync(file, 'utf-8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);   // Windows editors add a BOM
        return JSON.parse(raw);
    } catch { return null; }
}

// A transcription outlives its mp4 on purpose: if the video was pruned or had
// to be re-fetched, the lyrics are still good and the GPU pass can be skipped.
function reusableTranscription(videoId) {
    const j = readJson(p(videoId, '.json'));
    return j && Array.isArray(j.segments) && j.segments.length ? j : null;
}

function removeQuietly(file) {
    try { fs.unlinkSync(file); } catch {}
}

// ─── Preparation ─────────────────────────────────────────────────────────────

const inflight = new Map();     // videoId -> promise (dedupes concurrent callers)
const preparing = new Set();    // videoId currently on or awaiting the GPU
const failures = new Map();     // videoId -> timestamp of last failure

function recentlyFailed(videoId) {
    const t = failures.get(videoId);
    if (t === undefined) return false;
    if (Date.now() - t < FAIL_TTL_MS) return true;
    failures.delete(videoId);
    return false;
}

async function prepare(videoId, languageHint, onStatus) {
    const script = path.join(__dirname, 'download_video.py');
    const cached = reusableTranscription(videoId);

    // Video only -- the lyrics already exist, so no audio and no GPU needed.
    if (cached) {
        const video = fs.existsSync(p(videoId, '.mp4'))
            ? { videoPath: p(videoId, '.mp4'), videoSize: fs.statSync(p(videoId, '.mp4')).size }
            : await downloadSem.run(() =>
                runPython([script, videoId, '--video', '--out', VIDEOS_DIR], onStatus));

        const out = {
            ...cached, success: true,
            videoPath: video.videoPath,
            videoSize: video.videoSize ?? fs.statSync(video.videoPath).size,
            duration: video.duration || cached.duration || null,
        };
        fs.writeFileSync(p(videoId, '.json'), JSON.stringify(out, null, 2), 'utf-8');
        console.log(`Reusing existing transcription for ${videoId}`);
        return out;
    }

    // Audio and video race each other; whichever finishes first unblocks its
    // half of the graph. Attach the catch now so a failure on one side can
    // never surface as an unhandled rejection while we await the other.
    const audioP = downloadSem.run(() =>
        runPython([script, videoId, '--audio', '--out', VIDEOS_DIR], onStatus));
    const videoP = downloadSem.run(() =>
        runPython([script, videoId, '--video', '--out', VIDEOS_DIR], onStatus));
    audioP.catch(() => {});
    videoP.catch(() => {});

    const audio = await audioP;
    const meta = audio.meta || {};
    const lyrics = await fetchLyrics(meta);
    if (lyrics.plain) console.log(`lrclib matched: ${lyrics.artist || '?'} - ${lyrics.track || '?'}`);

    preparing.add(videoId);
    let transcription;
    try {
        transcription = await worker.transcribe({
            audio: audio.audioPath,
            language: languageHint || null,
            official: lyrics.plain || null,
            synced: lyrics.synced || null,
            title: meta.title || null,
            artist: lyrics.artist || meta.artist || null,
            track: lyrics.track || meta.track || null,
            duration: meta.duration || audio.duration || null,
        }, onStatus);
    } finally {
        preparing.delete(videoId);
        removeQuietly(audio.audioPath);   // replays use the mp4 + json
    }

    const video = await videoP;

    const out = {
        success: true,
        videoPath: video.videoPath,
        videoId,
        segments: transcription.segments,
        text: transcription.text,
        language: transcription.language,
        model: transcription.model,
        videoSize: video.videoSize,
        duration: video.duration || meta.duration || null,
    };
    fs.writeFileSync(p(videoId, '.json'), JSON.stringify(out, null, 2), 'utf-8');
    return out;
}

/**
 * Prepare a song, or join the preparation already running for it.
 *
 * Callers used to poll a boolean every 500ms and race each other to claim the
 * pipeline. Memoizing the in-flight promise per video gives every caller the
 * same answer at the same moment, with no polling and no ordering surprises.
 */
function prepareVideo(videoId, languageHint, onStatus) {
    if (isVideoReady(videoId)) return Promise.resolve({ success: true, cached: true });

    const existing = inflight.get(videoId);
    if (existing) return existing;

    const run = prepare(videoId, languageHint, onStatus)
        .then((r) => { failures.delete(videoId); return r; })
        .catch((err) => {
            failures.set(videoId, Date.now());
            console.error(`Prepare failed for ${videoId}: ${err.message}`);
            return { success: false, error: err.message };
        })
        .finally(() => inflight.delete(videoId));

    inflight.set(videoId, run);
    return run;
}

/**
 * Warm the songs the room will want soon.
 *
 * Cheap to over-call: ready songs are skipped and in-flight ones are left
 * alone. Returns only the preparations this call actually started, so the
 * caller can react once (and not once per poll) when each finishes.
 */
function warm(songs, lookahead = 3) {
    const fresh = [];
    let counted = 0;
    for (const { videoId, languageHint } of songs) {
        if (counted >= lookahead) break;
        if (isVideoReady(videoId) || recentlyFailed(videoId)) continue;
        counted++;                                  // an in-flight song still occupies a slot
        if (inflight.has(videoId)) continue;
        fresh.push({ videoId, promise: prepareVideo(videoId, languageHint, null) });
    }
    return fresh;
}

module.exports = {
    VIDEOS_DIR,
    WHISPER_MODEL,
    isVideoReady,
    readJson,
    prepareVideo,
    warm,
    isPreparing: (videoId) => preparing.has(videoId),
    status: () => ({
        model: WHISPER_MODEL,
        preparing: [...preparing],
        inflight: [...inflight.keys()],
        downloads: downloadSem.active,
        workerUp: !!worker.proc,
    }),
    stopWorker: () => worker.stop(),
};
