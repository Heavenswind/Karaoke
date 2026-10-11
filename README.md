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

Set via environment variable (default: `large-v3`):

```bash
WHISPER_MODEL=small npm start
```

| Model    | Accuracy on singing | VRAM (measured, float16) |
|----------|---------------------|--------------------------|
| tiny     | Low                 | ~1GB                     |
| small    | Mishears often      | ~0.7GB                   |
| medium   | Better              | ~2.5GB                   |
| large-v3 | Best                | ~3.9GB                   |

`large-v3` is the default because on a mid-range GPU it is not actually slower:
`small` spends its time looping on hallucinated lyrics, so on a 4070 the big
model finished a test song in 5.6s against `small`'s 7.4s — and got the words
right. Drop to `small` only if you're short on VRAM.

Models are held in VRAM by a worker process that exits after 10 minutes of
silence (`WORKER_IDLE_MS`), so the GPU is free between parties.

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
