// The scheduler: starts search runs when their strategies are due. It ticks once a minute and
// when the Mac wakes (applyant-native's `wake` event). Node can't see sleep, so a strategy
// whose slots passed while the Mac slept is simply due at the next tick, and runs once, not
// once per missed slot: its next run counts from when it started.
import type { Db } from '../db/client.ts';
import { scheduleDue } from '../domain/search/strategies.ts';
import type { Logger } from '../util/log.ts';
import type { EventBus } from './events.ts';
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

  constructor(options: SchedulerOptions) {
    this.o = options;
  }

  start(): void {
    if (this.timer) return;
    this.tick('schedule');
    this.timer = setInterval(() => this.tick('schedule'), this.o.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Starts every due strategy's run; returns the new run ids. */
  tick(trigger: 'schedule' | 'wake'): number[] {
    try {
      const now = this.o.now?.() ?? new Date();
      const runs = runInTx(this.o.db, this.o.bus, { now }, (tx) => scheduleDue(tx, trigger));
      if (runs.length) this.o.log.info('search runs started', { trigger, runs });
      return runs;
    } catch (err) {
      this.o.log.error('scheduler tick failed', { err });
      return [];
    }
  }
}
