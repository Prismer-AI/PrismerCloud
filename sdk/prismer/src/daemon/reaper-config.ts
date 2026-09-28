const DEFAULT_TASK_REAPER_MIN_INACTIVITY_MS = 5 * 60_000;

export function getTaskReaperMinInactivityMs(): number {
  const raw = process.env.PRISMER_DAEMON_TASK_REAPER_MIN_INACTIVITY_MS;
  if (!raw) return DEFAULT_TASK_REAPER_MIN_INACTIVITY_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TASK_REAPER_MIN_INACTIVITY_MS;
}

