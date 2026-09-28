// The search readers over recorded responses (test/fixtures/search, from
// scripts/search-fixtures.ts: real public lists, trimmed to a few jobs) and a few synthetic
// career pages. Nothing here touches the network.
import { describe, expect, it } from 'vitest';
import { readAtsBoard } from '../src/domain/search/readers/ats-api.ts';
import {
  atsJobKey,
  atsJobPage,
  boardFromUrl,
  detectAtsBoard,
} from '../src/domain/search/readers/ats-embed.ts';
import { hnFirstLine, hnJobLink, readBoard } from '../src/domain/search/readers/boards.ts';
import { feedLinks, parseFeed } from '../src/domain/search/readers/feed.ts';
import { readPage } from '../src/domain/search/readers/page.ts';
import { plainText, type ReaderContext } from '../src/domain/search/readers/types.ts';
import { fixtureJson, type RecordedFetch, recordedFetch } from './helpers/search.ts';

const now = new Date('2026-09-28T12:00:00Z');
const ctx = (fetch: RecordedFetch, queries: string[] = []): ReaderContext => ({
  fetch,
  signal: new AbortController().signal,
  queries,
  reader: null,
  now,
});

describe('ATS list APIs (recorded)', () => {
  it('Greenhouse: the whole board, complete when every job came back', async () => {
    const run = await readAtsBoard('greenhouse', 'gitlab', ctx(recordedFetch()));
    expect(run.complete).toBe(true);
    expect(run.company).toBe('GitLab');
    expect(run.listings).toHaveLength(4);
    const first = run.listings[0];
    expect(first).toMatchObject({
      url: 'https://job-boards.greenhouse.io/gitlab/jobs/8556658002',
      sourceUrl: 'https://job-boards.greenhouse.io/gitlab/jobs/8556658002',
      externalId: '8556658002',
      title: 'AI Engineer',
      company: 'GitLab',
      location: 'Remote, Bangalore',
      remote: true,
    });
    // The content is HTML escaped twice over: it arrives as plain text.
    expect(first?.description).toMatch(/^GitLab is the intelligent orchestration platform/);
    expect(first?.description).not.toMatch(/<|&lt;|&quot;/);
  });

  it('Greenhouse: fewer jobs than meta.total is a partial list', async () => {
    const data = fixtureJson<{ jobs: unknown[]; meta: { total: number } }>(
      'greenhouse-gitlab.json',
    );
    const fetch = recordedFetch({
      'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true': {
        ...data,
        meta: { total: 198 },
      },
    });
    const run = await readAtsBoard('greenhouse', 'gitlab', ctx(fetch));
    expect(run.complete).toBe(false);
    expect(run.note).toContain('4 jobs of 198 (partial)');
  });

  it('Ashby: listed jobs with their workplace', async () => {
    const run = await readAtsBoard('ashby', 'ashby', ctx(recordedFetch()));
    expect(run.complete).toBe(true);
    expect(run.listings.map((l) => l.title)[0]).toBe('Engineering Manager - EU');
    expect(run.listings[0]).toMatchObject({
      externalId: '7458d4e9-da2e-47bd-98cb-adfda43d42b2',
      url: 'https://jobs.ashbyhq.com/ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2',
      remote: true,
      team: 'EMEA Engineering',
    });
    expect(run.listings[0]?.location).toMatch(/^Remote - European Union; Spain; Italy/);
  });

  it('Lever: the global host, and the EU host when the global one lists nothing', async () => {
    const fetch = recordedFetch();
    const demo = await readAtsBoard('lever', 'leverdemo', ctx(fetch));
    expect(demo.apiHost).toBe('api.lever.co');
    expect(demo.listings).toHaveLength(4);
    expect(demo.listings[0]).toMatchObject({ title: 'Approved Professional 3', remote: true });

    const eu = await readAtsBoard('lever', 'lever', ctx(fetch));
    expect(eu.apiHost).toBe('api.eu.lever.co');
    expect(eu.complete).toBe(true);
    expect(eu.listings[0]?.url).toMatch(/^https:\/\/jobs\.eu\.lever\.co\/lever\//);
    expect(fetch.calls.slice(-2)).toEqual([
      'https://api.lever.co/v0/postings/lever?mode=json',
      'https://api.eu.lever.co/v0/postings/lever?mode=json',
    ]);
    // Next time the host that answered is asked first.
    fetch.calls.length = 0;
    await readAtsBoard('lever', 'lever', ctx(fetch), { apiHost: 'api.eu.lever.co' });
    expect(fetch.calls).toEqual(['https://api.eu.lever.co/v0/postings/lever?mode=json']);
  });

  it('Lever: a site neither host knows is an error, not an empty list', async () => {
    await expect(readAtsBoard('lever', 'nobody', ctx(recordedFetch()))).rejects.toThrow(/404/);
  });

  it('Workable: the account widget, with the company name', async () => {
    const run = await readAtsBoard('workable', 'huggingface', ctx(recordedFetch()));
    expect(run.company).toBe('Hugging Face');
    expect(run.listings[0]).toMatchObject({
      externalId: 'F4C096B22E',
      url: 'https://apply.workable.com/j/F4C096B22E',
      remote: true,
      location: 'Remote (Paris, Île-de-France, France)',
    });
  });

  it('a board that does not exist fails the read', async () => {
    await expect(readAtsBoard('greenhouse', 'no-such-board', ctx(recordedFetch()))).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

describe('job boards (recorded)', () => {
  it('HN "Who is hiring": one listing per comment, never a complete list', async () => {
    const run = await readBoard('hn', ctx(recordedFetch()));
    expect(run.complete).toBe(false);
    expect(run.listings).toHaveLength(6);
    const modash = run.listings[0];
    expect(modash).toMatchObject({
      company: 'Modash.io',
      title: 'Senior Product Engineer',
      location: 'Remote (Europe)',
      sourceUrl: 'https://news.ycombinator.com/item?id=49522903',
      externalId: '49522903',
      // The comment links a Workable job: that job page is the posting.
      url: 'https://apply.workable.com/modash/j/C1507B65C3',
    });
    expect(run.listings.find((l) => l.externalId === '49522989')?.company).toBe('Snout');
    expect(run.note).toBe('Ask HN: Who is hiring? (September 2026): 6 of 6 posts link a job page');
  });

  it('HN posts that link no job page are left out (nothing to verify or apply through)', async () => {
    const thread = fixtureJson<{ children: Array<Record<string, unknown>> }>('hn-thread.json');
    thread.children.push({
      id: 1,
      author: 'x',
      created_at: '2026-09-02T00:00:00Z',
      text: 'Quiet Co | Backend Engineer | Remote<p>Email jobs at quiet dot co',
      children: [],
    });
    const fetch = recordedFetch({ 'https://hn.algolia.com/api/v1/items/49522897': thread });
    const run = await readBoard('hn', ctx(fetch));
    expect(run.listings.map((l) => l.externalId)).not.toContain('1');
    expect(run.note).toContain('6 of 7 posts link a job page');
  });

  it('HN first lines and links', () => {
    expect(
      hnFirstLine('Acme | Staff Backend Engineer | Remote (EU) | Full-time<p>More'),
    ).toMatchObject({
      company: 'Acme',
      title: 'Staff Backend Engineer',
      location: 'Remote (EU)',
    });
    // A post that opens with prose: titled by its opening, with no company guessed.
    const prose = hnFirstLine(
      'Beacon AI builds intelligent systems that make aviation safer and more autonomous. We have completed several programs<p>More',
    );
    expect(prose.company).toBeNull();
    expect(prose.title).toMatch(/^Beacon AI builds intelligent systems.*…$/);
    expect(prose.title.length).toBeLessThanOrEqual(90);
    expect(
      hnJobLink(
        'x <a href="https:&#x2F;&#x2F;acme.com">acme</a> <a href="https://jobs.lever.co/acme/0f2b7c0e-1111-4222-8333-944445555666">apply</a>',
      ),
    ).toBe('https://jobs.lever.co/acme/0f2b7c0e-1111-4222-8333-944445555666');
  });

  it('RemoteOK skips its legal notice; We Work Remotely splits "Company: Role"', async () => {
    const fetch = recordedFetch();
    const rok = await readBoard('remoteok', ctx(fetch));
    expect(rok.listings).toHaveLength(4);
    expect(rok.listings[0]).toMatchObject({
      externalId: '1137434',
      company: 'SIHO Insurance Services',
    });
    const wwr = await readBoard('wwr', ctx(fetch));
    expect(wwr.listings[0]).toMatchObject({
      company: 'Zanda Health',
      title: 'Product Owner',
      location: 'Anywhere in the World',
      url: 'https://weworkremotely.com/remote-jobs/zanda-health-product-owner',
    });
    expect([rok.complete, wwr.complete]).toEqual([false, false]);
  });

  it('searching boards get the strategy queries; the others are read once', async () => {
    const fetch = recordedFetch();
    const remotive = await readBoard('remotive', ctx(fetch, ['engineer']));
    const himalayas = await readBoard('himalayas', ctx(fetch, ['engineer']));
    const jobicy = await readBoard('jobicy', ctx(fetch, ['engineer']));
    const arbeitnow = await readBoard('arbeitnow', ctx(fetch, ['engineer']));
    expect(fetch.calls).toEqual([
      'https://remotive.com/api/remote-jobs?limit=100&search=engineer',
      'https://himalayas.app/jobs/api/search?q=engineer',
      'https://jobicy.com/api/v2/remote-jobs?count=50&tag=engineer',
      'https://www.arbeitnow.com/api/job-board-api',
    ]);
    expect(remotive.listings[1]?.title).toBe('Frontend Web Application Developer');
    expect(himalayas.listings[0]?.company).toBe('Roberts Civil Engineering, LLC');
    expect(jobicy.listings[0]).toMatchObject({ company: 'Maze', location: 'Remote (Europe)' });
    // Arbeitnow's escaped HTML arrives as text.
    expect(arbeitnow.listings[1]?.description).toMatch(/^SLSQ327R341\nDatabricks is seeking/);
  });
});

describe('the known-ATS detector', () => {
  it('reads the board from embed scripts, iframes and links', () => {
    expect(
      detectAtsBoard(
        '<div id="grnhse_app"></div><script src="https://boards.greenhouse.io/embed/job_board/js?for=acmeai"></script>',
      ),
    ).toEqual({ ats: 'greenhouse', token: 'acmeai' });
    expect(
      detectAtsBoard('<iframe src="https://jobs.ashbyhq.com/lumen/embed?version=2"></iframe>'),
    ).toEqual({ ats: 'ashby', token: 'lumen' });
    expect(detectAtsBoard('<a href="https://jobs.eu.lever.co/tallyhall">Jobs</a>')).toEqual({
      ats: 'lever',
      token: 'tallyhall',
    });
    expect(detectAtsBoard('<a href="https://apply.workable.com/huggingface/">Careers</a>')).toEqual(
      {
        ats: 'workable',
        token: 'huggingface',
      },
    );
    // The embed outweighs a stray link to another board.
    expect(
      detectAtsBoard(
        '<a href="https://jobs.lever.co/partner">x</a><script src="//boards.greenhouse.io/embed/job_board/js?for=acmeai"></script>',
      ),
    ).toEqual({ ats: 'greenhouse', token: 'acmeai' });
    expect(detectAtsBoard('<a href="https://example.com/jobs">Jobs</a>')).toBeNull();
    expect(boardFromUrl('https://apply.workable.com/j/F4C096B22E')).toBeNull();
    expect(boardFromUrl('https://boards-api.greenhouse.io/v1/boards/gitlab/jobs')).toEqual({
      ats: 'greenhouse',
      token: 'gitlab',
    });
  });

  it("gives each job its ATS id, from the ATS's pages or a career page's parameter", () => {
    expect(atsJobKey('https://job-boards.greenhouse.io/gitlab/jobs/8556658002')).toBe(
      'greenhouse:8556658002',
    );
    expect(atsJobKey('https://boards.greenhouse.io/gitlab/jobs/8556658002?gh_src=x')).toBe(
      'greenhouse:8556658002',
    );
    expect(atsJobKey('https://about.gitlab.com/jobs/apply?gh_jid=8556658002')).toBe(
      'greenhouse:8556658002',
    );
    expect(
      atsJobKey('https://www.origamics.ai/join-us?ashby_jid=7acf3a2d-46a5-420e-8397-a4e0b67bd968'),
    ).toBe('ashby:7acf3a2d-46a5-420e-8397-a4e0b67bd968');
    expect(
      atsJobKey('https://jobs.lever.co/leverdemo/681fbc53-1e34-4a46-8677-3a78118674eb/apply'),
    ).toBe('lever:681fbc53-1e34-4a46-8677-3a78118674eb');
    expect(atsJobKey('https://apply.workable.com/modash/j/c1507b65c3/')).toBe(
      'workable:C1507B65C3',
    );
    expect(atsJobKey('https://acme.example/careers/42')).toBeNull();
    expect(
      atsJobPage('https://jobs.ashbyhq.com/a/7458d4e9-da2e-47bd-98cb-adfda43d42b2/application'),
    ).toBe('https://jobs.ashbyhq.com/a/7458d4e9-da2e-47bd-98cb-adfda43d42b2');
    // A career page with the ATS's parameter keeps its own URL.
    expect(atsJobPage('https://about.gitlab.com/jobs/apply?gh_jid=1')).toBeNull();
  });
});

const CAREERS_JSONLD = `<!doctype html><html><head><title>Careers · Acme AI</title>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  itemListElement: [
    {
      '@type': 'ListItem',
      position: 1,
      item: {
        '@type': 'JobPosting',
        title: 'Senior AI Engineer',
        url: '/careers/senior-ai-engineer',
        identifier: { '@type': 'PropertyValue', value: 'AI-1' },
        hiringOrganization: { '@type': 'Organization', name: 'Acme AI' },
        jobLocationType: 'TELECOMMUTE',
        applicantLocationRequirements: { '@type': 'Country', name: 'European Union' },
        description: '<p>Build production LLM systems.</p>',
        datePosted: '2026-09-20',
      },
    },
    {
      '@type': 'ListItem',
      position: 2,
      item: {
        '@type': 'JobPosting',
        title: 'Office Manager',
        url: '/careers/office-manager',
        hiringOrganization: 'Acme AI',
        jobLocation: {
          '@type': 'Place',
          address: { addressLocality: 'Athens', addressCountry: 'GR' },
        },
        validThrough: '2026-09-01',
      },
    },
  ],
})}</script></head><body><h1>Careers</h1></body></html>`;

describe('feeds', () => {
  it('JobPosting JSON-LD on a career page (expired ones dropped)', () => {
    const feed = parseFeed(CAREERS_JSONLD, 'text/html', 'https://acme.example/careers', now);
    expect(feed?.format).toBe('json-ld');
    expect(feed?.complete).toBe(true);
    expect(feed?.listings).toEqual([
      expect.objectContaining({
        url: 'https://acme.example/careers/senior-ai-engineer',
        title: 'Senior AI Engineer',
        externalId: 'AI-1',
        company: 'Acme AI',
        remote: true,
        location: 'European Union',
        description: 'Build production LLM systems.',
      }),
    ]);
  });

  it('RSS, Atom and JSON Feed; a next page makes it partial', () => {
    const rss = parseFeed(
      `<?xml version="1.0"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Acme jobs</title>
      <item><title>Backend Engineer</title><link>https://acme.example/jobs/1</link><guid>job-1</guid><description>&lt;p&gt;Go &amp;amp; Postgres&lt;/p&gt;</description></item>
      </channel></rss>`,
      'application/rss+xml',
      'https://acme.example/jobs.rss',
      now,
    );
    expect(rss).toMatchObject({ format: 'rss', complete: true, title: 'Acme jobs' });
    expect(rss?.listings[0]).toMatchObject({
      title: 'Backend Engineer',
      url: 'https://acme.example/jobs/1',
      externalId: 'job-1',
      description: 'Go & Postgres',
    });
    const atom = parseFeed(
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Jobs</title><link rel="next" href="?page=2"/>
      <entry><title><![CDATA[Data Engineer]]></title><link href="/jobs/2"/><id>urn:2</id><summary>ETL</summary></entry></feed>`,
      'application/atom+xml',
      'https://acme.example/jobs.atom',
      now,
    );
    expect(atom).toMatchObject({ format: 'atom', complete: false });
    expect(atom?.listings[0]).toMatchObject({
      title: 'Data Engineer',
      url: 'https://acme.example/jobs/2',
    });
    const json = parseFeed(
      JSON.stringify({
        version: 'https://jsonfeed.org/version/1.1',
        title: 'Acme',
        items: [
          {
            id: '3',
            url: 'https://acme.example/jobs/3',
            title: 'ML Engineer',
            content_text: 'PyTorch',
          },
        ],
      }),
      'application/feed+json',
      'https://acme.example/feed.json',
      now,
    );
    expect(json).toMatchObject({ format: 'json-feed', complete: true });
    expect(json?.listings[0]).toMatchObject({ title: 'ML Engineer', externalId: '3' });
    expect(
      parseFeed('<html><body>No jobs</body></html>', 'text/html', 'https://x.example', now),
    ).toBeNull();
    expect(
      feedLinks(
        '<link rel="alternate" type="application/rss+xml" href="/jobs.rss"><link rel="stylesheet" href="/a.css">',
        'https://acme.example/careers',
      ),
    ).toEqual(['https://acme.example/jobs.rss']);
    expect(plainText('&lt;p&gt;a&lt;/p&gt;&lt;p&gt;b')).toBe('a\nb');
  });
});

describe('career pages: a feed first, then a known ATS embed', () => {
  const greenhouse = 'https://boards-api.greenhouse.io/v1/boards/acmeai/jobs?content=true';
  const gh = fixtureJson<Record<string, unknown>>('greenhouse-gitlab.json');

  it('a page with JobPosting JSON-LD is its own feed', async () => {
    const fetch = recordedFetch({ 'https://acme.example/careers': CAREERS_JSONLD });
    const run = await readPage('https://acme.example/careers', ctx(fetch));
    expect(run.resolved).toEqual({
      via: 'feed',
      url: 'https://acme.example/careers',
      format: 'json-ld',
    });
    expect(run.complete).toBe(true);
    expect(run.listings.map((l) => l.title)).toEqual(['Senior AI Engineer']);
  });

  it('a page that embeds a Greenhouse board is read through the Greenhouse API, and remembered', async () => {
    const fetch = recordedFetch({
      'https://acme.example/careers':
        '<html><body><div id="grnhse_app"></div><script src="https://boards.greenhouse.io/embed/job_board/js?for=acmeai"></script></body></html>',
      [greenhouse]: gh,
    });
    const run = await readPage('https://acme.example/careers', ctx(fetch));
    expect(run.resolved).toEqual({ via: 'ats', ats: 'greenhouse', token: 'acmeai' });
    expect(run.complete).toBe(true);
    expect(run.listings).toHaveLength(4);
    expect(run.note).toMatch(/^embedded greenhouse board acmeai: GitLab on Greenhouse: 4 jobs/);
    // The next run goes straight to the API.
    fetch.calls.length = 0;
    await readPage('https://acme.example/careers', ctx(fetch), run.resolved);
    expect(fetch.calls).toEqual([greenhouse]);
  });

  it('a page that advertises a feed is read through it', async () => {
    const fetch = recordedFetch({
      'https://acme.example/careers':
        '<html><head><link rel="alternate" type="application/rss+xml" href="/jobs.rss"></head><body></body></html>',
      'https://acme.example/jobs.rss': {
        contentType: 'application/rss+xml',
        body: '<?xml version="1.0"?><rss><channel><item><title>SRE</title><link>https://acme.example/jobs/9</link></item></channel></rss>',
      },
    });
    const run = await readPage('https://acme.example/careers', ctx(fetch));
    expect(run.resolved).toEqual({
      via: 'feed',
      url: 'https://acme.example/jobs.rss',
      format: 'rss',
    });
    expect(run.listings[0]?.title).toBe('SRE');
  });

  it('a page with neither says so (recipes come in phase 11)', async () => {
    const fetch = recordedFetch({
      'https://acme.example/careers': '<html><body><ul><li>Engineer</li></ul></body></html>',
    });
    await expect(readPage('https://acme.example/careers', ctx(fetch))).rejects.toThrow(
      /listing recipe \(phase 11\)/,
    );
  });
});
