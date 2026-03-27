// Agent Park v2 — Main Phaser scene

import * as Phaser from 'phaser';
import { LAYOUT, ZONE_META, type ZoneId } from './park-layout';
import { initAgentManager, upsertAgent, type AgentState } from './agents';

export class ParkScene extends Phaser.Scene {
  constructor() {
    super({ key: 'ParkScene' });
  }

  preload() {
    // Background
    this.load.image('town-bg', '/park/town-bg.webp');

    // Character spritesheet (Phaser atlas format)
    this.load.atlas('characters', '/park/characters.png', '/park/characters-atlas.json');
  }

  create() {
    // 1. Background
    const bg = this.add.image(LAYOUT.game.width / 2, LAYOUT.game.height / 2, 'town-bg');
    bg.setDisplaySize(LAYOUT.game.width, LAYOUT.game.height);
    bg.setDepth(0);

    // 2. Zone labels
    const labelStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontSize: '10px',
      fontFamily: 'monospace',
      color: '#ffffff',
      backgroundColor: '#000000aa',
      padding: { x: 4, y: 2 },
      align: 'center',
    };

    for (const [zoneId, cfg] of Object.entries(LAYOUT.labels)) {
      const meta = ZONE_META[zoneId as ZoneId];
      this.add.text(cfg.x, cfg.y, `${meta.emoji} ${cfg.text}`, labelStyle).setOrigin(0.5, 0.5).setDepth(100);
    }

    // 3. Building click zones (interactive hitboxes)
    for (const [zoneId, rect] of Object.entries(LAYOUT.buildingHitAreas)) {
      const zone = this.add
        .rectangle(
          rect.x + rect.w / 2,
          rect.y + rect.h / 2,
          rect.w,
          rect.h,
          0x000000,
          0, // invisible
        )
        .setInteractive({ cursor: 'pointer' })
        .setDepth(50);

      zone.on('pointerover', () => {
        zone.setFillStyle(0xffffff, 0.12);
      });
      zone.on('pointerout', () => {
        zone.setFillStyle(0x000000, 0);
      });
      zone.on('pointerdown', () => {
        // Emit event for React UI to handle interior overlay
        this.game.events.emit('zone-click', zoneId);
      });
    }

    // 4. Init agent manager
    initAgentManager(this);

    // 5. Spawn demo agents for testing
    this.spawnDemoAgents();
  }

  private spawnDemoAgents() {
    const demoAgents: AgentState[] = [
      { id: 'agent-alpha', name: 'Alpha', zone: 'library', isOnline: true },
      { id: 'agent-beta', name: 'Beta', zone: 'tavern', isOnline: true },
      { id: 'agent-gamma', name: 'Gamma', zone: 'lab', isOnline: true },
      { id: 'agent-delta', name: 'Delta', zone: 'town_center', isOnline: true },
      { id: 'agent-epsilon', name: 'Epsilon', zone: 'post_office', isOnline: true },
      { id: 'agent-zeta', name: 'Zeta', zone: 'workshop', isOnline: true },
      { id: 'agent-eta', name: 'Eta', zone: 'archive', isOnline: true },
      { id: 'agent-theta', name: 'Theta', zone: 'city_hall', isOnline: true },
    ];

    for (const agent of demoAgents) {
      upsertAgent(agent);
    }

    // After 3 seconds, trigger some movement for demo
    this.time.delayedCall(3000, () => {
      upsertAgent({ id: 'agent-alpha', name: 'Alpha', zone: 'tavern', isOnline: true });
      upsertAgent({ id: 'agent-beta', name: 'Beta', zone: 'lab', isOnline: true });
    });

    this.time.delayedCall(6000, () => {
      upsertAgent({ id: 'agent-gamma', name: 'Gamma', zone: 'city_hall', isOnline: true });
      upsertAgent({ id: 'agent-delta', name: 'Delta', zone: 'archive', isOnline: true });
    });
  }

  update(_time: number, _delta: number) {
    // Future: periodic state polling, bubble refresh, etc.
  }
}
