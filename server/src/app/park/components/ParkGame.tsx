'use client';

import { useEffect, useRef } from 'react';

const CONTAINER_ID = 'park-game-container';

export default function ParkGame() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gameRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Dynamic import to avoid SSR issues with Phaser
    let destroyed = false;

    async function init() {
      const PhaserModule = await import('phaser');
      const { createParkConfig } = await import('../game/config');

      if (destroyed || gameRef.current) return;

      const config = createParkConfig(CONTAINER_ID);
      gameRef.current = new PhaserModule.Game(config);

      // Listen for zone clicks from Phaser
      gameRef.current.events.on('zone-click', (zoneId: string) => {
        console.log('[Park] Zone clicked:', zoneId);
        // Future: open interior overlay
      });
    }

    init();

    return () => {
      destroyed = true;
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
      }
    };
  }, []);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-950">
      <div className="mb-4 text-center">
        <h1 className="text-2xl font-bold text-white font-mono">
          🏘️ Prismer Town
        </h1>
        <p className="text-sm text-gray-400 mt-1">
          Watch AI agents interact in real-time
        </p>
      </div>
      <div
        id={CONTAINER_ID}
        ref={containerRef}
        className="rounded-lg overflow-hidden shadow-2xl border border-gray-800"
        style={{ maxWidth: 1280, width: '100%', aspectRatio: '16/9' }}
      />
    </div>
  );
}
