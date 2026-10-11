#!/usr/bin/env python3
"""
Fetch a YouTube song: audio for the transcriber, video for the screen.

This script deliberately imports nothing from the ML stack. Downloading is
network-bound and transcription is GPU-bound, and the server now runs them as
separate stages so a song can be downloading while the previous one is still on
the GPU. Keeping torch out of here means the download stage starts in ~0.1s.

Usage:
  python download_video.py <video_id> [--audio | --video | --all] [--out DIR]

  --audio   just the audio stream, converted to <id>.wav (small and quick, so
            the GPU can start while --video is still running)
  --video   the playable <id>.mp4, capped at 1080p
  --all     both, sequentially (default; handy for a manual one-shot test)

Prints a single JSON object on stdout. Progress goes to stdout too, as
{"status": ...} lines, which is what the server relays to the room.
"""

import sys
import os
import json
import shutil
import subprocess

# YouTube cookies bypass the "confirm you're not a bot" wall. Use an exported
# cookies.txt if present (works while the browser is open). We do NOT fall back to
# --cookies-from-browser by default: Chrome 127+ app-bound encryption makes it
# fail with a DPAPI error, which would break ALL downloads. Opt in via env var
# COOKIES_BROWSER=firefox (or a browser without that encryption) if you want it.
COOKIES_FILE = os.environ.get("COOKIES_FILE") or os.path.join(os.path.dirname(__file__), "cookies.txt")
COOKIES_BROWSER = os.environ.get("COOKIES_BROWSER", "")

# yt-dlp splits a stream into fragments and fetches them in parallel. 4 was
# conservative for a machine with this many cores and this much bandwidth.
FRAGMENTS = os.environ.get("YTDLP_FRAGMENTS", "8")


def run(cmd, **kw):
    """subprocess.run that never blows up on non-ASCII child output.

    Windows defaults text mode to the ANSI codepage (cp1252 here), and the
    decode happens on a reader thread -- so a Japanese title in ffmpeg's banner
    used to kill that thread and silently hand back stderr=None, turning a real
    error message into "None".
    """
    kw.setdefault("capture_output", True)
    kw.setdefault("text", True)
    kw.setdefault("encoding", "utf-8")
    kw.setdefault("errors", "replace")
    return subprocess.run(cmd, **kw)


def cookie_args():
    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        return ["--cookies", COOKIES_FILE]
    if COOKIES_BROWSER:
        return ["--cookies-from-browser", COOKIES_BROWSER]
    return []


def find_ffmpeg():
    """Find ffmpeg executable."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg

    common_paths = [
        os.path.expanduser("~\\AppData\\Local\\Microsoft\\WinGet\\Packages"),
        "C:\\ffmpeg\\bin",
        "C:\\Program Files\\ffmpeg\\bin",
    ]

    for base in common_paths:
        if os.path.exists(base):
            for root, dirs, files in os.walk(base):
                if "ffmpeg.exe" in files:
                    return os.path.join(root, "ffmpeg.exe")

    return "ffmpeg"  # Fallback to PATH


def find_ffprobe():
    """Find ffprobe executable (usually next to ffmpeg)."""
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        return ffprobe
    ffmpeg = find_ffmpeg()
    d = os.path.dirname(ffmpeg)
    if d:
        cand = os.path.join(d, "ffprobe.exe" if ffmpeg.lower().endswith(".exe") else "ffprobe")
        if os.path.exists(cand):
            return cand
    return "ffprobe"


def find_deno():
    """Find deno executable."""
    deno = shutil.which("deno")
    if deno:
        return deno

    common_paths = [
        os.path.expanduser("~\\.deno\\bin"),
        os.path.expanduser("~\\AppData\\Local\\Microsoft\\WinGet\\Packages"),
        "C:\\Program Files\\deno",
    ]

    for base in common_paths:
        if os.path.exists(base):
            for root, dirs, files in os.walk(base):
                if "deno.exe" in files:
                    return os.path.join(root, "deno.exe")

    return None


def setup_paths():
    """Add ffmpeg and deno to PATH if needed."""
    paths_to_add = []

    ffmpeg = find_ffmpeg()
    if ffmpeg and os.path.dirname(ffmpeg):
        paths_to_add.append(os.path.dirname(ffmpeg))

    deno = find_deno()
    if deno and os.path.dirname(deno):
        paths_to_add.append(os.path.dirname(deno))

    if paths_to_add:
        current_path = os.environ.get("PATH", "")
        new_paths = [p for p in paths_to_add if p not in current_path]
        if new_paths:
            os.environ["PATH"] = os.pathsep.join(new_paths) + os.pathsep + current_path


def probe_duration(path):
    """Media duration in seconds via ffprobe, or None if unreadable."""
    try:
        result = run([find_ffprobe(), "-v", "error", "-show_entries", "format=duration",
                      "-of", "default=noprint_wrappers=1:nokey=1", path])
        return float(result.stdout.strip())
    except Exception:
        return None


def ytdlp_base():
    ffmpeg_path = find_ffmpeg()
    ffmpeg_dir = os.path.dirname(ffmpeg_path) or ffmpeg_path
    return [
        "yt-dlp",
        *cookie_args(),
        "-N", FRAGMENTS,
        "--ffmpeg-location", ffmpeg_dir,
        "--no-playlist",
        "--geo-bypass",
        "--geo-bypass-country", "US",
        "--remote-components", "ejs:github",
        # metadata rides along with the download -- one extractor pass, not two
        "--dump-single-json", "--no-simulate",
    ]


def _clean_partials(prefix, output_dir, keep, skip_prefix=None):
    """Remove interrupted-download leftovers (.part, .f137.mp4, ...) without
    touching the artifacts we still want.

    `skip_prefix` shields a stage running concurrently with this one. The audio
    and video for a song are fetched at the same time now, and a sweep that
    matched on the bare video id would delete the fragments the other stage was
    still writing -- reachable whenever the download semaphore is full and the
    two stages start minutes apart rather than together.
    """
    try:
        names = os.listdir(output_dir)
    except OSError:
        return
    for f in names:
        if not f.startswith(prefix) or f in keep:
            continue
        if skip_prefix and f.startswith(skip_prefix):
            continue
        try:
            os.remove(os.path.join(output_dir, f))
        except OSError:
            pass


def _keepers(video_id):
    return {f"{video_id}{ext}" for ext in (".mp4", ".json", ".wav")}


# The audio stage downloads under its own stem so its temporary files can never
# collide with the video stage's. The finished wav is renamed to <id>.wav, so
# everything downstream still sees the filename it expects.
def _audio_stem(video_id):
    return f"{video_id}.audio"


def download_audio(video_id, output_dir):
    """Grab just the audio stream and convert it to <id>.wav.

    Audio is a few MB against a video's tens or hundreds, so this finishes long
    before the mp4 does and lets separation/transcription start early. yt-dlp
    re-fetches this stream as part of the video merge later; that duplication is
    a rounding error next to the latency it buys back.
    """
    audio_path = os.path.join(output_dir, f"{video_id}.wav")
    if os.path.exists(audio_path):
        return audio_path, None

    stem = _audio_stem(video_id)
    tmp_wav = os.path.join(output_dir, f"{stem}.wav")
    _clean_partials(stem, output_dir, set())

    url = f"https://www.youtube.com/watch?v={video_id}"
    cmd = [
        *ytdlp_base(),
        "-f", "bestaudio[ext=m4a]/bestaudio/best",
        "-x", "--audio-format", "wav",
        "-o", os.path.join(output_dir, f"{stem}.%(ext)s"),
        url,
    ]
    result = run(cmd)

    info = None
    try:
        info = json.loads(result.stdout)
    except Exception:
        pass

    if not os.path.exists(tmp_wav):
        err = result.stderr or ""
        if "not made this video available in your country" in err:
            raise Exception("Video is geo-restricted in your country. Try a different video or use a VPN.")
        raise Exception(f"yt-dlp audio failed: {err[-800:]}")

    os.replace(tmp_wav, audio_path)
    return audio_path, info


def download_video(video_id, output_dir):
    """Download video from YouTube using yt-dlp.

    Returns (video_path, info_dict_or_None) -- the metadata JSON rides along
    with the download (one extractor pass instead of two).
    """
    url = f"https://www.youtube.com/watch?v={video_id}"
    video_path = os.path.join(output_dir, f"{video_id}.mp4")

    if os.path.exists(video_path):
        return video_path, None

    # Never delete the transcription json (reused when only the video needs a
    # re-fetch), nor the wav the audio stage may have just produced, nor
    # anything that stage is downloading right now.
    _clean_partials(video_id, output_dir, _keepers(video_id),
                    skip_prefix=_audio_stem(video_id))

    setup_paths()

    # Cap at 1080p and prefer H.264: 4K AV1 streams stall in the browser while
    # Demucs/Whisper hammer the same GPU, and karaoke doesn't need 4K anyway.
    cmd = [
        *ytdlp_base(),
        "-f", "bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/"
              "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/"
              "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        "--merge-output-format", "mp4",
        "-o", video_path,
        url,
    ]
    result = run(cmd)

    info = None
    try:
        info = json.loads(result.stdout)
    except Exception:
        pass

    if not os.path.exists(video_path):
        error_msg = result.stderr or ""
        if "not made this video available in your country" in error_msg:
            raise Exception("Video is geo-restricted in your country. Try a different video or use a VPN.")
        raise Exception(f"yt-dlp video failed: {error_msg[-800:]}")

    return video_path, info


def info_to_meta(data):
    """Reduce a yt-dlp info dict to the fields the lyrics pipeline needs.

    `uploader` is deliberately NOT a fallback for `artist`. Only official
    artist channels and YouTube Music set the real `artist`/`creator` tags;
    on the personal uploads most karaoke links point at, `uploader` is just
    whoever posted it ("François"). Feeding that to lrclib as the artist made
    every such lookup miss -- and worse, it outranked the artist parsed from
    the title, so "Crawling - Linkin Park" searched for François instead.
    """
    if not isinstance(data, dict):
        return {}
    return {
        "title": data.get("title"),
        "artist": data.get("artist") or data.get("creator"),
        "track": data.get("track"),
        "duration": data.get("duration"),
    }


def get_metadata(video_id):
    """Fetch title/artist/track/duration via yt-dlp (only needed when the media
    was already cached -- fresh downloads return metadata inline)."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    cmd = [
        "yt-dlp", *cookie_args(), "--skip-download", "--dump-single-json", "--no-playlist",
        "--geo-bypass", "--geo-bypass-country", "US",
        "--remote-components", "ejs:github", url
    ]
    try:
        result = run(cmd)
        return info_to_meta(json.loads(result.stdout))
    except Exception as e:
        print(f"Metadata fetch failed: {e}", file=sys.stderr)
        return {}


def fetch_video(video_id, output_dir, expected=None):
    """Download the mp4 and make sure it isn't truncated.

    A short file (interrupted merge, flaky network) plays a few seconds and then
    "ends" -- and with a persistent cache it would keep doing that forever. So
    compare against YouTube's reported duration and re-download once.
    """
    video_path, info = download_video(video_id, output_dir)
    meta = info_to_meta(info) if info else {}
    expected = meta.get("duration") or expected

    file_dur = probe_duration(video_path)
    if file_dur is None or (expected and file_dur < expected - 10):
        print(f"Video failed validation (file={file_dur}s, expected={expected}s) - redownloading",
              file=sys.stderr)
        try:
            os.remove(video_path)
        except OSError:
            pass
        video_path, info2 = download_video(video_id, output_dir)
        if info2:
            meta = info_to_meta(info2)
            expected = meta.get("duration") or expected
        file_dur = probe_duration(video_path)
        if file_dur is None:
            raise Exception("Downloaded video is unreadable even after retrying")
        if expected and file_dur < expected - 10:
            print(f"Still short after retry ({file_dur}s vs {expected}s) - continuing anyway",
                  file=sys.stderr)

    # Log what we actually got -- download quality varies with YouTube bot-checks
    try:
        res_info = run([find_ffprobe(), "-v", "error", "-select_streams", "v:0",
                        "-show_entries", "stream=codec_name,width,height",
                        "-of", "csv=p=0", video_path]).stdout.strip()
        size_mb = os.path.getsize(video_path) / 1048576
        print(f"Downloaded: {res_info} ({size_mb:.0f} MB, {file_dur or '?'}s)", file=sys.stderr)
    except Exception:
        pass

    return video_path, meta, file_dur


def main():
    args = [a for a in sys.argv[1:]]
    if not args:
        print(json.dumps({"success": False, "error": "No video ID provided"}))
        sys.exit(1)

    video_id = args[0]
    mode = "all"
    output_dir = os.path.join(os.path.dirname(__file__), "videos")

    i = 1
    while i < len(args):
        a = args[i]
        if a in ("--audio", "--video", "--all"):
            mode = a[2:]
        elif a == "--out":
            i += 1
            output_dir = args[i]
        elif not a.startswith("--"):
            output_dir = a          # positional out-dir, as the old CLI took it
        i += 1

    os.makedirs(output_dir, exist_ok=True)
    setup_paths()

    out = {"success": True, "videoId": video_id, "mode": mode}

    try:
        if mode in ("audio", "all"):
            print(json.dumps({"status": "downloading_audio"}), flush=True)
            audio_path, info = download_audio(video_id, output_dir)
            meta = info_to_meta(info) if info else get_metadata(video_id)
            out["audioPath"] = audio_path
            out["meta"] = meta
            out["duration"] = meta.get("duration") or probe_duration(audio_path)

        if mode in ("video", "all"):
            print(json.dumps({"status": "downloading_video"}), flush=True)
            video_path, vmeta, file_dur = fetch_video(
                video_id, output_dir, expected=out.get("duration"))
            out["videoPath"] = video_path
            out["videoSize"] = os.path.getsize(video_path)
            out["duration"] = out.get("duration") or vmeta.get("duration") or file_dur
            if vmeta and not out.get("meta"):
                out["meta"] = vmeta

        print(json.dumps(out, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
