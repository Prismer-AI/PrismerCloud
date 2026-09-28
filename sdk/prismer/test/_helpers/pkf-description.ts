// memory211/01 轴H ② — the description gate. A NEW page on the memory_write
// surface must carry the mandated one-sentence frontmatter description, so test
// fixtures that only care about a DIFFERENT gate (placement, URI upgrade,
// outbox atomicity, visibility) stamp it rather than hand-writing it 30 times.
// Production bodies are NOT stamped anywhere: the 422 is the contract.

const FRONTMATTER_RE = /<script[^>]*type=["']application\/prismer\+json["'][^>]*>/i;

/**
 * Prepend a minimal PKF frontmatter script (with a description) to a fixture
 * body, unless the body already declares one. Idempotent.
 */
export function withDescription(content: string, description = 'Fixture page description.'): string {
  if (FRONTMATTER_RE.test(content)) return content;
  const frontmatter =
    `<script type="application/prismer+json">` +
    `{"type":"note","title":"fixture","description":"${description}","pkfVersion":"1.1"}` +
    `</script>`;
  return `${frontmatter}${content}`;
}
