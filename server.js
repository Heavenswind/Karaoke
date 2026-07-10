const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
app.use(express.json());

const VIDEOS_DIR = path.join(__dirname, 'videos');
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

app.use('/videos', express.static(VIDEOS_DIR));

let whisperModel = process.env.WHISPER_MODEL || 'small';

// ─── Helpers ────────────────────────────────────────────────────────────────

function isVideoReady(videoId) {
    return fs.existsSync(path.join(VIDEOS_DIR, `${videoId}.mp4`))
        && fs.existsSync(path.join(VIDEOS_DIR, `${videoId}.json`));
}

function loadCachedTranscription(videoId) {
    const p = path.join(VIDEOS_DIR, `${videoId}.json`);
    if (!fs.existsSync(p)) return null;
    try {
        // strip a UTF-8 BOM - Windows editors add one when users hand-fix lyrics
        let raw = fs.readFileSync(p, 'utf-8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        return JSON.parse(raw);
    } catch { return null; }
}

// Downloaded songs are kept as a cache (replays skip the whole pipeline).
// Oldest songs are pruned when the cache grows past MAX_CACHE_MB.
const MAX_CACHE_MB = parseInt(process.env.MAX_CACHE_MB || '8192', 10);

function pruneCache(protectedIds = new Set()) {
    let entries;
    try {
        entries = fs.readdirSync(VIDEOS_DIR)
            .filter(f => f.endsWith('.mp4'))
            .map(f => {
                const id = f.slice(0, -4);
                const files = ['.mp4', '.mp3', '.json']
                    .map(ext => path.join(VIDEOS_DIR, id + ext))
                    .filter(p => fs.existsSync(p));
                return {
                    id, files,
                    size: files.reduce((n, p) => { try { return n + fs.statSync(p).size; } catch { return n; } }, 0),
                    mtime: fs.statSync(path.join(VIDEOS_DIR, f)).mtimeMs
                };
            });
    } catch { return; }

    let total = entries.reduce((n, e) => n + e.size, 0);
    const cap = MAX_CACHE_MB * 1024 * 1024;
    for (const e of entries.sort((a, b) => a.mtime - b.mtime)) {
        if (total <= cap) break;
        if (protectedIds.has(e.id)) continue;
        for (const p of e.files) { try { fs.unlinkSync(p); } catch {} }
        total -= e.size;
        console.log(`Cache pruned: ${e.id}`);
    }
}

function touchVideoFiles(videoId) {
    const now = new Date();
    for (const ext of ['.mp4', '.json']) {
        const p = path.join(VIDEOS_DIR, `${videoId}${ext}`);
        try { fs.utimesSync(p, now, now); } catch {}
    }
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function extractYouTubeId(input) {
    const text = (input || '').trim();
    if (VIDEO_ID_RE.test(text)) return text; // raw video ID pasted directly
    const m = text.match(/(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|embed\/|live\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

// Resolve free-text input ("artist song name") to a video via yt-dlp search.
function searchYouTube(query) {
    return new Promise((resolve) => {
        const proc = spawn('yt-dlp', ['--no-warnings', '--flat-playlist', '--dump-single-json', `ytsearch1:${query}`]);
        let out = '';
        let done = false;
        const finish = (val) => { if (!done) { done = true; resolve(val); } };
        const timer = setTimeout(() => { try { proc.kill(); } catch {} finish(null); }, 20000);
        proc.stdout.on('data', d => out += d);
        proc.on('error', () => { clearTimeout(timer); finish(null); });
        proc.on('close', () => {
            clearTimeout(timer);
            try {
                const entry = JSON.parse(out)?.entries?.[0];
                if (entry && VIDEO_ID_RE.test(entry.id || '')) {
                    return finish({ videoId: entry.id, title: entry.title || null });
                }
            } catch {}
            finish(null);
        });
    });
}

function detectLanguageFromTitle(title) {
    if (!title) return null;
    if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(title)) return 'ja';
    if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(title)) return 'ko';
    if (/[\u4E00-\u9FFF]/.test(title) && !/[\u3040-\u309F\u30A0-\u30FF]/.test(title)) return 'zh';
    return null;
}

async function getVideoTitle(videoId) {
    try {
        const res = await fetch(
            `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
            { signal: AbortSignal.timeout(5000) }
        );
        if (res.ok) { const d = await res.json(); return d.title || null; }
    } catch {}
    return null;
}

// ─── Download + Transcribe ───────────────────────────────────────────────────
// Runs one at a time — no concurrent GPU access

let pipelineBusy = false;
let pipelineVideoId = null; // which video is currently in the pipeline (for queue status)

function runPipeline(videoId, languageHint, io, roomId) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, 'download_video.py');
        const args = [scriptPath, videoId, whisperModel, VIDEOS_DIR];
        if (languageHint) args.push(languageHint);

        const python = spawn('python', args);
        let lastLine = '';

        python.stdout.on('data', (data) => {
            for (const line of data.toString().split('\n').filter(l => l.trim())) {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.status) {
                        const messages = {
                            downloading_video: '📥 Downloading video...',
                            extracting_audio: '🎵 Extracting audio...',
                            transcribing: '🎤 Transcribing lyrics...'
                        };
                        if (io && roomId) io.to(roomId).emit('video-status', {
                            status: parsed.status,
                            message: messages[parsed.status] || parsed.status
                        });
                    }
                    if (parsed.success !== undefined) lastLine = line;
                } catch { lastLine = line; }
            }
        });

        python.stderr.on('data', (data) => console.error(`[python] ${data}`));

        python.on('close', (code) => {
            try { resolve(JSON.parse(lastLine)); }
            catch { reject(new Error(`Pipeline failed (code ${code})`)); }
        });

        python.on('error', reject);
    });
}

async function prepareVideo(videoId, languageHint, io, roomId) {
    if (isVideoReady(videoId)) return { success: true, cached: true };

    // Wait if pipeline is busy
    while (pipelineBusy) await new Promise(r => setTimeout(r, 500));

    // Check again after waiting — maybe it was prepared while we waited
    if (isVideoReady(videoId)) return { success: true, cached: true };

    pipelineBusy = true;
    pipelineVideoId = videoId;
    try {
        const result = await runPipeline(videoId, languageHint, io, roomId);
        return result;
    } finally {
        pipelineBusy = false;
        pipelineVideoId = null;
        scheduleAheadPrep(); // GPU just freed up — see if there's more queue to warm
    }
}

// Keeps the GPU busy for the whole queue, not just the next song: whenever
// the pipeline frees up, this prepares the earliest not-yet-ready queued
// song across every room (there's one shared GPU) and chains into the next
// one. Without this, prep stopped after just the immediate next song was
// ready and the GPU sat idle for the rest of a long song's playback.
let aheadPrepScheduled = false;
// Songs that already failed an ahead-of-queue prepare attempt this run — skip
// them so a permanently-bad link doesn't get retried in a tight loop. The song
// still gets one fresh, real attempt (and the usual drop-if-it-fails handling)
// once it actually reaches the head of the queue in runPlayLoop.
const aheadPrepFailed = new Set();

function scheduleAheadPrep() {
    if (aheadPrepScheduled || pipelineBusy) return;
    aheadPrepScheduled = true;
    setImmediate(runAheadPrep);
}

async function runAheadPrep() {
    aheadPrepScheduled = false;
    for (const [rid, room] of rooms) {
        const target = room.queue.find(s => !isVideoReady(s.videoId) && !aheadPrepFailed.has(s.videoId));
        if (!target) continue;
        try {
            const result = await prepareVideo(target.videoId, target.languageHint, null, null);
            if (!result || (!result.success && !result.cached)) {
                aheadPrepFailed.add(target.videoId);
                console.error(`Pre-prepare failed for ${target.videoId}: ${result?.error || 'unknown error'}`);
            } else {
                const r = rooms.get(rid);
                if (r) io.to(rid).emit('queue-updated', { queue: enrichQueue(r.queue) });
            }
        } catch (err) {
            aheadPrepFailed.add(target.videoId);
            console.error(`Pre-prepare failed for ${target.videoId}: ${err.message}`);
        }
        return; // prepareVideo's finally already chains the next one via scheduleAheadPrep
    }
}

// ─── Room State ──────────────────────────────────────────────────────────────

const rooms = new Map();

function getRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, { id: roomId, queue: [], currentSong: null, users: new Map(), hostId: null });
    }
    return rooms.get(roomId);
}

function enrichQueue(queue) {
    return queue.map(s => ({
        ...s,
        videoReady: isVideoReady(s.videoId),
        lyricsReady: fs.existsSync(path.join(VIDEOS_DIR, `${s.videoId}.json`)),
        preparing: pipelineVideoId === s.videoId
    }));
}

// Every current song and queued song across all rooms — never prune these.
function protectedVideoIds() {
    const ids = new Set();
    for (const room of rooms.values()) {
        if (room.currentSong) ids.add(room.currentSong.videoId);
        for (const s of room.queue) ids.add(s.videoId);
    }
    return ids;
}

// ─── Play Loop ───────────────────────────────────────────────────────────────
// Simple: prepare head of queue → play it → prepare next → repeat

const activeLoops = new Set();

async function runPlayLoop(roomId) {
    if (activeLoops.has(roomId)) return; // already running
    activeLoops.add(roomId);

    try {
        while (true) {
            const room = rooms.get(roomId);
            if (!room || room.queue.length === 0) break;

            const song = room.queue[0]; // peek, don't shift yet

            // Prepare the video
            io.to(roomId).emit('video-status', { status: 'preparing', message: '📥 Preparing video and lyrics...' });
            const result = await prepareVideo(song.videoId, song.languageHint, io, roomId);

            if (!result || (!result.success && !result.cached)) {
                console.error(`Failed to prepare ${song.videoId}: ${result?.error}`);
                io.to(roomId).emit('error', { message: `Failed to prepare: ${result?.error || 'unknown error'}` });
                room.queue.shift(); // drop bad song
                io.to(roomId).emit('queue-updated', { queue: enrichQueue(room.queue) });
                continue;
            }

            // Re-check room still exists and song is still at head (not removed)
            const roomNow = rooms.get(roomId);
            if (!roomNow || roomNow.queue[0]?.id !== song.id) break;

            // Shift it out and set as current
            roomNow.queue.shift();
            roomNow.currentSong = song;
            roomNow.currentSongStartedAt = Date.now();
            touchVideoFiles(song.videoId); // mark as recently used for cache pruning

            io.to(roomId).emit('play-song', { song });
            io.to(roomId).emit('queue-updated', { queue: enrichQueue(roomNow.queue) });

            console.log(`Now playing: ${song.title}`);

            // Warm the rest of the queue in the background while this one plays
            scheduleAheadPrep();

            // Wait for song to end (any client emits 'song-ended', or 'skip-song')
            await waitForSongEnd(roomId, song.id);

            const roomAfter = rooms.get(roomId);
            if (roomAfter) roomAfter.currentSong = null;

            // Keep files cached for replays; trim oldest songs past the cap
            pruneCache(protectedVideoIds());
        }
    } finally {
        activeLoops.delete(roomId);
        const room = rooms.get(roomId);
        if (room) {
            room.currentSong = null;
            io.to(roomId).emit('no-songs', {});
        }
    }
}

// Returns a promise that resolves when the current song ends or is skipped
const songEndCallbacks = new Map();

function waitForSongEnd(roomId, songId) {
    return new Promise(resolve => {
        songEndCallbacks.set(roomId, { songId, resolve });
    });
}

// songId guards against a stale 'song-ended' (from a previous song) killing the
// song that just started. Pass null to end whatever is playing (skip, room close).
function signalSongEnd(roomId, songId = null) {
    const cb = songEndCallbacks.get(roomId);
    if (cb && (!songId || cb.songId === songId)) {
        songEndCallbacks.delete(roomId);
        cb.resolve();
    }
}

// ─── HTTP API ────────────────────────────────────────────────────────────────

app.get('/api/video/prepare/:videoId', async (req, res) => {
    const { videoId } = req.params;
    if (isVideoReady(videoId)) {
        const cached = loadCachedTranscription(videoId);
        return res.json({
            success: true, cached: true,
            videoUrl: `/videos/${videoId}.mp4`,
            segments: cached?.segments || [],
            lyrics: cached?.text || '',
            language: cached?.language || 'unknown',
            duration: cached?.duration || null
        });
    }
    return res.json({ success: false, error: 'Video not ready yet' });
});

app.get('/api/video/status/:videoId', (req, res) => {
    const { videoId } = req.params;
    const ready = isVideoReady(videoId);
    res.json({ ready, videoUrl: ready ? `/videos/${videoId}.mp4` : null });
});

app.get('/api/rooms', (req, res) => {
    const list = [];
    const canDelete = isLocalRequest(req);
    for (const [id, room] of rooms) {
        if (room.users.size > 0) {
            list.push({
                id,
                userCount: room.users.size,
                currentSong: room.currentSong ? room.currentSong.title : null,
                queueLength: room.queue.length,
                canDelete
            });
        }
    }
    res.json(list);
});

function isLocalRequest(req) {
    const ip = req.ip || '';
    return ip.includes('127.0.0.1') || ip.includes('::1');
}

app.delete('/api/rooms/:roomId', (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'Forbidden' });

    const { roomId } = req.params;
    const room = rooms.get(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    signalSongEnd(roomId);
    io.to(roomId).emit('no-songs', {});
    io.to(roomId).emit('notification', { message: 'Room closed by host' });
    rooms.delete(roomId);
    activeLoops.delete(roomId);

    console.log(`Room ${roomId} deleted`);
    res.json({ success: true });
});

app.get('/api/rooms/:roomId', (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'Forbidden' });

    const room = rooms.get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    res.json({
        id: room.id,
        users: Array.from(room.users.values()),
        currentSong: room.currentSong,
        queue: room.queue
    });
});

app.get('/api/status', (req, res) => {
    res.json({ whisper: { model: whisperModel }, pipelineBusy });
});

// ─── Socket.io ───────────────────────────────────────────────────────────────

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    let currentRoom = null;
    let userName = 'Anonymous';

    socket.on('join-room', ({ roomId, name, isHost }) => {
        currentRoom = roomId;
        userName = name || 'Anonymous';
        socket.join(roomId);
        const room = getRoom(roomId);

        if (!room.hostId || isHost) room.hostId = socket.id;
        // keep exactly one crown — a reclaimed host demotes the migrated one
        for (const [id, u] of room.users) u.isHost = id === room.hostId;
        room.users.set(socket.id, { name: userName, isHost: socket.id === room.hostId });

        socket.emit('room-state', {
            queue: enrichQueue(room.queue),
            currentSong: room.currentSong,
            isHost: socket.id === room.hostId,
            users: Array.from(room.users.values())
        });

        io.to(roomId).emit('user-joined', {
            name: userName,
            users: Array.from(room.users.values())
        });

        console.log(`${userName} joined room ${roomId}`);
    });

    socket.on('add-song', async ({ url, languageHint: clientLangHint }) => {
        if (!currentRoom) return socket.emit('error', { message: 'Not in a room' });

        const input = (url || '').trim();
        if (!input) return;

        let videoId = extractYouTubeId(input);
        let title = null;

        if (!videoId) {
            // Not a YouTube link — treat it as a song search
            if (/^https?:\/\//i.test(input)) {
                return socket.emit('error', { message: "That link doesn't look like a YouTube video" });
            }
            socket.emit('notification', { message: `Searching YouTube for "${input}"...` });
            const found = await searchYouTube(input);
            if (!found) return socket.emit('error', { message: `No results for "${input}"` });
            videoId = found.videoId;
            title = found.title;
        }

        if (!rooms.has(currentRoom)) return;

        title = title || await getVideoTitle(videoId) || `Song by ${userName}`;
        const languageHint = clientLangHint || detectLanguageFromTitle(title);

        const song = {
            id: uuidv4(),
            videoId, url, title,
            addedBy: userName,
            addedAt: Date.now(),
            languageHint
        };

        const room = getRoom(currentRoom);
        room.queue.push(song);

        io.to(currentRoom).emit('queue-updated', { queue: enrichQueue(room.queue) });
        io.to(currentRoom).emit('notification', { message: `${userName} added: ${title}` });

        console.log(`Queued: ${title} (${videoId})`);

        // If something is already playing, start warming the queue in the
        // background (if the play loop isn't running, it'll prepare the head
        // of the queue directly when it starts)
        if (room.currentSong) scheduleAheadPrep();

        // Start play loop if not already running
        runPlayLoop(currentRoom);
    });

    socket.on('skip-song', () => {
        if (!currentRoom) return;
        signalSongEnd(currentRoom);
        io.to(currentRoom).emit('notification', { message: `Song skipped by ${userName}` });
    });

    // Any client's ended video advances the queue (first one wins; the songId
    // guard makes it idempotent). This keeps the party moving even when the
    // host is on a phone and never plays the video themselves. songId is
    // required — a stale client can't blind-fire the current song away.
    socket.on('song-ended', (data) => {
        if (!currentRoom || !data?.songId) return;
        const room = rooms.get(currentRoom);
        if (room?.currentSongStartedAt) {
            const elapsed = ((Date.now() - room.currentSongStartedAt) / 1000).toFixed(1);
            console.log(`song-ended from ${userName} after ${elapsed}s (songId ${data.songId})`);
        }
        signalSongEnd(currentRoom, data.songId);
    });

    // A client noticed the cached file is shorter than the real song
    // (truncated download) — purge it so the next play re-downloads.
    socket.on('video-corrupt', (data) => {
        const videoId = data?.videoId;
        if (!currentRoom || !VIDEO_ID_RE.test(videoId || '')) return;
        console.warn(`Corrupt cached video reported by ${userName}: ${videoId} (${data.got}s, expected ${data.expected}s) - purging`);
        for (const ext of ['.mp4', '.mp3', '.json']) {
            try { fs.unlinkSync(path.join(VIDEOS_DIR, `${videoId}${ext}`)); } catch {}
        }
    });

    socket.on('remove-song', ({ songId }) => {
        if (!currentRoom) return;
        const room = getRoom(currentRoom);
        room.queue = room.queue.filter(s => s.id !== songId);
        io.to(currentRoom).emit('queue-updated', { queue: enrichQueue(room.queue) });
    });

    // Play/pause works like skip: anyone at the party can hit it, including
    // phones that don't have a local player. Every client with a video toggles.
    socket.on('toggle-play-request', () => {
        if (!currentRoom) return;
        io.to(currentRoom).emit('remote-toggle-play');
    });

    // Host's playback clock — relayed so other screens can correct drift.
    socket.on('time-sync', (data) => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (room && socket.id === room.hostId) {
            socket.to(currentRoom).emit('time-sync', data);
        }
    });

    // Client-side playback diagnostics (stalls etc.) — surfaced in this console
    socket.on('client-debug', (data) => {
        console.warn(`[client ${userName}]`, JSON.stringify(data));
    });

    socket.on('heartbeat', () => {});

    socket.on('disconnect', () => {
        if (currentRoom) {
            const room = rooms.get(currentRoom);
            if (room) {
                room.users.delete(socket.id);
                if (room.hostId === socket.id && room.users.size > 0) {
                    room.hostId = room.users.keys().next().value;
                    const newHost = room.users.get(room.hostId);
                    if (newHost) newHost.isHost = true;
                }
                io.to(currentRoom).emit('user-left', {
                    name: userName,
                    users: Array.from(room.users.values())
                });
                if (room.users.size === 0) rooms.delete(currentRoom);
            }
        }
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎤 Karaoke server running on http://localhost:${PORT}`));
