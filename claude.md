# Karaoke Party App

An online karaoke application with real-time song queuing, word-by-word lyrics highlighting, and AI-powered transcription.

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────────┐
│   Browser UI    │◄───►│  Node.js Server  │────►│  download_video.py   │
│  (Socket.io)    │     │  (Express/WS)    │     │  (yt-dlp, N at once) │
└─────────────────┘     │                  │     └──────────────────────┘
                        │   pipeline.js    │     ┌──────────────────────┐
                        │  stages the DAG  │────►│  lyrics_correct.py   │
                        │                  │     │  (lrclib, --fetch)   │
                        └──────────────────┘     └──────────────────────┘
                               │    │
                               │    │  JSON lines over stdio
                               │    ▼
                               │  ┌──────────────────────────────────┐
                               │  │  worker.py  (long-lived, 1 job)  │
                               │  │  htdemucs + faster-whisper in    │
                               │  │  VRAM; exits when idle           │
                               │  └──────────────────────────────────┘
                               ▼
                        ┌─────────────┐
                        │   videos/   │
                        │  (MP4/JSON) │
                        └─────────────┘
```

Two independent resources, deliberately decoupled: **downloads** are network-bound
and run several at a time, the **GPU** takes one job at a time. They used to share
a single `pipelineBusy` flag, which left the GPU idle for most of every song.

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
| `server.js`           | Express server, Socket.io rooms, play loop                      |
| `pipeline.js`         | Song preparation DAG: download semaphore, GPU lock, worker client |
| `worker.py`           | Long-lived GPU process; models stay resident, JSON-lines protocol |
| `download_video.py`   | yt-dlp fetch only (`--audio` / `--video`); imports no ML deps   |
| `lyrics_correct.py`   | lrclib.net lookup (`--fetch`) + proofreads Whisper against official lyrics |
| `resegment.py`        | Re-splits lines on LRC boundaries, keeping Whisper's timings    |
| `furigana.py`         | Adds hiragana readings over kanji for Japanese songs (fugashi)  |
| `audio_io.py`         | torchaudio loading with ffmpeg fallback                         |
| `transcribe_audio.py` | One-shot CLI wrapper around `worker.py`, for testing by hand    |
| `public/index.html`   | Karaoke UI with video player and lyrics overlay                 |
| `public/app.js`       | Client-side logic, word highlighting, queue management          |
| `videos/`             | Cached MP4s + transcription JSONs (LRU-pruned past MAX_CACHE_MB)|

## Transcription Pipeline Flow

1. **User adds a YouTube URL, raw video ID, or free-text search** (resolved via `yt-dlp ytsearch1:`)
2. **`pipeline.js` starts the song's DAG.** Audio and video download concurrently:

   ```
   audio ─┬─────────────► GPU (separate → transcribe → correct) ─┐
          └─► lyrics ────┘                                       ├─► videos/<id>.json
   video ────────────────────────────────────────────────────────┘
   ```

   The GPU stage waits only on the audio (a few MB) and the lrclib lookup — not on
   the full video — so transcription starts while the mp4 is still downloading.
3. **`worker.py`** separates vocals (Demucs) and transcribes (faster-whisper). It is a
   *persistent* process: the models load once, not once per song.
4. **Lyrics**: official lyrics are fetched off the GPU path and passed in, used both to
   bias the decode (`hotwords`) and to proofread word spellings afterwards — never
   replacing Whisper's timing. When lrclib has a synced (LRC) copy, `resegment.py`
   borrows its line boundaries.
   - Japanese: furigana ruby annotations added (`furigana.py`)
5. **Server sends** transcription to clients via Socket.io
6. **Cache**: mp4 + json stay in `videos/` for instant replays; the intermediate wav is
   deleted; oldest songs pruned past `MAX_CACHE_MB`

## GPU Considerations

- **CUDA required** for optimal performance (float16 compute)
- **One GPU job at a time**, enforced by a semaphore in `pipeline.js` — downloads are
  *not* covered by it, since they never touch the GPU
- **Keep the Demucs mix on the CPU.** `apply_model` allocates its full-length output
  buffer on `mix.device`, so handing it a CUDA tensor makes VRAM scale with song
  length (measured 6.2GB on a 32-minute video). A CPU mix pins it at ~615MB for any
  length, at ~8% more wall clock, which is what lets Demucs and large-v3 stay resident
  together on a 12GB card.
- **Worker exits after `WORKER_IDLE_MS`** so the VRAM comes back between parties
- Falls back to CPU (int8) if no CUDA available

## Whisper Models

VRAM measured with `nvidia-smi` (resident, float16):

| Model    | Accuracy on singing | VRAM   |
| -------- | ------------------- | ------ |
| tiny     | Low                 | ~1GB   |
| base     | Low                 | ~1GB   |
| small    | Mishears often      | ~0.7GB |
| medium   | Better              | ~2.5GB |
| turbo    | Hallucinates badly on music | ~2.0GB |
| large-v3 | Best                | ~3.9GB |

Default: `large-v3`. It is not slower in practice — `small` burns its time looping on
hallucinated lyrics, so on a 4070 large-v3 finished a test song in 5.6s vs `small`'s
7.4s while getting the words right. `turbo` is fast but returned `"La Beomachico"` four
times on a test song; don't use it for singing.

## Configuration

### Environment Variables
```bash
WHISPER_MODEL=large-v3   # tiny, base, small, medium, turbo, large-v3
MAX_CACHE_MB=8192        # videos/ cache cap; oldest songs pruned past this
COOKIES_FILE=...         # exported cookies.txt for YouTube bot-check bypass
DOWNLOAD_CONCURRENCY=3   # songs downloading at once (the GPU is always 1)
WORKER_IDLE_MS=600000    # GPU worker exits after this long idle; 0 disables
LYRICS_TIMEOUT_MS=15000  # lrclib lookup deadline (it 504s for hours sometimes)
YTDLP_FRAGMENTS=8        # yt-dlp parallel fragment downloads
DEMUCS_OVERLAP=0.10      # demucs chunk overlap; its own default is 0.25
KARAOKE_HALLUCINATION_THRESHOLD=2.0  # 0 disables the hallucination guard
KARAOKE_HOTWORDS=1       # 0 stops biasing the decode with official lyrics
KARAOKE_LRC_LINES=1      # 0 keeps Whisper's own line segmentation
KARAOKE_LANG_DETECT_WINDOW=30  # seconds of stem used to detect language; 0 = whisper's own
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

# Download only (no ML deps loaded)
python download_video.py VIDEO_ID --audio --out videos
python download_video.py VIDEO_ID --video --out videos

# Test Demucs + Whisper directly (one-shot; loads the models itself)
python transcribe_audio.py input.wav large-v3 output.json ja

# Drive the persistent worker by hand
echo {"id":"1","cmd":"transcribe","audio":"x.wav","language":"ja"} | python -u worker.py

# What did lrclib return for this song?
python lyrics_correct.py --fetch --title "artist - track" --duration 213

# Run one song through the whole DAG (download -> lyrics -> GPU -> json)
node testpipe.js VIDEO_ID [languageHint]
```

## Dependencies

### Node.js
```bash
npm install express socket.io
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
| GPU crash (code 3221226505)   | The GPU semaphore in `pipeline.js` prevents concurrent access |
| Misheard lyrics               | Demucs + `large-v3`; lrclib biases the decode (`hotwords`) and proofreads afterwards |
| "ご視聴ありがとうございました" / "Let's listen to the song" over an instrumental | Whisper filler. `hallucination_silence_threshold=2.0` removed it on every song tested, and cut the longest line from 14-16.6s to 6-7.9s |
| Whisper OOM on long videos    | Keep the Demucs mix on the CPU — see GPU Considerations |
| Geo-blocked videos            | yt-dlp with `--geo-bypass --geo-bypass-country US` |
| Non-ASCII child output crashes a subprocess read | Windows text mode defaults to cp1252; always pass `encoding="utf-8", errors="replace"` (see `run()` in `download_video.py`) |
| VAD filtering removes singing | Still true, even on a vocals-only stem: `vad_filter=True` fixed two test songs but dropped half the words on a third. Left off; the hallucination guard covers the same ground more safely |
| lrclib.net returns 504 for hours | `pipeline.js` trips a circuit breaker after 3 timeouts and skips lookups for 10 min |
| Official lyrics "never found" on ordinary uploads | yt-dlp only sets `artist`/`creator` for official-artist and YouTube Music uploads. `info_to_meta` used to fall back to `uploader` — the person who posted the video — and that outranked the artist parsed from the title, so "Crawling - Linkin Park" searched lrclib for *François*. Real tags only now, plus a duration-gated track-only attempt as a third try |
| Whisper reports an absurd language (`la` on an English song) | It detects on the first 30s and stops at the first window over `language_detection_threshold`. After Demucs that window is a vocals-only stem of the instrumental intro — near silence, confidently mislabelled — and the wrong language code turns the whole decode into looping fragments. `worker.py` detects on the most energetic 30s of the stem instead |
| One 140-second karaoke line | The upload is longer than the release lrclib synced (extended intro, outro, a second play-through), so every word past the final LRC boundary lands in the last bucket. `resegment.py` now declines when the singing runs more than `MAX_TAIL_RATIO` past the LRC's end |
| A bad transcription keeps coming back after a fix | `videos/<id>.json` is reused whenever it has any segments at all, so old garbage never re-transcribes. Delete the json (keep the mp4) to redo just the GPU pass |

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
