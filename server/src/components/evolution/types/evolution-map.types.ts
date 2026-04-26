/**
 * Evolution Map — Type Definitions (v0.4)
 *
 * Single zoomable canvas with cosmic metaphor:
 * L1 (Earth+Moon) → L2 (Solar System) → L3 (Orion Arm) → L4 (Galaxy)
 *
 * v0.4 changes (MAP-DESIGN v0.3.1 alignment):
 * - CommunityInfo replaces string-based ClusterInfo.id with numeric communityId
 * - GeneNodePosition / SignalNodePosition for layout internals
 * - EventMark for real-time capsule impact markers
 * - Coordinate space: [-5000, 5000] logical pixels
 */

// ─── SignalTag (from EVOLUTION-ENGINE.md §3.4.1) ────────

export interface SignalTag {
  type: string;
  provider?: string;
  stage?: string;
  severity?: string;
  [key: string]: string | undefined;
}

// ─── API Response ────────────────────────────────────────

export interface EvolutionMapData {
  signals: MapSignal[];
  genes: MapGene[];
  edges: MapEdge[];
  hyperedges?: MapHyperedge[];
  causalLinks?: MapCausalLink[];
  recentEvents: MapEvent[];
  stats: MapStats;
}

export interface MapHyperedge {
  id: string;
  atoms: Array<{ kind: string; value: string; role?: string | null }>;
}

export interface MapCausalLink {
  causeId: string;
  effectId: string;
  strength: number;
  linkType: string;
}

export interface MapSignal {
  key: string; // "error:timeout"
  category: string; // "error" | "task" | "capability" | "tag"
  frequency: number; // occurrences in last 30d
  lastSeen: string | null; // ISO timestamp
  signalTags?: SignalTag[]; // v0.3.0+: hierarchical tags
}

export interface MapGene {
  id: string;
  title: string;
  category: string; // "repair" | "optimize" | "innovate" | "diagnostic"
  successRate: number; // 0-1
  totalExecutions: number;
  agentCount: number;
  pqi: number; // 0-100
  strategySteps?: string[]; // v0.3.0: Gene strategy steps (if available from API)
}

export interface MapEdge {
  signalKey: string;
  geneId: string;
  alpha: number; // Beta distribution α ("有改善" count + 1)
  beta: number; // Beta distribution β ("无改善" count + 1)
  confidence: number; // α / (α + β) — kept for backward compat
  routingWeight?: number; // = confidence — P(gene 值得尝试 | signal 类别)
  totalObs: number; // α + β - 2
  isExploring: boolean; // totalObs < 10
  bimodalityIndex?: number; // 0-1, overdispersion (§3.4.5)
  taskSuccessRate?: number; // final task success rate (separate from routing weight)
  coverageLevel?: number; // 0=coarse, 1=medium, 2=fine match
}

export interface MapEvent {
  signalKey: string;
  geneId: string;
  outcome: 'success' | 'failed';
  agentName: string;
  timestamp: string;
}

export interface MapStats {
  totalExecutions: number;
  systemSuccessRate: number;
  activeAgents: number;
  explorationRate: number; // exploring edges / total edges
  totalSignals: number;
  totalGenes: number;
  totalEdges: number;
}

// ─── EvolutionStory (MAP-DESIGN §9.2) ───────────────────

export interface EvolutionStory {
  id: string;
  timestamp: string;
  agent: { id: string; name: string };
  task: { description: string; phase?: string };
  signal: { key: string; category: string; label: string };
  gene: { id: string; name: string; category: string; strategyPreview: string };
  outcome: 'success' | 'failed';
  effect: {
    actionDescription: string;
    resultSummary: string;
    geneSuccessRateBefore: number;
    geneSuccessRateAfter: number;
    successRateDelta: number;
    isExplorationEvent: boolean;
  };
}

// ─── Gene Shape ─────────────────────────────────────────

export type GeneShape = 'hexagon' | 'circle' | 'diamond';

export function categoryToShape(category: string): GeneShape {
  if (category === 'repair') return 'hexagon';
  if (category === 'innovate') return 'diamond';
  return 'circle'; // optimize + fallback
}

// ─── Render Mode (viewport-aware) ───────────────────────

export type RenderMode = 'full' | 'dim' | 'ghost' | 'hidden';

// ─── Community Detection (MAP-DESIGN §14) ───────────────

export type CommunityPhase = 'cold' | 'transition' | 'mature';

export interface CommunityInfo {
  communityId: number;
  label: string; // auto-named from dominant signal type
  geneIds: string[];
  center: { x: number; y: number };
  color: string; // domain-specific halo color
}

export interface CommunityDetectionResult {
  geneCommunities: Map<string, number>; // geneId → communityId
  communityLabels: Map<number, string>; // communityId → human-readable label
  communityMembership: Map<string, number>; // geneId → membership strength 0-1
  phase: CommunityPhase;
}

// ─── Layout: Gene Position (MAP-DESIGN §2.4) ────────────

export interface GeneNodePosition {
  geneId: string;
  x: number;
  y: number;
  communityId: number;
  communityMembership: number; // 0-1, < 0.5 = cross-domain gene
  clusterCenter: { x: number; y: number };
  mass: number; // = totalExecutions
}

// ─── Layout: Signal Position (MAP-DESIGN §2.3) ──────────

export interface SignalNodePosition {
  signalKey: string;
  x: number;
  y: number;
  primaryGeneId: string;
  orbitRadius: number;
  orbitAngle: number;
}

// ─── Layout: Event Mark (MAP-DESIGN §2.4) ───────────────

export interface EventMark {
  id: string;
  x: number;
  y: number;
  signalKey: string;
  geneId: string;
  outcome: 'success' | 'failed';
  agentName: string;
  timestamp: string;
  ttl: number; // ms remaining, fades after 30min
}

// ─── Layout Output ──────────────────────────────────────

export interface LayoutConfig {
  width: number;
  height: number;
  /** @deprecated old bipartite layout fields — kept for backward compat */
  signalColumnX?: number;
  geneColumnX?: number;
  paddingY?: number;
  signalGroupGap?: number;
  geneGroupGap?: number;
  categoryGap?: number;
}

/** @deprecated Use CommunityInfo instead for new code */
export interface ClusterInfo {
  id: string;
  label: string;
  geneIds: string[];
  center: { x: number; y: number };
}

export interface SignalNode {
  key: string;
  category: string;
  frequency: number;
  lastSeen: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  primaryGeneId?: string;
  orbitRadius?: number;
  orbitAngle?: number;
}

export interface GeneNode {
  id: string;
  title: string;
  category: string;
  shape?: GeneShape;
  successRate: number;
  totalExecutions: number;
  agentCount: number;
  pqi: number;
  strategySteps?: string[]; // v0.3.0: Gene strategy steps
  clusterId?: string;
  communityId?: number;
  communityMembership?: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EdgePath {
  signalKey: string;
  geneId: string;
  confidence: number;
  routingWeight?: number;
  totalObs: number;
  isExploring: boolean;
  alpha: number;
  beta: number;
  bimodalityIndex?: number;
  coverageLevel?: number;
  taskSuccessRate?: number;
  sx: number;
  sy: number;
  gx: number;
  gy: number;
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
  lineWidth: number;
  color: string;
  opacity: number;
}

export interface MapLayout {
  signalNodes: SignalNode[];
  geneNodes: GeneNode[];
  edges: EdgePath[];
  clusters?: CommunityInfo[];
  contentWidth: number;
  contentHeight: number;
  bounds?: { minX: number; maxX: number; minY: number; maxY: number };
  phase?: CommunityPhase;
  /** Max of width/height span — used by zoom-pan to compute adaptive level diameters */
  totalSpan?: number;
}

// ─── Animation ───────────────────────────────────────────

export interface Particle {
  edgeIdx: number;
  progress: number; // 0-1 along path
  speed: number; // per frame increment
  color: string;
  radius: number;
  opacity: number;
  isHighlight: boolean; // event-triggered highlight particle
  trail: { x: number; y: number; opacity: number }[];
}

export interface AnimatedOpacity {
  current: number;
  target: number;
}

export interface AnimationClock {
  time: number;
  frameCount: number;
}

export interface Ripple {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  opacity: number;
  color: string;
}

// ─── Interaction ─────────────────────────────────────────

export type HitType = 'signal' | 'gene' | 'edge' | 'cluster';

export interface HitResult {
  type: HitType;
  signalKey?: string;
  geneId?: string;
  clusterId?: string;
  node?: SignalNode | GeneNode;
  edge?: EdgePath;
}

export interface HoverState {
  active: boolean;
  hit: HitResult | null;
  connectedSignals: Set<string>;
  connectedGenes: Set<string>;
  connectedEdges: Set<string>;
}

/** L1=Focus (1-3 genes), L2=Cluster (one domain), L3=Full Map */
export type ZoomLevel = 1 | 2 | 3;

export interface MapViewState {
  zoom: number;
  panX: number;
  panY: number;
  zoomLevel: ZoomLevel;
}

// ─── Detail Panel ────────────────────────────────────────

export type DetailTarget =
  | { type: 'signal'; data: SignalNode; connectedGenes: GeneNode[]; connectedEdges: EdgePath[] }
  | { type: 'gene'; data: GeneNode; connectedSignals: SignalNode[]; connectedEdges: EdgePath[] }
  | { type: 'edge'; data: EdgePath; signal: SignalNode; gene: GeneNode }
  | null;
