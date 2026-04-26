/**
 * Evolution Map — Community Detection (Louvain Algorithm)
 *
 * Detects functional domains among genes based on shared signal co-occurrence.
 * Three phases depending on data density:
 *   - cold (< 20 edges):       category-prefix fallback grouping
 *   - transition (20-99 edges): Louvain with resolution 0.5
 *   - mature (>= 100 edges):   Louvain with resolution 1.0
 */

import type { MapEdge, MapGene, MapSignal, CommunityPhase } from '../../types/evolution-map.types';

// ─── Public interface ────────────────────────────────────────

export interface CommunityResult {
  geneCommunities: Map<string, number>; // geneId -> communityId
  communityLabels: Map<number, string>; // communityId -> human-readable label
  communityMembership: Map<string, number>; // geneId -> membership strength 0-1
  phase: CommunityPhase;
}

// ─── Entry point ─────────────────────────────────────────────

/** Minimum genes per cluster — smaller ones get merged into nearest neighbor */
const MIN_CLUSTER_SIZE = 3;

export function detectDomains(edges: MapEdge[], genes: MapGene[], signals: MapSignal[]): CommunityResult {
  // Count non-trivial edges (edges where at least one observation has been made)
  const nonZeroEdges = edges.filter((e) => e.totalObs > 0);
  const nonZeroCount = nonZeroEdges.length;

  // Determine phase and resolution
  let result: CommunityResult;
  if (nonZeroCount < 20) {
    result = coldStartFallback(edges, genes, signals);
  } else {
    const resolution = nonZeroCount < 100 ? 0.5 : 1.0;
    const phase: CommunityPhase = nonZeroCount < 100 ? 'transition' : 'mature';

    // Step 1: Build gene-gene co-occurrence graph from shared signals
    const coGraph = buildCoOccurrenceGraph(edges);

    // Step 2: Run Louvain community detection
    const geneIds = genes.map((g) => g.id);
    const communities = louvain(geneIds, coGraph, resolution);

    // Step 3: Compute membership strength per gene
    const membership = computeMembership(geneIds, communities, coGraph);

    // Step 4: Label each community by most frequent signal prefix
    const labels = labelCommunities(communities, edges, signals);

    result = {
      geneCommunities: communities,
      communityLabels: labels,
      communityMembership: membership,
      phase,
    };
  }

  // Post-process: merge tiny clusters into nearest larger neighbor
  return mergeSmallCommunities(result, genes, edges);
}

// ─── Cold start fallback ─────────────────────────────────────

/**
 * When data is sparse (< 20 edges), group genes by the most common
 * signal category prefix they are connected to.
 */
function coldStartFallback(edges: MapEdge[], genes: MapGene[], _signals: MapSignal[]): CommunityResult {
  // Map geneId -> array of signal keys it connects to
  const geneSignals = new Map<string, string[]>();
  for (const e of edges) {
    const arr = geneSignals.get(e.geneId) ?? [];
    arr.push(e.signalKey);
    geneSignals.set(e.geneId, arr);
  }

  // For each gene, find dominant signal prefix (the part before ':')
  const genePrefixes = new Map<string, string>();
  for (const gene of genes) {
    const sigs = geneSignals.get(gene.id) ?? [];
    const prefixCounts = new Map<string, number>();
    for (const sig of sigs) {
      const prefix = sig.split(':')[0] || 'unknown';
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
    // Fallback to gene category if no signals
    let bestPrefix = gene.category || 'unknown';
    let bestCount = 0;
    for (const [prefix, count] of prefixCounts) {
      if (count > bestCount) {
        bestPrefix = prefix;
        bestCount = count;
      }
    }
    genePrefixes.set(gene.id, bestPrefix);
  }

  // Assign community IDs by unique prefix
  const prefixToId = new Map<string, number>();
  let nextId = 0;
  const geneCommunities = new Map<string, number>();
  const communityLabels = new Map<number, string>();
  const communityMembership = new Map<string, number>();

  for (const gene of genes) {
    const prefix = genePrefixes.get(gene.id) ?? 'unknown';
    if (!prefixToId.has(prefix)) {
      const id = nextId++;
      prefixToId.set(prefix, id);
      communityLabels.set(id, prefix);
    }
    const communityId = prefixToId.get(prefix)!;
    geneCommunities.set(gene.id, communityId);
    communityMembership.set(gene.id, 1.0); // full membership in cold start
  }

  return {
    geneCommunities,
    communityLabels,
    communityMembership,
    phase: 'cold',
  };
}

// ─── Co-occurrence graph ─────────────────────────────────────

/**
 * Build an undirected weighted graph between genes that share signals.
 * Weight = number of shared signals between each gene pair.
 *
 * Returns adjacency as Map<geneId, Map<geneId, weight>>.
 */
function buildCoOccurrenceGraph(edges: MapEdge[]): Map<string, Map<string, number>> {
  // Group gene IDs by signal key
  const signalGenes = new Map<string, string[]>();
  for (const e of edges) {
    if (e.totalObs <= 0) continue;
    const arr = signalGenes.get(e.signalKey) ?? [];
    arr.push(e.geneId);
    signalGenes.set(e.signalKey, arr);
  }

  // For each signal, every pair of connected genes shares that signal
  const graph = new Map<string, Map<string, number>>();

  const ensureNode = (id: string) => {
    if (!graph.has(id)) graph.set(id, new Map());
  };

  for (const [, geneIds] of signalGenes) {
    // Deduplicate genes per signal
    const unique = [...new Set(geneIds)];
    for (let i = 0; i < unique.length; i++) {
      ensureNode(unique[i]);
      for (let j = i + 1; j < unique.length; j++) {
        ensureNode(unique[j]);
        const a = unique[i];
        const b = unique[j];
        const mapA = graph.get(a)!;
        const mapB = graph.get(b)!;
        mapA.set(b, (mapA.get(b) ?? 0) + 1);
        mapB.set(a, (mapB.get(a) ?? 0) + 1);
      }
    }
  }

  return graph;
}

// ─── Louvain algorithm ───────────────────────────────────────

/**
 * Simplified Louvain community detection.
 *
 * Phase 1: Greedy modularity optimization — each node moves to the
 *          neighbor community yielding the maximum modularity gain.
 * Phase 2: Aggregate communities into super-nodes, rebuild graph, repeat.
 *
 * Returns geneId -> communityId mapping.
 */
function louvain(
  geneIds: string[],
  coGraph: Map<string, Map<string, number>>,
  resolution: number,
): Map<string, number> {
  // Initialize: each gene is its own community
  const nodeToCommunity = new Map<string, number>();
  for (let i = 0; i < geneIds.length; i++) {
    nodeToCommunity.set(geneIds[i], i);
  }

  // Build weighted degree (sum of edge weights for each node) and total weight
  let totalWeight = 0;
  const nodeDegree = new Map<string, number>();
  for (const geneId of geneIds) {
    let deg = 0;
    const neighbors = coGraph.get(geneId);
    if (neighbors) {
      for (const [, w] of neighbors) {
        deg += w;
      }
    }
    nodeDegree.set(geneId, deg);
    totalWeight += deg;
  }
  totalWeight /= 2; // each edge counted twice

  if (totalWeight === 0) {
    // No edges — every gene stays in its own community
    return nodeToCommunity;
  }

  const m2 = 2 * totalWeight; // = sum of all edge weights (each edge counted once per side)

  // Phase 1: Local moves
  const MAX_ITERATIONS = 50;
  let improved = true;
  let iteration = 0;

  // Track the sum of degrees for each community (sigma_tot)
  const communityTotalDegree = new Map<number, number>();
  // Track the sum of internal edges for each community (sigma_in)
  const communityInternalWeight = new Map<number, number>();

  // Initialize community stats
  for (const geneId of geneIds) {
    const cId = nodeToCommunity.get(geneId)!;
    const deg = nodeDegree.get(geneId) ?? 0;
    communityTotalDegree.set(cId, (communityTotalDegree.get(cId) ?? 0) + deg);
    // Self-loops contribute to internal weight; initially each node is alone
    communityInternalWeight.set(cId, 0);
  }

  while (improved && iteration < MAX_ITERATIONS) {
    improved = false;
    iteration++;

    for (const nodeId of geneIds) {
      const currentCommunity = nodeToCommunity.get(nodeId)!;
      const ki = nodeDegree.get(nodeId) ?? 0; // degree of this node
      const neighbors = coGraph.get(nodeId);

      if (!neighbors || neighbors.size === 0) continue;

      // Compute weight from this node to each neighboring community
      const communityEdgeWeight = new Map<number, number>();
      for (const [neighborId, w] of neighbors) {
        const neighborComm = nodeToCommunity.get(neighborId)!;
        communityEdgeWeight.set(neighborComm, (communityEdgeWeight.get(neighborComm) ?? 0) + w);
      }

      // Weight to own community
      const kiIn = communityEdgeWeight.get(currentCommunity) ?? 0;

      // Evaluate removing node from current community
      const sigmaTotCurrent = communityTotalDegree.get(currentCommunity) ?? 0;

      let bestGain = 0;
      let bestCommunity = currentCommunity;

      for (const [candidateComm, kiCandidate] of communityEdgeWeight) {
        if (candidateComm === currentCommunity) continue;

        const sigmaTotCandidate = communityTotalDegree.get(candidateComm) ?? 0;

        // Modularity gain of moving node from current to candidate community
        // dQ = [kiCandidate/m - resolution * sigmaTotCandidate * ki / (m*m)]
        //    - [kiIn/m - resolution * (sigmaTotCurrent - ki) * ki / (m*m)]
        const gain =
          (kiCandidate - kiIn) / m2 - (resolution * ki * (sigmaTotCandidate - sigmaTotCurrent + ki)) / (m2 * m2);

        if (gain > bestGain) {
          bestGain = gain;
          bestCommunity = candidateComm;
        }
      }

      if (bestCommunity !== currentCommunity) {
        improved = true;

        // Remove node from current community
        communityTotalDegree.set(currentCommunity, (communityTotalDegree.get(currentCommunity) ?? 0) - ki);
        communityInternalWeight.set(currentCommunity, (communityInternalWeight.get(currentCommunity) ?? 0) - 2 * kiIn);

        // Add node to new community
        const kiBest = communityEdgeWeight.get(bestCommunity) ?? 0;
        communityTotalDegree.set(bestCommunity, (communityTotalDegree.get(bestCommunity) ?? 0) + ki);
        communityInternalWeight.set(bestCommunity, (communityInternalWeight.get(bestCommunity) ?? 0) + 2 * kiBest);

        nodeToCommunity.set(nodeId, bestCommunity);
      }
    }
  }

  // Phase 2: Aggregate and repeat (one level of aggregation)
  // Re-number communities to be contiguous
  const communitySet = new Set(nodeToCommunity.values());
  const reMap = new Map<number, number>();
  let nextCommunityId = 0;
  for (const cId of communitySet) {
    if (!reMap.has(cId)) {
      reMap.set(cId, nextCommunityId++);
    }
  }

  // Build super-node graph (community-level)
  const superEdges = new Map<number, Map<number, number>>();
  const ensureSuperNode = (id: number) => {
    if (!superEdges.has(id)) superEdges.set(id, new Map());
  };

  for (const [nodeId, neighbors] of coGraph) {
    const commA = reMap.get(nodeToCommunity.get(nodeId)!)!;
    ensureSuperNode(commA);
    if (!neighbors) continue;
    for (const [neighborId, w] of neighbors) {
      const commB = reMap.get(nodeToCommunity.get(neighborId)!)!;
      if (commA === commB) continue; // internal edge
      ensureSuperNode(commB);
      const mapA = superEdges.get(commA)!;
      mapA.set(commB, (mapA.get(commB) ?? 0) + w);
    }
  }

  // Run another round of local moves on super-nodes
  const superNodes = [...new Set(reMap.values())];
  const superNodeToCommunity = new Map<number, number>();
  for (const sn of superNodes) {
    superNodeToCommunity.set(sn, sn);
  }

  // Compute super-node degrees
  let superTotalWeight = 0;
  const superDegree = new Map<number, number>();
  for (const sn of superNodes) {
    let deg = 0;
    const neighbors = superEdges.get(sn);
    if (neighbors) {
      for (const [, w] of neighbors) deg += w;
    }
    superDegree.set(sn, deg);
    superTotalWeight += deg;
  }
  superTotalWeight /= 2;

  if (superTotalWeight > 0) {
    const sm2 = 2 * superTotalWeight;
    const superCommDegree = new Map<number, number>();
    for (const sn of superNodes) {
      const cId = superNodeToCommunity.get(sn)!;
      superCommDegree.set(cId, (superCommDegree.get(cId) ?? 0) + (superDegree.get(sn) ?? 0));
    }

    let superImproved = true;
    let superIter = 0;
    while (superImproved && superIter < 20) {
      superImproved = false;
      superIter++;

      for (const sn of superNodes) {
        const currentComm = superNodeToCommunity.get(sn)!;
        const ki = superDegree.get(sn) ?? 0;
        const neighbors = superEdges.get(sn);
        if (!neighbors || neighbors.size === 0) continue;

        const commWeights = new Map<number, number>();
        for (const [neighborSn, w] of neighbors) {
          const nComm = superNodeToCommunity.get(neighborSn)!;
          commWeights.set(nComm, (commWeights.get(nComm) ?? 0) + w);
        }

        const kiIn = commWeights.get(currentComm) ?? 0;
        const sigmaCurrent = superCommDegree.get(currentComm) ?? 0;

        let bestGain = 0;
        let bestComm = currentComm;

        for (const [candidateComm, kiCandidate] of commWeights) {
          if (candidateComm === currentComm) continue;
          const sigmaCandidate = superCommDegree.get(candidateComm) ?? 0;
          const gain =
            (kiCandidate - kiIn) / sm2 - (resolution * ki * (sigmaCandidate - sigmaCurrent + ki)) / (sm2 * sm2);
          if (gain > bestGain) {
            bestGain = gain;
            bestComm = candidateComm;
          }
        }

        if (bestComm !== currentComm) {
          superImproved = true;
          superCommDegree.set(currentComm, (superCommDegree.get(currentComm) ?? 0) - ki);
          superCommDegree.set(bestComm, (superCommDegree.get(bestComm) ?? 0) + ki);
          superNodeToCommunity.set(sn, bestComm);
        }
      }
    }
  }

  // Map genes to final community IDs
  // gene -> first-level community -> super-community
  const finalCommunities = new Map<string, number>();
  for (const geneId of geneIds) {
    const firstLevel = reMap.get(nodeToCommunity.get(geneId)!)!;
    const secondLevel = superNodeToCommunity.get(firstLevel) ?? firstLevel;
    finalCommunities.set(geneId, secondLevel);
  }

  // Re-number final communities to be contiguous starting from 0
  const finalSet = new Set(finalCommunities.values());
  const finalReMap = new Map<number, number>();
  let finalNextId = 0;
  for (const cId of finalSet) {
    if (!finalReMap.has(cId)) {
      finalReMap.set(cId, finalNextId++);
    }
  }

  const result = new Map<string, number>();
  for (const [geneId, cId] of finalCommunities) {
    result.set(geneId, finalReMap.get(cId)!);
  }

  return result;
}

// ─── Membership strength ─────────────────────────────────────

/**
 * Compute how strongly each gene belongs to its assigned community.
 *
 * Membership = (intra-community edge weight) / (total edge weight).
 * A gene with all connections inside its community gets 1.0.
 * A gene bridging multiple communities gets < 0.5.
 */
function computeMembership(
  geneIds: string[],
  communities: Map<string, number>,
  coGraph: Map<string, Map<string, number>>,
): Map<string, number> {
  const membership = new Map<string, number>();

  for (const geneId of geneIds) {
    const myCommunity = communities.get(geneId);
    const neighbors = coGraph.get(geneId);

    if (!neighbors || neighbors.size === 0 || myCommunity === undefined) {
      // Isolated gene — full membership by default
      membership.set(geneId, 1.0);
      continue;
    }

    let intraWeight = 0;
    let totalWeight = 0;

    for (const [neighborId, w] of neighbors) {
      totalWeight += w;
      if (communities.get(neighborId) === myCommunity) {
        intraWeight += w;
      }
    }

    membership.set(geneId, totalWeight > 0 ? intraWeight / totalWeight : 1.0);
  }

  return membership;
}

// ─── Community labeling ──────────────────────────────────────

/**
 * Label each community by the most frequent signal key prefix
 * among signals connected to genes in that community.
 */
function labelCommunities(
  communities: Map<string, number>,
  edges: MapEdge[],
  _signals: MapSignal[],
): Map<number, string> {
  // Gather signal keys per community
  const communitySignals = new Map<number, string[]>();
  for (const e of edges) {
    const cId = communities.get(e.geneId);
    if (cId === undefined) continue;
    const arr = communitySignals.get(cId) ?? [];
    arr.push(e.signalKey);
    communitySignals.set(cId, arr);
  }

  const labels = new Map<number, string>();

  for (const [communityId, signalKeys] of communitySignals) {
    // Count prefix frequencies
    const prefixCounts = new Map<string, number>();
    for (const key of signalKeys) {
      const prefix = key.split(':')[0] || 'unknown';
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }

    let bestPrefix = 'domain';
    let bestCount = 0;
    for (const [prefix, count] of prefixCounts) {
      if (count > bestCount) {
        bestPrefix = prefix;
        bestCount = count;
      }
    }

    labels.set(communityId, bestPrefix);
  }

  // Ensure all communities have a label (even if they have no edges)
  for (const cId of new Set(communities.values())) {
    if (!labels.has(cId)) {
      labels.set(cId, `domain-${cId}`);
    }
  }

  return labels;
}

// ─── Post-processing: merge small clusters ─────────────────

/**
 * Merge communities with fewer than MIN_CLUSTER_SIZE genes into the
 * nearest larger community (by shared-signal connectivity).
 *
 * If no larger neighbor is found, merge small clusters that share
 * the same label (prefix) together.
 */
function mergeSmallCommunities(result: CommunityResult, genes: MapGene[], edges: MapEdge[]): CommunityResult {
  const { geneCommunities, communityLabels, communityMembership, phase } = result;

  // Count genes per community
  const commSizes = new Map<number, number>();
  for (const [, cId] of geneCommunities) {
    commSizes.set(cId, (commSizes.get(cId) ?? 0) + 1);
  }

  // Identify small vs large communities
  const smallComms = new Set<number>();
  const largeComms = new Set<number>();
  for (const [cId, size] of commSizes) {
    if (size < MIN_CLUSTER_SIZE) smallComms.add(cId);
    else largeComms.add(cId);
  }

  if (smallComms.size === 0) return result;

  // Build adjacency: gene -> signal keys, signal -> gene ids
  const geneToSignals = new Map<string, string[]>();
  const signalToGenes = new Map<string, string[]>();
  for (const e of edges) {
    const arr1 = geneToSignals.get(e.geneId) ?? [];
    arr1.push(e.signalKey);
    geneToSignals.set(e.geneId, arr1);
    const arr2 = signalToGenes.get(e.signalKey) ?? [];
    arr2.push(e.geneId);
    signalToGenes.set(e.signalKey, arr2);
  }

  const newCommunities = new Map(geneCommunities);

  // Pass 1: merge small-comm genes into nearest LARGE community
  for (const gene of genes) {
    const currentComm = newCommunities.get(gene.id);
    if (currentComm === undefined || !smallComms.has(currentComm)) continue;

    // Find neighboring communities via shared signals
    const neighborCommWeights = new Map<number, number>();
    const sigs = geneToSignals.get(gene.id) ?? [];
    for (const sig of sigs) {
      const otherGenes = signalToGenes.get(sig) ?? [];
      for (const otherGeneId of otherGenes) {
        if (otherGeneId === gene.id) continue;
        const otherComm = newCommunities.get(otherGeneId);
        if (otherComm !== undefined && largeComms.has(otherComm)) {
          neighborCommWeights.set(otherComm, (neighborCommWeights.get(otherComm) ?? 0) + 1);
        }
      }
    }

    if (neighborCommWeights.size > 0) {
      let bestComm = currentComm;
      let bestWeight = 0;
      for (const [comm, weight] of neighborCommWeights) {
        if (weight > bestWeight) {
          bestWeight = weight;
          bestComm = comm;
        }
      }
      newCommunities.set(gene.id, bestComm);
    }
  }

  // Pass 2: merge remaining small clusters that share the same label
  const labelToLargestSmallComm = new Map<string, number>();
  // Recount sizes after pass 1
  const sizes2 = new Map<number, number>();
  for (const [, cId] of newCommunities) {
    sizes2.set(cId, (sizes2.get(cId) ?? 0) + 1);
  }

  // For each still-small community, pick one representative per label
  for (const [cId, size] of sizes2) {
    if (size >= MIN_CLUSTER_SIZE) continue;
    const label = communityLabels.get(cId) ?? 'unknown';
    const existing = labelToLargestSmallComm.get(label);
    if (existing === undefined || size > (sizes2.get(existing) ?? 0)) {
      labelToLargestSmallComm.set(label, cId);
    }
  }

  for (const gene of genes) {
    const currentComm = newCommunities.get(gene.id);
    if (currentComm === undefined) continue;
    if ((sizes2.get(currentComm) ?? 0) >= MIN_CLUSTER_SIZE) continue;

    const label = communityLabels.get(currentComm) ?? 'unknown';
    const mergeTarget = labelToLargestSmallComm.get(label);
    if (mergeTarget !== undefined && mergeTarget !== currentComm) {
      newCommunities.set(gene.id, mergeTarget);
    }
  }

  // Re-number communities contiguously
  const usedComms = new Set(newCommunities.values());
  const reMap = new Map<number, number>();
  let nextId = 0;
  for (const cId of usedComms) {
    reMap.set(cId, nextId++);
  }

  const finalCommunities = new Map<string, number>();
  for (const [geneId, cId] of newCommunities) {
    finalCommunities.set(geneId, reMap.get(cId)!);
  }

  // Re-label
  const finalLabels = new Map<number, string>();
  for (const [oldId, newId] of reMap) {
    finalLabels.set(newId, communityLabels.get(oldId) ?? `domain-${newId}`);
  }

  // Transfer membership
  const finalMembership = new Map<string, number>();
  for (const gene of genes) {
    finalMembership.set(gene.id, communityMembership.get(gene.id) ?? 1.0);
  }

  return {
    geneCommunities: finalCommunities,
    communityLabels: finalLabels,
    communityMembership: finalMembership,
    phase,
  };
}
