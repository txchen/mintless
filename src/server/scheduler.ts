import { eq } from 'drizzle-orm';
import { items } from './db/schema.ts';
import { syncItem, type SyncDeps } from './sync/engine.ts';

export function startScheduler(deps: SyncDeps, intervalMs: number, tickMs = 10 * 60_000) {
  if (intervalMs <= 0) return () => {};
  const tick = async () => {
    const now = (deps.now ?? Date.now)();
    const due = deps.db.select().from(items).where(eq(items.status, 'active')).all();
    for (const item of due) {
      if (item.lastSyncAt !== null && now - item.lastSyncAt < intervalMs) continue;
      try {
        await syncItem(deps, item.id, 'scheduled');
      } catch (error) {
        console.error('scheduled sync failed', item.id, error);
      }
    }
  };
  const timer = setInterval(() => {
    tick().catch((error: unknown) => console.error('scheduler tick failed', error));
  }, tickMs);
  timer.unref();
  return () => clearInterval(timer);
}
