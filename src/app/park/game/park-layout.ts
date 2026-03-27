// Agent Park v2 — Layout Configuration
// All coordinates based on town-bg.webp (1280×720, Gemini-generated modern city)
// No magic numbers — everything defined here

export type ZoneId =
  | 'tavern'
  | 'workshop'
  | 'city_hall'
  | 'post_office'
  | 'library'
  | 'archive'
  | 'town_center'
  | 'lab';

export type WaypointId =
  | 'road_TL' | 'road_TML' | 'road_TC' | 'road_TMR' | 'road_TR'
  | 'road_CL' | 'road_CML' | 'road_CC' | 'road_CMR' | 'road_CR'
  | 'road_BL' | 'road_BC'  | 'road_BR';

export type NodeId = ZoneId | WaypointId;

export interface Point { x: number; y: number }

// ─── Zone → Waypoint entry point mapping ───
export const ZONE_ENTRY: Record<ZoneId, WaypointId> = {
  tavern:      'road_TL',
  workshop:    'road_TML',
  city_hall:   'road_TC',
  post_office: 'road_TMR',
  library:     'road_TR',
  archive:     'road_BL',
  town_center: 'road_CC',
  lab:         'road_BR',
};

// ─── Zone label + emoji for UI ───
export const ZONE_META: Record<ZoneId, { label: string; emoji: string }> = {
  tavern:      { label: 'Tavern',      emoji: '💬' },
  workshop:    { label: 'Workshop',    emoji: '🔧' },
  city_hall:   { label: 'City Hall',   emoji: '🏛️' },
  post_office: { label: 'Post Office', emoji: '✉️' },
  library:     { label: 'Library',     emoji: '📚' },
  archive:     { label: 'Archive',     emoji: '🗄️' },
  town_center: { label: 'Town Center', emoji: '⛲' },
  lab:         { label: 'Laboratory',  emoji: '🔬' },
};

// ─── Slot generation (8 slots per zone, 2 rows × 4 cols around center) ───
function generateSlots(cx: number, cy: number, dx = 24, dy = 20): Point[] {
  return [
    { x: cx - dx * 1.5, y: cy },
    { x: cx - dx * 0.5, y: cy },
    { x: cx + dx * 0.5, y: cy },
    { x: cx + dx * 1.5, y: cy },
    { x: cx - dx * 1.5, y: cy + dy },
    { x: cx - dx * 0.5, y: cy + dy },
    { x: cx + dx * 0.5, y: cy + dy },
    { x: cx + dx * 1.5, y: cy + dy },
  ];
}

// ─── Main layout ───
export const LAYOUT = {
  game: { width: 1280, height: 720 },

  // Background asset key
  bgKey: 'town-bg',

  // 8 zone positions — building entrance (where agents stand)
  areas: {
    tavern:      { x: 204, y: 220 },
    workshop:    { x: 428, y: 225 },
    city_hall:   { x: 640, y: 205 },
    post_office: { x: 860, y: 220 },
    library:     { x: 1102, y: 245 },
    archive:     { x: 265, y: 505 },
    town_center: { x: 640, y: 365 },
    lab:         { x: 1023, y: 505 },
  } as Record<ZoneId, Point>,

  // 8 slots per zone for agent placement
  areaSlots: {
    tavern:      generateSlots(204, 230),
    workshop:    generateSlots(428, 235),
    city_hall:   generateSlots(640, 215),
    post_office: generateSlots(860, 230),
    library:     generateSlots(1102, 255),
    archive:     generateSlots(265, 515),
    town_center: generateSlots(640, 375, 28, 24),
    lab:         generateSlots(1023, 515),
  } as Record<ZoneId, Point[]>,

  // Zone labels (rendered by Phaser text overlay)
  labels: {
    tavern:      { x: 204, y: 155, text: 'Tavern' },
    workshop:    { x: 428, y: 158, text: 'Workshop' },
    city_hall:   { x: 640, y: 130, text: 'City Hall' },
    post_office: { x: 860, y: 155, text: 'Post Office' },
    library:     { x: 1102, y: 168, text: 'Library' },
    archive:     { x: 265, y: 445, text: 'Archive' },
    town_center: { x: 640, y: 310, text: 'Town Center' },
    lab:         { x: 1023, y: 445, text: 'Laboratory' },
  } as Record<ZoneId, Point & { text: string }>,

  // Building click hitboxes (for interior overlay)
  buildingHitAreas: {
    tavern:      { x: 130, y: 130, w: 150, h: 100 },
    workshop:    { x: 355, y: 130, w: 150, h: 100 },
    city_hall:   { x: 565, y: 100, w: 155, h: 120 },
    post_office: { x: 785, y: 130, w: 150, h: 100 },
    library:     { x: 1025, y: 140, w: 155, h: 110 },
    archive:     { x: 190, y: 420, w: 155, h: 100 },
    town_center: { x: 570, y: 290, w: 140, h: 140 },
    lab:         { x: 945, y: 420, w: 160, h: 100 },
  } as Record<ZoneId, { x: number; y: number; w: number; h: number }>,

  // Road waypoint positions
  waypoints: {
    road_TL:  { x: 204, y: 270 },
    road_TML: { x: 428, y: 270 },
    road_TC:  { x: 640, y: 260 },
    road_TMR: { x: 860, y: 270 },
    road_TR:  { x: 1102, y: 290 },
    road_CL:  { x: 204, y: 380 },
    road_CML: { x: 428, y: 380 },
    road_CC:  { x: 640, y: 380 },
    road_CMR: { x: 860, y: 380 },
    road_CR:  { x: 1102, y: 380 },
    road_BL:  { x: 265, y: 480 },
    road_BC:  { x: 640, y: 520 },
    road_BR:  { x: 1023, y: 480 },
  } as Record<WaypointId, Point>,

  // Road connections (bidirectional edges)
  roadEdges: [
    // Top horizontal
    ['road_TL', 'road_TML'], ['road_TML', 'road_TC'],
    ['road_TC', 'road_TMR'], ['road_TMR', 'road_TR'],
    // Center horizontal
    ['road_CL', 'road_CML'], ['road_CML', 'road_CC'],
    ['road_CC', 'road_CMR'], ['road_CMR', 'road_CR'],
    // Bottom horizontal
    ['road_BL', 'road_BC'], ['road_BC', 'road_BR'],
    // Left vertical
    ['road_TL', 'road_CL'], ['road_CL', 'road_BL'],
    // Center-left vertical
    ['road_TML', 'road_CML'],
    // Center vertical
    ['road_TC', 'road_CC'], ['road_CC', 'road_BC'],
    // Center-right vertical
    ['road_TMR', 'road_CMR'],
    // Right vertical
    ['road_TR', 'road_CR'], ['road_CR', 'road_BR'],
  ] as [WaypointId, WaypointId][],

  // Agent sprite config
  character: {
    frameWidth: 32,
    frameHeight: 32,
    scale: 1.5,
    walkSpeed: 100,     // pixels per second
    variants: 8,        // f1-f8
    depth: 500,
  },

  // Bubble config
  bubble: {
    offsetY: -28,
    maxWidth: 120,
    duration: 3000,
    depth: 600,
  },

  // Total asset count (for loading bar)
  totalAssets: 3, // town-bg, characters, characters-json
};
