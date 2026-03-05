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
| `download_video.py`   | Downloads YouTube video/audio using yt-dlp                      |
| `transcribe_audio.py` | Demucs vocal separation + faster-whisper transcription          |
| `public/index.html`   | Karaoke UI with video player and lyrics overlay                 |
| `public/app.js`       | Client-side logic, word highlighting, queue management          |
| `videos/`             | Downloaded MP4s and transcription JSON files                    |

## Transcription Pipeline Flow

1. **User adds YouTube URL** → extracts video ID
2. **Server queues transcription** (prevents concurrent GPU access)
3. **download_video.py** → downloads video + extracts MP3 audio
4. **transcribe_audio.py**:
   - Loads audio with torchaudio
   - **Demucs htdemucs** separates vocals from drums/bass/other
   - **faster-whisper** transcribes vocals-only audio
   - Outputs JSON with word-level timestamps
5. **Server sends** transcription to clients via Socket.io

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
WHISPER_MODEL=small  # tiny, base, small, medium, turbo, large-v3
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
python transcribe_audio.py input.mp3 small output.json ja
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
| GPU crash (code 3221226505)   | Transcription queue prevents concurrent access     |
| Misheard lyrics               | Demucs vocal separation improves accuracy          |
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
