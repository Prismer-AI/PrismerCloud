'use client';

import { useEffect, useRef, useState } from 'react';
import { Film, Loader2 } from 'lucide-react';

type VideoJsPlayer = {
  dispose: () => void;
};

type VideoJsFactory = (
  element: HTMLVideoElement,
  options: {
    controls: boolean;
    preload: string;
    responsive: boolean;
    fluid: boolean;
    sources: Array<{ src: string; type: string }>;
    poster?: string;
  },
) => VideoJsPlayer;

export interface HlsVideoPlayerProps {
  src: string;
  title: string;
  isDark: boolean;
  poster?: string | null;
}

export function HlsVideoPlayer({ src, title, isDark, poster }: HlsVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<VideoJsPlayer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void import('video.js')
      .then((mod) => {
        if (cancelled || !videoRef.current) return;
        const videojs = (mod.default ?? mod) as unknown as VideoJsFactory;
        playerRef.current = videojs(videoRef.current, {
          controls: true,
          preload: 'metadata',
          responsive: true,
          fluid: false,
          sources: [{ src, type: 'application/x-mpegURL' }],
          ...(poster ? { poster } : {}),
        });
        setLoading(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'HLS player failed to load');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, [poster, src]);

  return (
    <div
      className="relative flex h-full min-h-0 items-center justify-center bg-black p-2"
      data-testid="asset-preview-hls"
    >
      <video
        ref={videoRef}
        className="video-js vjs-default-skin vjs-big-play-centered h-full max-h-full w-full rounded-2xl shadow-2xl"
        playsInline
        controls
        aria-label={title}
      >
        <track kind="captions" />
      </video>
      {loading ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70">
          <Loader2 className="h-5 w-5 animate-spin text-white" />
        </div>
      ) : null}
      {error ? (
        <div
          className={`absolute inset-x-4 bottom-4 rounded-lg border px-3 py-2 text-xs ${
            isDark ? 'border-red-400/20 bg-red-500/15 text-red-100' : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          <div className="flex items-center gap-2">
            <Film className="h-3.5 w-3.5" />
            <span className="min-w-0 truncate">{error}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
