#!/usr/bin/env python3
"""
Furigana generation for Japanese transcriptions.

Whisper outputs kanji with character-level timestamps but no readings. This
re-tokenizes each line into real words with fugashi (UniDic), attaches the
hiragana reading, and remaps the character-level timing onto the new word
tokens. Readings are split so they sit only over kanji (okurigana stays bare),
e.g. 強がる -> [[強, つよ], [がる, None]].

Output per word: {word, start, end, reading, ruby}
  ruby = list of [text, reading_or_None] pairs for <ruby> rendering.

No-op for non-Japanese. Requires: fugashi, unidic-lite.
"""

import re
import sys

_KANJI = re.compile(r"[一-鿿㐀-䶿豈-﫿]")


def _is_kana(c):
    return 0x3040 <= ord(c) <= 0x30FF      # hiragana + katakana (incl. ー)


def _has_kanji(s):
    return bool(_KANJI.search(s))


def _kata_to_hira(s):
    out = []
    for c in s:
        o = ord(c)
        out.append(chr(o - 0x60) if 0x30A1 <= o <= 0x30F6 else c)
    return "".join(out)


def _align(s, r):
    """Align kanji runs in surface `s` to reading `r`; return [[text, rd|None]]."""
    if not s:
        return []
    if not _has_kanji(s):
        return [[s, None]]
    # Leading kana: peel off, consuming the same characters from the reading.
    if _is_kana(s[0]):
        i = 0
        while i < len(s) and _is_kana(s[i]):
            i += 1
        return [[s[:i], None]] + _align(s[i:], r[i:])
    # Kanji run up to the next kana.
    j = 0
    while j < len(s) and not _is_kana(s[j]):
        j += 1
    kanji, rest = s[:j], s[j:]
    if not rest:
        return [[kanji, r]]
    # Find where the following kana run appears in the reading → that's the
    # boundary between this kanji run's reading and the rest.
    k = 0
    while k < len(rest) and _is_kana(rest[k]):
        k += 1
    kana_run = rest[:k]
    idx = r.find(kana_run, 1)
    if idx <= 0:
        return [[kanji, r]]
    return [[kanji, r[:idx]]] + _align(rest, r[idx:])


def _ruby_parts(surface, reading):
    if not reading or not _has_kanji(surface) or reading == surface:
        return [[surface, None]]
    return _align(surface, reading)


def _char_timeline(words):
    """Flatten char-level words into [(char, start, end)] by even split."""
    chars = []
    for w in words:
        txt = w.get("word", "")
        if not txt:
            continue
        n = len(txt)
        dur = max((w["end"] - w["start"]) / n, 0.0)
        for i, c in enumerate(txt):
            chars.append((c, round(w["start"] + i * dur, 3),
                          round(w["start"] + (i + 1) * dur, 3)))
    return chars


def add_furigana(segments):
    """Mutate segments in place, replacing words with reading-annotated tokens.
    Returns the number of tokens that got a kanji reading."""
    try:
        from fugashi import Tagger
    except Exception as e:
        print(f"furigana: fugashi unavailable: {e}", file=sys.stderr)
        return 0

    tagger = Tagger()
    annotated = 0

    for seg in segments:
        words = seg.get("words") or []
        chars = _char_timeline(words)
        line = "".join(c for c, _, _ in chars)
        if not line:
            continue

        new_words, pos, ok = [], 0, True
        for tok in tagger(line):
            surface = tok.surface
            L = len(surface)
            if pos + L > len(chars):
                ok = False
                break
            span = chars[pos:pos + L]
            pos += L

            reading = None
            kana = getattr(tok.feature, "kana", None)
            if kana and kana != "*":
                reading = _kata_to_hira(kana)

            parts = _ruby_parts(surface, reading)
            if any(p[1] for p in parts):
                annotated += 1
            new_words.append({
                "word": surface,
                "start": span[0][1],
                "end": span[-1][2],
                "reading": reading,
                "ruby": parts,
            })

        if ok and new_words:
            seg["words"] = new_words

    return annotated
