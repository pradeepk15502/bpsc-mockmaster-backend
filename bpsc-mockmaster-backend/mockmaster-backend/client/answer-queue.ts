/**
 * Browser-side answer queue for the test screen (framework-free; drop into the Next.js app).
 *
 *   select option → record() → local pending queue (persisted in localStorage) → flush() → PUT /answers
 *   offline / 5xx → keep pending, retry with backoff, flush again on the `online` event
 *   server reply → drop items the server accepted or already has a newer version of (reconciliation)
 *
 * Every save carries a version that only increases: max(previous + 1, wall-clock ms), persisted across refreshes.
 * An old request that arrives late can never overwrite a newer answer on the server, and when two tabs/devices
 * answer the same question the later change wins.
 * The browser never decides time, score or correctness: it only proposes answers.
 */
export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export interface PendingAnswer { position: number; selected: string | null; marked: boolean; timeSpentSec: number; version: number }
export type SendFn = (attemptId: string, answers: PendingAnswer[]) => Promise<{ status: number; body: any }>;
export type QueueState = 'idle' | 'saving' | 'offline' | 'closed';

interface Persisted { seq: number; pending: Record<string, PendingAnswer> }

export class AnswerQueue {
  private key: string; private data: Persisted; private inFlight: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null; private failures = 0;
  state: QueueState = 'idle'; closedReason: string | null = null;

  constructor(private attemptId: string, private storage: StorageLike, private send: SendFn,
              private onChange: (s: QueueState, pending: number) => void = () => {}, private schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
              private nowMs: () => number = () => Date.now()) {
    this.key = `mm:answers:${attemptId}`;
    let d: Persisted | null = null; try { d = JSON.parse(storage.getItem(this.key) ?? 'null'); } catch { d = null; }
    this.data = d && typeof d.seq === 'number' ? d : { seq: 0, pending: {} };
  }
  get pendingCount() { return Object.keys(this.data.pending).length; }
  get pending() { return Object.values(this.data.pending).sort((a, b) => a.position - b.position); }

  /** After loading GET /api/attempts/:id: never reuse a version the server has already seen. */
  syncFromServer(serverAnswers: { position: number; version: number }[]) {
    const max = serverAnswers.reduce((m, a) => Math.max(m, a.version), 0);
    if (max > this.data.seq) { this.data.seq = max; this.persist(); }
  }

  record(position: number, selected: string | null, marked: boolean, timeSpentSec: number) {
    if (this.state === 'closed') return;
    this.data.seq = Math.max(this.data.seq + 1, this.nowMs());
    this.data.pending[String(position)] = { position, selected, marked, timeSpentSec: Math.max(0, Math.round(timeSpentSec)), version: this.data.seq };
    this.persist(); this.emit();
    void this.flush();
  }

  /** Sends everything pending. Safe to call any time (online event, interval, before submit). */
  flush(): Promise<void> {
    if (this.state === 'closed' || !this.pendingCount) return Promise.resolve();
    if (this.inFlight) return this.inFlight.then(() => this.flush());
    const batch = this.pending;
    this.state = 'saving'; this.emit();
    this.inFlight = (async () => {
      try {
        const r = await this.send(this.attemptId, batch);
        if (r.status === 200) {
          for (const res of r.body?.results ?? []) {
            const cur = this.data.pending[String(res.position)];
            // Keep an answer the student changed while this request was in flight (its version is higher).
            if (cur && res.serverVersion >= cur.version) delete this.data.pending[String(res.position)];
          }
          this.failures = 0; this.state = 'idle';
        } else if (r.status === 409) {
          // TIME_UP / ALREADY_SUBMITTED: the server is the source of truth; nothing more can be saved.
          this.closedReason = r.body?.error?.code ?? 'CLOSED'; this.state = 'closed'; this.data.pending = {};
        } else if (r.status === 401 || r.status === 403) {
          this.state = 'offline'; this.closedReason = 'SIGNED_OUT';             // keep answers; resend after sign-in
        } else if (r.status >= 400 && r.status < 500 && r.status !== 429) {
          this.state = 'idle'; this.data.pending = {};                         // invalid payload: drop, do not loop
        } else throw new Error('HTTP ' + r.status);
      } catch {
        this.failures += 1; this.state = 'offline';
        const wait = Math.min(30_000, 1000 * Math.pow(2, Math.min(this.failures - 1, 5)));
        if (!this.retryTimer) this.retryTimer = this.schedule(() => { this.retryTimer = null; void this.flush(); }, wait);
      } finally {
        this.persist(); this.inFlight = null; this.emit();
      }
    })();
    return this.inFlight;
  }

  /** Wire to window events in the browser. */
  attach(win: { addEventListener(t: string, f: () => void): void }) { win.addEventListener('online', () => { void this.flush(); }); }
  clear() { this.storage.removeItem(this.key); this.data = { seq: this.data.seq, pending: {} }; }
  private persist() { try { this.storage.setItem(this.key, JSON.stringify(this.data)); } catch { /* storage full / private mode: queue still works in memory */ } }
  private emit() { this.onChange(this.state, this.pendingCount); }
}

/** Display-only countdown from the server's clock (never trusted for anything). */
export function remainingFromServer(t: { serverNow: string; serverExpiresAt: string }, receivedAtMs: number, nowMs: number) {
  const skew = new Date(t.serverNow).getTime() - receivedAtMs;
  return Math.max(0, Math.floor((new Date(t.serverExpiresAt).getTime() - (nowMs + skew)) / 1000));
}

/** Default transport for the Next.js app. */
export function fetchSender(baseUrl: string, csrf: () => string): SendFn {
  return async (attemptId, answers) => {
    const res = await fetch(`${baseUrl}/api/attempts/${attemptId}/answers`, { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() }, body: JSON.stringify({ answers }) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
