// Karaoke Party - client

// Phones act as remotes: they queue songs and control playback, but never play video
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || window.innerWidth <= 600;

// Socket with reconnection settings to stay connected when a phone locks
const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    timeout: 20000,
    transports: ['websocket', 'polling']
});

let heartbeatInterval = null;
function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
        if (socket.connected) socket.emit('heartbeat');
    }, 15000);
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !socket.connected) socket.connect();
});

socket.on('connect', () => {
    startHeartbeat();
    // Rejoin after a reconnect (isHost is remembered, so the host reclaims their room)
    if (roomId) {
        const name = userNameInput.value.trim() || 'Anonymous';
        socket.emit('join-room', { roomId, name, isHost });
    }
});

socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') socket.connect();
});

startHeartbeat();

// ─── State ───────────────────────────────────────────────────────────────────

let isHost = false;
let roomId = null;
let player = null;
let currentSong = null;      // { id, videoId, title, addedBy }
let currentLyrics = [];      // segments with timestamps, or plain strings
let hasTimestamps = false;
let lyricsTimer = null;
let lyricsOffset = 0;        // user nudge in seconds
let remotePaused = false;    // best-effort playback state for screens without a player

// ─── DOM ─────────────────────────────────────────────────────────────────────

const joinScreen = document.getElementById('joinScreen');
const appScreen = document.getElementById('appScreen');
const userNameInput = document.getElementById('userName');
const roomCodeInput = document.getElementById('roomCode');
const hostBtn = document.getElementById('hostBtn');
const roomsList = document.getElementById('roomsList');
const activeRooms = document.getElementById('activeRooms');
const displayRoomId = document.getElementById('displayRoomId');
const copyRoomBtn = document.getElementById('copyRoomBtn');
const userCount = document.getElementById('userCount');
const videoContainer = document.getElementById('videoContainer');
const songUrlInput = document.getElementById('songUrl');
const songLanguage = document.getElementById('songLanguage');
const addSongBtn = document.getElementById('addSongBtn');
const queueList = document.getElementById('queueList');
const queueCount = document.getElementById('queueCount');
const nowPlaying = document.getElementById('nowPlaying');
const nowPlayingTitle = document.getElementById('nowPlayingTitle');
const nowPlayingUser = document.getElementById('nowPlayingUser');
const skipBtn = document.getElementById('skipBtn');
const playPauseBtn = document.getElementById('playPauseBtn');
const syncMinus = document.getElementById('syncMinus');
const syncPlus = document.getElementById('syncPlus');
const syncValue = document.getElementById('syncValue');
const usersList = document.getElementById('usersList');
const notifications = document.getElementById('notifications');
let lyricsOverlay = document.getElementById('lyricsOverlay');

const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// clipboard API needs a secure context; LAN guests on http://192.168.x.x don't have one
function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
    return Promise.resolve();
}

// ─── Notifications (deduped — reconnect storms were spamming join toasts) ────

const recentNotifs = new Map();

function showNotification(message, duration = 3000, isError = false) {
    const now = Date.now();
    const last = recentNotifs.get(message);
    if (last && now - last < 4000) return;
    recentNotifs.set(message, now);
    for (const [msg, ts] of recentNotifs) {
        if (now - ts > 10000) recentNotifs.delete(msg);
    }

    const notif = document.createElement('div');
    notif.className = 'notification' + (isError ? ' notification-error' : '');
    notif.textContent = message;
    notifications.appendChild(notif);

    setTimeout(() => {
        notif.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => notif.remove(), 300);
    }, duration);
}

// ─── Join screen ─────────────────────────────────────────────────────────────

function updateJoinButton() {
    hostBtn.textContent = roomCodeInput.value.trim() ? 'Join the party' : 'Start a party';
}

function joinRoom(asHost) {
    const name = userNameInput.value.trim() || 'Anonymous';
    const code = roomCodeInput.value.trim().toUpperCase();
    roomId = code || generateRoomId();
    // You're the host when you start a fresh room, not when you join someone's code
    isHost = asHost !== undefined ? asHost : !code;

    socket.emit('join-room', { roomId, name, isHost });

    joinScreen.style.display = 'none';
    appScreen.style.display = 'block';
    displayRoomId.textContent = roomId;
    window.history.pushState({}, '', `?room=${roomId}`);
    stopRoomsPolling();
}

hostBtn.addEventListener('click', () => joinRoom());
roomCodeInput.addEventListener('input', updateJoinButton);
userNameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') joinRoom(); });
roomCodeInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') joinRoom(); });

// Active rooms on this network
let roomsPollTimer = null;

async function loadActiveRooms() {
    try {
        const res = await fetch('/api/rooms');
        const rooms = await res.json();

        if (!rooms.length) {
            activeRooms.hidden = true;
            return;
        }

        roomsList.innerHTML = rooms.map(room => `
            <div class="room-card" data-id="${escapeHtml(room.id)}">
                <div class="room-card-icon">🎤</div>
                <div class="room-card-info">
                    <div class="room-card-top">
                        <span class="room-card-code">${escapeHtml(room.id)}</span>
                        <span class="room-card-count">${room.userCount} singing</span>
                    </div>
                    ${room.currentSong
                        ? `<div class="room-card-song">♪ ${escapeHtml(room.currentSong)}</div>`
                        : '<div class="room-card-song idle">Waiting for songs</div>'}
                </div>
                ${room.canDelete ? `<button class="room-delete" data-id="${escapeHtml(room.id)}" aria-label="Close room">×</button>` : ''}
            </div>
        `).join('');
        activeRooms.hidden = false;
    } catch {}
}

function startRoomsPolling() {
    loadActiveRooms();
    roomsPollTimer = setInterval(loadActiveRooms, 6000);
}

function stopRoomsPolling() {
    if (roomsPollTimer) clearInterval(roomsPollTimer);
    roomsPollTimer = null;
}

roomsList.addEventListener('click', async (e) => {
    const del = e.target.closest('.room-delete');
    if (del) {
        if (!confirm(`Close room ${del.dataset.id}?`)) return;
        const res = await fetch(`/api/rooms/${del.dataset.id}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!data.success) showNotification(data.error || 'Could not close the room', 4000, true);
        loadActiveRooms();
        return;
    }
    const card = e.target.closest('.room-card');
    if (card) {
        roomCodeInput.value = card.dataset.id;
        joinRoom(false);
    }
});

// ─── Video player ────────────────────────────────────────────────────────────

function showVideoLoading(message) {
    videoContainer.innerHTML = `
        <div class="video-loading">
            <div class="loading-dots"><span></span><span></span><span></span></div>
            <p id="videoStatusText">${escapeHtml(message)}</p>
            <p class="video-loading-sub">Downloading, separating vocals and syncing lyrics — a song's first play takes a minute</p>
        </div>
    `;
}

function showVideoError(message, videoId) {
    videoContainer.innerHTML = `
        <div class="empty-stage">
            <div class="empty-stage-mic">😕</div>
            <h2>${escapeHtml(message)}</h2>
            <button class="btn btn-primary" style="width: auto; margin-top: 18px; padding: 11px 24px;"
                data-retry="${escapeHtml(videoId)}">Try again</button>
        </div>
    `;
}

function showTapToStart() {
    if (!player || videoContainer.querySelector('.tap-to-start')) return;
    const btn = document.createElement('button');
    btn.className = 'tap-to-start';
    btn.innerHTML = `${ICON_PLAY} Tap to start the song`;
    videoContainer.appendChild(btn);
}

videoContainer.addEventListener('click', (e) => {
    const retry = e.target.closest('[data-retry]');
    if (retry) {
        createPlayer(retry.dataset.retry);
        return;
    }
    const tap = e.target.closest('.tap-to-start');
    if (tap) {
        if (player) player.play().catch(() => {});
        tap.remove();
    }
});

function createPlayer(videoId) {
    showVideoLoading('Getting the song ready…');
    prepareAndPlayVideo(videoId);
}

async function prepareAndPlayVideo(videoId) {
    try {
        const response = await fetch(`/api/video/prepare/${videoId}`);
        const data = await response.json();

        if (!data.success || !data.videoUrl) {
            showVideoError(data.error || 'The video is not ready yet', videoId);
            return;
        }

        videoContainer.innerHTML = `
            <video id="localPlayer" controls autoplay playsinline></video>
            <div class="lyrics-overlay" id="lyricsOverlay"></div>
        `;
        player = document.getElementById('localPlayer');
        player.src = data.videoUrl;
        lyricsOverlay = document.getElementById('lyricsOverlay');
        overlayKey = '';

        player.addEventListener('play', () => { setPlayIcon(false); startLyricsSync(); });
        player.addEventListener('pause', () => setPlayIcon(true));
        player.addEventListener('ended', onVideoEnded);
        player.addEventListener('timeupdate', onTimeUpdate);
        player.addEventListener('loadedmetadata', () => {
            // A truncated download plays a few seconds and then "ends". Compare
            // the file against YouTube's duration and have the server purge it.
            if (data.duration && player.duration && data.duration - player.duration > 10) {
                socket.emit('video-corrupt', { videoId, got: player.duration, expected: data.duration });
                showNotification('This video file is incomplete — it will re-download on the next play', 5000, true);
            }
        });

        if (data.segments && data.segments.length > 0) {
            currentLyrics = data.segments;
            hasTimestamps = true;
        } else if (data.lyrics) {
            currentLyrics = parseLyrics(data.lyrics);
            hasTimestamps = false;
        } else {
            currentLyrics = [];
            hasTimestamps = false;
        }

        startLyricsSync();
        player.play().catch(() => showTapToStart());
    } catch (error) {
        console.error('Failed to prepare video:', error);
        showVideoError('Could not load the video', videoId);
    }
}

function onVideoEnded() {
    stopLyricsSync();
    if (currentSong) socket.emit('song-ended', { songId: currentSong.id });
}

function onTimeUpdate() {
    if (player && currentLyrics.length > 0) updateLyricsDisplay(player.currentTime);
}

function parseLyrics(text) {
    return text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
}

// ─── Lyrics engine ───────────────────────────────────────────────────────────

const INTRO_WAIT_MIN = 4;   // intros longer than this get the "get ready" countdown
const GAP_WAIT_MIN = 7;     // instrumental breaks longer than this show the break card
const WAIT_LEAD = 0.8;      // switch from countdown back to the line this early
const OUTRO_HIDE = 3;       // hide the overlay this long after the last line

function segText(seg) {
    return hasTimestamps ? seg.text : seg;
}

function computeOverlayState(t) {
    if (!currentLyrics.length) return { mode: 'hidden' };

    if (!hasTimestamps) {
        // No timing info — estimate pacing across the video duration
        const duration = (player && player.duration) || 180;
        const intro = Math.min(duration * 0.08, 20);
        const lineTime = Math.max((duration - intro - 10) / currentLyrics.length, 1);
        const idx = Math.max(0, Math.min(currentLyrics.length - 1, Math.floor((t - intro) / lineTime)));
        const fill = Math.min(100, Math.max(0, ((t - (intro + idx * lineTime)) / lineTime) * 100));
        return { mode: 'line', index: idx, fill };
    }

    const first = currentLyrics[0];
    const last = currentLyrics[currentLyrics.length - 1];

    if (t < first.start - WAIT_LEAD) {
        if (first.start >= INTRO_WAIT_MIN) {
            return { mode: 'wait', index: 0, remaining: first.start - t, label: 'Get ready to sing' };
        }
        return { mode: 'line', index: 0, fill: 0 };
    }
    if (t > last.end + OUTRO_HIDE) return { mode: 'hidden' };

    for (let i = 0; i < currentLyrics.length; i++) {
        const seg = currentLyrics[i];
        if (t < seg.start) {
            if (i === 0) return { mode: 'line', index: 0, fill: 0 };
            const prev = currentLyrics[i - 1];
            const gap = seg.start - prev.end;
            if (gap >= GAP_WAIT_MIN && t > prev.end + 1.5 && t < seg.start - WAIT_LEAD) {
                return { mode: 'wait', index: i, remaining: seg.start - t, label: null };
            }
            // Just after the previous line: keep it visible; otherwise show the next one
            return t < prev.end + 1.5
                ? { mode: 'line', index: i - 1, fill: 100 }
                : { mode: 'line', index: i, fill: 0 };
        }
        if (t <= seg.end) {
            const fill = Math.min(100, ((t - seg.start) / Math.max(seg.end - seg.start, 0.01)) * 100);
            return { mode: 'line', index: i, fill };
        }
    }
    return { mode: 'line', index: currentLyrics.length - 1, fill: 100 };
}

function updateLyricsDisplay(currentTime) {
    const t = currentTime + lyricsOffset;
    renderOverlay(computeOverlayState(t), t);
}

// Build a word's inner HTML, rendering furigana as <ruby> when present
function wordInner(word) {
    if (Array.isArray(word.ruby) && word.ruby.length) {
        return word.ruby.map(p => p[1]
            ? `<ruby>${escapeHtml(p[0])}<rt>${escapeHtml(p[1])}</rt></ruby>`
            : escapeHtml(p[0])).join('');
    }
    return escapeHtml(word.word);
}

// The overlay rebuilds its DOM only when the line changes; per-tick updates
// just adjust fill widths and countdown dots (no re-layout jank on ruby text).
let overlayKey = '';
let overlayWordEls = [];
let overlayLineFillEl = null;
let overlayDots = [];
let overlayDotsWrap = null;

function buildOverlay(state) {
    overlayWordEls = [];
    overlayLineFillEl = null;
    overlayDots = [];
    overlayDotsWrap = null;

    if (state.mode === 'wait') {
        const seg = currentLyrics[state.index];
        lyricsOverlay.innerHTML = `
            ${state.label ? `<div class="cd-label">${escapeHtml(state.label)}</div>` : ''}
            <div class="cd-note">♪</div>
            <div class="cd-dots" hidden>${'<span class="cd-dot"></span>'.repeat(5)}</div>
            <div class="karaoke-line next">${escapeHtml(segText(seg))}</div>
        `;
        overlayDotsWrap = lyricsOverlay.querySelector('.cd-dots');
        overlayDots = [...lyricsOverlay.querySelectorAll('.cd-dot')];
        return;
    }

    const seg = currentLyrics[state.index];
    const words = (hasTimestamps && seg.words) || [];
    const nextSeg = currentLyrics[state.index + 1];

    let inner;
    if (words.length) {
        inner = words.map(w => `
            <span class="karaoke-word"><span class="word-bg">${wordInner(w)}</span><span class="word-fill">${wordInner(w)}</span></span>
        `.trim()).join('');
    } else {
        const text = escapeHtml(segText(seg));
        inner = `<span class="karaoke-text"><span class="text-bg">${text}</span><span class="text-fill">${text}</span></span>`;
    }

    lyricsOverlay.innerHTML = `
        <div class="karaoke-line current">${inner}</div>
        ${nextSeg ? `<div class="karaoke-line next">${escapeHtml(segText(nextSeg))}</div>` : ''}
    `;

    if (words.length) {
        const els = lyricsOverlay.querySelectorAll('.word-fill');
        overlayWordEls = words.map((w, i) => ({ el: els[i], start: w.start, end: w.end }));
    } else {
        overlayLineFillEl = lyricsOverlay.querySelector('.text-fill');
    }
}

function renderOverlay(state, t) {
    if (!lyricsOverlay) return;

    if (state.mode === 'hidden') {
        if (overlayKey !== 'hidden') {
            lyricsOverlay.innerHTML = '';
            overlayKey = 'hidden';
        }
        return;
    }

    const key = `${state.mode}:${state.index}`;
    if (key !== overlayKey) {
        buildOverlay(state);
        overlayKey = key;
    }

    if (state.mode === 'line') {
        if (overlayWordEls.length) {
            for (const w of overlayWordEls) {
                let pct = 0;
                if (t >= w.end) pct = 100;
                else if (t >= w.start) pct = ((t - w.start) / Math.max(w.end - w.start, 0.01)) * 100;
                w.el.style.width = pct + '%';
            }
        } else if (overlayLineFillEl) {
            overlayLineFillEl.style.width = (state.fill || 0) + '%';
        }
    } else if (state.mode === 'wait' && overlayDotsWrap) {
        const lit = Math.max(0, Math.min(5, Math.ceil(state.remaining)));
        overlayDotsWrap.hidden = state.remaining > 5.5;
        overlayDots.forEach((d, i) => d.classList.toggle('lit', i < lit));
    }
}

function startLyricsSync() {
    stopLyricsSync();
    lyricsTimer = setInterval(() => {
        if (player && currentLyrics.length > 0) updateLyricsDisplay(player.currentTime);
    }, 100);
}

function stopLyricsSync() {
    if (lyricsTimer) clearInterval(lyricsTimer);
    lyricsTimer = null;
}

// Lyrics sync nudge
function setLyricsOffset(v) {
    lyricsOffset = Math.max(-15, Math.min(15, Math.round(v * 2) / 2));
    const sign = lyricsOffset > 0 ? '+' : lyricsOffset < 0 ? '−' : '±';
    syncValue.textContent = `lyrics ${sign}${Math.abs(lyricsOffset).toFixed(1)}s`;
    overlayKey = '';
    if (player) updateLyricsDisplay(player.currentTime);
}

syncMinus.addEventListener('click', () => setLyricsOffset(lyricsOffset - 0.5));
syncPlus.addEventListener('click', () => setLyricsOffset(lyricsOffset + 0.5));

// ─── Queue & singers ─────────────────────────────────────────────────────────

function updateQueueDisplay(queue) {
    queueCount.textContent = queue.length;

    if (queue.length === 0) {
        queueList.innerHTML = `
            <div class="empty-queue">
                <div class="empty-queue-icon">🎶</div>
                <p>Nothing queued yet</p>
                <p class="empty-queue-sub">Drop in a YouTube link or type a song name above</p>
            </div>
        `;
        return;
    }

    queueList.innerHTML = queue.map((song, index) => {
        let status = 'Queued';
        let cls = '';
        if (song.videoReady && song.lyricsReady) {
            status = 'Ready';
            cls = 'ready';
        } else if (song.preparing) {
            status = 'Warming up…';
            cls = 'prep';
        }
        const thumb = `https://img.youtube.com/vi/${song.videoId}/mqdefault.jpg`;
        return `
            <div class="queue-item" data-id="${song.id}">
                <div class="queue-thumb" style="background-image: url('${thumb}')">
                    <span class="queue-pos">${index + 1}</span>
                </div>
                <div class="queue-item-info">
                    <div class="queue-item-title">${escapeHtml(song.title)}</div>
                    <div class="queue-item-meta">${escapeHtml(song.addedBy)} · <span class="q-status ${cls}">${status}</span></div>
                </div>
                <button class="queue-item-remove" data-id="${song.id}" aria-label="Remove from queue">×</button>
            </div>
        `;
    }).join('');
}

queueList.addEventListener('click', (e) => {
    const btn = e.target.closest('.queue-item-remove');
    if (btn) socket.emit('remove-song', { songId: btn.dataset.id });
});

function updateUsersDisplay(users) {
    userCount.textContent = users.length;
    usersList.innerHTML = users.map(user => `
        <span class="user-tag ${user.isHost ? 'host' : ''}">${user.isHost ? '👑 ' : ''}${escapeHtml(user.name)}</span>
    `).join('');
}

// ─── Transport ───────────────────────────────────────────────────────────────

function setPlayIcon(showPlay) {
    playPauseBtn.innerHTML = showPlay ? ICON_PLAY : ICON_PAUSE;
}

playPauseBtn.addEventListener('click', () => {
    socket.emit('toggle-play-request');
    if (!player) {
        // Remote screens flip optimistically; the host's time-sync corrects them
        remotePaused = !remotePaused;
        setPlayIcon(remotePaused);
    }
});

skipBtn.addEventListener('click', () => socket.emit('skip-song'));

socket.on('remote-toggle-play', () => {
    if (!player) return;
    if (player.paused) player.play().catch(() => showTapToStart());
    else player.pause();
});

// Stall watchdog: if the clock freezes while "playing", report diagnostics to
// the server console so we can see which layer starved (network vs decode).
const stallCheck = { t: -1, since: 0, reported: false };
setInterval(() => {
    if (!player || player.paused || player.ended || !currentSong) {
        stallCheck.t = -1;
        stallCheck.reported = false;
        return;
    }
    if (player.currentTime !== stallCheck.t) {
        stallCheck.t = player.currentTime;
        stallCheck.since = Date.now();
        stallCheck.reported = false;
        return;
    }
    if (stallCheck.reported || Date.now() - stallCheck.since < 6000) return;
    stallCheck.reported = true;
    const buffered = player.buffered.length ? player.buffered.end(player.buffered.length - 1) : 0;
    const q = player.getVideoPlaybackQuality ? player.getVideoPlaybackQuality() : {};
    socket.emit('client-debug', {
        what: 'playback-stall',
        videoId: currentSong.videoId,
        at: Math.round(player.currentTime * 10) / 10,
        bufferedTo: Math.round(buffered * 10) / 10,
        readyState: player.readyState,
        networkState: player.networkState,
        droppedFrames: q.droppedVideoFrames,
        decodedFrames: q.totalVideoFrames,
        mediaError: player.error ? player.error.code : null
    });
    showNotification('Playback stalled — diagnostics sent to the server console', 5000, true);
}, 2000);

// Host broadcasts its playback clock; other screens correct drift so the
// whole room sings the same word at the same time.
setInterval(() => {
    if (isHost && player && currentSong) {
        socket.emit('time-sync', {
            songId: currentSong.id,
            t: player.currentTime,
            paused: player.paused
        });
    }
}, 4000);

socket.on('time-sync', (data) => {
    if (isHost || !currentSong || data.songId !== currentSong.id) return;
    remotePaused = !!data.paused;
    if (!player) {
        setPlayIcon(remotePaused);
        return;
    }
    // Drift-correct only while both screens are playing. Pause state is
    // deliberately NOT mirrored here — pausing the whole room is the transport
    // button's job — so a host whose autoplay got blocked (or who paused their
    // own screen) can't silently freeze everyone else's playback.
    if (data.paused || player.paused) return;
    const target = data.t + 0.2;
    const nearEnd = player.duration && target > player.duration - 1.5;
    if (!nearEnd && Math.abs(player.currentTime - data.t) > 2.5) {
        player.currentTime = target;
    }
});

// ─── Now playing / add song ──────────────────────────────────────────────────

function showNowPlaying(song) {
    nowPlaying.style.display = 'block';
    nowPlayingTitle.textContent = song.title;
    nowPlayingUser.textContent = `Picked by ${song.addedBy}`;
    const thumb = `https://img.youtube.com/vi/${song.videoId}/mqdefault.jpg`;
    nowPlaying.style.backgroundImage =
        `linear-gradient(to right, rgba(11,10,18,0.93) 35%, rgba(11,10,18,0.55) 100%), url('${thumb}')`;
}

function startSong(song) {
    currentLyrics = [];
    hasTimestamps = false;
    overlayKey = '';
    setLyricsOffset(0);
    createPlayer(song.videoId);
}

addSongBtn.addEventListener('click', () => {
    const url = songUrlInput.value.trim();
    if (!url) {
        showNotification('Type a song name or paste a YouTube link');
        return;
    }
    socket.emit('add-song', { url, languageHint: songLanguage.value || null });
    songUrlInput.value = '';
});

songUrlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addSongBtn.click();
});

copyRoomBtn.addEventListener('click', () => {
    copyText(`${window.location.origin}?room=${roomId}`).then(() => {
        showNotification('Invite link copied');
    });
});

// ─── Socket events ───────────────────────────────────────────────────────────

socket.on('room-state', (data) => {
    isHost = data.isHost;
    updateQueueDisplay(data.queue);
    updateUsersDisplay(data.users);

    if (data.currentSong) {
        // Don't restart the video when this is just a reconnect mid-song
        const alreadyPlaying = player && currentSong && currentSong.id === data.currentSong.id;
        currentSong = data.currentSong;
        showNowPlaying(data.currentSong);
        setPlayIcon(false);
        if (!isMobile && !alreadyPlaying) startSong(data.currentSong);
    }
});

socket.on('queue-updated', (data) => {
    updateQueueDisplay(data.queue);
});

socket.on('play-song', ({ song }) => {
    currentSong = song;
    remotePaused = false;
    setPlayIcon(false);
    showNowPlaying(song);
    if (!isMobile) startSong(song);
    showNotification(`Now singing: ${song.title}`);
});

socket.on('video-status', (data) => {
    if (isMobile) return;
    if (data.status === 'preparing' && !videoContainer.querySelector('.video-loading')) {
        showVideoLoading(data.message || 'Getting the song ready…');
    }
    const statusText = document.getElementById('videoStatusText');
    if (statusText && data.message) statusText.textContent = data.message;
});

socket.on('no-songs', () => {
    currentSong = null;
    player = null;
    stopLyricsSync();
    currentLyrics = [];
    overlayKey = '';
    setPlayIcon(true);
    videoContainer.innerHTML = `
        <div class="empty-stage">
            <div class="empty-stage-mic">🎤</div>
            <h2>The stage is empty</h2>
            <p>Add a song and get this party started</p>
        </div>
        <div class="lyrics-overlay" id="lyricsOverlay"></div>
    `;
    lyricsOverlay = document.getElementById('lyricsOverlay');
    nowPlaying.style.display = 'none';
    nowPlaying.style.backgroundImage = '';
});

socket.on('user-joined', (data) => {
    updateUsersDisplay(data.users);
    showNotification(`${data.name} joined the party!`);
});

socket.on('user-left', (data) => {
    updateUsersDisplay(data.users);
    showNotification(`${data.name} left the party`);
});

socket.on('notification', (data) => {
    showNotification(data.message);
});

socket.on('error', (data) => {
    showNotification(data.message, 5000, true);
});

// ─── Boot ────────────────────────────────────────────────────────────────────

const urlRoom = new URLSearchParams(window.location.search).get('room');
if (urlRoom) roomCodeInput.value = urlRoom.toUpperCase();
updateJoinButton();
setPlayIcon(true);
startRoomsPolling();
