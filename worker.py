#!/usr/bin/env python3
"""
Persistent GPU worker: vocal separation + transcription, models kept resident.

The old pipeline spawned two fresh Python processes per song. Each one paid
~2.5s importing torch/faster-whisper and another 0.8-4s loading the Whisper
weights -- every single song, and all of it inside the GPU lock. On a 4-minute
song that was roughly a third of the wall clock spent doing nothing.

This process stays alive instead. Whisper (~3.9GB for large-v3) and htdemucs
(~160MB) sit in VRAM and a song costs only its actual compute.

Two things make co-residency safe on a 12GB card:

  * The mix stays on the CPU. demucs' apply_model allocates its full-length
    output buffer on `mix.device` (apply.py: `th.zeros(..., device=mix.device)`)
    and only ships each chunk to the GPU, so a CPU mix pins GPU use at ~615MB
    no matter how long the song is. Handing it a CUDA tensor -- which is what
    the old code did -- made that buffer grow with the song instead: measured
    6.2GB on a 32-minute video, which would not fit alongside large-v3.
  * The worker exits after WORKER_IDLE_MS of inactivity, so the VRAM comes back
    when nobody is singing.

Protocol -- one JSON object per line, both directions.

  stdin   {"id": "1", "cmd": "transcribe", "audio": "<path.wav>",
           "language": "ja"|null, "official": "<official lyrics>"|null}
          {"id": "2", "cmd": "ping"}
          {"cmd": "shutdown"}

  stdout  {"event": "ready", "model": "large-v3", "device": "cuda"}
          {"id": "1", "event": "status", "status": "separating"|"transcribing"|"correcting"}
          {"id": "1", "event": "result", "segments": [...], "language": "...", "text": "..."}
          {"id": "1", "event": "error", "error": "..."}

Requests are handled strictly one at a time; that serialization IS the GPU lock.
"""

import os
import sys
import json
import gc
import time
import threading
import traceback

# The protocol owns stdout. Anything a library decides to print would corrupt it,
# so grab the real handle and point sys.stdout at stderr before importing torch.
_OUT = sys.stdout
try:
    _OUT.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
sys.stdout = sys.stderr

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3")
IDLE_MS = int(os.environ.get("WORKER_IDLE_MS", "600000"))
USE_HOTWORDS = os.environ.get("KARAOKE_HOTWORDS", "1") != "0"
# demucs' own default is 0.25; 0.10 is ~15-25% faster and the difference is
# inaudible once the stem is only being fed to a speech model.
DEMUCS_OVERLAP = float(os.environ.get("DEMUCS_OVERLAP", "0.10"))
# Whisper fills instrumental stretches with filler it has heard in training --
# "ご視聴ありがとうございました", "Let's listen to the song" -- and stamps it across
# the whole gap, producing 14-16 second "lines". Measured across four songs
# (es/en/ja/ja) this guard removed every such line and pulled the longest line
# from 14-16.6s down to 6-7.9s. It is deliberately preferred over vad_filter,
# which fixed two of those songs and dropped half the words on the third.
# Set to 0 to turn off.
HALLUCINATION_SILENCE = float(os.environ.get("KARAOKE_HALLUCINATION_THRESHOLD", "2.0"))
# Language is detected on the most energetic 30s of the vocal stem rather than
# on whatever the song happens to open with. faster-whisper's own detection
# reads the first window and stops as soon as one clears
# language_detection_threshold -- and after Demucs an instrumental intro is a
# vocals-only stem of near silence, which it labels confidently and wrongly.
# Linkin Park's "Crawling" came back as "la" (Latin) that way, and the bad
# language code then turned the whole decode into looping nonsense. Raising
# language_detection_segments does not help: the early break means the later
# windows are never examined. Set to 0 to fall back to faster-whisper's own.
LANG_DETECT_WINDOW_S = int(os.environ.get("KARAOKE_LANG_DETECT_WINDOW", "30"))

WHISPER_SR = 16000

INITIAL_PROMPTS = {
    "ja": "歌詞を正確に書き起こしてください。",
    "ko": "가사를 정확하게 받아쓰세요.",
    "zh": "请准确转录歌词。",
    "en": "Transcribe the song lyrics accurately.",
}


def emit(obj):
    _OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _OUT.flush()


def log(msg):
    # No prefix: pipeline.js tags every stderr line it reads from this process.
    print(msg, file=sys.stderr, flush=True)


# ─── Models ──────────────────────────────────────────────────────────────────

class Models:
    """Loaded once, reused for every song."""

    def __init__(self):
        import torch
        from demucs.pretrained import get_model
        from faster_whisper import WhisperModel

        self.torch = torch

        # TF32 + cudnn autotuning are free throughput on Ada for demucs' convs.
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        compute_type = "float16" if self.device == "cuda" else "int8"

        t0 = time.perf_counter()
        self.demucs = get_model("htdemucs").to(self.device)
        self.demucs.eval()
        log(f"htdemucs loaded in {time.perf_counter() - t0:.1f}s")

        t0 = time.perf_counter()
        self.whisper = WhisperModel(MODEL_NAME, device=self.device, compute_type=compute_type)
        log(f"whisper {MODEL_NAME} ({compute_type}) loaded in {time.perf_counter() - t0:.1f}s")

    # ── vocal separation ──────────────────────────────────────────────────────

    def separate_vocals(self, audio_path):
        """Return the vocal stem as a float32 CPU tensor [channels, samples] plus its rate.

        `mix` deliberately stays on the CPU -- see the module docstring.
        """
        import torch
        import torchaudio
        from demucs.apply import apply_model
        from audio_io import load_audio

        wav, sr = load_audio(audio_path)
        if sr != self.demucs.samplerate:
            wav = torchaudio.functional.resample(wav, sr, self.demucs.samplerate)
            sr = self.demucs.samplerate

        if wav.shape[0] == 1:
            wav = wav.repeat(2, 1)
        elif wav.shape[0] > 2:
            wav = wav[:2]

        amp = (torch.autocast("cuda", dtype=torch.float16)
               if self.device == "cuda" else _null_ctx())
        with torch.no_grad(), amp:
            sources = apply_model(
                self.demucs, wav.unsqueeze(0), device=self.device,
                shifts=0,                      # deterministic; the random shift buys nothing here
                overlap=DEMUCS_OVERLAP,
            )

        vocals = sources[0, 3].float()         # htdemucs order: drums, bass, other, vocals
        del sources
        return vocals, sr

    def to_whisper_audio(self, vocals, sr):
        """16 kHz mono float32 ndarray -- what faster-whisper wants natively, so
        nothing round-trips through a temp wav on disk."""
        import torchaudio
        mono = vocals.mean(0, keepdim=True)
        if sr != WHISPER_SR:
            mono = torchaudio.functional.resample(mono, sr, WHISPER_SR)
        return mono.squeeze(0).contiguous().numpy()

    # ── language ──────────────────────────────────────────────────────────────

    def detect_language(self, audio):
        """Detect the language from the most-sung stretch of the stem.

        Returns (language, probability), or (None, 0.0) to let faster-whisper
        decide for itself. Picking the window by energy costs one extra encoder
        pass and is the difference between hearing the chorus and hearing the
        silence where the intro's vocals aren't.
        """
        import numpy as np

        win = LANG_DETECT_WINDOW_S * WHISPER_SR
        if LANG_DETECT_WINDOW_S <= 0 or audio.shape[0] <= win:
            return None, 0.0

        # Mean square per second, then the densest LANG_DETECT_WINDOW_S run of
        # them via a prefix sum -- a plain sliding window over a 30-minute song
        # would be the slowest thing in this function.
        hop = WHISPER_SR
        usable = (audio.shape[0] // hop) * hop
        energy = (audio[:usable].reshape(-1, hop).astype(np.float32) ** 2).mean(axis=1)
        if energy.shape[0] <= LANG_DETECT_WINDOW_S:
            return None, 0.0
        cumulative = np.concatenate([[0.0], np.cumsum(energy)])
        sums = cumulative[LANG_DETECT_WINDOW_S:] - cumulative[:-LANG_DETECT_WINDOW_S]
        offset = int(np.argmax(sums)) * hop

        lang, prob, _ = self.whisper.detect_language(audio=audio[offset:offset + win])
        log(f"language {lang} (p={prob:.2f}) from {offset // WHISPER_SR}s")
        return lang, prob

    # ── transcription ─────────────────────────────────────────────────────────

    def transcribe(self, audio, language, hotwords):
        segments, info = self.whisper.transcribe(
            audio,
            word_timestamps=True,
            language=language,
            task="transcribe",
            initial_prompt=INITIAL_PROMPTS.get(language) if language else None,
            hotwords=hotwords or None,
            condition_on_previous_text=False,
            vad_filter=False,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.5,
            hallucination_silence_threshold=HALLUCINATION_SILENCE or None,
        )

        out, texts = [], []
        for seg in segments:
            out.append({
                "start": seg.start,
                "end": seg.end,
                "text": seg.text,
                "words": [{"word": w.word, "start": w.start, "end": w.end}
                          for w in (seg.words or [])],
            })
            texts.append(seg.text)

        return {"segments": out, "text": " ".join(texts), "language": info.language}

    def release(self):
        gc.collect()
        if self.device == "cuda":
            self.torch.cuda.empty_cache()


class _null_ctx:
    def __enter__(self): return self
    def __exit__(self, *a): return False


# ─── Hotwords ────────────────────────────────────────────────────────────────

def build_hotwords(official, language):
    """A short bias string from the official lyrics.

    faster-whisper truncates hotwords to half the prompt window on its own, so
    the only job here is to spend those tokens on distinctive words instead of
    whatever happens to open the first verse.
    """
    if not official or not USE_HOTWORDS:
        return None
    text = " ".join(official.split())
    if not text:
        return None

    if (language or "") in ("ja", "zh", "yue", "ko"):
        return text[:120] or None       # no word boundaries to dedupe on

    seen, picked, size = set(), [], 0
    for raw in text.split(" "):
        w = raw.strip(".,!?;:\"'()[]-–—")
        if len(w) < 4:
            continue
        k = w.lower()
        if k in seen:
            continue
        seen.add(k)
        picked.append(w)
        size += len(w) + 1
        if size > 200:
            break
    return " ".join(picked) or None


# ─── Request handling ────────────────────────────────────────────────────────

def handle_transcribe(models, req):
    rid = req.get("id")
    audio_path = req.get("audio")
    language = req.get("language") or None
    official = req.get("official") or None

    if not audio_path or not os.path.exists(audio_path):
        raise FileNotFoundError(f"audio not found: {audio_path}")

    emit({"id": rid, "event": "status", "status": "separating"})
    t0 = time.perf_counter()
    vocals, sr = models.separate_vocals(audio_path)
    log(f"separated in {time.perf_counter() - t0:.1f}s")

    audio = models.to_whisper_audio(vocals, sr)
    del vocals
    models.release()

    # A caller-supplied hint always wins; this only fills in the blank.
    if not language:
        try:
            detected, _ = models.detect_language(audio)
            language = detected or None
        except Exception as e:
            log(f"language detection failed, letting whisper choose: {e}")

    emit({"id": rid, "event": "status", "status": "transcribing"})
    t0 = time.perf_counter()
    result = models.transcribe(audio, language, build_hotwords(official, language))
    log(f"transcribed in {time.perf_counter() - t0:.1f}s "
        f"({len(result['segments'])} segments)")
    del audio
    models.release()

    # Proofreading is pure CPU *only* if we already have the lyrics. The caller
    # fetches them off the GPU path and passes them in; when it came back empty
    # there is nothing to proofread against, and we must not let
    # correct_with_official_lyrics fall back to its own lrclib call -- that would
    # drag a 7-15s network wait (or a full timeout, when lrclib is down) right
    # back inside the GPU lock this whole design exists to keep free.
    lang = result.get("language")
    if official:
        emit({"id": rid, "event": "status", "status": "correcting"})
        try:
            from lyrics_correct import correct_with_official_lyrics
            stats = correct_with_official_lyrics(
                result, youtube_title=req.get("title"), artist=req.get("artist"),
                track=req.get("track"), duration=req.get("duration"),
                language=lang, official=official)
            log(f"lyrics correction: {stats or 'no confident match'}")
        except Exception as e:
            log(f"lyrics correction skipped: {e}")
    else:
        log("lyrics correction: no official lyrics available, skipped")

    segments = format_segments(result)

    # Whisper breaks lines on pauses, which on sung audio gives verse-length
    # lines next to two-word ones. When lrclib has a synced copy, borrow its
    # line boundaries (timings stay Whisper's -- see resegment.py).
    if req.get("synced"):
        try:
            from resegment import apply_lrc_lines
            relined = apply_lrc_lines(segments, req["synced"], lang)
            if relined:
                log(f"lrc lines: {len(segments)} whisper segments -> {len(relined)} lines")
                segments = relined
            else:
                log("lrc lines: not a confident match, keeping whisper segmentation")
        except Exception as e:
            log(f"lrc lines skipped: {e}")

    if lang == "ja":
        try:
            from furigana import add_furigana
            log(f"furigana: annotated {add_furigana(segments)} tokens")
        except Exception as e:
            log(f"furigana skipped: {e}")

    return {
        "id": rid, "event": "result",
        "segments": segments,
        "text": result.get("text", "").strip(),
        "language": lang or "unknown",
        "model": MODEL_NAME,
    }


def format_segments(result):
    """Round timings for the wire; the client only needs 10ms resolution."""
    out = []
    for seg in result.get("segments", []):
        words = []
        for w in seg.get("words", []):
            word = {"word": (w.get("word") or "").strip(),
                    "start": round(w.get("start", 0), 2),
                    "end": round(w.get("end", 0), 2)}
            # furigana runs later and adds these; preserve anything already set
            for extra in ("reading", "ruby"):
                if extra in w:
                    word[extra] = w[extra]
            words.append(word)
        out.append({
            "start": round(seg["start"], 2),
            "end": round(seg["end"], 2),
            "text": seg["text"].strip(),
            "words": words,
        })
    return out


def main():
    models = Models()
    emit({"event": "ready", "model": MODEL_NAME, "device": models.device})

    # A karaoke party is bursty. Holding ~4.5GB of VRAM forever would be rude to
    # anything else on this GPU, so the worker retires itself when the room goes
    # quiet; the server respawns it on the next song.
    last_activity = [time.monotonic()]
    stop = threading.Event()

    def idle_reaper():
        while not stop.wait(5.0):
            if IDLE_MS > 0 and (time.monotonic() - last_activity[0]) * 1000 > IDLE_MS:
                log("idle timeout - exiting to free VRAM")
                os._exit(0)

    threading.Thread(target=idle_reaper, daemon=True).start()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        last_activity[0] = time.monotonic()

        try:
            req = json.loads(line)
        except Exception:
            log(f"bad request line: {line[:200]}")
            continue

        cmd = req.get("cmd")
        if cmd == "shutdown":
            break
        if cmd == "ping":
            emit({"id": req.get("id"), "event": "pong"})
            last_activity[0] = time.monotonic()
            continue
        if cmd != "transcribe":
            emit({"id": req.get("id"), "event": "error", "error": f"unknown cmd {cmd!r}"})
            continue

        try:
            emit(handle_transcribe(models, req))
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            emit({"id": req.get("id"), "event": "error", "error": str(e)})
        finally:
            models.release()
            last_activity[0] = time.monotonic()

    stop.set()


if __name__ == "__main__":
    main()
