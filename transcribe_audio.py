#!/usr/bin/env python3
"""
Transcribe audio file using faster-whisper with optional vocal separation.
Usage: python transcribe_audio.py <audio_path> <model_name> <output_json> [language_hint]
"""

import sys
import os
import json
import gc

def separate_vocals(audio_path):
    """Use Demucs to separate vocals from the audio."""
    try:
        import torch
        import torchaudio
        from demucs.pretrained import get_model
        from demucs.apply import apply_model
        from audio_io import load_audio

        # Free throughput on Ampere+/Ada GPUs for Demucs's conv-heavy model;
        # cudnn.benchmark auto-picks faster conv algorithms for the input size.
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True

        print("Separating vocals with Demucs...", file=sys.stderr)

        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Demucs using device: {device}", file=sys.stderr)

        # Load model (htdemucs is fast and good quality)
        model = get_model("htdemucs")
        model.to(device)

        # Load audio (ffmpeg fallback handles mp3, which has no torchaudio backend)
        wav, sr = load_audio(audio_path)
        
        # Resample to model's sample rate if needed
        if sr != model.samplerate:
            resampler = torchaudio.transforms.Resample(sr, model.samplerate)
            wav = resampler(wav)
            sr = model.samplerate
        
        wav = wav.to(device)
        
        # Ensure stereo
        if wav.shape[0] == 1:
            wav = wav.repeat(2, 1)
        elif wav.shape[0] > 2:
            wav = wav[:2]
        
        # Add batch dimension
        wav = wav.unsqueeze(0)
        
        # Apply model
        with torch.no_grad():
            sources = apply_model(model, wav, device=device)
        
        # htdemucs sources: drums, bass, other, vocals (index 3)
        vocals = sources[0, 3].cpu()
        
        # Save vocals to temp file
        output_dir = os.path.dirname(audio_path)
        vocals_path = os.path.join(output_dir, "vocals_temp.wav")
        torchaudio.save(vocals_path, vocals, sr)
        
        print(f"Vocals extracted successfully", file=sys.stderr)
        
        # Clear GPU memory
        del model, wav, sources, vocals
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        
        return vocals_path
        
    except Exception as e:
        print(f"Demucs failed: {e}", file=sys.stderr)
        print("Using original audio instead", file=sys.stderr)
        return None

def main():
    if len(sys.argv) < 4:
        print(json.dumps({"success": False, "error": "Usage: transcribe_audio.py <audio_path> <model_name> <output_json> [language_hint]"}))
        sys.exit(1)
    
    audio_path = sys.argv[1]
    model_name = sys.argv[2]
    output_path = sys.argv[3]
    language_hint = (sys.argv[4] or None) if len(sys.argv) > 4 else None
    # Optional pre-separated vocals from the caller — skip demucs if provided.
    prevocals = sys.argv[5] if len(sys.argv) > 5 else None

    try:
        import torch
        from faster_whisper import WhisperModel

        # Clear GPU memory
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        # Use caller-provided vocals if given (caller owns cleanup), else separate.
        if prevocals and os.path.exists(prevocals):
            print("Using pre-separated vocals", file=sys.stderr)
            vocals_path = None              # not ours to delete
            transcribe_path = prevocals
        else:
            vocals_path = separate_vocals(audio_path)
            transcribe_path = vocals_path if vocals_path else audio_path
        
        device = "cuda" if torch.cuda.is_available() else "cpu"
        compute_type = "float16" if device == "cuda" else "int8"
        
        print(f"Loading faster-whisper model: {model_name}", file=sys.stderr)
        print(f"Using device: {device} ({compute_type})", file=sys.stderr)
        
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        
        # Build initial prompt for karaoke
        initial_prompts = {
            'ja': '歌詞を正確に書き起こしてください。',
            'ko': '가사를 정확하게 받아쓰세요.',
            'zh': '请准确转录歌词。',
            'en': 'Transcribe the song lyrics accurately.'
        }
        initial_prompt = initial_prompts.get(language_hint, initial_prompts['en']) if language_hint else None
        
        print(f"Transcribing: {transcribe_path}", file=sys.stderr)
        
        segments, info = model.transcribe(
            transcribe_path,
            word_timestamps=True,
            language=language_hint,
            task="transcribe",
            initial_prompt=initial_prompt,
            condition_on_previous_text=False,
            vad_filter=False,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.5
        )
        
        result = {
            "segments": [],
            "text": "",
            "language": info.language
        }
        
        full_text = []
        for segment in segments:
            seg_data = {
                "start": segment.start,
                "end": segment.end,
                "text": segment.text,
                "words": []
            }
            if segment.words:
                for word in segment.words:
                    seg_data["words"].append({
                        "word": word.word,
                        "start": word.start,
                        "end": word.end
                    })
            result["segments"].append(seg_data)
            full_text.append(segment.text)
        
        result["text"] = " ".join(full_text)
        
        # Write to output file
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        
        # Clean up vocals temp file
        if vocals_path and os.path.exists(vocals_path):
            try:
                os.remove(vocals_path)
            except:
                pass
        
        print(json.dumps({"success": True, "language": result["language"], "segments": len(result["segments"])}))
        
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
