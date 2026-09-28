#!/usr/bin/env python3
"""
Fetch a YouTube video transcript and output it as structured JSON.

Usage:
    uv run python3 fetch_transcript.py <url_or_video_id> [--language en,tr] [--timestamps]

Output (JSON):
    {
        "video_id": "...",
        "language": "en",
        "segments": [{"text": "...", "start": 0.0, "duration": 2.5}, ...],
        "full_text": "complete transcript as plain text",
        "timestamped_text": "00:00 first line\n00:05 second line\n..."
    }

Install dependency:  uv pip install youtube-transcript-api
"""

import argparse
import json
import re
import sys
import math
from urllib.parse import urlparse, parse_qs


def extract_video_id(url_or_id: str) -> str:
    """Extract the 11-character video ID from various YouTube URL formats."""
    url_or_id = url_or_id.strip()
    if re.fullmatch(r'[a-zA-Z0-9_-]{11}', url_or_id):
        return url_or_id
    url = urlparse(url_or_id)
    if url.scheme not in ('https', 'http') or url.username or url.password:
        raise ValueError('Expected a YouTube URL or exact 11-character video ID')
    if url.hostname == 'youtu.be':
        candidate = url.path.removeprefix('/')
    elif url.hostname in ('youtube.com', 'www.youtube.com', 'm.youtube.com'):
        parts = url.path.strip('/').split('/')
        if url.path == '/watch':
            ids = parse_qs(url.query).get('v', [])
            candidate = ids[0] if len(ids) == 1 else ''
        else:
            candidate = parts[1] if len(parts) == 2 and parts[0] in ('shorts', 'embed', 'live') else ''
    else:
        raise ValueError('Unsupported video host')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{11}', candidate):
        raise ValueError('Invalid video ID')
    return candidate


def format_timestamp(seconds: float) -> str:
    """Convert seconds to HH:MM:SS or MM:SS format."""
    total = int(seconds)
    h, remainder = divmod(total, 3600)
    m, s = divmod(remainder, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def fetch_transcript(video_id: str, languages: list = None):
    """Fetch transcript segments from YouTube.

    Returns transcript metadata and normalized source segments.
    Compatible with youtube-transcript-api v1.x.
    """
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        print("Error: youtube-transcript-api not installed. Run: uv pip install youtube-transcript-api",
              file=sys.stderr)
        sys.exit(1)

    api = YouTubeTranscriptApi()
    result = api.fetch(video_id, languages=languages or ['en'])

    # v1.x returns FetchedTranscriptSnippet objects; normalize to dicts
    segments = [
        {"text": seg.text, "start": seg.start, "duration": seg.duration}
        for seg in result
    ]
    if not segments or not any(seg['text'].strip() for seg in segments):
        raise ValueError('No transcript content found')
    for seg in segments:
        if not all(isinstance(seg[k], (float, int)) and math.isfinite(seg[k]) and seg[k] >= 0
                   for k in ('start', 'duration')):
            raise ValueError('Invalid transcript timing')
    return {'segments': segments, 'language': result.language_code,
            'is_generated': result.is_generated}


def main():
    parser = argparse.ArgumentParser(description="Fetch YouTube transcript as JSON")
    parser.add_argument("url", help="YouTube URL or video ID")
    parser.add_argument("--language", "-l", default=None,
                        help="Comma-separated language codes (e.g. en,tr). Default: en")
    parser.add_argument("--timestamps", "-t", action="store_true",
                        help="Include timestamped text in output")
    parser.add_argument("--text-only", action="store_true",
                        help="Output plain text instead of JSON")
    args = parser.parse_args()

    languages = [l.strip() for l in args.language.split(",")] if args.language else None

    try:
        video_id = extract_video_id(args.url)
        if languages is not None and not all(languages):
            raise ValueError('Language codes cannot be empty')
        transcript = fetch_transcript(video_id, languages)
        segments = transcript['segments']
    except Exception as e:
        error_msg = str(e)
        if "disabled" in error_msg.lower():
            print(json.dumps({"error": "Transcripts are disabled for this video."}))
        elif "no transcript" in error_msg.lower():
            print(json.dumps({"error": "No transcript found. Try specifying a language with --language."}))
        else:
            print(json.dumps({"error": error_msg}))
        sys.exit(1)

    full_text = " ".join(seg["text"] for seg in segments)
    timestamped = "\n".join(
        f"{format_timestamp(seg['start'])} {seg['text']}" for seg in segments
    )

    if args.text_only:
        print(timestamped if args.timestamps else full_text)
        return

    result = {
        **transcript,
        "video_id": video_id,
        "source_url": f"https://www.youtube.com/watch?v={video_id}",
        "segment_count": len(segments),
        "duration": format_timestamp(max(s['start'] + s['duration'] for s in segments)),
        "full_text": full_text,
    }
    if args.timestamps:
        result["timestamped_text"] = timestamped

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
