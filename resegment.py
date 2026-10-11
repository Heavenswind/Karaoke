#!/usr/bin/env python3
"""
Re-split transcribed words into karaoke lines using lrclib's synced lyrics.

Whisper decides where a "segment" ends from acoustic pauses, which on sung
audio produces lines that are sometimes a whole verse long and sometimes two
words. An LRC file already knows where the lines are, because a human decided.

So we borrow only the *boundaries*. Every word keeps the timestamp Whisper gave
it -- that timing is locked to this particular video, while the LRC's is locked
to whatever release it was made for and is routinely offset by an intro. Nothing
here can move a word, drop a word, or change a word; the worst a badly-aligned
LRC can do is put a line break in an odd place.

Bails out entirely (returning None) whenever the two sources don't look like the
same performance.
"""

import os
import re

# Beyond this the LRC belongs to a different cut of the song (radio edit, live
# version, a video with a long intro) and its line starts mean nothing here.
MAX_OFFSET = 12.0
# A word this close to a boundary is treated as starting the next line -- LRC
# timestamps are usually placed a beat early, on the breath rather than the note.
BOUNDARY_TOLERANCE = 0.30
MIN_LINES = 4
# If the boundaries only carve out a handful of lines the LRC probably didn't
# match the vocal at all; keep Whisper's own segmentation instead.
MIN_KEEP_RATIO = 0.5
# The LRC has to cover the singing, not just start in the right place. Uploads
# routinely run longer than the release lrclib synced (extended intros, an
# outro, a whole second play-through), and every word past the final boundary
# piles into the last bucket: measured 127 words in one 143-second "line" on a
# 5:41 upload of a 3:29 song. Whisper's own segmentation beats that by miles.
# A ratio alone would punish short songs, where the closing line's own words
# are a big share of a small total -- hence the absolute floor.
MAX_TAIL_RATIO = 0.25
MAX_TAIL_S = 20.0

_CJK = re.compile(r"[぀-ヿ一-鿿가-힣]")


def _join(words, language):
    """CJK scripts don't put spaces between words; everything else does."""
    texts = [w.get("word", "") for w in words]
    if (language or "") in ("ja", "zh", "yue", "ko") or _CJK.search("".join(texts)):
        return "".join(texts)
    return " ".join(t for t in texts if t)


def apply_lrc_lines(segments, synced_text, language=None):
    """Return a new segment list split on the LRC's line starts, or None.

    None means "not confident" and the caller should keep `segments` as-is.
    """
    if os.environ.get("KARAOKE_LRC_LINES") == "0" or not synced_text:
        return None

    try:
        from lyrics_correct import parse_lrc
        lines = parse_lrc(synced_text)
    except Exception:
        return None

    words = [w for seg in segments for w in (seg.get("words") or [])]
    if len(lines) < MIN_LINES or len(words) < MIN_LINES:
        return None

    starts = sorted({round(l["start"], 2) for l in lines if l.get("text")})
    if len(starts) < MIN_LINES:
        return None

    first_word = words[0]["start"]
    last_word = words[-1]["end"]

    # Same performance? The first sung word and the first lyric line should land
    # near each other, and the lyrics shouldn't run past the end of the audio.
    if abs(starts[0] - first_word) > MAX_OFFSET:
        return None
    if starts[-1] > last_word + MAX_OFFSET:
        return None
    # ...and it has to reach the end of the singing, not stop a third of the way.
    sung_span = last_word - first_word
    if last_word - starts[-1] > max(MAX_TAIL_S, sung_span * MAX_TAIL_RATIO):
        return None

    buckets = [[] for _ in starts]
    idx = 0
    for w in words:
        t = w.get("start", 0)
        # advance to the last boundary this word is at or past
        while idx + 1 < len(starts) and t >= starts[idx + 1] - BOUNDARY_TOLERANCE:
            idx += 1
        buckets[idx].append(w)      # anything before the first boundary opens line 0

    out = []
    for bucket in buckets:
        if not bucket:
            continue
        text = _join(bucket, language)
        if not text.strip():
            continue
        out.append({
            "start": bucket[0]["start"],
            "end": bucket[-1]["end"],
            "text": text.strip(),
            "words": bucket,
        })

    if len(out) < MIN_LINES or len(out) < len(starts) * MIN_KEEP_RATIO:
        return None
    # A split that just reproduces one giant line has bought nothing.
    if len(out) < 2:
        return None

    return out
