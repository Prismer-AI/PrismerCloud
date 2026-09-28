/** Transport metadata is local to an envelope and never changes its wire shape. */
const delays = new WeakMap<object, number>();
export function rememberRetryAfter(envelope: object, response: Response): void {
  if (response.status !== 429) return;
  const raw = response.headers.get('Retry-After');
  if (!raw) return;
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  if (Number.isFinite(delay) && delay >= 0) delays.set(envelope, delay);
}
export function retryAfterMs(envelope: object): number | undefined {
  return delays.get(envelope);
}
