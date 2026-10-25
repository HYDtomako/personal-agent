import argparse
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("未安装 faster-whisper，请在 pa 使用的 Python 环境中安装。", file=sys.stderr)
        return 2

    language = None if args.language.lower() in {"", "auto", "自動", "自动"} else args.language
    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
        segments, _info = model.transcribe(
            args.audio,
            language=language,
            vad_filter=False,
            beam_size=5,
        )
        with open(args.output, "w", encoding="utf-8") as output:
            for segment in segments:
                text = segment.text.strip()
                if text:
                    output.write(f"[{format_time(segment.start)}] {text}\n")
    except Exception as exc:
        print(f"语音转写失败：{exc}", file=sys.stderr)
        return 1
    return 0


def format_time(seconds):
    total = max(0, int(seconds))
    hours, rest = divmod(total, 3600)
    minutes, seconds = divmod(rest, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


if __name__ == "__main__":
    raise SystemExit(main())
