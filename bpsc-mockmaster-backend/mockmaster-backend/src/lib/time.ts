/** Calendar date (YYYY-MM-DD) of an instant in the exam time zone (Asia/Kolkata by default). */
export function examDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
export function addDaysToDate(d: string, n: number): string {
  const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10);
}
export const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms);

export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };
/** Test clock: time only moves when told to. */
export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | number = Date.now()) { this.t = typeof start === 'number' ? start : start.getTime(); }
  now() { return new Date(this.t); }
  set(d: Date | string) { this.t = new Date(d).getTime(); }
  advance(ms: number) { this.t += ms; }
}
