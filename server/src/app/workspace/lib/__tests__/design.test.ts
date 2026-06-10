import { describe, expect, it } from 'vitest';

import {
  lifecycleAccent,
  projectAccent,
  projectColorFromId,
  spatialGrammar,
  springFlip,
  springLiquid,
  springSplat,
  statusAccent,
  type ProjectColor,
  type SkillLifecycleStage,
  type SpatialGrammarKey,
} from '../design';

describe('design.ts — S44 motion + spatial grammar', () => {
  describe('motion presets (release201/12 §8.8.6.1)', () => {
    it('springLiquid is slower and softer than springHeavy baseline', () => {
      expect(springLiquid).toMatchObject({
        type: 'spring',
        stiffness: 180,
        damping: 30,
        mass: 1.2,
      });
    });

    it('springFlip has high stiffness for snappy card flip', () => {
      expect(springFlip).toMatchObject({
        type: 'spring',
        stiffness: 420,
        damping: 32,
        mass: 0.6,
      });
    });

    it('springSplat has low damping for visible bounce', () => {
      expect(springSplat).toMatchObject({
        type: 'spring',
        stiffness: 600,
        damping: 18,
        mass: 0.4,
      });
    });
  });

  describe('spatialGrammar (release201/12 §8.8.6.5)', () => {
    it('exposes exactly 7 grammar keys', () => {
      const keys: SpatialGrammarKey[] = [
        'workshop',
        'pipeline',
        'shelf',
        'identityCard',
        'garden',
        'controlTower',
        'map',
      ];
      expect(Object.keys(spatialGrammar).sort()).toEqual([...keys].sort());
    });

    it('each grammar has a Tailwind layout class + at least one region', () => {
      for (const key of Object.keys(spatialGrammar) as SpatialGrammarKey[]) {
        const spec = spatialGrammar[key];
        expect(spec.layout.length, `${key} layout`).toBeGreaterThan(0);
        expect(Object.keys(spec.regions).length, `${key} regions`).toBeGreaterThan(0);
      }
    });

    // v2.0.8 X1 fix — the workshop middle track must use `minmax(0,1fr)` not
    // plain `1fr`. With plain `1fr` the grid track's min-content can grow
    // past the viewport and the active-draft accent border bleeds into the
    // reference-panel column. `minmax(0,1fr)` lets the track shrink to 0,
    // so long content wraps/truncates inside its own column.
    it('workshop middle track uses minmax(0,1fr) to keep accent border in column (Bug X1)', () => {
      const layout = spatialGrammar.workshop.layout;
      expect(layout).toContain('lg:grid-cols-[280px_minmax(0,1fr)_320px]');
      // Defensive: the old `1fr_320px` token must be gone so we don't
      // regress accidentally via a bad merge.
      expect(layout).not.toMatch(/_1fr_320px/);
    });
  });

  describe('lifecycleAccent (release201/08 §9.6)', () => {
    it('maps 5 lifecycle stages by re-using statusAccent entries', () => {
      const stages: SkillLifecycleStage[] = ['draft', 'eval', 'review', 'published', 'archived'];
      expect(Object.keys(lifecycleAccent).sort()).toEqual([...stages].sort());

      expect(lifecycleAccent.draft).toBe(statusAccent.backlog);
      expect(lifecycleAccent.eval).toBe(statusAccent.todo);
      expect(lifecycleAccent.review).toBe(statusAccent.review);
      expect(lifecycleAccent.published).toBe(statusAccent.done);
      expect(lifecycleAccent.archived).toBe(statusAccent.cancelled);
    });
  });

  describe('projectAccent + projectColorFromId (release201/09 §8.8)', () => {
    it('exposes 5 project colors mapped to --chart-1..5 CSS vars', () => {
      const colors: ProjectColor[] = [1, 2, 3, 4, 5];
      expect(Object.keys(projectAccent).map(Number).sort()).toEqual(colors);

      for (const c of colors) {
        const spec = projectAccent[c];
        expect(spec.dot).toContain(`--chart-${c}`);
        expect(spec.chip).toContain(`--chart-${c}`);
        expect(spec.ring).toContain(`--chart-${c}`);
      }
    });

    it('projectColorFromId returns a stable color in 1..5', () => {
      const id = 'prj_abc123';
      const first = projectColorFromId(id);
      expect(first).toBeGreaterThanOrEqual(1);
      expect(first).toBeLessThanOrEqual(5);

      // hash stability — same id should always produce the same color
      for (let i = 0; i < 10; i++) {
        expect(projectColorFromId(id)).toBe(first);
      }
    });

    it('projectColorFromId produces different colors for different ids (probabilistic)', () => {
      const samples = new Set<ProjectColor>();
      for (let i = 0; i < 200; i++) {
        samples.add(projectColorFromId(`prj_${i.toString(36)}`));
      }
      // With 200 samples and 5 buckets, we expect to hit all 5 colors with overwhelming probability.
      expect(samples.size).toBe(5);
    });

    it('projectColorFromId handles edge cases without throwing', () => {
      expect(() => projectColorFromId('')).not.toThrow();
      expect(() => projectColorFromId('a')).not.toThrow();
      expect(() => projectColorFromId('!@#$%^&*()')).not.toThrow();
      // empty string still in valid range
      const empty = projectColorFromId('');
      expect(empty).toBeGreaterThanOrEqual(1);
      expect(empty).toBeLessThanOrEqual(5);
    });
  });
});
