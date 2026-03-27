/**
 * Evolution Sub-module: Hypergraph Layer
 *
 * Mode resolution, hypergraph writes (atoms, hyperedges, causal links),
 * and hypergraph queries for candidate gene discovery.
 */

import prisma from '../db';
import type { SignalTag } from '../types/index';

// ===== Mode Resolution =====

/**
 * Determine which evolution mode an agent is in.
 * Priority: agent metadata > env var > 'standard'
 */
export async function getAgentMode(agentId: string): Promise<'standard' | 'hypergraph'> {
  try {
    const agent = await prisma.iMAgentCard.findUnique({
      where: { imUserId: agentId },
      select: { metadata: true },
    });
    const meta = agent?.metadata ? JSON.parse(agent.metadata as string) : {};
    if (meta.evolution_mode === 'hypergraph') return 'hypergraph';
    if (meta.evolution_mode === 'standard') return 'standard';
  } catch {
    /* fallback */
  }
  const envMode = process.env.EVOLUTION_DEFAULT_MODE;
  if (envMode === 'hypergraph') return 'hypergraph';
  return 'standard';
}

// ===== Hypergraph Layer (§5 SUPERGRAPH.md) =====

/**
 * Register atoms and return their IDs (upsert: create if not exist).
 */
async function upsertAtoms(atoms: Array<{ kind: string; value: string }>): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (const atom of atoms) {
    const key = `${atom.kind}:${atom.value}`;
    // Upsert: find or create
    const existing = await prisma.iMAtom.findUnique({
      where: { kind_value: { kind: atom.kind, value: atom.value } },
    });
    if (existing) {
      result.set(key, existing.id);
    } else {
      const created = await prisma.iMAtom.create({
        data: { kind: atom.kind, value: atom.value },
      });
      result.set(key, created.id);
    }
  }
  return result;
}

/**
 * Write hypergraph layer for a capsule execution.
 * Only called when agentMode === 'hypergraph'.
 */
export async function writeHypergraphLayer(
  agentId: string,
  signalTags: SignalTag[],
  geneId: string,
  outcome: string,
  signalKey: string,
): Promise<void> {
  // 1. Collect atoms from the execution context
  const atomDefs: Array<{ kind: string; value: string }> = [
    { kind: 'agent', value: agentId },
    { kind: 'gene', value: geneId },
    { kind: 'outcome', value: outcome },
  ];
  for (const tag of signalTags) {
    atomDefs.push({ kind: 'signal_type', value: tag.type });
    if (tag.provider) atomDefs.push({ kind: 'provider', value: tag.provider });
    if (tag.stage) atomDefs.push({ kind: 'stage', value: tag.stage });
    if (tag.severity) atomDefs.push({ kind: 'severity', value: tag.severity });
  }

  // 2. Upsert atoms
  const atomMap = await upsertAtoms(atomDefs);

  // 3. Generate capsule ID for hyperedge (use latest capsule)
  const latestCapsule = await prisma.iMEvolutionCapsule.findFirst({
    where: { ownerAgentId: agentId, geneId, mode: 'hypergraph' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!latestCapsule) return; // shouldn't happen, capsule was just created

  const hyperedgeId = latestCapsule.id;

  // 4. Create hyperedge
  await prisma.iMHyperedge.create({
    data: { id: hyperedgeId, type: 'execution' },
  });

  // 5. Link atoms to hyperedge (inverted index entries)
  const atomLinks = Array.from(atomMap.values()).map((atomId) => ({
    hyperedgeId,
    atomId,
    role: 'participant' as const,
  }));
  // Use createMany for batch insert
  await prisma.iMHyperedgeAtom.createMany({ data: atomLinks });

  // 6. Causal link: find the previous capsule for the same (signal, gene) pair
  const previousCapsule = await prisma.iMEvolutionCapsule.findFirst({
    where: {
      ownerAgentId: agentId,
      signalKey,
      geneId,
      mode: 'hypergraph',
      id: { not: hyperedgeId },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  if (previousCapsule) {
    await prisma.iMCausalLink.create({
      data: {
        causeId: previousCapsule.id,
        effectId: hyperedgeId,
        linkType: 'learning',
        strength: 1.0,
      },
    });
  }
}

/**
 * Query hypergraph inverted index to find candidate genes for given signal atoms.
 * Returns gene IDs that co-occur with the signal atoms in past hyperedges.
 */
export async function queryHypergraphCandidates(signalTags: SignalTag[]): Promise<string[]> {
  // Collect signal atom values to search for
  const signalAtoms: Array<{ kind: string; value: string }> = [];
  for (const tag of signalTags) {
    signalAtoms.push({ kind: 'signal_type', value: tag.type });
    if (tag.provider) signalAtoms.push({ kind: 'provider', value: tag.provider });
    if (tag.stage) signalAtoms.push({ kind: 'stage', value: tag.stage });
  }

  if (signalAtoms.length === 0) return [];

  // Find atom IDs
  const atomRecords = await prisma.iMAtom.findMany({
    where: {
      OR: signalAtoms.map((a) => ({ kind: a.kind, value: a.value })),
    },
    select: { id: true },
  });
  if (atomRecords.length === 0) return [];

  const atomIds = atomRecords.map((a: { id: number }) => a.id);

  // Find hyperedges that contain ALL these atoms (intersection)
  // Strategy: find hyperedges containing the rarest atom, then filter
  const hyperedgeAtoms = await prisma.iMHyperedgeAtom.findMany({
    where: { atomId: { in: atomIds } },
    select: { hyperedgeId: true, atomId: true },
  });

  // Count how many query atoms each hyperedge matches
  const hyperedgeCounts = new Map<string, number>();
  for (const ha of hyperedgeAtoms) {
    hyperedgeCounts.set(ha.hyperedgeId, (hyperedgeCounts.get(ha.hyperedgeId) || 0) + 1);
  }

  // Hyperedges matching at least the signal_type atom (minimum coverage)
  const minMatch = 1; // at least signal_type matches
  const matchingHyperedges = [...hyperedgeCounts.entries()].filter(([, count]) => count >= minMatch).map(([id]) => id);

  if (matchingHyperedges.length === 0) return [];

  // Extract gene atoms from matching hyperedges
  const geneAtoms = await prisma.iMHyperedgeAtom.findMany({
    where: {
      hyperedgeId: { in: matchingHyperedges },
    },
    include: { atom: true },
  });

  const geneIds = new Set<string>();
  for (const ga of geneAtoms) {
    if (ga.atom.kind === 'gene') {
      geneIds.add(ga.atom.value);
    }
  }

  return [...geneIds];
}
