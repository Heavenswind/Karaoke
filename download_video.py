#!/usr/bin/env python3
"""
Download YouTube video and audio, transcribe with Whisper.
Usage: python download_video.py <youtube_video_id> [whisper_model] [output_dir]
"""

import sys
import os
import json
import time
import threading
import subprocess
import hashlib
import shutil

# YouTube cookies bypass the "confirm you're not a bot" wall. Use an exported
# cookies.txt if present (works while the browser is open). We do NOT fall back to
# --cookies-from-browser by default: Chrome 127+ app-bound encryption makes it
# fail with a DPAPI error, which would break ALL downloads. Opt in via env var
# COOKIES_BROWSER=firefox (or a browser without that encryption) if you want it.
COOKIES_FILE = os.environ.get("COOKIES_FILE") or os.path.join(os.path.dirname(__file__), "cookies.txt")
COOKIES_BROWSER = os.environ.get("COOKIES_BROWSER", "")


def cookie_args():
    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        return ["--cookies", COOKIES_FILE]
    if COOKIES_BROWSER:
        return ["--cookies-from-browser", COOKIES_BROWSER]
    return []


def find_ffmpeg():
    """Find ffmpeg executable."""
    # Try shutil.which first
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    
    # Common Windows locations
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


def probe_duration(path):
    """Media duration in seconds via ffprobe, or None if unreadable."""
    try:
        cmd = [find_ffprobe(), "-v", "error", "-show_entries", "format=duration",
               "-of", "default=noprint_wrappers=1:nokey=1", path]
        result = subprocess.run(cmd, capture_output=True, text=True)
        return float(result.stdout.strip())
    except Exception:
        return None


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

def download_video(video_id, output_dir):
    """Download video from YouTube using yt-dlp.

    Returns (video_path, info_dict_or_None) — the metadata JSON rides along
    with the download (one extractor pass instead of two).
    """
    url = f"https://www.youtube.com/watch?v={video_id}"
    video_path = os.path.join(output_dir, f"{video_id}.mp4")

    # Check if already downloaded
    if os.path.exists(video_path):
        return video_path, None
    
    # Clean up partial downloads (.part, .f137.mp4 etc.) — but never the
    # transcription json, which is reused when only the video needs a re-fetch
    for f in os.listdir(output_dir):
        if f.startswith(video_id) and f not in (f"{video_id}.mp4", f"{video_id}.json"):
            try:
                os.remove(os.path.join(output_dir, f))
            except:
                pass
    
    # Ensure PATH is set up
    setup_paths()
    
    ffmpeg_path = find_ffmpeg()
    ffmpeg_dir = os.path.dirname(ffmpeg_path) if os.path.dirname(ffmpeg_path) else ffmpeg_path

    # Cap at 1080p and prefer H.264: 4K AV1 streams stall in the browser while
    # Demucs/Whisper hammer the same GPU, and karaoke doesn't need 4K anyway.
    base_cmd = [
        "yt-dlp",
        *cookie_args(),
        "-f", "bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/"
              "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/"
              "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        "-N", "4",  # parallel fragment downloads
        "--merge-output-format", "mp4",
        "--ffmpeg-location", ffmpeg_dir,
        "-o", video_path,
        "--no-playlist",
        "--geo-bypass",
        "--geo-bypass-country", "US",
        "--remote-components", "ejs:github",
        "--dump-single-json", "--no-simulate",  # print metadata while downloading
        url
    ]
    result = subprocess.run(base_cmd, capture_output=True, text=True,
                            encoding="utf-8", errors="replace")

    info = None
    try:
        info = json.loads(result.stdout)
    except Exception:
        pass

    if not os.path.exists(video_path):
        error_msg = result.stderr
        # Check for geo-restriction
        if "not made this video available in your country" in error_msg:
            raise Exception("Video is geo-restricted in your country. Try a different video or use a VPN.")
        raise Exception(f"yt-dlp video failed: {error_msg}")

    return video_path, info

def extract_audio(video_path, output_dir, video_id):
    """Extract audio as WAV: no lossy mp3 re-encode, and torchaudio reads it
    natively (mp3 forced a second ffmpeg decode inside audio_io)."""
    audio_path = os.path.join(output_dir, f"{video_id}.wav")

    # Check if already extracted
    if os.path.exists(audio_path):
        return audio_path

    ffmpeg_path = find_ffmpeg()

    cmd = [
        ffmpeg_path,
        "-i", video_path,
        "-vn",
        "-acodec", "pcm_s16le",
        "-ar", "44100",
        "-ac", "2",
        "-y",
        audio_path
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    if result.returncode != 0:
        raise Exception(f"ffmpeg failed: {result.stderr}")
    
    return audio_path

def info_to_meta(data):
    """Reduce a yt-dlp info dict to the fields the lyrics pipeline needs."""
    if not isinstance(data, dict):
        return {}
    return {
        "title": data.get("title"),
        "artist": data.get("artist") or data.get("creator") or data.get("uploader"),
        "track": data.get("track"),
        "duration": data.get("duration"),
    }


def get_metadata(video_id):
    """Fetch title/artist/track/duration via yt-dlp (only needed when the
    video was already cached — fresh downloads return metadata inline)."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    cmd = [
        "yt-dlp", *cookie_args(), "--skip-download", "--dump-single-json", "--no-playlist",
        "--geo-bypass", "--geo-bypass-country", "US",
        "--remote-components", "ejs:github", url
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True,
                                encoding="utf-8", errors="replace")
        return info_to_meta(json.loads(result.stdout))
    except Exception as e:
        print(f"Metadata fetch failed: {e}", file=sys.stderr)
        return {}

def transcribe_audio(audio_path, model_name="large-v3", language_hint=None, vocals_path=None):
    """Transcribe audio by calling separate Python script (avoids crashes)."""
    import platform
    
    # Use a separate Python process to avoid memory/DLL issues
    script_dir = os.path.dirname(os.path.abspath(__file__))
    transcribe_script = os.path.join(script_dir, "transcribe_audio.py")
    
    # Create temp file for output
    output_dir = os.path.dirname(audio_path)
    video_id = os.path.splitext(os.path.basename(audio_path))[0]
    temp_output = os.path.join(output_dir, f"{video_id}_transcription.json")
    
    # Build command
    cmd = ["python", transcribe_script, audio_path, model_name, temp_output]
    if vocals_path:
        cmd.append(language_hint or "")   # keep positional slot for vocals arg
        cmd.append(vocals_path)
    elif language_hint:
        cmd.append(language_hint)
    
    # On Windows, use shell=True to avoid PowerShell stderr issues
    if platform.system() == "Windows":
        result = subprocess.run(cmd, capture_output=True, text=True, shell=True)
    else:
        result = subprocess.run(cmd, capture_output=True, text=True)
    
    # Check for transcription success (we check the output file, not exit code)
    if not os.path.exists(temp_output):
        raise Exception(f"Transcription failed: {result.stderr}")
    
    # Load the result
    try:
        with open(temp_output, "r", encoding="utf-8") as f:
            transcription = json.load(f)
        os.remove(temp_output)
        return transcription
    except Exception as e:
        raise Exception(f"Failed to read transcription: {e}")

def format_segments(result):
    """Format transcription result into timestamped lyrics with word-level timing."""
    segments = []
    
    for segment in result.get("segments", []):
        # Extract word-level timing for karaoke fill effect
        words = []
        for word in segment.get("words", []):
            words.append({
                "word": word.get("word", "").strip(),
                "start": round(word.get("start", 0), 2),
                "end": round(word.get("end", 0), 2)
            })
        
        segments.append({
            "start": round(segment["start"], 2),
            "end": round(segment["end"], 2),
            "text": segment["text"].strip(),
            "words": words
        })
    
    return segments

def run_whisper_with_correction(audio_path, model_name, language_hint, meta, artist, track, vocals_path=None):
    """Fallback: Whisper transcription, then proofread words against lrclib."""
    print(json.dumps({"status": "transcribing"}), flush=True)
    result = transcribe_audio(audio_path, model_name, language_hint, vocals_path=vocals_path)
    try:
        from lyrics_correct import correct_with_official_lyrics, parse_artist_track
        a, t = artist, track
        if not t:
            pa, pt = parse_artist_track(meta.get("title"))
            a, t = a or pa, pt
        stats = correct_with_official_lyrics(
            result, youtube_title=meta.get("title"), artist=a, track=t,
            duration=meta.get("duration"), language=result.get("language"))
        if stats:
            print(json.dumps({"status": "lyrics_corrected", **stats}), file=sys.stderr)
        else:
            print("Lyrics correction: no confident match (kept transcription)", file=sys.stderr)
    except Exception as e:
        print(f"Lyrics correction skipped: {e}", file=sys.stderr)
    return result


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No video ID provided"}))
        sys.exit(1)
    
    # Setup PATH for ffmpeg and deno
    setup_paths()
    
    video_id = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "large-v3"
    output_dir = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(__file__), "videos")
    language_hint = sys.argv[4] if len(sys.argv) > 4 else None
    
    # Create output directory
    os.makedirs(output_dir, exist_ok=True)
    
    try:
        # Download video (metadata comes back from the same yt-dlp pass —
        # one extractor call instead of a separate download + get_metadata)
        print(json.dumps({"status": "downloading_video"}), flush=True)
        video_path, info = download_video(video_id, output_dir)

        if not os.path.exists(video_path):
            raise Exception("Video file not found after download")

        # Metadata: use what the download already fetched; only re-query
        # when the video was already cached (download_video returns no info
        # then, since it skipped the extractor entirely).
        meta = info_to_meta(info) if info else get_metadata(video_id)
        expected = meta.get("duration")

        # Validate the download. A truncated file (interrupted merge, flaky
        # network) plays a few seconds and then "ends" — and with a persistent
        # cache it would keep doing that forever. Compare against YouTube's
        # reported duration and re-download once if it comes up short.
        file_dur = probe_duration(video_path)
        if file_dur is None or (expected and file_dur < expected - 10):
            print(f"Video failed validation (file={file_dur}s, expected={expected}s) - redownloading",
                  file=sys.stderr)
            for ext in (".mp4", ".mp3", ".wav"):
                p = os.path.join(output_dir, f"{video_id}{ext}")
                if os.path.exists(p):
                    try:
                        os.remove(p)
                    except OSError:
                        pass
            video_path, info2 = download_video(video_id, output_dir)
            if info2:
                meta = info_to_meta(info2)
                expected = meta.get("duration")
            file_dur = probe_duration(video_path)
            if file_dur is None:
                raise Exception("Downloaded video is unreadable even after retrying")
            if expected and file_dur < expected - 10:
                print(f"Still short after retry ({file_dur}s vs {expected}s) - continuing anyway",
                      file=sys.stderr)

        # Log what we actually got — download quality varies with YouTube bot-checks
        try:
            res_info = subprocess.run(
                [find_ffprobe(), "-v", "error", "-select_streams", "v:0",
                 "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", video_path],
                capture_output=True, text=True).stdout.strip()
            size_mb = os.path.getsize(video_path) / 1048576
            print(f"Downloaded: {res_info} ({size_mb:.0f} MB, {file_dur or '?'}s)", file=sys.stderr)
        except Exception:
            pass

        # Reuse an existing transcription (e.g. the mp4 was purged or re-downloaded
        # at a different quality but the lyrics are still good) — skips the whole
        # Demucs/Whisper pass.
        lyrics_path = os.path.join(output_dir, f"{video_id}.json")
        if os.path.exists(lyrics_path):
            try:
                with open(lyrics_path, "r", encoding="utf-8") as f:
                    prev = json.load(f)
                if prev.get("segments"):
                    prev["success"] = True
                    prev["videoPath"] = video_path
                    prev["videoSize"] = os.path.getsize(video_path)
                    prev["duration"] = expected or file_dur or prev.get("duration")
                    with open(lyrics_path, "w", encoding="utf-8") as f:
                        json.dump(prev, f, ensure_ascii=False, indent=2)
                    print("Reusing existing transcription", file=sys.stderr)
                    print(json.dumps(prev))
                    return
            except Exception as e:
                print(f"Could not reuse existing lyrics: {e}", file=sys.stderr)

        # A leftover mp3 (legacy) or wav is from an interrupted run and may
        # itself be truncated
        for ext in (".mp3", ".wav"):
            stale_audio = os.path.join(output_dir, f"{video_id}{ext}")
            if os.path.exists(stale_audio):
                try:
                    os.remove(stale_audio)
                except OSError:
                    pass

        # Extract audio for transcription
        print(json.dumps({"status": "extracting_audio"}), flush=True)
        audio_path = extract_audio(video_path, output_dir, video_id)
        
        # Separate vocals once — passed to Whisper so it transcribes vocals-only
        # audio instead of the full mix (and skips re-running Demucs in the
        # transcribe_audio.py subprocess).
        vocals_path = None
        try:
            from transcribe_audio import separate_vocals
            vocals_path = separate_vocals(audio_path)
        except Exception as e:
            print(f"Vocal separation failed: {e}", file=sys.stderr)

        # Whisper transcription, then proofread words against lrclib where
        # they confidently agree — see run_whisper_with_correction.
        artist, track = meta.get("artist"), meta.get("track")
        result = run_whisper_with_correction(
            audio_path, model_name, language_hint, meta, artist, track, vocals_path)

        if vocals_path and os.path.exists(vocals_path):
            try:
                os.remove(vocals_path)
            except OSError:
                pass

        # Format output
        segments = format_segments(result)

        # Japanese: attach furigana readings to each word for ruby display.
        if result.get("language") == "ja":
            try:
                from furigana import add_furigana
                n = add_furigana(segments)
                print(json.dumps({"status": "furigana", "annotated": n}), file=sys.stderr)
            except Exception as e:
                print(f"Furigana skipped: {e}", file=sys.stderr)

        full_text = result.get("text", "").strip()
        
        # Get video file size
        video_size = os.path.getsize(video_path)
        
        output = {
            "success": True,
            "videoPath": video_path,
            "videoId": video_id,
            "segments": segments,
            "text": full_text,
            "language": result.get("language", "unknown"),
            "videoSize": video_size,
            "duration": expected or file_dur
        }
        
        # Save transcription to JSON file for caching
        lyrics_path = os.path.join(output_dir, f"{video_id}.json")
        with open(lyrics_path, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)

        # The wav was only needed for transcription; replays use mp4 + json.
        try:
            os.remove(audio_path)
        except OSError:
            pass

        print(json.dumps(output))
        
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
