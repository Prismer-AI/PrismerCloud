// Tiny token-set fuzzy matcher used by RolePicker surfaces (Simple modal,
// Pro command palette). 225 rows is small — front-end-only filter is fine,
// no need for Fuse/MiniSearch overhead.
//
// Score components (higher is better):
//   - exact prefix on any token of the searchable text → +10
//   - substring hit on the joined text                  → +5
//   - per-query-token coverage ratio                    → +0..5
//   - shorter searchable text wins on ties              → tiny tiebreak

export interface FuzzyItem {
  readonly slug: string;
  readonly searchText: string; // lowercased: name + description + tags + category
}

export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  if (!text) return 0;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  let score = 0;
  const words = text.split(/\s+/);
  for (const tok of tokens) {
    if (words.some((w) => w.startsWith(tok))) score += 10;
    else if (text.includes(tok)) score += 5;
  }
  const hits = tokens.filter((t) => text.includes(t)).length;
  score += (hits / tokens.length) * 5;
  // Tiebreak: shorter text wins very slightly.
  score -= Math.min(text.length / 5000, 0.5);
  return score;
}

export function fuzzyFilter<T extends FuzzyItem>(query: string, items: readonly T[], limit?: number): T[] {
  const q = query.trim();
  if (!q) return limit ? items.slice(0, limit) : items.slice();
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const s = fuzzyScore(q, item.searchText);
    if (s > 0) scored.push({ item, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = scored.map((s) => s.item);
  return limit ? out.slice(0, limit) : out;
}
