import { DurableObject } from 'cloudflare:workers';
import { SESSION_LIMITS } from '../../src/shared/protocol';

const ROW_ID = 1;

// Fixed name for the single Worker-global limiter instance. Rooms look this
// up internally; it is not reachable over HTTP.
export const GLOBAL_LIMITER_INSTANCE = 'global';

type LimiterRecord = {
  attempts: number[];
};

export class GlobalLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ensureTable();
    });
  }

  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  }

  // Atomic check-and-record. `now` is for tests of the rolling window.
  async tryConsume(now = Date.now()): Promise<boolean> {
    this.ensureTable();
    const windowMs = SESSION_LIMITS.openAiCallGlobalWindowMs;
    const cap = SESSION_LIMITS.maxOpenAiCallsGlobalPerWindow;
    const times = this.loadTimes().filter((t) => now - t < windowMs);
    if (times.length >= cap) {
      this.saveTimes(times);
      return false;
    }
    times.push(now);
    this.saveTimes(times);
    return true;
  }

  // Test helper: wipe persisted attempts. Not exposed over HTTP.
  async reset(): Promise<void> {
    this.ensureTable();
    this.saveTimes([]);
  }

  private ensureTable(): void {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS limiter (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)'
    );
  }

  private loadTimes(): number[] {
    this.ensureTable();
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM limiter WHERE id = ?', ROW_ID).toArray()[0];
    if (!row?.data) return [];
    try {
      const parsed = JSON.parse(row.data) as LimiterRecord;
      if (!Array.isArray(parsed?.attempts)) return [];
      return parsed.attempts.filter((t) => typeof t === 'number' && Number.isFinite(t));
    } catch {
      return [];
    }
  }

  private saveTimes(attempts: number[]): void {
    this.ensureTable();
    const record: LimiterRecord = { attempts };
    this.ctx.storage.sql.exec(
      'INSERT INTO limiter (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      ROW_ID,
      JSON.stringify(record)
    );
  }
}
