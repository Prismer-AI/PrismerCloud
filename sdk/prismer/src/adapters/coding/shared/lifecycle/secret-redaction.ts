const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|private[_-]?key|client[_-]?secret|connection[_-]?string)\s*[:=]\s*[^\s,;]+/gi,
];

/** Single redaction boundary for persisted post-turn evidence and wire errors. */
export function redactSensitiveText(value: unknown, maxBytes?: number): string {
  const original = typeof value === 'string' ? value : String(value ?? '');
  const redacted = SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, '[REDACTED]'),
    original,
  );
  if (maxBytes === undefined || Buffer.byteLength(redacted, 'utf8') <= maxBytes) return redacted;
  return Buffer.from(redacted, 'utf8')
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
}
