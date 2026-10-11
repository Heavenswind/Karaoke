#!/usr/bin/env python3
"""
Robust audio loading for the ML stack.

torchaudio's only backend here (soundfile/libsndfile) can't open mp3, so we fall
back to decoding through ffmpeg into a temp WAV. Used by demucs vocal separation
so it doesn't silently fail on anything but wav.
"""

import os
import shutil
import tempfile
import subprocess

import torchaudio


def _ffmpeg():
    return shutil.which("ffmpeg") or "ffmpeg"


def load_audio(path, target_sr=None, mono=False):
    """
    Return (waveform[channels, samples] float32 tensor, sample_rate).

    Tries torchaudio directly; on any failure (e.g. mp3 with no native backend)
    decodes via ffmpeg to a temp WAV. Optionally downmixes to mono / resamples.
    """
    try:
        wav, sr = torchaudio.load(path)
    except Exception:
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        try:
            cmd = [_ffmpeg(), "-y", "-i", path]
            if target_sr:
                cmd += ["-ar", str(target_sr)]
            if mono:
                cmd += ["-ac", "1"]
            cmd += ["-c:a", "pcm_s16le", tmp.name]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if not os.path.exists(tmp.name) or os.path.getsize(tmp.name) == 0:
                raise RuntimeError(f"ffmpeg decode failed: {proc.stderr[-300:]}")
            wav, sr = torchaudio.load(tmp.name)
        finally:
            if os.path.exists(tmp.name):
                try:
                    os.remove(tmp.name)
                except OSError:
                    pass

    if mono and wav.shape[0] > 1:
        wav = wav.mean(0, keepdim=True)
    if target_sr and sr != target_sr:
        wav = torchaudio.functional.resample(wav, sr, target_sr)
        sr = target_sr
    return wav, sr
