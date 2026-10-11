#!/usr/bin/env python3
"""
One-shot vocal separation + transcription, for testing by hand.

The server does not use this -- it talks to the long-lived worker.py instead, so
it never pays the model-load cost per song. Everything here just borrows that
worker's code so the two can't drift apart.

Usage: python transcribe_audio.py <audio_path> [model] [output_json] [language]
"""

import os
import sys
import json


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False,
                          "error": "Usage: transcribe_audio.py <audio_path> [model] [output_json] [language]"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("WHISPER_MODEL", "large-v3")
    output_path = sys.argv[3] if len(sys.argv) > 3 else None
    language = (sys.argv[4] or None) if len(sys.argv) > 4 else None

    # worker.py reads the model name from the environment when it builds Models
    os.environ["WHISPER_MODEL"] = model_name
    os.environ.setdefault("WORKER_IDLE_MS", "0")   # no reaper for a one-shot run

    import worker

    try:
        models = worker.Models()
        vocals, sr = models.separate_vocals(audio_path)
        audio = models.to_whisper_audio(vocals, sr)
        del vocals
        models.release()

        result = models.transcribe(audio, language, None)
        result["segments"] = worker.format_segments(result)

        if output_path:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)

        print(json.dumps({"success": True, "language": result["language"],
                          "segments": len(result["segments"])}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
