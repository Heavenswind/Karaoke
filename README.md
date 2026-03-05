# 🎤 Karaoke Party

Real-time karaoke app for local parties. Friends join from their phones, add YouTube songs to a shared queue, and the TV plays them with word-by-word lyrics sync.

## How It Works

1. Run the server on a PC/TV connected to speakers
2. Friends open the app on their phones and join the room
3. Anyone can add YouTube URLs to the queue
4. The server downloads, separates vocals, and transcribes lyrics automatically
5. Songs play on the TV with karaoke-style highlighted lyrics

## Stack

- **Node.js + Express + Socket.io** — server and real-time sync
- **yt-dlp** — YouTube downloader
- **Demucs** — AI vocal separation (local, GPU)
- **faster-whisper** — speech-to-text transcription (local, GPU)
- **FFmpeg** — audio extraction

No cloud APIs. Runs entirely on your machine.

## Requirements

- Node.js
- Python 3.8+
- FFmpeg
- CUDA GPU (recommended — falls back to CPU)
- Deno (for yt-dlp JS challenge solving)

## Setup

```bash
# Install Node dependencies
npm install

# Install Python dependencies
pip install yt-dlp faster-whisper demucs torchaudio torch
```

## Run

```bash
npm start
```

Open `http://localhost:3000` on the TV. Friends connect via your local IP (e.g. `http://192.168.1.x:3000`).

## Whisper Model

Set via environment variable (default: `small`):

```bash
WHISPER_MODEL=large-v3 npm start
```

| Model    | Speed   | Accuracy | VRAM  |
|----------|---------|----------|-------|
| tiny     | Fastest | Low      | ~1GB  |
| small    | Fast    | Good     | ~2GB  |
| medium   | Slow    | Better   | ~5GB  |
| large-v3 | Slowest | Best     | ~10GB |

## Room Management

From the server machine only:

```bash
# List active rooms
curl http://localhost:3000/api/rooms

# Inspect a room
curl http://localhost:3000/api/rooms/ROOMID

# Delete a room
curl -X DELETE http://localhost:3000/api/rooms/ROOMID
```
