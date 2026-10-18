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
import { NeedsRecipeError, readPage } from '../src/domain/search/readers/page.ts';
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

  describe('SmartRecruiters', () => {
    const api = (offset: number) =>
      `https://api.smartrecruiters.com/v1/companies/Acme/postings?limit=100&offset=${offset}`;
    const job = (i: number, over: Record<string, unknown> = {}) => ({
      id: String(744000100000000 + i),
      name: `Engineer ${i}`,
      company: { identifier: 'Acme', name: 'Acme Corp' },
      releasedDate: '2026-10-01T10:00:00.000Z',
      location: { city: 'Berlin', country: 'de', fullLocation: 'Berlin, Germany', remote: false },
      department: { label: 'Engineering' },
      ...over,
    });

    it('reads every page of the list; jobs have their id, company and place', async () => {
      const first = Array.from({ length: 100 }, (_, i) => job(i));
      const fetch = recordedFetch({
        [api(0)]: { totalFound: 101, content: first },
        [api(100)]: {
          totalFound: 101,
          content: [job(100, { location: { fullLocation: 'Lisbon, Portugal', remote: true } })],
        },
      });
      const run = await readAtsBoard('smartrecruiters', 'Acme', ctx(fetch));
      expect(run.complete).toBe(true);
      expect(run.company).toBe('Acme Corp');
      expect(run.note).toBe('Acme Corp on SmartRecruiters: 101 jobs');
      expect(run.listings).toHaveLength(101);
      expect(run.listings[0]).toMatchObject({
        url: 'https://jobs.smartrecruiters.com/Acme/744000100000000',
        externalId: '744000100000000',
        title: 'Engineer 0',
        company: 'Acme Corp',
        location: 'Berlin, Germany',
        remote: null,
        team: 'Engineering',
        postedAt: '2026-10-01T10:00:00.000Z',
      });
      expect(run.listings[100]).toMatchObject({
        location: 'Remote (Lisbon, Portugal)',
        remote: true,
      });
    });

    it('an empty list is a company with no jobs only if its careers page exists', async () => {
      const empty = { totalFound: 0, content: [] };
      const known = recordedFetch({
        [api(0)]: empty,
        'https://careers.smartrecruiters.com/Acme': '<html>Acme careers</html>',
      });
      const run = await readAtsBoard('smartrecruiters', 'Acme', ctx(known));
      expect(run).toMatchObject({ complete: true, listings: [] });
      // The API answers an unknown company with an empty list too.
      await expect(
        readAtsBoard('smartrecruiters', 'Acme', ctx(recordedFetch({ [api(0)]: empty }))),
      ).rejects.toThrow(/HTTP 404/);
    });
  });

  it('a board that does not exist fails the read', async () => {
    await expect(readAtsBoard('greenhouse', 'no-such-board', ctx(recordedFetch()))).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

describe('job boards (recorded)', () => {
  it('searches Djinni for the strategy terms, whatever the role', async () => {
    const url = 'https://djinni.co/jobs/rss/?all_keywords=Laravel';
    const fetch = recordedFetch({
      [url]: `<?xml version="1.0"?><rss><channel><title>Djinni</title><item>
        <guid>https://djinni.co/jobs/123-laravel-engineer/</guid>
        <link>https://djinni.co/jobs/123-laravel-engineer/</link>
        <title>Laravel Engineer</title><description>Build services</description>
      </item></channel></rss>`,
    });
    const run = await readBoard('djinni', ctx(fetch, ['Laravel -junior']));
    expect(fetch.calls).toEqual([url]);
    expect(run).toMatchObject({ complete: false, note: 'Djinni: 1 jobs for this search' });
    expect(run.listings[0]).toMatchObject({
      title: 'Laravel Engineer',
      url: 'https://djinni.co/jobs/123-laravel-engineer/',
    });
  });

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
    expect(
      detectAtsBoard('<a href="https://careers.smartrecruiters.com/Ubisoft2">Open roles</a>'),
    ).toEqual({ ats: 'smartrecruiters', token: 'Ubisoft2' });
    expect(
      detectAtsBoard(
        '<script src="https://static.smartrecruiters.com/job-widget/1.6.1/script/smart_widget.min.js"></script><script>widget({"company_code":"Ubisoft2"})</script>',
      ),
    ).toEqual({ ats: 'smartrecruiters', token: 'Ubisoft2' });
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
    expect(
      atsJobKey('https://jobs.smartrecruiters.com/Ubisoft2/744000156048035-development-executive'),
    ).toBe('smartrecruiters:744000156048035');
    expect(boardFromUrl('https://jobs.smartrecruiters.com/Ubisoft2/744000156048035')).toEqual({
      ats: 'smartrecruiters',
      token: 'Ubisoft2',
    });
    expect(boardFromUrl('https://api.smartrecruiters.com/v1/companies/Ubisoft2/postings')).toEqual({
      ats: 'smartrecruiters',
      token: 'Ubisoft2',
    });
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

  it('reads Jobico’s public XML feed as direct job pages', () => {
    const feed = parseFeed(
      `<?xml version="1.0"?><source><publisher>Jobico</publisher><job>
        <id>abc123</id><link>https://www.jobico.io/jobs/senior-python-engineer</link>
        <title>Senior Python Engineer</title><company>Acme</company>
        <locationtype>remote</locationtype><country>Ukraine</country>
        <description><![CDATA[<p>Build Python services.</p>]]></description>
        <date>2026-10-02T08:00:00Z</date>
      </job></source>`,
      'application/xml',
      'https://jobico.io/api/feeds/jobs.xml',
      now,
    );
    expect(feed).toMatchObject({ format: 'job-xml', complete: true, title: 'Jobico' });
    expect(feed?.listings).toEqual([
      expect.objectContaining({
        url: 'https://www.jobico.io/jobs/senior-python-engineer',
        externalId: 'abc123',
        title: 'Senior Python Engineer',
        company: 'Acme',
        remote: true,
        description: 'Build Python services.',
      }),
    ]);
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

  it('a page with neither says it needs a listing recipe', async () => {
    const fetch = recordedFetch({
      'https://acme.example/careers': '<html><body><ul><li>Engineer</li></ul></body></html>',
    });
    const read = readPage('https://acme.example/careers', ctx(fetch));
    await expect(read).rejects.toThrow(/it needs a listing recipe/);
    await expect(read).rejects.toBeInstanceOf(NeedsRecipeError);
  });

  it('a page that is a Teamtailor board itself is read as the board, not its feed', async () => {
    const run = await readPage('https://eworgmbh.teamtailor.com/jobs.rss', ctx(recordedFetch()), {
      via: 'feed',
      url: 'https://eworgmbh.teamtailor.com/jobs.rss',
      format: 'rss',
    });
    expect(run.resolved).toEqual({ via: 'ats', ats: 'teamtailor', token: 'eworgmbh' });
    expect(run.complete).toBe(true);
    expect(run.listings).toHaveLength(4);
  });
});

describe('European ATS boards (recorded)', () => {
  it('Personio: the XML list, its offices and sections, the entity without its number', async () => {
    const run = await readAtsBoard('personio', 'ottonova', ctx(recordedFetch()));
    expect(run.complete).toBe(true);
    expect(run.listings).toHaveLength(4);
    const first = run.listings[0];
    expect(first).toMatchObject({
      url: 'https://ottonova.jobs.personio.de/job/2573573',
      externalId: '2573573',
      company: 'ottonova Krankenversicherung AG',
      location: 'München; Köln',
      team: 'Risk Management & Actuary',
      postedAt: '2026-03-23T15:24:29+00:00',
    });
    // Each description section's heading, then its text.
    expect(first?.description).toMatch(/^DEIN TEAM\n/);
    expect(first?.description).not.toMatch(/<|&amp;/);
    expect(run.note).toMatch(/^ottonova .* on Personio: 4 jobs$/);
  });

  it('Personio: a position written only in English is described from ?language=en', async () => {
    const fetch = recordedFetch();
    const run = await readAtsBoard('personio', 'personio', ctx(fetch));
    expect(fetch.calls).toEqual([
      'https://personio.jobs.personio.de/xml',
      'https://personio.jobs.personio.de/xml?language=en',
    ]);
    expect(run.company).toBe('Personio SE & Co. KG');
    expect(run.listings[0]).toMatchObject({
      title: 'Staff Software Engineer, Data Platform',
      location: 'Munich; Berlin',
    });
    expect(run.listings[0]?.description).toMatch(/^The Role: How you'll make an impact/);
  });

  it('Recruitee: the offers, on the career site with the Recruitee page beside', async () => {
    const run = await readAtsBoard('recruitee', 'channable', ctx(recordedFetch()));
    expect(run).toMatchObject({ complete: true, company: 'Channable' });
    expect(run.listings).toHaveLength(4);
    expect(run.listings[0]).toMatchObject({
      url: 'https://jobs.channable.com/o/senior-customer-success-manager-benelux-9',
      sourceUrl: 'https://channable.recruitee.com/o/senior-customer-success-manager-benelux-9',
      applyUrl: 'https://jobs.channable.com/o/senior-customer-success-manager-benelux-9/c/new',
      externalId: '2786321',
      location: 'Utrecht, Netherlands',
      remote: false,
      team: 'Customer Success',
      postedAt: '2026-10-16T11:35:00Z',
    });
    expect(run.listings[3]).toMatchObject({ location: 'Remote (United States)', remote: true });
    // The Recruitee page names the job, whatever the career site's domain.
    expect(atsJobKey(run.listings[0]?.sourceUrl)).toBe(
      'recruitee:channable/senior-customer-success-manager-benelux-9',
    );
  });

  it('Teamtailor: every page of the JSON Feed, places from each job’s JobPosting', async () => {
    const fetch = recordedFetch();
    const run = await readAtsBoard('teamtailor', 'eworgmbh', ctx(fetch));
    expect(fetch.calls).toHaveLength(3);
    expect(run).toMatchObject({ complete: true, company: 'EWOR GmbH' });
    expect(run.listings).toHaveLength(4);
    expect(run.listings[0]).toMatchObject({
      url: 'https://eworgmbh.teamtailor.com/jobs/8558035-ai-co-founder-cco-100-remote-m-f-d',
      externalId: '8558035',
      company: 'EWOR GmbH',
      location: 'Vaduz, Europe, LI',
      postedAt: '2026-10-16T12:32:18+02:00',
    });
    expect(run.listings[0]?.description).toMatch(/^We are looking to hire ambitious entrepreneurs/);
    // A next page on another host isn't followed, and the list is partial.
    const last = fixtureJson('teamtailor-eworgmbh-3.json');
    const off = recordedFetch({
      'https://eworgmbh.teamtailor.com/jobs.json?page=3&per_page=100': {
        ...last,
        next_url: 'https://elsewhere.example/jobs.json?page=4',
      },
    });
    const partial = await readAtsBoard('teamtailor', 'eworgmbh', ctx(off));
    expect(partial.complete).toBe(false);
    expect(off.calls).toHaveLength(3);
  });

  it('JOIN: the company id from its page, then the list five jobs a page', async () => {
    const fetch = recordedFetch();
    const run = await readAtsBoard('join', 'join', ctx(fetch));
    expect(fetch.calls).toEqual([
      'https://join.com/companies/join',
      'https://join.com/api/public/companies/54/jobs?page=1&pageSize=5',
    ]);
    expect(run).toMatchObject({ complete: true, company: 'JOIN' });
    expect(run.listings).toHaveLength(4);
    expect(run.listings[0]).toMatchObject({
      // The job's id, not the ad's current number (16833245), which changes on republishing.
      url: 'https://join.com/companies/join/14771122-engineering-manager',
      externalId: '14771122',
      title: 'Engineering Manager',
      company: 'JOIN',
      location: 'Barcelona, Spain',
      remote: false,
      team: 'Management, Team Leader',
    });

    const api = (n: number) => `https://join.com/api/public/companies/54/jobs?page=${n}&pageSize=5`;
    const job = (i: number) => ({
      id: 100 + i,
      idParam: `${900 + i}-engineer-${i}`,
      title: `Engineer ${i}`,
      workplaceType: i === 5 ? 'REMOTE' : 'ONSITE',
      city: { cityName: 'Berlin', countryName: 'Germany' },
    });
    const paged = recordedFetch({
      [api(1)]: {
        items: [0, 1, 2, 3, 4].map(job),
        pagination: { rowCount: 6, pageCount: 2, page: 1, pageSize: 5 },
      },
      [api(2)]: {
        items: [job(5)],
        pagination: { rowCount: 6, pageCount: 2, page: 2, pageSize: 5 },
      },
    });
    const two = await readAtsBoard('join', 'join', ctx(paged));
    expect(two.complete).toBe(true);
    expect(two.listings).toHaveLength(6);
    expect(two.listings[5]).toMatchObject({
      url: 'https://join.com/companies/join/105-engineer-5',
      location: 'Remote (Berlin, Germany)',
      remote: true,
    });
  });

  it('Breezy: the verbose JSON list', async () => {
    const run = await readAtsBoard('breezy', 'breezy', ctx(recordedFetch()));
    expect(run).toMatchObject({ complete: true, company: 'MS Breezy Trial' });
    expect(run.listings).toHaveLength(3);
    expect(run.listings[0]).toMatchObject({
      url: 'https://breezy.breezy.hr/p/98323abf2296-employee-12',
      externalId: '98323abf2296',
      title: 'Employee #12',
      location: 'Chaos, FL',
      remote: null,
      team: 'Does Not Matter',
      description: 'Roses and Rainbows until 30 days in.',
    });
  });

  it('a company none of them knows fails the read with a 404', async () => {
    for (const ats of ['personio', 'recruitee', 'teamtailor', 'join', 'breezy'] as const) {
      await expect(readAtsBoard(ats, 'no-such-company', ctx(recordedFetch()))).rejects.toThrow(
        /HTTP 404/,
      );
    }
  });

  it('finds their boards on career pages, and their jobs’ ids', () => {
    expect(detectAtsBoard('<a href="https://acme.jobs.personio.de/?language=en">Jobs</a>')).toEqual(
      { ats: 'personio', token: 'acme' },
    );
    expect(
      detectAtsBoard(
        '<script src="https://acme.breezy.hr/embed/js?inline=true"></script><a href="https://www.teamtailor.com/?utm_source=career-site">Powered by Teamtailor</a>',
      ),
    ).toEqual({ ats: 'breezy', token: 'acme' });
    expect(detectAtsBoard('<a href="https://join.com/companies/acme">Open roles</a>')).toEqual({
      ats: 'join',
      token: 'acme',
    });
    expect(detectAtsBoard('<a href="https://acme.teamtailor.com/jobs">Jobs</a>')).toEqual({
      ats: 'teamtailor',
      token: 'acme',
    });
    // A Recruitee career site on the company's own domain: its config names the subdomain;
    // Recruitee's own hosts (analytics, the marketing site) are no company.
    expect(
      detectAtsBoard(
        '<script src="https://careers-analytics.recruitee.com/a.js"></script><div data-props="{&quot;atsHost&quot;:&quot;recruitee.com&quot;,&quot;subdomain&quot;:&quot;channable&quot;}"></div>',
      ),
    ).toEqual({ ats: 'recruitee', token: 'channable' });
    expect(detectAtsBoard('<a href="https://www.teamtailor.com/">Teamtailor</a>')).toBeNull();
    expect(boardFromUrl('https://acme.jobs.personio.com/xml')).toEqual({
      ats: 'personio',
      token: 'acme',
    });
    expect(boardFromUrl('https://acme.recruitee.com/api/offers/')).toEqual({
      ats: 'recruitee',
      token: 'acme',
    });
    expect(boardFromUrl('https://join.com/companies/acme/16833245-engineering-manager')).toEqual({
      ats: 'join',
      token: 'acme',
    });
    expect(boardFromUrl('https://join.com/api/public/companies/54/jobs')).toBeNull();
    expect(boardFromUrl('https://careers-analytics.recruitee.com/')).toBeNull();

    expect(atsJobKey('https://acme.jobs.personio.de/job/2573573?language=de')).toBe(
      'personio:2573573',
    );
    expect(atsJobKey('https://Acme.recruitee.com/o/Backend-Engineer-2/c/new')).toBe(
      'recruitee:acme/backend-engineer-2',
    );
    expect(atsJobKey('https://acme.teamtailor.com/jobs/8558035-ai-engineer')).toBe(
      'teamtailor:8558035',
    );
    expect(atsJobKey('https://acme.breezy.hr/p/98323abf2296-employee-12/apply')).toBe(
      'breezy:98323abf2296',
    );
    // JOIN's job addresses take a new number at each republishing: no key.
    expect(atsJobKey('https://join.com/companies/acme/16833245-engineering-manager')).toBeNull();
    expect(atsJobKey('https://acme.teamtailor.com/jobs')).toBeNull();
    expect(atsJobPage('https://acme.recruitee.com/o/backend-engineer-2/c/new')).toBe(
      'https://acme.recruitee.com/o/backend-engineer-2',
    );
  });
});
