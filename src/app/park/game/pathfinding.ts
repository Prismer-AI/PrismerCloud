// Agent Park v2 — Waypoint-based road pathfinding
// BFS shortest path on pre-defined road network (no A*, no tilemap)

import {
  LAYOUT, ZONE_ENTRY,
  type ZoneId, type WaypointId, type NodeId, type Point,
} from './park-layout';

// Build adjacency list from road edges
const adjacency = new Map<WaypointId, WaypointId[]>();

for (const [a, b] of LAYOUT.roadEdges) {
  if (!adjacency.has(a)) adjacency.set(a, []);
  if (!adjacency.has(b)) adjacency.set(b, []);
  adjacency.get(a)!.push(b);
  adjacency.get(b)!.push(a);
}

/**
 * BFS shortest path between two waypoints.
 * Returns ordered array of waypoint IDs (inclusive of start and end).
 */
function bfsWaypoints(start: WaypointId, end: WaypointId): WaypointId[] {
  if (start === end) return [start];

  const visited = new Set<WaypointId>([start]);
  const parent = new Map<WaypointId, WaypointId>();
  const queue: WaypointId[] = [start];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adjacency.get(current) ?? [];

    for (const next of neighbors) {
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, current);

      if (next === end) {
        // Reconstruct path
        const path: WaypointId[] = [end];
        let node = end;
        while (parent.has(node)) {
          node = parent.get(node)!;
          path.unshift(node);
        }
        return path;
      }
      queue.push(next);
    }
  }

  // No path found (shouldn't happen in connected graph)
  return [start, end];
}

/**
 * Get the full point-path for an agent moving from one zone to another.
 * Returns array of (x, y) coordinates the agent should walk through:
 *   [zone_start] → [entry_waypoint] → [...road_waypoints] → [exit_waypoint] → [zone_end]
 */
export function findPath(fromZone: ZoneId, toZone: ZoneId): Point[] {
  if (fromZone === toZone) return [];

  const fromEntry = ZONE_ENTRY[fromZone];
  const toEntry = ZONE_ENTRY[toZone];
  const waypointPath = bfsWaypoints(fromEntry, toEntry);

  // Build full coordinate path
  const points: Point[] = [];

  // 1. Start at zone position
  points.push(LAYOUT.areas[fromZone]);

  // 2. Walk to entry waypoint (road)
  // (included in waypointPath[0], which is fromEntry)

  // 3. Walk through road waypoints
  for (const wp of waypointPath) {
    points.push(LAYOUT.waypoints[wp]);
  }

  // 4. Walk to destination zone
  points.push(LAYOUT.areas[toZone]);

  return points;
}

/**
 * Determine walk direction based on movement delta.
 * Returns the animation direction key.
 */
export function getDirection(dx: number, dy: number): 'down' | 'up' | 'left' | 'right' {
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? 'right' : 'left';
  }
  return dy > 0 ? 'down' : 'up';
}
