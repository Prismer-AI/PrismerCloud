import type { EaasFailEnvelope } from './environment-contract';

/** Retry-After uses UTC for all three HTTP-date formats, including asctime. */
function httpDate(raw: string): number {
  const standard = /^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?), (\d{1,2})[ -](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ -](\d{2}|\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(raw);
  const old = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(raw);
  if (!standard && !old) return NaN;
  const [day, month, year, hour, minute, second] = standard ? standard.slice(1) : [old![2],old![1],old![6],old![3],old![4],old![5]];
  let fullYear = Number(year);
  if (year.length === 2) {
    const currentYear = new Date().getUTCFullYear();
    fullYear += Math.floor(currentYear / 100) * 100;
    if (fullYear > currentYear + 50) fullYear -= 100;
  }
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(month);
  const date = new Date(0);
  date.setUTCFullYear(fullYear, m, Number(day));
  date.setUTCHours(Number(hour),Number(minute),Number(second),0);
  if (date.getUTCFullYear() !== fullYear || date.getUTCMonth() !== m || date.getUTCDate() !== Number(day) || date.getUTCHours() !== Number(hour) || date.getUTCMinutes() !== Number(minute) || date.getUTCSeconds() !== Number(second)) return NaN;
  return date.getTime();
}

/** Header hint only: does not authorize replay or promise recovery. */
export function retryAfterDelay(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After')?.trim();
  if (!raw) return undefined;
  const delay = /^\d+$/.test(raw) ? Number(raw) * 1000 : Math.max(0,httpDate(raw)-Date.now());
  return Number.isSafeInteger(delay) && delay >= 0 ? delay : undefined;
}
export function rememberRetryAfter(envelope: EaasFailEnvelope, response: Response): void {
  delete envelope.error.retryAfterMs;
  const delay = retryAfterDelay(response);
  if (delay !== undefined) envelope.error.retryAfterMs = delay;
}
export function retryAfterMs(envelope: EaasFailEnvelope): number | undefined {
  return envelope.error.retryAfterMs;
}
