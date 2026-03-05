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
    return fs.existsSync(path.join(VIDEOS_DIR, `${videoId}.mp4`));
}

function loadCachedTranscription(videoId) {
    const p = path.join(VIDEOS_DIR, `${videoId}.json`);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function deleteVideoFiles(videoId) {
    for (const ext of ['.mp4', '.mp3', '.json']) {
        const p = path.join(VIDEOS_DIR, `${videoId}${ext}`);
        if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch {}
    }
}

function extractYouTubeId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
        /youtube\.com\/shorts\/([^&\n?#]+)/
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
    }
    return null;
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
        const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
        if (res.ok) { const d = await res.json(); return d.title || null; }
    } catch {}
    return null;
}

// ─── Download + Transcribe ───────────────────────────────────────────────────
// Runs one at a time — no concurrent GPU access

let pipelineBusy = false;

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
    try {
        const result = await runPipeline(videoId, languageHint, io, roomId);
        return result;
    } finally {
        pipelineBusy = false;
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
        lyricsReady: fs.existsSync(path.join(VIDEOS_DIR, `${s.videoId}.json`))
    }));
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

            io.to(roomId).emit('play-song', { song });
            io.to(roomId).emit('queue-updated', { queue: enrichQueue(roomNow.queue) });

            console.log(`Now playing: ${song.title}`);

            // Pre-prepare next song in background while current one plays
            const nextSong = roomNow.queue[0];
            if (nextSong && !isVideoReady(nextSong.videoId)) {
                prepareVideo(nextSong.videoId, nextSong.languageHint, null, null)
                    .then(() => {
                        const r = rooms.get(roomId);
                        if (r) io.to(roomId).emit('queue-updated', { queue: enrichQueue(r.queue) });
                    })
                    .catch(err => console.error(`Pre-prepare failed for ${nextSong.videoId}: ${err.message}`));
            }

            // Wait for song to end (host emits 'song-ended' or 'skip-song')
            await waitForSongEnd(roomId, song.id);

            // Clean up files
            deleteVideoFiles(song.videoId);

            const roomAfter = rooms.get(roomId);
            if (roomAfter) roomAfter.currentSong = null;
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

function signalSongEnd(roomId) {
    const cb = songEndCallbacks.get(roomId);
    if (cb) {
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
            language: cached?.language || 'unknown'
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
    for (const [id, room] of rooms) {
        if (room.users.size > 0) {
            list.push({
                id,
                userCount: room.users.size,
                currentSong: room.currentSong ? room.currentSong.title : null,
                queueLength: room.queue.length
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

        const videoId = extractYouTubeId(url);
        if (!videoId) return socket.emit('error', { message: 'Invalid YouTube URL' });

        const title = await getVideoTitle(videoId) || `Song by ${userName}`;
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

        // If something is already playing, pre-prepare this song in background
        // (if play loop not running, it will prepare it when it starts)
        if (room.currentSong && !isVideoReady(videoId)) {
            prepareVideo(videoId, song.languageHint, null, null)
                .then(() => {
                    const r = rooms.get(currentRoom);
                    if (r) io.to(currentRoom).emit('queue-updated', { queue: enrichQueue(r.queue) });
                })
                .catch(err => console.error(`Pre-prepare failed for ${videoId}: ${err.message}`));
        }

        // Start play loop if not already running
        runPlayLoop(currentRoom);
    });

    socket.on('skip-song', () => {
        if (!currentRoom) return;
        signalSongEnd(currentRoom);
        io.to(currentRoom).emit('notification', { message: `Song skipped by ${userName}` });
    });

    socket.on('song-ended', () => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (room && socket.id === room.hostId) signalSongEnd(currentRoom);
    });

    socket.on('remove-song', ({ songId }) => {
        if (!currentRoom) return;
        const room = getRoom(currentRoom);
        room.queue = room.queue.filter(s => s.id !== songId);
        io.to(currentRoom).emit('queue-updated', { queue: enrichQueue(room.queue) });
    });

    socket.on('toggle-play', ({ isPlaying }) => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (room && socket.id === room.hostId) {
            io.to(currentRoom).emit('play-state-changed', { isPlaying });
        }
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
