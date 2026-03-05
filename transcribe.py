#!/usr/bin/env python3
"""
Transcribe YouTube audio using Whisper with timestamps.
Usage: python transcribe.py <youtube_video_id> [whisper_model]
"""

import sys
import os
import json
import tempfile
import shutil
import subprocess

def download_audio(video_id, output_path):
    """Download audio from YouTube using yt-dlp."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    
    cmd = [
        "yt-dlp",
        "-x",  # Extract audio
        "--audio-format", "mp3",
        "--audio-quality", "0",
        "-o", output_path,
        "--no-playlist",
        "--quiet",
        url
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    if result.returncode != 0:
        raise Exception(f"yt-dlp failed: {result.stderr}")
    
    return output_path

def transcribe_audio(audio_path, model_name="base"):
    """Transcribe audio using Whisper with GPU acceleration."""
    import whisper
    import torch
    
    # Use CUDA if available
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Using device: {device}", file=sys.stderr)
    
    # Load the model on GPU
    model = whisper.load_model(model_name, device=device)
    
    # Transcribe with word-level timestamps
    result = model.transcribe(
        audio_path,
        word_timestamps=True,
        language=None,  # Auto-detect language
        task="transcribe"
    )
    
    return result

def format_segments(result):
    """Format transcription result into timestamped lyrics."""
    segments = []
    
    for segment in result.get("segments", []):
        segments.append({
            "start": round(segment["start"], 2),
            "end": round(segment["end"], 2),
            "text": segment["text"].strip()
        })
    
    return segments

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No video ID provided"}))
        sys.exit(1)
    
    video_id = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base"
    
    # Create temp directory for audio
    temp_dir = tempfile.mkdtemp()
    audio_path = os.path.join(temp_dir, f"{video_id}.mp3")
    
    try:
        # Download audio
        print(json.dumps({"status": "downloading"}), flush=True)
        download_audio(video_id, audio_path)
        
        # Verify file exists
        if not os.path.exists(audio_path):
            # yt-dlp might add extension differently
            for f in os.listdir(temp_dir):
                if f.startswith(video_id):
                    audio_path = os.path.join(temp_dir, f)
                    break
        
        if not os.path.exists(audio_path):
            raise Exception("Audio file not found after download")
        
        # Transcribe
        print(json.dumps({"status": "transcribing"}), flush=True)
        result = transcribe_audio(audio_path, model_name)
        
        # Format output
        segments = format_segments(result)
        full_text = result.get("text", "").strip()
        
        output = {
            "success": True,
            "segments": segments,
            "text": full_text,
            "language": result.get("language", "unknown")
        }
        
        print(json.dumps(output))
        
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
    
    finally:
        # Cleanup temp files
        shutil.rmtree(temp_dir, ignore_errors=True)

if __name__ == "__main__":
    main()
