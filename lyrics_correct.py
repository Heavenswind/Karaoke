#!/usr/bin/env python3
"""
Proofread Whisper transcriptions against official lyrics from lrclib.net.

Keeps Whisper's word-level timestamps (which are synced to the actual video)
and only swaps in the official spelling where the two confidently agree on a
word. Conservative by design: it corrects obvious mishearings, never fabricates
words or timing, and bails out entirely when it can't get a trustworthy match.

No external dependencies (stdlib urllib + difflib).
"""

import re
import sys
import json
import difflib
import functools
import unicodedata
import concurrent.futures
from urllib.parse import urlencode
from urllib.request import urlopen, Request

LRCLIB_API = "https://lrclib.net/api"
USER_AGENT = "KaraokeParty/1.0 (+https://github.com/Heavenswind/Karaoke)"

# Word-level correction only makes sense for space-delimited scripts.
CORRECTABLE_LANGS = {"es", "en", "pt", "it", "fr", "de", "ca", "gl", "nl"}
# CJK has no clean word boundaries — those languages are corrected per character
# instead (katakana/hiragana-insensitive), with timing interpolated inside each
# Whisper token.
CJK_CORRECTABLE_LANGS = {"ja", "zh", "yue", "ko"}

# Max size of a mismatched island we're willing to "fix". Bigger divergences are
# almost always structural (skipped verse, reordered chorus) — trust Whisper there.
MAX_ISLAND = 4
# Same idea in characters for the CJK path (a CJK word is ~2-3 chars).
MAX_ISLAND_CHARS = 10
# Equal runs shorter than this are chance matches on common kana/particles
# inside divergent text, not real anchors.
MIN_CHAR_ANCHOR = 3
# Minimum fraction of Whisper's chars that must sit in confident anchor runs
# (length >= MIN_CHAR_ANCHOR) in the official text. Below this the lyrics are
# the wrong song (or a romanization) — don't touch anything. Measured against
# Whisper's side only, so official text with extra verses doesn't penalize.
MIN_CJK_COVERAGE = 0.5
# A search hit whose duration is more than this many seconds off is a wrong match.
DURATION_TOLERANCE = 8

_BRACKETS_RE = re.compile(r"[\(\[\{].*?[\)\]\}]")
_JUNK_RE = re.compile(
    r"(?i)\b(official\s*(music\s*)?video|video\s*oficial|lyric[s]?\s*video|"
    r"audio\s*oficial|official\s*audio|visuali[sz]er|mv|hd|4k|remaster(ed)?|"
    r"live|en\s*vivo)\b"
)
_PUNCT_RE = re.compile(r"[^\w]", re.UNICODE)
_CJK_RE = re.compile(r"[぀-ヿ一-鿿가-힣]")  # kana, CJK ideographs, hangul
# [mm:ss], [mm:ss.cc], [mm:ss.ccc] — anything else in brackets is a metadata tag.
_LRC_TS_RE = re.compile(r"\[(\d+):(\d{1,2}(?:[.:]\d{1,3})?)\]")


# ─── HTTP / lrclib ────────────────────────────────────────────────────────────

def _http_json(url):
    req = Request(url, headers={"User-Agent": USER_AGENT})
    # Measured: lrclib.net routinely takes 7-10s to respond either way (hit or
    # a clean 404) - it's not hanging, just slow. A tight timeout here doesn't
    # save time, it truncates legitimate answers into false "not found"s. The
    # actual win is running requests concurrently (see fetch_official_lyrics)
    # so we pay this latency once instead of up to 4 times sequentially.
    with urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def _clean_track(track):
    """Drop 'feat.'/'ft.' tails and trailing separators from a track name."""
    if not track:
        return None
    track = re.split(r"(?i)\s[\(\[]?\b(?:feat|ft|featuring|con)\b\.?\s", track)[0]
    return track.strip(" -—|·").strip() or None


def parse_artist_track(youtube_title):
    """Best-effort split of a noisy YouTube title into (artist, track)."""
    if not youtube_title:
        return None, None
    t = _BRACKETS_RE.sub("", youtube_title)
    t = _JUNK_RE.sub("", t)
    t = re.sub(r"【.*?】", " ", t)  # 【MV】,【歌ってみた】 etc. are junk tags
    if _CJK_RE.search(t):
        # ARTIST「TRACK」/ ARTIST『TRACK』 — the brackets wrap the track name.
        m = re.search(r"[「『]([^」』]+)[」』]", t)
        if m:
            artist = t[:m.start()].strip(" 　-—|·/／") or None
            return artist, _clean_track(m.group(1))
        # "TRACK ／ ARTIST" (utaite/vocaloid convention — note the order).
        if " - " not in t:
            for sep in ("／", "/"):
                if sep in t:
                    left, right = t.split(sep, 1)
                    right = re.sub(r"\s{2,}", " ", right).strip(" 　-—|·")
                    return (right or None), _clean_track(left)
    # Titles often append "| Album", "| Topic", "- Artist" etc. after the song.
    t = t.split("|")[0]
    t = re.sub(r"\s{2,}", " ", t).strip(" -—|·")
    if " - " in t:
        artist, track = t.split(" - ", 1)
        return artist.strip() or None, _clean_track(track)
    return None, _clean_track(t)


def _usable_record(rec):
    """An lrclib record we can proofread against: has text, isn't instrumental."""
    return bool(isinstance(rec, dict) and rec.get("plainLyrics")
                and not rec.get("instrumental"))


def fetch_official_bundle(track, artist, duration):
    """Return {"plain": text|None, "synced": lrc|None} for the best lrclib match.

    Internally parallel: get + search, and the original/swapped artist-track
    order retry, all fire concurrently instead of up to 4 requests in a row —
    lrclib.net was observed to take 7-10s per request even on a clean miss, so
    doing them one at a time was the main source of latency here. Cached so a
    repeat call with the same (track, artist, duration) is free.

    "synced" is the LRC timeline lrclib ships alongside the plain text; plenty
    of records don't have one, so it's None more often than "plain" is.

    Handing back a copy: the cache used to hold an immutable string, and a dict
    returned by identity would let one caller's edit poison every later lookup.
    """
    return dict(_official_bundle_cached(track, artist, duration))


@functools.lru_cache(maxsize=64)
def _official_bundle_cached(track, artist, duration):
    attempts = [(track, artist)]
    if track and artist:
        attempts.append((artist, track))  # "TRACK ／ ARTIST" titles can parse swapped
        # Last resort: the title gave us two names but we may have guessed the
        # wrong one for the artist (or it isn't an artist at all). Searching on
        # the track alone is safe because try_search still requires the record's
        # duration to land within DURATION_TOLERANCE of this video's.
        attempts.append((track, None))

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(attempts)) as ex:
            results = [f.result() for f in [ex.submit(_fetch_official_once, t, a, duration)
                                             for t, a in attempts]]
    except Exception:
        return {"plain": None, "synced": None}

    for r in results:
        if r:
            # Report the names on the record we actually matched, not the guess
            # that happened to find it -- the guess is routinely reversed, and
            # echoing it back made the logs claim things like "Crawling" was the
            # artist. It is also the better label to hand downstream.
            return {"plain": r.get("plainLyrics"),
                    "synced": r.get("syncedLyrics") or None,
                    "artist": r.get("artistName") or None,
                    "track": r.get("trackName") or None}
    return {"plain": None, "synced": None, "artist": None, "track": None}


def fetch_official_lyrics(track, artist, duration):
    """Return plain official lyrics text, or None if no confident match.

    Thin view over fetch_official_bundle, which carries the cache — no second
    lru_cache here so both entry points share one set of network results.
    """
    return fetch_official_bundle(track, artist, duration)["plain"]


def _fetch_official_once(track, artist, duration):
    """Best matching lrclib record (the full dict), or None."""
    def try_get():
        # Precise lookup when we have everything — but the exact-match
        # endpoint appears to hang rather than fail fast on a near-miss, so
        # it must never block the (usually faster) search fallback below.
        if not (track and artist and duration):
            return None
        try:
            params = {"track_name": track, "artist_name": artist,
                      "duration": int(round(duration))}
            data = _http_json(f"{LRCLIB_API}/get?" + urlencode(params))
            return data if _usable_record(data) else None
        except Exception:
            return None

    def try_search():
        # Search, then require a close duration match to avoid the wrong song.
        try:
            q = {}
            if track:
                q["track_name"] = track
            if artist:
                q["artist_name"] = artist
            if not q:
                return None
            results = _http_json(f"{LRCLIB_API}/search?" + urlencode(q))
            cand = [r for r in results if _usable_record(r)] if isinstance(results, list) else []
            if not cand:
                return None
            if duration:
                # Secondary key only breaks ties on duration distance: between
                # two equally close records, take the one that also has an LRC.
                cand.sort(key=lambda r: (abs((r.get("duration") or 0) - duration),
                                         not r.get("syncedLyrics")))
                if abs((cand[0].get("duration") or 0) - duration) <= DURATION_TOLERANCE:
                    return cand[0]
                return None
            # No duration to rank on, so every hit is equally plausible — then
            # an LRC is the tiebreaker worth having, since it's what drives the
            # karaoke line splitting.
            cand.sort(key=lambda r: not r.get("syncedLyrics"))
            return cand[0]
        except Exception:
            return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        fg = ex.submit(try_get)
        fs = ex.submit(try_search)
        get_result, search_result = fg.result(), fs.result()
    return get_result or search_result


def parse_lrc(synced_text):
    """Parse LRC text into [{"start": seconds, "text": line}], sorted by start.

    Metadata tags ([ar:...], [offset:...] …) aren't timestamps, so they're
    skipped; a line can carry several timestamps when the same words repeat
    (chorus), and each one becomes its own entry. Never raises — bad or missing
    input just yields [].
    """
    if not synced_text or not isinstance(synced_text, str):
        return []
    out = []
    try:
        for line in synced_text.splitlines():
            line = line.strip()
            pos, stamps = 0, []
            for m in _LRC_TS_RE.finditer(line):
                # only the run of leading timestamps counts, but writers space
                # them out as often as they pack them: "[00:15.00] [00:20.50] x"
                if line[pos:m.start()].strip():
                    break
                stamps.append(m)
                pos = m.end()
            if not stamps:
                continue
            text = line[pos:].strip()
            if not text:
                continue
            for m in stamps:
                # some writers use [mm:ss:cc] instead of [mm:ss.cc]
                secs = int(m.group(1)) * 60 + float(m.group(2).replace(":", "."))
                out.append({"start": round(secs, 2), "text": text})
    except Exception:
        return []
    out.sort(key=lambda e: e["start"])
    return out


# ─── Normalization / tokenizing ───────────────────────────────────────────────

def _norm(token):
    """Lowercase, strip accents and punctuation — for matching only."""
    t = unicodedata.normalize("NFKD", token)
    t = "".join(c for c in t if not unicodedata.combining(c))
    return _PUNCT_RE.sub("", t.lower())


def _tokenize_official(text):
    words = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        words.extend(line.split())
    return words


def _kata_to_hira(s):
    return "".join(chr(ord(c) - 0x60) if 0x30A1 <= ord(c) <= 0x30F6 else c
                   for c in s)


def _norm_char(c):
    """Char normalized for matching (kana-case/width-insensitive), '' if punct."""
    n = unicodedata.normalize("NFKC", c)
    if len(n) != 1 or not n.isalnum():
        return ""
    return _kata_to_hira(n).lower()


def _ascii_joinable(c):
    """Printable ASCII — chars that form space-delimited words, not CJK."""
    return 32 < ord(c) < 127


# ─── Correction ───────────────────────────────────────────────────────────────

def _correct_cjk_chars(result, official_text):
    """
    Character-level analogue of the word path for CJK. Flattens Whisper words
    into a per-character timeline (evenly interpolated inside each token), diffs
    it against the official lyrics' characters, and swaps misheard characters
    for the official ones while keeping audio-derived timing. Punctuation is
    carried along except inside replaced islands. Returns stats or None.
    """
    segments = result.get("segments", [])
    flat = []  # (seg_idx, char, start, end, space_before)
    for si, seg in enumerate(segments):
        sp = False
        for w in seg.get("words", []):
            txt = w.get("word", "")
            if not txt:
                continue
            start, end = w.get("start", 0.0), w.get("end", 0.0)
            dur = max((end - start) / len(txt), 0.0)
            for i, c in enumerate(txt):
                if c.isspace():
                    sp = True
                    continue
                flat.append((si, c, start + i * dur, start + (i + 1) * dur, sp))
                sp = False
    if not flat:
        return None

    off_disp, off_norm, off_sp = [], [], []
    sp = False
    for c in official_text:
        if c.isspace():
            sp = True
            continue
        n = _norm_char(c)
        if n:
            off_disp.append(c)
            off_norm.append(n)
            off_sp.append(sp)
            sp = False

    match_idx = [k for k, e in enumerate(flat) if _norm_char(e[1])]
    wh_norm = [_norm_char(flat[k][1]) for k in match_idx]
    if not wh_norm or not off_norm:
        return None

    sm = difflib.SequenceMatcher(a=wh_norm, b=off_norm, autojunk=False)
    anchored = sum(b.size for b in sm.get_matching_blocks()
                   if b.size >= MIN_CHAR_ANCHOR)
    coverage = anchored / len(wh_norm)
    if coverage < MIN_CJK_COVERAGE:
        return None

    # Demote short equal runs (chance matches on common kana inside divergent
    # text) to replaces and coalesce them with their neighbors, so the
    # island-size limit sees the true extent of a divergence.
    ops = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal" and (i2 - i1) < MIN_CHAR_ANCHOR:
            tag = "replace"
        if ops and tag != "equal" and ops[-1][0] != "equal":
            _, pi1, _, pj1, _ = ops[-1]
            ops[-1] = ("replace", pi1, i2, pj1, j2)
        else:
            ops.append((tag, i1, i2, j1, j2))

    # Plan one action per matchable Whisper char, then walk the full stream.
    actions = [("keep",)] * len(wh_norm)
    for tag, i1, i2, j1, j2 in ops:
        if tag == "equal":
            # Normalized match — display the official character (restores
            # katakana/hiragana and width lost in normalization).
            for k in range(i2 - i1):
                actions[i1 + k] = ("swap", off_disp[j1 + k])
        elif tag == "replace":
            if i2 == i1 or j2 == j1:
                continue  # degenerate after coalescing — keep Whisper's chars
            if (i2 - i1) > MAX_ISLAND_CHARS or (j2 - j1) > MAX_ISLAND_CHARS:
                continue  # too divergent — trust Whisper's audio-derived chars
            actions[i1] = ("island", i2 - 1,
                           list(zip(off_disp[j1:j2], off_sp[j1:j2])))
            for k in range(i1 + 1, i2):
                actions[k] = ("drop",)
        # delete → keep Whisper's extra chars; insert → no timing, skip.

    rebuilt = {si: [] for si in range(len(segments))}
    changed = 0
    m = 0
    island_end = -1  # flat index of the last char of the active island
    for k, (si, ch, s, e, csp) in enumerate(flat):
        if not _norm_char(ch):
            if k > island_end:  # punctuation inside a replaced island is junk
                rebuilt[si].append({"word": ch, "start": round(s, 2),
                                    "end": round(e, 2), "sp": csp})
            continue
        act = actions[m]
        m += 1
        if act[0] in ("keep", "swap"):
            disp = ch if act[0] == "keep" else act[1]
            if disp != ch:
                changed += 1
            rebuilt[si].append({"word": disp, "start": round(s, 2),
                                "end": round(e, 2), "sp": csp})
        elif act[0] == "island":
            island_end = match_idx[act[1]]
            chosen = act[2]
            t0, t1 = s, flat[island_end][3]
            total = max(t1 - t0, 0.01)
            t = t0
            for c2, c2sp in chosen:
                ce = t + total / len(chosen)
                # Segment of the original char this time slot overlaps.
                seg_for, mid = si, (t + ce) / 2
                for kk in range(k, island_end + 1):
                    if flat[kk][2] <= mid <= flat[kk][3]:
                        seg_for = flat[kk][0]
                        break
                rebuilt[seg_for].append({"word": c2, "start": round(t, 2),
                                         "end": round(ce, 2), "sp": c2sp})
                t = ce
            changed += len(chosen)
        # "drop": consumed by the island that replaced it

    if changed == 0:
        return None

    for si, seg in enumerate(segments):
        # Re-merge Latin runs into whole words (the frontend renders each word
        # token as a separate span, which is right for CJK chars but would
        # letter-space embedded English).
        words = []
        for w in rebuilt.get(si, []):
            if (words and not w["sp"] and _ascii_joinable(words[-1]["word"][-1])
                    and _ascii_joinable(w["word"][0])):
                words[-1]["word"] += w["word"]
                words[-1]["end"] = w["end"]
            else:
                words.append(w)
        parts = []
        for i, w in enumerate(words):
            if w.pop("sp", False) and i:
                parts.append(" ")
            parts.append(w["word"])
        seg["words"] = words
        if words:
            seg["text"] = "".join(parts)
    result["text"] = " ".join(s["text"].strip() for s in segments if s.get("text"))

    return {"mode": "char", "chars_total": len(flat), "chars_changed": changed,
            "coverage": round(coverage, 2)}


def correct_with_official_lyrics(result, youtube_title=None, artist=None,
                                 track=None, duration=None, language=None,
                                 official=None):
    """
    Mutate `result` (a transcription dict with segments[].words[]) in place,
    swapping misheard words for the official spelling while keeping timestamps.
    Returns a small stats dict, or None if nothing was corrected.

    Pass `official` when the lyrics were already fetched elsewhere — that keeps
    the lrclib round-trip off this (GPU-bound) path entirely.
    """
    lang = (language or "").lower()
    cjk = lang in CJK_CORRECTABLE_LANGS
    if lang not in CORRECTABLE_LANGS and not cjk:
        return None

    if not track:
        pa, pt = parse_artist_track(youtube_title)
        artist = artist or pa
        track = pt
    if not track:
        return None

    if not official:
        official = fetch_official_lyrics(track, artist, duration)
    if not official:
        return None

    if cjk:
        stats = _correct_cjk_chars(result, official)
        if not stats:
            return None
        return {"source": "lrclib", "track": track, "artist": artist, **stats}

    official_words = _tokenize_official(official)
    if not official_words:
        return None

    segments = result.get("segments", [])
    flat = [(si, w) for si, seg in enumerate(segments) for w in seg.get("words", [])]
    if not flat:
        return None

    whisper_norm = [_norm(w["word"]) for _, w in flat]
    official_norm = [_norm(w) for w in official_words]

    sm = difflib.SequenceMatcher(a=whisper_norm, b=official_norm, autojunk=False)
    rebuilt = {si: [] for si in range(len(segments))}
    changed = 0

    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                seg_idx, wobj = flat[i1 + k]
                disp = official_words[j1 + k]
                # Restore accents/spelling lost by Whisper (normalized forms match).
                if disp != wobj["word"].strip():
                    wobj = {**wobj, "word": disp}
                    changed += 1
                rebuilt[seg_idx].append(wobj)

        elif tag == "delete":
            # Whisper heard words not in the lyrics (ad-libs, repeats) — keep them.
            for k in range(i1, i2):
                seg_idx, wobj = flat[k]
                rebuilt[seg_idx].append(wobj)

        elif tag == "insert":
            # Lyrics have words Whisper missed — skip; we won't fake timing.
            continue

        elif tag == "replace":
            wlen, olen = i2 - i1, j2 - j1
            if wlen > MAX_ISLAND or olen > MAX_ISLAND:
                # Too divergent to trust — keep Whisper's audio-derived words.
                for k in range(i1, i2):
                    seg_idx, wobj = flat[k]
                    rebuilt[seg_idx].append(wobj)
                continue
            if wlen == olen:
                for k in range(wlen):
                    seg_idx, wobj = flat[i1 + k]
                    rebuilt[seg_idx].append({**wobj, "word": official_words[j1 + k]})
                    changed += 1
            else:
                # Word-count mismatch: spread the time span across the official
                # words proportionally to their length.
                seg_idx = flat[i1][0]
                start = flat[i1][1]["start"]
                end = flat[i2 - 1][1]["end"]
                total = max(end - start, 0.01)
                chosen = official_words[j1:j2]
                lengths = [max(len(_norm(w)), 1) for w in chosen]
                lsum = sum(lengths)
                t = start
                for w, L in zip(chosen, lengths):
                    dur = total * (L / lsum)
                    rebuilt[seg_idx].append({"word": w, "start": round(t, 2),
                                             "end": round(t + dur, 2)})
                    t += dur
                changed += olen

    if changed == 0:
        return None

    for si, seg in enumerate(segments):
        words = rebuilt.get(si, [])
        seg["words"] = words
        if words:
            seg["text"] = " ".join(w["word"].strip() for w in words)
    result["text"] = " ".join(s["text"].strip() for s in segments if s.get("text"))

    return {"source": "lrclib", "track": track, "artist": artist,
            "words_total": len(flat), "words_changed": changed}


# ─── CLI test harness ─────────────────────────────────────────────────────────
# Usage: python lyrics_correct.py "<artist>" "<track>" [duration]
#    or: python lyrics_correct.py --fetch --title "<youtube title>"
#                                 [--artist A] [--track T] [--duration 213.5]
if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")  # Windows console is cp1252

    if "--fetch" in sys.argv[1:]:
        # Machine-readable mode so the server can pre-fetch lyrics in its own
        # process — the 7-10s lrclib latency then overlaps the download instead
        # of stalling the GPU pipeline. One JSON line out, nulls on any failure.
        def _flag(name):
            argv = sys.argv
            return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else None

        out = {"plain": None, "synced": None, "artist": None, "track": None}
        try:
            f_artist, f_track = _flag("--artist"), _flag("--track")
            f_dur = _flag("--duration")
            f_duration = float(f_dur) if f_dur else None
            if not f_track:
                pa, pt = parse_artist_track(_flag("--title"))
                f_artist = f_artist or pa
                f_track = pt
            if f_track:
                bundle = fetch_official_bundle(f_track, f_artist, f_duration)
                out = {"plain": bundle["plain"], "synced": bundle["synced"],
                       "artist": bundle.get("artist") or f_artist,
                       "track": bundle.get("track") or f_track}
        except Exception as e:
            print(f"lyrics fetch failed: {e}", file=sys.stderr)
            out = {"plain": None, "synced": None, "artist": None, "track": None}
        print(json.dumps(out, ensure_ascii=False))
        sys.exit(0)

    artist = sys.argv[1] if len(sys.argv) > 1 else None
    track = sys.argv[2] if len(sys.argv) > 2 else None
    duration = float(sys.argv[3]) if len(sys.argv) > 3 else None
    lyrics = fetch_official_lyrics(track, artist, duration)
    if lyrics:
        print(f"Found lyrics for {artist} - {track} ({len(lyrics)} chars):\n")
        print("\n".join(lyrics.splitlines()[:12]))
    else:
        print(f"No lyrics found for {artist} - {track}")
