#!/usr/bin/env python3
"""
Download YouTube video and audio, transcribe with Whisper.
Usage: python download_video.py <youtube_video_id> [whisper_model] [output_dir]
"""

import sys
import os
import json
import subprocess
import hashlib
import shutil

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
    """Download video from YouTube using yt-dlp."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    video_path = os.path.join(output_dir, f"{video_id}.mp4")
    
    # Check if already downloaded
    if os.path.exists(video_path):
        return video_path
    
    # Clean up partial downloads
    for f in os.listdir(output_dir):
        if f.startswith(video_id) and f != f"{video_id}.mp4":
            try:
                os.remove(os.path.join(output_dir, f))
            except:
                pass
    
    # Ensure PATH is set up
    setup_paths()
    
    ffmpeg_path = find_ffmpeg()
    ffmpeg_dir = os.path.dirname(ffmpeg_path) if os.path.dirname(ffmpeg_path) else ffmpeg_path

    base_cmd = [
        "yt-dlp",
        "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
        "--merge-output-format", "mp4",
        "--ffmpeg-location", ffmpeg_dir,
        "-o", video_path,
        "--no-playlist",
        "--geo-bypass",
        "--geo-bypass-country", "US",
        "--remote-components", "ejs:github",
        url
    ]
    result = subprocess.run(base_cmd, capture_output=True, text=True)
    
    if not os.path.exists(video_path):
        error_msg = result.stderr
        # Check for geo-restriction
        if "not made this video available in your country" in error_msg:
            raise Exception("Video is geo-restricted in your country. Try a different video or use a VPN.")
        raise Exception(f"yt-dlp video failed: {error_msg}")
    
    return video_path

def extract_audio(video_path, output_dir, video_id):
    """Extract audio from video for Whisper."""
    audio_path = os.path.join(output_dir, f"{video_id}.mp3")
    
    # Check if already extracted
    if os.path.exists(audio_path):
        return audio_path
    
    ffmpeg_path = find_ffmpeg()
    
    cmd = [
        ffmpeg_path,
        "-i", video_path,
        "-vn",
        "-acodec", "libmp3lame",
        "-q:a", "2",
        "-y",
        audio_path
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    if result.returncode != 0:
        raise Exception(f"ffmpeg failed: {result.stderr}")
    
    return audio_path

def transcribe_audio(audio_path, model_name="large-v3", language_hint=None):
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
    if language_hint:
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
        # Download video
        print(json.dumps({"status": "downloading_video"}), flush=True)
        video_path = download_video(video_id, output_dir)
        
        if not os.path.exists(video_path):
            raise Exception("Video file not found after download")
        
        # Extract audio for transcription
        print(json.dumps({"status": "extracting_audio"}), flush=True)
        audio_path = extract_audio(video_path, output_dir, video_id)
        
        # Transcribe
        print(json.dumps({"status": "transcribing"}), flush=True)
        result = transcribe_audio(audio_path, model_name, language_hint)
        
        # Format output
        segments = format_segments(result)
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
            "videoSize": video_size
        }
        
        # Save transcription to JSON file for caching
        lyrics_path = os.path.join(output_dir, f"{video_id}.json")
        with open(lyrics_path, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)
        
        print(json.dumps(output))
        
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
