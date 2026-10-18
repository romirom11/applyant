// The scheduler: starts search runs when their strategies are due. It ticks once a minute and
// when the Mac wakes (applyant-native's `wake` event). Node can't see sleep, so a strategy
// whose slots passed while the Mac slept is simply due at the next tick, and runs once, not
// once per missed slot: its next run counts from when it started. Once the candidate has run
// the search planner, it also starts a new plan a week after the last one. The ATS index gets a
// crawl of its due boards every few minutes and a discovery run weekly (ats-index/). While the
// candidate has paused background work (queue/pause.ts) it starts nothing; on resume, whatever
// came due in the meantime starts at once, once.
import type { Db } from '../db/client.ts';
import { scheduleCrawl } from '../domain/search/ats-index/crawl.ts';
import { scheduleDiscovery } from '../domain/search/ats-index/discover.ts';
import { schedulePlanner } from '../domain/search/planner.ts';
import { scheduleDue } from '../domain/search/strategies.ts';
import type { Logger } from '../util/log.ts';
import type { EventBus } from './events.ts';
import { pausedAt } from './pause.ts';
import { runInTx } from './tx.ts';

export interface SchedulerOptions {
  db: Db;
  bus: EventBus;
  log: Logger;
  intervalMs: number;
  now?: () => Date;
}

export class Scheduler {
  private readonly o: SchedulerOptions;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(options: SchedulerOptions) {
    this.o = options;
  }

  start(): void {
    if (this.timer) return;
    this.tick('schedule');
    this.timer = setInterval(() => this.tick('schedule'), this.o.intervalMs);
    this.timer.unref();
    this.unsubscribe = this.o.bus.subscribe((e) => {
      if (e.kind === 'system.resumed') this.tick('schedule');
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Starts every due strategy's run; returns the new run ids. */
  tick(trigger: 'schedule' | 'wake'): number[] {
    try {
      const now = this.o.now?.() ?? new Date();
      const { runs, plan, discovery } = runInTx(this.o.db, this.o.bus, { now }, (tx) =>
        pausedAt(tx.db)
          ? { runs: [], plan: null, discovery: null }
          : {
              runs: scheduleDue(tx, trigger),
              plan: schedulePlanner(tx),
              discovery: scheduleDiscovery(tx),
              crawl: scheduleCrawl(tx),
            },
      );
      if (runs.length) this.o.log.info('search runs started', { trigger, runs });
      if (plan !== null) this.o.log.info('search planner started', { plan });
      if (discovery !== null) this.o.log.info('ATS index discovery started', { discovery });
      return runs;
    } catch (err) {
      this.o.log.error('scheduler tick failed', { err });
      return [];
    }
  }
}
