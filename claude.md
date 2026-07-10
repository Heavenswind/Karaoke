# Karaoke Party App

An online karaoke application with real-time song queuing, word-by-word lyrics highlighting, and AI-powered transcription.

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Browser UI    │◄───►│  Node.js Server │◄───►│  Python Backend │
│  (Socket.io)    │     │  (Express/WS)   │     │  (Whisper/Demucs)│
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────┐
                        │   videos/   │
                        │  (MP4/JSON) │
                        └─────────────┘
```

## Tech Stack

### Server (Node.js)
- **Express** - HTTP server and static file serving
- **Socket.io** - Real-time bidirectional communication for rooms/queue sync
- **UUID** - Unique room and song identifiers

### Transcription Pipeline (Python)
- **yt-dlp** - YouTube video/audio download with geo-bypass
- **Demucs (htdemucs)** - Vocal separation using AI (isolates vocals from instruments)
- **faster-whisper** - GPU-accelerated speech-to-text with word-level timestamps
- **FFmpeg** - Audio extraction and conversion

### Frontend
- **Socket.io Client** - Real-time updates
- **HTML5 Video** - Local video playback
- **CSS** - Karaoke overlay with word-by-word fill effect

## Key Files

| File                  | Purpose                                                         |
| --------------------- | --------------------------------------------------------------- |
| `server.js`           | Express server, Socket.io rooms, transcription queue management |
| `download_video.py`   | Pipeline orchestrator: download, vocals, transcription, furigana |
| `transcribe_audio.py` | Demucs vocal separation + faster-whisper transcription          |
| `lyrics_correct.py`   | lrclib.net lookup + proofreads Whisper output against official lyrics |
| `furigana.py`         | Adds hiragana readings over kanji for Japanese songs (fugashi)  |
| `audio_io.py`         | torchaudio loading with ffmpeg fallback (mp3 support)           |
| `public/index.html`   | Karaoke UI with video player and lyrics overlay                 |
| `public/app.js`       | Client-side logic, word highlighting, queue management          |
| `videos/`             | Cached MP4s + transcription JSONs (LRU-pruned past MAX_CACHE_MB)|

## Transcription Pipeline Flow

1. **User adds a YouTube URL, raw video ID, or free-text search** (resolved via `yt-dlp ytsearch1:`)
2. **Server queues transcription** (prevents concurrent GPU access)
3. **download_video.py** → downloads video (metadata piggybacks on the same yt-dlp call) + extracts WAV audio, separates vocals (Demucs)
4. **Lyrics**: **faster-whisper** transcription (`transcribe_audio.py`) on the vocals-only audio, then word-level proofreading against official lyrics from lrclib.net where they confidently agree (`lyrics_correct.py`) — never replaces Whisper's timing, only fixes misheard words
   - Japanese: furigana ruby annotations added (`furigana.py`)
5. **Server sends** transcription to clients via Socket.io
6. **Cache**: mp4 + json stay in `videos/` for instant replays; the intermediate wav is deleted; oldest songs pruned past `MAX_CACHE_MB`

## GPU Considerations

- **CUDA required** for optimal performance (float16 compute)
- **Transcription queue** ensures only one GPU operation at a time
- **Memory cleanup** after Demucs with `torch.cuda.empty_cache()`
- Falls back to CPU (int8) if no CUDA available

## Whisper Models

| Model    | Speed   | Accuracy | VRAM Usage |
| -------- | ------- | -------- | ---------- |
| tiny     | Fastest | Low      | ~1GB       |
| base     | Fast    | Medium   | ~1GB       |
| small    | Medium  | Good     | ~2GB       |
| medium   | Slow    | Better   | ~5GB       |
| turbo    | Medium  | Good     | ~6GB       |
| large-v3 | Slowest | Best     | ~10GB      |

Default: `small` (good balance for karaoke)

## Configuration

### Environment Variables
```bash
WHISPER_MODEL=small   # tiny, base, small, medium, turbo, large-v3
MAX_CACHE_MB=8192     # videos/ cache cap; oldest songs pruned past this
COOKIES_FILE=...      # exported cookies.txt for YouTube bot-check bypass
```

### Socket.io Tuning (in server.js)
```javascript
pingTimeout: 60000,
pingInterval: 25000
```

## Commands

```bash
# Start server
npm start

# Manual transcription test
python download_video.py VIDEO_ID small videos

# Test Demucs + Whisper directly
python transcribe_audio.py input.wav small output.json ja
```

## Dependencies

### Node.js
```bash
npm install express socket.io uuid
```

### Python
```bash
pip install yt-dlp faster-whisper demucs torchaudio torch
```

### System
- FFmpeg (required by yt-dlp and audio processing)
- CUDA toolkit (for GPU acceleration)

## Known Issues & Solutions

| Issue                         | Solution                                           |
| ----------------------------- | -------------------------------------------------- |
| Video stalls ~4s in, looks like buffering | 4K AV1 decode starves while Demucs/Whisper hog the GPU — downloads capped at 1080p, H.264 preferred |
| Low-res downloads (360p/480p) | YouTube bot-check limits formats — keep the POT provider running (start.bat launches it) |
| GPU crash (code 3221226505)   | Transcription queue prevents concurrent access     |
| Misheard lyrics               | Demucs vocal separation improves accuracy; lrclib word-correction fixes the rest where a confident match exists |
| Geo-blocked videos            | yt-dlp with `--geo-bypass --geo-bypass-country US` |
| PowerShell subprocess issues  | Use `shell=True` on Windows                        |
| VAD filtering removes singing | `vad_filter=False` in faster-whisper               |

## JSON Transcription Format

```json
{
  "language": "ja",
  "segments": [
    {
      "start": 2.96,
      "end": 4.42,
      "text": "テロリングマイチー!",
      "words": [
        {"word": "テロリング", "start": 2.96, "end": 3.5},
        {"word": "マイチー", "start": 3.5, "end": 4.42}
      ]
    }
  ]
}
```

## Future Development Ideas

- [ ] Pitch detection for scoring/feedback
- [ ] Lyrics editing interface
- [ ] Multiple language support per song
- [ ] Background music volume control
- [ ] Room password protection
- [ ] Persistent song database
- [ ] Spotify/Apple Music integration
