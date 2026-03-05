// Karaoke Party - Client App

// Detect mobile devices
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || window.innerWidth <= 600;

// Socket with reconnection settings to stay connected when phone locks
const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    timeout: 20000,
    forceNew: false,
    transports: ['websocket', 'polling']
});

// Keep connection alive with heartbeat
let heartbeatInterval = null;
function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
        if (socket.connected) {
            socket.emit('heartbeat');
        }
    }, 15000); // Send heartbeat every 15 seconds
}

// Handle visibility changes (phone lock/unlock, tab switch)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        // Page became visible - ensure connection
        if (!socket.connected) {
            socket.connect();
        }
        // Rejoin room if we have one
        if (roomId && !socket.connected) {
            setTimeout(() => {
                if (socket.connected && roomId) {
                    const name = userNameInput.value.trim() || 'Anonymous';
                    socket.emit('join-room', { roomId, name, isHost });
                }
            }, 500);
        }
    }
});

// Handle socket reconnection
socket.on('connect', () => {
    console.log('Socket connected');
    startHeartbeat();
    // Rejoin room after reconnection
    if (roomId) {
        const name = userNameInput.value.trim() || 'Anonymous';
        socket.emit('join-room', { roomId, name, isHost });
    }
});

socket.on('disconnect', (reason) => {
    console.log('Socket disconnected:', reason);
    if (reason === 'io server disconnect') {
        // Server disconnected us, reconnect
        socket.connect();
    }
});

// Start heartbeat immediately
startHeartbeat();

// State
let isHost = false;
let roomId = null;
let player = null;
let currentLyrics = [];      // Array of {text, start, end} for timestamped or just strings
let currentLyricIndex = 0;
let lyricsTimer = null;
let currentVideoId = null;
let lyricsLoading = false;
let lyricsOffset = 0;        // Offset in seconds for lyrics sync
let hasTimestamps = false;   // Whether lyrics have timestamps

// DOM Elements
const joinScreen = document.getElementById('joinScreen');
const appScreen = document.getElementById('appScreen');
const userNameInput = document.getElementById('userName');
const roomCodeInput = document.getElementById('roomCode');
const hostBtn = document.getElementById('hostBtn');
const displayRoomId = document.getElementById('displayRoomId');
const copyRoomBtn = document.getElementById('copyRoomBtn');
const userCount = document.getElementById('userCount');
const videoContainer = document.getElementById('videoContainer');
const songUrlInput = document.getElementById('songUrl');
const addSongBtn = document.getElementById('addSongBtn');
const queueList = document.getElementById('queueList');
const queueCount = document.getElementById('queueCount');
const nowPlaying = document.getElementById('nowPlaying');
const nowPlayingTitle = document.getElementById('nowPlayingTitle');
const nowPlayingUser = document.getElementById('nowPlayingUser');
const hostControls = document.getElementById('hostControls');
const skipBtn = document.getElementById('skipBtn');
const playPauseBtn = document.getElementById('playPauseBtn');
const usersList = document.getElementById('usersList');
const notifications = document.getElementById('notifications');
const lyricsDisplay = document.getElementById('lyricsDisplay');
const toggleLyricsInput = document.getElementById('toggleLyricsInput');
const lyricsInputContainer = document.getElementById('lyricsInputContainer');
const lyricsInput = document.getElementById('lyricsInput');
const saveLyricsBtn = document.getElementById('saveLyrics');
const lyricsOffsetSlider = document.getElementById('lyricsOffset');
const offsetValueDisplay = document.getElementById('offsetValue');
const resetOffsetBtn = document.getElementById('resetOffset');
let lyricsOverlay = document.getElementById('lyricsOverlay');

// Generate room ID
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Show notification
function showNotification(message, duration = 3000, isError = false) {
    const notif = document.createElement('div');
    notif.className = 'notification' + (isError ? ' notification-error' : '');
    notif.textContent = message;
    notifications.appendChild(notif);

    setTimeout(() => {
        notif.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => notif.remove(), 300);
    }, duration);
}

// Join room
function joinRoom(asHost = false) {
    const name = userNameInput.value.trim() || 'Anonymous';
    roomId = roomCodeInput.value.trim().toUpperCase() || generateRoomId();
    isHost = asHost;

    socket.emit('join-room', { roomId, name, isHost });

    // Show app screen
    joinScreen.style.display = 'none';
    appScreen.style.display = 'block';
    displayRoomId.textContent = roomId;

    // Update URL
    window.history.pushState({}, '', `?room=${roomId}`);
}

// Create HTML5 Video Player (downloads video first)
function createPlayer(videoId) {
    currentVideoId = videoId;

    // Show loading state
    videoContainer.innerHTML = `
        <div class="video-loading">
            <div class="loading-dots"><span></span><span></span><span></span></div>
            <p id="videoStatusText">📥 Preparing video...</p>
            <p style="font-size: 0.85rem; opacity: 0.7; margin-top: 8px;">Downloading and processing</p>
        </div>
    `;

    // Fetch video and lyrics
    prepareAndPlayVideo(videoId);
}

// Download video and play when ready
async function prepareAndPlayVideo(videoId) {
    try {
        const response = await fetch(`/api/video/prepare/${videoId}`);
        const data = await response.json();

        if (data.success && data.videoUrl) {
            // Create HTML5 video player with lyrics overlay
            videoContainer.innerHTML = `
                <video id="localPlayer" controls autoplay style="width: 100%; height: 100%; max-height: 100%; background: #000;">
                    <source src="${data.videoUrl}" type="video/mp4">
                    Your browser doesn't support HTML5 video.
                </video>
                <div class="lyrics-overlay" id="lyricsOverlay"></div>
            `;

            player = document.getElementById('localPlayer');
            lyricsOverlay = document.getElementById('lyricsOverlay');

            // Set up event listeners
            player.addEventListener('loadedmetadata', onPlayerReady);
            player.addEventListener('play', () => {
                playPauseBtn.textContent = '⏸️';
                startLyricsSync();
            });
            player.addEventListener('pause', () => {
                playPauseBtn.textContent = '▶️';
            });
            player.addEventListener('ended', onVideoEnded);
            player.addEventListener('timeupdate', onTimeUpdate);

            // Store lyrics if they came with the video
            if (data.segments && data.segments.length > 0) {
                currentLyrics = data.segments;
                hasTimestamps = true;
                lyricsInput.value = data.lyrics || data.segments.map(s => s.text).join('\n');
                currentLyricIndex = 0;
                renderLyrics();
                renderKaraokeOverlay(0, 0); // Initial render
                showNotification(`🎤 Video ready with lyrics!`);
            } else if (data.lyrics) {
                currentLyrics = parseLyrics(data.lyrics);
                hasTimestamps = false;
                lyricsInput.value = data.lyrics;
                currentLyricIndex = 0;
                renderLyrics();
                renderKaraokeOverlay(0, 0); // Initial render
            }

            // Start playback
            player.play().catch(e => console.log('Autoplay prevented:', e));

        } else {
            videoContainer.innerHTML = `
                <div class="no-video">
                    <p>😕 ${data.error || 'Failed to load video'}</p>
                    <button onclick="prepareAndPlayVideo('${videoId}')" style="margin-top: 12px; padding: 8px 16px; background: var(--primary); border: none; border-radius: 8px; color: white; cursor: pointer;">Retry</button>
                </div>
            `;
        }
    } catch (error) {
        console.error('Failed to prepare video:', error);
        videoContainer.innerHTML = `
            <div class="no-video">
                <p>Could not load video</p>
                <button onclick="prepareAndPlayVideo('${videoId}')" style="margin-top: 12px; padding: 8px 16px; background: var(--primary); border: none; border-radius: 8px; color: white; cursor: pointer;">Retry</button>
            </div>
        `;
    }
}

// Make prepareAndPlayVideo available globally
window.prepareAndPlayVideo = prepareAndPlayVideo;

function onPlayerReady() {
    console.log('Video player ready');
    startLyricsSync();

    // Fetch lyrics if not already loaded
    if (currentVideoId && currentLyrics.length === 0) {
        fetchLyricsForVideo(currentVideoId);
    }
}

function onVideoEnded() {
    if (isHost) {
        socket.emit('song-ended');
    }
    stopLyricsSync();
}

function onTimeUpdate() {
    if (player && currentLyrics.length > 0) {
        updateLyricsDisplay(player.currentTime);
    }
}

// Fetch lyrics automatically using Whisper transcription
async function fetchLyricsForVideo(videoId) {
    if (lyricsLoading) return;
    lyricsLoading = true;

    lyricsDisplay.innerHTML = `
        <div style="text-align: center; color: var(--text-muted);">
            <div class="loading-dots"><span></span><span></span><span></span></div>
            <p style="margin-top: 10px;" id="lyricsStatusText">🎵 Downloading audio...</p>
            <p style="font-size: 0.85rem; opacity: 0.7;">First time may take 30-60 seconds</p>
        </div>
    `;

    try {
        const response = await fetch(`/api/lyrics/${videoId}`);
        const data = await response.json();

        if (data.success) {
            // Check if we have timestamped segments
            if (data.segments && data.segments.length > 0) {
                // Use timestamped segments
                currentLyrics = data.segments;
                hasTimestamps = true;
                lyricsInput.value = data.lyrics || data.segments.map(s => s.text).join('\n');
                showNotification(`🎤 Transcribed: ${data.artist} - ${data.title}`);
            } else if (data.lyrics) {
                // Fallback to plain lyrics
                currentLyrics = parseLyrics(data.lyrics);
                hasTimestamps = false;
                lyricsInput.value = data.lyrics;
                showNotification(`📝 Lyrics: ${data.artist} - ${data.title}`);
            }

            currentLyricIndex = 0;
            renderLyrics();
        } else {
            lyricsDisplay.innerHTML = `
                <div style="text-align: center; color: var(--text-muted);">
                    <p>😕 ${data.error || 'Could not transcribe audio'}</p>
                    <p style="font-size: 0.9rem; margin-top: 5px;">Click "Manual" to paste lyrics yourself</p>
                    ${data.artist ? `<p style="font-size: 0.8rem; margin-top: 10px; opacity: 0.7;">Song: ${data.artist} - ${data.title}</p>` : ''}
                    <div style="margin-top: 12px; display: flex; gap: 10px; justify-content: center;">
                        <button onclick="fetchLyricsForVideo('${videoId}')" style="padding: 8px 16px; background: var(--primary); border: none; border-radius: 8px; color: white; cursor: pointer;">Retry Whisper</button>
                        <button onclick="fetchLyricsWithOllama('${videoId}')" style="padding: 8px 16px; background: var(--bg-lighter); border: none; border-radius: 8px; color: white; cursor: pointer;">Try AI Instead</button>
                    </div>
                </div>
            `;
        }
    } catch (error) {
        console.error('Failed to fetch lyrics:', error);
        lyricsDisplay.innerHTML = `
            <div style="text-align: center; color: var(--text-muted);">
                <p>Could not connect to server</p>
                <p style="font-size: 0.9rem; margin-top: 5px;">Click "Manual" to paste lyrics yourself</p>
            </div>
        `;
    }

    lyricsLoading = false;
}

// Fallback to Ollama AI generation
async function fetchLyricsWithOllama(videoId) {
    if (lyricsLoading) return;
    lyricsLoading = true;

    lyricsDisplay.innerHTML = `
        <div style="text-align: center; color: var(--text-muted);">
            <div class="loading-dots"><span></span><span></span><span></span></div>
            <p style="margin-top: 10px;">🤖 Generating lyrics with AI...</p>
        </div>
    `;

    try {
        const response = await fetch(`/api/lyrics/${videoId}?fallback=ollama`);
        const data = await response.json();

        if (data.success && data.lyrics) {
            currentLyrics = parseLyrics(data.lyrics);
            hasTimestamps = false;
            currentLyricIndex = 0;
            lyricsInput.value = data.lyrics;
            renderLyrics();
            showNotification(`🤖 AI Lyrics: ${data.artist} - ${data.title}`);
        } else {
            lyricsDisplay.innerHTML = `
                <div style="text-align: center; color: var(--text-muted);">
                    <p>😕 ${data.error || 'Could not generate lyrics'}</p>
                    ${data.ollamaRequired ? '<p style="font-size: 0.9rem; margin-top: 5px;">Start Ollama: <code>ollama serve</code></p>' : ''}
                </div>
            `;
        }
    } catch (error) {
        console.error('Failed to fetch lyrics with Ollama:', error);
    }

    lyricsLoading = false;
}

// Make functions available globally for retry buttons
window.fetchLyricsForVideo = fetchLyricsForVideo;
window.fetchLyricsWithOllama = fetchLyricsWithOllama;

// Listen for transcription status updates via socket
socket.on('lyrics-status', (data) => {
    const statusText = document.getElementById('lyricsStatusText');
    if (statusText) {
        if (data.status === 'downloading') {
            statusText.textContent = '🎵 Downloading audio...';
        } else if (data.status === 'transcribing') {
            statusText.textContent = '🎤 Transcribing with Whisper...';
        }
    }
});

// Lyrics handling
function startLyricsSync() {
    if (lyricsTimer) clearInterval(lyricsTimer);

    lyricsTimer = setInterval(() => {
        if (player && currentLyrics.length > 0) {
            const currentTime = player.currentTime;
            updateLyricsDisplay(currentTime);
        }
    }, 100);
}

function stopLyricsSync() {
    if (lyricsTimer) {
        clearInterval(lyricsTimer);
        lyricsTimer = null;
    }
}

function updateLyricsDisplay(currentTime) {
    if (currentLyrics.length === 0) {
        if (lyricsOverlay) lyricsOverlay.innerHTML = '';
        return;
    }

    // Apply user offset
    const adjustedTime = currentTime + lyricsOffset;
    let newIndex = currentLyricIndex;
    let fillPercent = 0;

    if (hasTimestamps) {
        // Use actual timestamps from Whisper transcription
        for (let i = 0; i < currentLyrics.length; i++) {
            const segment = currentLyrics[i];
            if (adjustedTime >= segment.start && adjustedTime < segment.end) {
                newIndex = i;
                // Calculate fill percentage within this segment
                const segmentDuration = segment.end - segment.start;
                const elapsed = adjustedTime - segment.start;
                fillPercent = Math.min(100, (elapsed / segmentDuration) * 100);
                break;
            } else if (adjustedTime < segment.start) {
                // We're before this segment, use previous
                newIndex = Math.max(0, i - 1);
                fillPercent = 100; // Previous line fully sung
                break;
            } else if (i === currentLyrics.length - 1) {
                // Past the last segment
                newIndex = i;
                fillPercent = 100;
            }
        }
    } else {
        // Fallback: Estimate timing based on video duration
        let duration = 180;
        if (player && player.duration) {
            duration = player.duration || 180;
        }

        const estimatedIntro = Math.min(duration * 0.08, 20);
        const lyricsDuration = duration - estimatedIntro - 10;
        const lineTime = lyricsDuration / currentLyrics.length;
        const estimatedTime = Math.max(0, adjustedTime - estimatedIntro);
        newIndex = Math.floor(estimatedTime / lineTime);

        // Calculate fill for non-timestamped lyrics
        const lineStart = estimatedIntro + (newIndex * lineTime);
        const elapsed = adjustedTime - lineStart;
        fillPercent = Math.min(100, (elapsed / lineTime) * 100);
    }

    // Update overlay with karaoke effect (pass time for word-level sync)
    renderKaraokeOverlay(newIndex, adjustedTime);

    if (newIndex !== currentLyricIndex && newIndex >= 0 && newIndex < currentLyrics.length) {
        currentLyricIndex = newIndex;
        renderLyrics(); // Keep the hidden lyrics panel updated too
    }
}

function renderKaraokeOverlay(index, currentTime) {
    if (!lyricsOverlay || currentLyrics.length === 0) return;

    const segment = currentLyrics[index];
    if (!segment) {
        lyricsOverlay.innerHTML = '';
        return;
    }

    const currentLine = hasTimestamps ? segment.text : segment;
    const words = segment.words || [];
    const nextLine = index + 1 < currentLyrics.length
        ? (hasTimestamps ? currentLyrics[index + 1]?.text : currentLyrics[index + 1])
        : '';

    let wordsHtml = '';

    if (words.length > 0 && hasTimestamps) {
        // Word-by-word fill based on actual Whisper timing
        for (const word of words) {
            let fillPercent = 0;
            if (currentTime >= word.end) {
                fillPercent = 100; // Word fully sung
            } else if (currentTime >= word.start) {
                // Currently singing this word - fill progressively
                const wordDuration = word.end - word.start;
                const elapsed = currentTime - word.start;
                fillPercent = Math.min(100, (elapsed / wordDuration) * 100);
            }

            wordsHtml += `<span class="karaoke-word">
                <span class="word-bg">${escapeHtml(word.word)}</span>
                <span class="word-fill" style="width: ${fillPercent}%">${escapeHtml(word.word)}</span>
            </span>`;
        }
    } else {
        // Fallback: full line fill (for lyrics without word timestamps)
        const segmentDuration = segment.end - segment.start;
        const elapsed = currentTime - segment.start;
        const fillPercent = Math.min(100, Math.max(0, (elapsed / segmentDuration) * 100));

        wordsHtml = `<span class="karaoke-text">
            <span class="text-bg">${escapeHtml(currentLine)}</span>
            <span class="text-fill" style="width: ${fillPercent}%">${escapeHtml(currentLine)}</span>
        </span>`;
    }

    lyricsOverlay.innerHTML = `
        <div class="karaoke-line current">${wordsHtml}</div>
        ${nextLine ? `<div class="karaoke-line next">${escapeHtml(nextLine)}</div>` : ''}
    `;
}

function renderLyrics() {
    if (currentLyrics.length === 0) {
        lyricsDisplay.innerHTML = '<p style="color: var(--text-muted); font-size: 1rem;">Searching for lyrics...</p>';
        return;
    }

    // Show 5 lines: 2 previous, current, 2 next for better context
    const start = Math.max(0, currentLyricIndex - 2);
    const end = Math.min(currentLyrics.length, currentLyricIndex + 4);

    let html = '';
    for (let i = start; i < end; i++) {
        let className = 'lyrics-line';
        if (i < currentLyricIndex) className += ' past';
        if (i === currentLyricIndex) className += ' active';
        if (i > currentLyricIndex) className += ' upcoming';

        // Get text from segment object or plain string
        const text = hasTimestamps ? currentLyrics[i].text : currentLyrics[i];
        html += `<div class="${className}">${escapeHtml(text)}</div>`;
    }

    lyricsDisplay.innerHTML = html;
}

function parseLyrics(text) {
    return text.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
}

// Update queue display
function updateQueueDisplay(queue) {
    queueCount.textContent = queue.length;

    if (queue.length === 0) {
        queueList.innerHTML = `
      <div class="empty-queue">
        <div class="empty-queue-icon">🎶</div>
        <p>Queue is empty</p>
        <p style="font-size: 0.85rem; margin-top: 5px;">Add songs to get started!</p>
      </div>
    `;
        return;
    }

    queueList.innerHTML = queue.map((song, index) => {
        // Status icons
        let statusIcons = '';
        if (song.downloading) {
            statusIcons = '<span class="status-icon downloading" title="Downloading...">⏳</span>';
        } else {
            const videoIcon = song.videoReady
                ? '<span class="status-icon ready" title="Video ready">🎬</span>'
                : '<span class="status-icon pending" title="Video pending">📥</span>';
            const lyricsIcon = song.lyricsReady
                ? '<span class="status-icon ready" title="Lyrics ready">🎤</span>'
                : '<span class="status-icon pending" title="Lyrics pending">📝</span>';
            statusIcons = videoIcon + lyricsIcon;
        }

        return `
        <div class="queue-item" data-id="${song.id}">
          <div class="queue-number">${index + 1}</div>
          <div class="queue-item-info">
            <div class="queue-item-title">${escapeHtml(song.title)}</div>
            <div class="queue-item-user">Added by ${escapeHtml(song.addedBy)}</div>
          </div>
          <div class="queue-item-status">${statusIcons}</div>
          <button class="queue-item-remove" onclick="removeSong('${song.id}')" title="Remove from queue">🗑️</button>
        </div>
      `;
    }).join('');
}

// Update users display
function updateUsersDisplay(users) {
    userCount.textContent = users.length;
    usersList.innerHTML = users.map(user => `
    <span class="user-tag ${user.isHost ? 'host' : ''}">${user.isHost ? '👑 ' : ''}${escapeHtml(user.name)}</span>
  `).join('');
}

// Remove song from queue
function removeSong(songId) {
    socket.emit('remove-song', { songId });
}

// Helper to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Event Listeners
hostBtn.addEventListener('click', () => joinRoom(true));

userNameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') joinRoom(true);
});

roomCodeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') joinRoom(true);
});

copyRoomBtn.addEventListener('click', () => {
    const url = `${window.location.origin}?room=${roomId}`;
    navigator.clipboard.writeText(url).then(() => {
        showNotification('Link copied to clipboard!');
    });
});

addSongBtn.addEventListener('click', () => {
    const url = songUrlInput.value.trim();
    const languageSelect = document.getElementById('songLanguage');
    const languageHint = languageSelect ? languageSelect.value : '';

    console.log('Add song clicked:', { url, languageHint, connected: socket.connected });

    if (!url) {
        showNotification('Please enter a YouTube URL');
        return;
    }

    socket.emit('add-song', { url, languageHint: languageHint || null });
    console.log('Emitted add-song event');
    songUrlInput.value = '';
});

songUrlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addSongBtn.click();
});

skipBtn.addEventListener('click', () => {
    socket.emit('skip-song');
});

playPauseBtn.addEventListener('click', () => {
    if (player) {
        if (player.paused) {
            player.play();
            socket.emit('toggle-play', { isPlaying: true });
        } else {
            player.pause();
            socket.emit('toggle-play', { isPlaying: false });
        }
    }
});

toggleLyricsInput.addEventListener('click', () => {
    const isVisible = lyricsInputContainer.style.display === 'block';
    lyricsInputContainer.style.display = isVisible ? 'none' : 'block';
    toggleLyricsInput.textContent = isVisible ? 'Manual' : 'Hide';
});

saveLyricsBtn.addEventListener('click', () => {
    currentLyrics = parseLyrics(lyricsInput.value);
    hasTimestamps = false; // Manual lyrics don't have timestamps
    currentLyricIndex = 0;
    renderLyrics();
    lyricsInputContainer.style.display = 'none';
    toggleLyricsInput.textContent = 'Manual';
    showNotification('Lyrics applied!');
});

// Lyrics offset controls
lyricsOffsetSlider.addEventListener('input', (e) => {
    lyricsOffset = parseInt(e.target.value);
    offsetValueDisplay.textContent = `${lyricsOffset >= 0 ? '+' : ''}${lyricsOffset}s`;
    // Force lyrics update
    currentLyricIndex = -1;
    if (player && player.currentTime !== undefined) {
        updateLyricsDisplay(player.currentTime);
    }
});

resetOffsetBtn.addEventListener('click', () => {
    lyricsOffset = 0;
    lyricsOffsetSlider.value = 0;
    offsetValueDisplay.textContent = '0s';
    currentLyricIndex = -1;
    if (player && player.currentTime !== undefined) {
        updateLyricsDisplay(player.currentTime);
    }
});

// Socket Events
socket.on('room-state', (data) => {
    isHost = data.isHost;
    updateQueueDisplay(data.queue);
    updateUsersDisplay(data.users);

    if (isHost) {
        hostControls.style.display = 'flex';
    }

    if (data.currentSong) {
        currentVideoId = data.currentSong.videoId;
        currentLyrics = [];
        currentLyricIndex = 0;
        lyricsLoading = false;
        hasTimestamps = false;
        createPlayer(data.currentSong.videoId);
        nowPlaying.style.display = 'block';
        nowPlayingTitle.textContent = data.currentSong.title;
        nowPlayingUser.textContent = `Added by ${data.currentSong.addedBy}`;
    }
});

socket.on('queue-updated', (data) => {
    updateQueueDisplay(data.queue);
});

socket.on('play-song', (data) => {
    const song = data.song;

    // Reset lyrics for new song
    currentLyrics = [];
    currentLyricIndex = 0;
    lyricsInput.value = '';
    lyricsLoading = false;
    hasTimestamps = false;

    // Only load video on desktop/host - mobile is just a remote control
    if (!isMobile) {
        createPlayer(song.videoId);
    }

    nowPlaying.style.display = 'block';
    nowPlayingTitle.textContent = song.title;
    nowPlayingUser.textContent = `Added by ${song.addedBy}`;

    showNotification(`Now playing: ${song.title}`);
});

socket.on('video-status', (data) => {
    // Show preparation status in video container
    if (!isMobile && data.status === 'preparing') {
        videoContainer.innerHTML = `
            <div class="video-loading">
                <div class="loading-dots"><span></span><span></span><span></span></div>
                <p id="videoStatusText">${data.message || '📥 Preparing video...'}</p>
                <p style="font-size: 0.85rem; opacity: 0.7; margin-top: 8px;">Please wait while we download and transcribe</p>
            </div>
        `;
    }

    // Update status text if it exists
    const statusText = document.getElementById('videoStatusText');
    if (statusText && data.message) {
        statusText.textContent = data.message;
    }
});

socket.on('no-songs', () => {
    videoContainer.innerHTML = `
    <div class="no-video">
      <div class="no-video-icon">🎵</div>
      <h2>Waiting for songs...</h2>
      <p style="color: var(--text-muted); margin-top: 10px;">Add a YouTube URL to start the party!</p>
    </div>
  `;
    nowPlaying.style.display = 'none';
    stopLyricsSync();
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
    showNotification(`❌ ${data.message}`, 5000, true);
});

socket.on('play-state-changed', (data) => {
    if (player) {
        if (data.isPlaying) {
            player.play();
        } else {
            player.pause();
        }
    }
});

// Check URL for room code
const urlParams = new URLSearchParams(window.location.search);
const urlRoom = urlParams.get('room');
if (urlRoom) {
    roomCodeInput.value = urlRoom;
}

// Show active rooms on join screen
async function loadActiveRooms() {
    try {
        const res = await fetch('/api/rooms');
        const rooms = await res.json();
        const container = document.getElementById('activeRooms');
        const list = document.getElementById('roomsList');

        if (rooms.length === 0) {
            container.style.display = 'none';
            return;
        }

        list.innerHTML = rooms.map(room => `
            <div style="
                background: var(--bg-lighter);
                border: 2px solid transparent;
                border-radius: 14px;
                padding: 18px 20px;
                display: flex;
                align-items: center;
                gap: 16px;
            ">
                <div style="font-size: 2rem; cursor: pointer;" onclick="joinRoomById('${room.id}')">🎤</div>
                <div style="flex: 1; overflow: hidden; cursor: pointer;" onclick="joinRoomById('${room.id}')">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 4px;">
                        <span style="font-family: monospace; font-size: 1.1rem; font-weight: 700; color: var(--primary);">${room.id}</span>
                        <span style="font-size: 0.8rem; color: var(--text-muted);">👥 ${room.userCount} online</span>
                    </div>
                    ${room.currentSong ? `<div style="font-size: 0.9rem; color: white; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">♪ ${escapeHtml(room.currentSong)}</div>` : '<div style="font-size: 0.85rem; color: var(--text-muted);">Waiting for songs...</div>'}
                    ${room.queueLength > 0 ? `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">${room.queueLength} more in queue</div>` : ''}
                </div>
                <button onclick="deleteRoom('${room.id}')" title="Delete room" style="
                    background: none;
                    border: none;
                    color: #ef4444;
                    cursor: pointer;
                    font-size: 1.2rem;
                    padding: 6px;
                    border-radius: 8px;
                    opacity: 0.5;
                    transition: opacity 0.2s;
                " onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.5'">🗑️</button>
            </div>
        `).join('');

        container.style.display = 'block';
    } catch {}
}

function joinRoomById(id) {
    roomCodeInput.value = id;
    joinRoom(false);
}
window.joinRoomById = joinRoomById;

async function deleteRoom(id) {
    if (!confirm(`Delete room ${id}?`)) return;
    const res = await fetch(`/api/rooms/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) loadActiveRooms();
    else alert(data.error || 'Failed to delete room');
}
window.deleteRoom = deleteRoom;

loadActiveRooms();

// Expose removeSong globally
window.removeSong = removeSong;
