// Agent Park v2 — Phaser game configuration

import * as Phaser from 'phaser';
import { LAYOUT } from './park-layout';
import { ParkScene } from './scene';

export function createParkConfig(parent: string): Phaser.Types.Core.GameConfig {
  return {
    type: Phaser.AUTO,
    parent,
    width: LAYOUT.game.width,
    height: LAYOUT.game.height,
    pixelArt: true,
    backgroundColor: '#1a1a2e',
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [ParkScene],
  };
}
