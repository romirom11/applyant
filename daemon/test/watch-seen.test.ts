// The watch list grows from what searches match: a job search across every company finds a job
// that fits, and its company's board joins the watch list, read in full on later runs. So does
// the board behind any matched job page (an HN post, a RemoteOK apply link) and behind a
// verified posting's apply link.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { postings, searchSources } from '../src/db/schema.ts';
import { addSource, setSourceEnabled, sourcesFor } from '../src/domain/search/sources.ts';
import {
  boardOf,
  MAX_SEEN_BOARDS_PER_RUN,
  MAX_WATCHED_BOARDS,
  watchSeen,
} from '../src/domain/search/watchlist.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { recordedFetch, roleReplies, type SearchHarness, searchHarness } from './helpers/search.ts';

const now = new Date('2026-10-17T12:00:00Z');

describe('boards behind matched jobs', () => {
  let t: TempDb;
  let h: SearchHarness | null;
  beforeEach(() => {
    t = tempDb();
    h = null;
  });
  afterEach(async () => {
    await h?.stop();
    t.cleanup();
  });

  const agentBoards = () =>
    t.db
      .select()
      .from(searchSources)
      .where(eq(searchSources.origin, 'agent'))
      .all()
      .map((s) => ({ key: s.key, label: s.label, note: s.note, enabled: s.enabled }));

  it('a job search finds jobs at companies nobody watched: they become postings, their boards join the watch list', async () => {
    h = searchHarness(t, { fetch: recordedFetch(roleReplies()), now: () => now });
    const run = await h.run({
      name: 'Laravel',
      queries: ['laravel -junior'],
      sources: ['board:smartrecruiters-search'],
    });
    const row = h.runRow(run);
    expect(row?.results[0]).toMatchObject({
      sourceKey: 'board:smartrecruiters-search',
      listed: 5,
      matched: 5,
      added: 5,
      complete: false,
    });
    expect(row?.note).toBe('5 listed · 5 matched · 5 new · 4 boards now watched');
    expect(
      t.db
        .select()
        .from(postings)
        .all()
        .map((p) => p.canonicalUrl),
    ).toContain('https://jobs.smartrecruiters.com/JobsForHumanity/744000074527197');
    expect(agentBoards()).toEqual([
      {
        key: 'smartrecruiters:ALTEN',
        label: 'ALTEN',
        note: 'has "Développeur Full Stack Vue.js / PHP Laravel" ("Laravel" matched it on SmartRecruiters job search · every company)',
        enabled: true,
      },
      expect.objectContaining({ key: 'smartrecruiters:SQLI1', label: 'SQLI' }),
      expect.objectContaining({
        key: 'smartrecruiters:JobsForHumanity',
        label: 'Jobs for Humanity',
      }),
      expect.objectContaining({ key: 'smartrecruiters:Shebaxyz3', label: 'Sheba.xyz' }),
    ]);
    // A strategy reading SmartRecruiters boards now reads them in full.
    expect(sourcesFor(t.db, ['smartrecruiters']).map((s) => s.key)).toHaveLength(4);

    // The next run finds them watched already.
    const again = await h.again(1);
    expect(h.runRow(again)?.note).toBe('5 listed · 5 matched · 0 new');
    expect(agentBoards()).toHaveLength(4);
  });

  it("a matched job page's board, from any source; the board a listing came from isn't seen again", async () => {
    h = searchHarness(t, {
      fetch: recordedFetch({
        'https://remoteok.com/api': [
          { legal: 'notice' },
          {
            id: '1',
            position: 'Senior AI Engineer',
            company: 'Acme AI',
            url: 'https://remoteok.com/remote-jobs/1',
            apply_url: 'https://jobs.ashbyhq.com/acme-ai/7458d4e9-da2e-47bd-98cb-adfda43d42b2',
          },
          {
            id: '2',
            position: 'AI Engineer',
            company: 'Blog Co',
            url: 'https://remoteok.com/remote-jobs/2',
            // A link to an ATS host that isn't a job page: no board.
            apply_url: 'https://www.greenhouse.io/blog/hiring',
          },
          {
            id: '3',
            position: 'Office Manager',
            company: 'Elsewhere',
            url: 'https://remoteok.com/remote-jobs/3',
            apply_url: 'https://jobs.lever.co/elsewhere/0cc069a3-f9c2-4d8b-a0d6-db117b3f02e7',
          },
        ],
      }),
      now: () => now,
    });
    await h.run({ name: 'AI', queries: ['ai engineer'], sources: ['board:remoteok'] });
    // Only the job that matched: an office manager's board isn't one for this candidate.
    expect(agentBoards()).toEqual([
      {
        key: 'ashby:acme-ai',
        label: 'Acme AI',
        note: 'has "Senior AI Engineer" ("AI" matched it on RemoteOK)',
        enabled: true,
      },
    ]);
  });

  it('at most MAX_SEEN_BOARDS_PER_RUN new ones at once; one watched already (in any case, on or off) stays as it is', () => {
    const bus = new EventBus();
    addSource(t.db, { kind: 'lever', locator: 'Acme' }, now);
    addSource(t.db, { kind: 'greenhouse', locator: 'offco' }, now);
    setSourceEnabled(t.db, 'greenhouse:offco', false);
    const job = (url: string, title = 'AI Engineer') => ({
      listing: { url, applyUrl: null, title, company: null },
      where: '"AI" matched it on HN',
    });
    const res = runInTx(t.db, bus, { now }, (tx) =>
      watchSeen(tx, [
        job('https://jobs.lever.co/acme/0cc069a3-f9c2-4d8b-a0d6-db117b3f02e7'),
        job('https://job-boards.greenhouse.io/offco/jobs/123'),
        ...Array.from({ length: MAX_SEEN_BOARDS_PER_RUN + 2 }, (_, i) =>
          job(`https://job-boards.greenhouse.io/co${i}/jobs/${1000 + i}`),
        ),
      ]),
    );
    expect(res.added.map((s) => s.key)).toEqual(
      Array.from({ length: MAX_SEEN_BOARDS_PER_RUN }, (_, i) => `greenhouse:co${i}`),
    );
    expect(res.rejected).toHaveLength(2);
    expect(t.db.select().from(searchSources).where(eq(searchSources.locator, 'acme')).get()).toBe(
      undefined,
    );
    expect(
      t.db.select().from(searchSources).where(eq(searchSources.key, 'greenhouse:offco')).get()
        ?.enabled,
    ).toBe(false);
  });

  it('a career page that reads the board watches it already; past MAX_WATCHED_BOARDS no more join', () => {
    const bus = new EventBus();
    const page = addSource(t.db, { kind: 'page', locator: 'https://acme.ai/careers' }, now).source;
    t.db
      .update(searchSources)
      .set({ resolved: { via: 'ats', ats: 'greenhouse', token: 'AcmeAI' } })
      .where(eq(searchSources.id, page.id))
      .run();
    const job = (url: string) => ({
      listing: { url, applyUrl: null, title: 'AI Engineer', company: null },
      where: '"AI" matched it on HN',
    });
    const seen = (...urls: string[]) =>
      runInTx(t.db, bus, { now }, (tx) => watchSeen(tx, urls.map(job))).added.map((s) => s.key);
    expect(seen('https://job-boards.greenhouse.io/acmeai/jobs/1')).toEqual([]);

    // The agent's boards that are switched on count; one switched off leaves room.
    for (let i = 0; i < MAX_WATCHED_BOARDS - 1; i++) {
      addSource(t.db, { kind: 'ashby', locator: `co${i}`, origin: 'agent' }, now);
    }
    expect(
      seen(
        'https://job-boards.greenhouse.io/one/jobs/1',
        'https://job-boards.greenhouse.io/two/jobs/2',
      ),
    ).toEqual(['greenhouse:one']);
    expect(seen('https://job-boards.greenhouse.io/two/jobs/2')).toEqual([]);
    setSourceEnabled(t.db, 'ashby:co0', false);
    expect(seen('https://job-boards.greenhouse.io/two/jobs/2')).toEqual(['greenhouse:two']);
  });

  it("a verified posting's apply link on an ATS board (a LinkedIn job applying through Greenhouse)", () => {
    const bus = new EventBus();
    // What verify_posting passes once a posting is live.
    const res = runInTx(t.db, bus, { now }, (tx) =>
      watchSeen(
        tx,
        [
          {
            listing: {
              url: 'https://www.linkedin.com/jobs/view/4100000001',
              applyUrl: 'https://job-boards.eu.greenhouse.io/acmeai/jobs/4001234?gh_src=li',
              title: 'Staff AI Engineer',
              company: 'Acme AI',
            },
            where: 'posting 7 applies there',
          },
        ],
        1,
      ),
    );
    expect(res.added.map((s) => [s.key, s.note])).toEqual([
      ['greenhouse:acmeai', 'has "Staff AI Engineer" (posting 7 applies there)'],
    ]);
  });

  it('the board a listing is on: its reader names it, or its job page or apply link shows it', () => {
    const l = (url: string, applyUrl: string | null = null) => ({ url, applyUrl });
    expect(boardOf({ ...l('https://apply.workable.com/j/996BE00528'), board: null })).toBeNull();
    expect(
      boardOf({
        ...l('https://apply.workable.com/j/996BE00528'),
        board: { ats: 'workable', token: 'intetics-2' },
      }),
    ).toEqual({ ats: 'workable', token: 'intetics-2' });
    expect(
      boardOf(
        l(
          'https://remoteok.com/remote-jobs/1',
          'https://jobs.lever.co/acme/0cc069a3-f9c2-4d8b-a0d6-db117b3f02e7/apply',
        ),
      ),
    ).toEqual({ ats: 'lever', token: 'acme' });
    expect(boardOf(l('https://jobs.smartrecruiters.com/Acme/744000074527197'))).toEqual({
      ats: 'smartrecruiters',
      token: 'Acme',
    });
    expect(boardOf(l('https://job-boards.greenhouse.io/acme'))).toBeNull();
  });
});
