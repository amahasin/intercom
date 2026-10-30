/**
 * How long someone has been with the company, from the day they joined ("YYYY-MM-DD", a day and not
 * a moment) to `today`. Whole months, the way people say it: 5 years 7 months; under a month, days.
 */
export type Tenure =
  | { kind: 'future' }
  | { kind: 'today' }
  | { kind: 'days'; days: number }
  | { kind: 'months'; years: number; months: number };

export function tenure(joinedOn: string, today: Date): Tenure | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(joinedOn);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  const ty = today.getFullYear();
  const tm = today.getMonth() + 1;
  const td = today.getDate();
  let months = (ty - y) * 12 + (tm - mo);
  if (td < d) months -= 1;
  // Day counts go through UTC so a daylight-saving change cannot make a day 23 or 25 hours.
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(y, mo - 1, d)) / 86_400_000);
  if (days < 0) return { kind: 'future' };
  if (days === 0) return { kind: 'today' };
  if (months < 1) return { kind: 'days', days };
  return { kind: 'months', years: Math.floor(months / 12), months: months % 12 };
}

/** The day as a local date (not midnight UTC, which is the day before in some time zones). */
export function joinedDate(joinedOn: string): Date {
  const [y, m, d] = joinedOn.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}
