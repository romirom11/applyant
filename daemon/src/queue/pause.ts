// The candidate's pause: search, scoring, research and the rest of the background work stop
// until they resume it, without quitting the app. Kept in app_state, so it outlasts a restart.
// While paused the scheduler starts no search runs and the worker leases only the tasks the
// candidate is waiting on in front of them (an interview answer, a delivery they approved);
// whatever else was running is given back to the queue and runs again on resume. Tasks still
// queue up while paused (a mail sync, a posting added by hand): they wait, they aren't dropped.
import { eq } from 'drizzle-orm';
import type { Conn } from '../db/client.ts';
import { appState } from '../db/schema.ts';
import type { TaskKind, Tx } from './types.ts';

const PAUSE_KEY = 'background_paused_at';

/** Tasks the candidate started and is watching: a pause doesn't hold them back. */
export const RUNS_WHILE_PAUSED: readonly TaskKind[] = [
  'interview_open',
  'interview_turn',
  'deliver_application',
];

/** When the candidate paused background work, or null while it runs. */
export function pausedAt(db: Conn): Date | null {
  const row = db.select().from(appState).where(eq(appState.key, PAUSE_KEY)).get();
  return typeof row?.value === 'number' ? new Date(row.value) : null;
}

/**
 * Pauses or resumes background work; returns when it was paused (null: running). Pausing twice
 * keeps the first time. The worker and the scheduler read it on their next look (a second for
 * the worker); `system.paused` / `system.resumed` tell the app and wake them up.
 */
export function setPaused(tx: Tx, paused: boolean): Date | null {
  const was = pausedAt(tx.db);
  if (paused) {
    if (was) return was;
    tx.db.insert(appState).values({ key: PAUSE_KEY, value: tx.now.getTime() }).run();
    tx.emit({ kind: 'system.paused', message: 'background work paused' });
    return tx.now;
  }
  if (!was) return null;
  tx.db.delete(appState).where(eq(appState.key, PAUSE_KEY)).run();
  tx.emit({ kind: 'system.resumed', message: 'background work resumed' });
  return null;
}
