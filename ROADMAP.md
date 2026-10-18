# Karaoke Party Roadmap

Planned work, roughly in priority order.

## Playback
- [ ] Pitch / key shift and tempo control
- [ ] Vocal guide volume slider (blend separated vocals back in)

## Party features
- [ ] Fair turn rotation between singers
- [ ] Reorder / remove songs from the phone UI
- [ ] Optional scoring based on pitch detection
- [ ] QR code on the TV screen for joining

## Pipeline
- [ ] Per-stage progress bars and retry for failed songs
- [ ] Support local audio/video files, not just URLs
- [ ] Use existing synced lyrics (LRC) when available, falling back to transcription

## Reliability
- [ ] Persist rooms and queues across server restarts
- [ ] Tests for room/queue logic in `server.js`
- [ ] One-command setup script for the Python dependencies
