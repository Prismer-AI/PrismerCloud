export function taskStateVersion(record: { updatedAt: Date }): number {
  return record.updatedAt.getTime();
}

export function formatTaskStateETag(stateVersion: number): string {
  return `"${stateVersion}"`;
}

export function parseExpectedTaskStateVersion(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }

  const value = typeof raw === "number" ? raw : parseStateVersionString(String(raw));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("expectedStateVersion must be a non-negative safe integer");
  }
  return value;
}

function parseStateVersionString(raw: string): number {
  let value = raw.trim();
  if (value.startsWith("W/")) value = value.slice(2);
  value = value.replace(/^"|"$/g, "");
  if (value.includes(":")) value = value.split(":").at(-1) ?? value;
  return Number(value);
}
