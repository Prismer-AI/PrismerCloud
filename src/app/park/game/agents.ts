// Agent Park v2 — Agent rendering & movement manager

import * as Phaser from 'phaser';
import { LAYOUT, ZONE_META, type ZoneId, type Point } from './park-layout';
import { findPath, getDirection } from './pathfinding';

export interface AgentState {
  id: string;
  name: string;
  zone: ZoneId;
  status?: string;
  isOnline?: boolean;
}

interface AgentSprite {
  container: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Sprite;
  nameTag: Phaser.GameObjects.Text;
  statusEmoji: Phaser.GameObjects.Text;
  bubble: Phaser.GameObjects.Container | null;
  state: AgentState;
  variant: number; // 1-8
  currentZone: ZoneId;
  slotIndex: number;
  isMoving: boolean;
  pathQueue: Point[];
}

// Track slot occupancy
const slotOccupancy: Record<ZoneId, (string | null)[]> = {
  tavern: Array(8).fill(null),
  workshop: Array(8).fill(null),
  city_hall: Array(8).fill(null),
  post_office: Array(8).fill(null),
  library: Array(8).fill(null),
  archive: Array(8).fill(null),
  town_center: Array(8).fill(null),
  lab: Array(8).fill(null),
};

const agents = new Map<string, AgentSprite>();
let scene: Phaser.Scene;

// ─── Variant assignment via hash ───
function hashToVariant(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % LAYOUT.character.variants) + 1;
}

// ─── Slot management ───
function allocateSlot(zone: ZoneId, agentId: string): number {
  const slots = slotOccupancy[zone];
  // Already has a slot?
  const existing = slots.indexOf(agentId);
  if (existing >= 0) return existing;
  // Find empty slot
  const empty = slots.indexOf(null);
  if (empty >= 0) {
    slots[empty] = agentId;
    return empty;
  }
  // Overflow: stack at last slot
  return slots.length - 1;
}

function releaseSlot(zone: ZoneId, agentId: string) {
  const slots = slotOccupancy[zone];
  const idx = slots.indexOf(agentId);
  if (idx >= 0) slots[idx] = null;
}

// ─── Animation creation ───
function createAnimations(scene: Phaser.Scene) {
  for (let v = 1; v <= 8; v++) {
    const prefix = `f${v}`;
    for (const dir of ['down', 'left', 'right', 'up'] as const) {
      // Walk animation
      const walkKey = `${prefix}_walk_${dir}`;
      if (!scene.anims.exists(walkKey)) {
        scene.anims.create({
          key: walkKey,
          frames: scene.anims.generateFrameNames('characters', {
            prefix: `${prefix}_${dir}_`,
            start: 0,
            end: 2,
          }),
          frameRate: 8,
          repeat: -1,
        });
      }
      // Idle (single frame)
      const idleKey = `${prefix}_idle_${dir}`;
      if (!scene.anims.exists(idleKey)) {
        scene.anims.create({
          key: idleKey,
          frames: [{ key: 'characters', frame: `${prefix}_${dir}_0` }],
          frameRate: 1,
        });
      }
    }
  }
}

// ─── Init ───
export function initAgentManager(s: Phaser.Scene) {
  scene = s;
  createAnimations(scene);
}

// ─── Add or update agent ───
export function upsertAgent(state: AgentState) {
  const existing = agents.get(state.id);
  if (existing) {
    // Update state
    existing.state = state;
    existing.nameTag.setText(state.name);
    updateOnlineStatus(existing);

    // Zone changed? Move!
    if (existing.currentZone !== state.zone) {
      moveAgent(state.id, state.zone);
    }
    return;
  }

  // New agent — create sprite
  const variant = hashToVariant(state.id);
  const prefix = `f${variant}`;
  const startZone = state.zone;
  const slotIdx = allocateSlot(startZone, state.id);
  const slot = LAYOUT.areaSlots[startZone][slotIdx];

  const sprite = scene.add.sprite(0, -8, 'characters', `${prefix}_down_0`);
  sprite.setScale(LAYOUT.character.scale);

  const nameTag = scene.add.text(0, 14, state.name, {
    fontSize: '9px',
    fontFamily: 'monospace',
    color: '#ffffff',
    backgroundColor: '#00000088',
    padding: { x: 3, y: 1 },
    align: 'center',
  }).setOrigin(0.5, 0);

  const statusEmoji = scene.add.text(0, -26, '', {
    fontSize: '12px',
  }).setOrigin(0.5, 1).setAlpha(0);

  const container = scene.add.container(slot.x, slot.y, [sprite, nameTag, statusEmoji]);
  container.setDepth(LAYOUT.character.depth);
  container.setSize(32, 32);

  const agent: AgentSprite = {
    container, sprite, nameTag, statusEmoji,
    bubble: null,
    state,
    variant,
    currentZone: startZone,
    slotIndex: slotIdx,
    isMoving: false,
    pathQueue: [],
  };

  agents.set(state.id, agent);
  sprite.play(`${prefix}_idle_down`);
  updateOnlineStatus(agent);
}

// ─── Move agent along road waypoints ───
export function moveAgent(agentId: string, targetZone: ZoneId) {
  const agent = agents.get(agentId);
  if (!agent || agent.isMoving) return;

  const path = findPath(agent.currentZone, targetZone);
  if (path.length === 0) return;

  // Release old slot
  releaseSlot(agent.currentZone, agentId);

  // Allocate new slot at destination
  const newSlot = allocateSlot(targetZone, agentId);
  const finalPos = LAYOUT.areaSlots[targetZone][newSlot];

  // Replace last point with exact slot position
  path[path.length - 1] = finalPos;

  agent.isMoving = true;
  agent.pathQueue = path;
  agent.slotIndex = newSlot;

  // Show destination emoji
  const meta = ZONE_META[targetZone];
  agent.statusEmoji.setText(meta.emoji);
  agent.statusEmoji.setAlpha(1);

  // Start walking the path
  walkNextSegment(agent, targetZone);
}

function walkNextSegment(agent: AgentSprite, targetZone: ZoneId) {
  const next = agent.pathQueue.shift();
  if (!next) {
    // Arrived!
    agent.isMoving = false;
    agent.currentZone = targetZone;
    const prefix = `f${agent.variant}`;
    agent.sprite.play(`${prefix}_idle_down`);

    // Fade emoji after arrival
    scene.tweens.add({
      targets: agent.statusEmoji,
      alpha: 0,
      delay: 800,
      duration: 400,
    });

    // Breathing micro-animation
    scene.tweens.add({
      targets: agent.container,
      y: agent.container.y + 1.5,
      duration: 1200,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    return;
  }

  const dx = next.x - agent.container.x;
  const dy = next.y - agent.container.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const duration = (dist / LAYOUT.character.walkSpeed) * 1000;

  // Play walk animation with correct direction
  const dir = getDirection(dx, dy);
  const prefix = `f${agent.variant}`;
  agent.sprite.play(`${prefix}_walk_${dir}`, true);

  // Stop any existing breathing tween
  scene.tweens.killTweensOf(agent.container);

  scene.tweens.add({
    targets: agent.container,
    x: next.x,
    y: next.y,
    duration: Math.max(duration, 100),
    ease: 'Linear',
    onComplete: () => walkNextSegment(agent, targetZone),
  });
}

// ─── Online/offline appearance ───
function updateOnlineStatus(agent: AgentSprite) {
  agent.container.setAlpha(agent.state.isOnline === false ? 0.35 : 1);
}

// ─── Remove agent ───
export function removeAgent(agentId: string) {
  const agent = agents.get(agentId);
  if (!agent) return;

  releaseSlot(agent.currentZone, agentId);
  scene.tweens.add({
    targets: agent.container,
    alpha: 0,
    duration: 500,
    onComplete: () => {
      agent.container.destroy();
      agents.delete(agentId);
    },
  });
}

// ─── Show chat bubble ───
export function showBubble(agentId: string, text: string) {
  const agent = agents.get(agentId);
  if (!agent) return;

  // Remove existing bubble
  if (agent.bubble) {
    agent.bubble.destroy();
    agent.bubble = null;
  }

  const maxW = LAYOUT.bubble.maxWidth;
  const displayText = text.length > 40 ? text.slice(0, 37) + '...' : text;

  const bubbleText = scene.add.text(0, 0, displayText, {
    fontSize: '8px',
    fontFamily: 'monospace',
    color: '#000000',
    wordWrap: { width: maxW - 8 },
    align: 'center',
  }).setOrigin(0.5, 1);

  const bubbleW = Math.min(maxW, bubbleText.width + 10);
  const bubbleH = bubbleText.height + 6;

  const bubbleBg = scene.add.rectangle(0, -bubbleText.height / 2, bubbleW, bubbleH, 0xffffff, 0.9)
    .setStrokeStyle(1, 0x333333)
    .setOrigin(0.5, 0.5);

  const bubbleContainer = scene.add.container(0, LAYOUT.bubble.offsetY - 10, [bubbleBg, bubbleText]);
  bubbleContainer.setDepth(LAYOUT.bubble.depth);

  agent.container.add(bubbleContainer);
  agent.bubble = bubbleContainer;

  // Fade out after duration
  scene.tweens.add({
    targets: bubbleContainer,
    alpha: 0,
    delay: LAYOUT.bubble.duration,
    duration: 400,
    onComplete: () => {
      bubbleContainer.destroy();
      if (agent.bubble === bubbleContainer) agent.bubble = null;
    },
  });
}

// ─── Get all agents (for React UI) ───
export function getAgentStates(): AgentState[] {
  return Array.from(agents.values()).map(a => a.state);
}

export function getAgentCount(): number {
  return agents.size;
}
