#!/usr/bin/env node
// Records the public list responses the search readers read, trimmed to a few jobs each, into
// test/fixtures/search/ (responses.json says which URL gave which file). Only GETs of public
// list APIs and feeds; nothing is sent anywhere. `test/readers.test.ts` replays them offline.
//
//   node scripts/search-fixtures.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_AGENT } from '../src/domain/search/readers/http.ts';

const OUT = fileURLToPath(new URL('../test/fixtures/search', import.meta.url));
const KEEP = 4;
const TEXT = 1500;

type Json = Record<string, unknown>;

interface Recorded {
  url: string;
  status: number;
  contentType: string;
  file: string;
}

const clip = (v: unknown, n = TEXT) => (typeof v === 'string' && v.length > n ? v.slice(0, n) : v);

function trimJob(job: Json, fields: string[]): Json {
  const out: Json = { ...job };
  for (const f of fields) if (f in out) out[f] = clip(out[f]);
  return out;
}

async function fetchText(
  url: string,
): Promise<{ status: number; contentType: string; text: string }> {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    text: await res.text(),
  };
}

const recorded: Recorded[] = [];

async function record(
  name: string,
  url: string,
  trim: (text: string) => string,
  ext = 'json',
): Promise<string> {
  const res = await fetchText(url);
  const file = `${name}.${ext}`;
  const body = res.status < 400 ? trim(res.text) : res.text;
  writeFileSync(join(OUT, file), body);
  recorded.push({
    url,
    status: res.status,
    contentType: res.contentType.split(';')[0] ?? '',
    file,
  });
  process.stdout.write(`${res.status} ${url} → ${file} (${body.length} bytes)\n`);
  return res.text;
}

const json = (f: (d: Json) => unknown) => (text: string) =>
  `${JSON.stringify(f(JSON.parse(text) as Json), null, 1)}\n`;

mkdirSync(OUT, { recursive: true });

await record(
  'greenhouse-gitlab',
  'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true',
  json((d) => {
    const jobs = (d.jobs as Json[]).slice(0, KEEP).map((j) => trimJob(j, ['content']));
    return { jobs, meta: { total: jobs.length } };
  }),
);
await record(
  'ashby-ashby',
  'https://api.ashbyhq.com/posting-api/job-board/ashby?includeCompensation=true',
  json((d) => ({
    ...d,
    jobs: (d.jobs as Json[])
      .slice(0, KEEP)
      .map((j) => trimJob(j, ['descriptionHtml', 'descriptionPlain'])),
  })),
);
await record(
  'lever-leverdemo',
  'https://api.lever.co/v0/postings/leverdemo?mode=json',
  json((d) =>
    (d as unknown as Json[])
      .slice(0, KEEP)
      .map((j) =>
        trimJob(j, [
          'description',
          'descriptionPlain',
          'additional',
          'additionalPlain',
          'descriptionBody',
          'descriptionBodyPlain',
          'opening',
          'openingPlain',
        ]),
      ),
  ),
);
// An EU board: empty on the global host, listed on api.eu.lever.co.
await record('lever-eu-on-global', 'https://api.lever.co/v0/postings/lever?mode=json', (t) => t);
await record(
  'lever-eu-lever',
  'https://api.eu.lever.co/v0/postings/lever?mode=json',
  json((d) =>
    (d as unknown as Json[])
      .slice(0, KEEP)
      .map((j) =>
        trimJob(j, [
          'description',
          'descriptionPlain',
          'additional',
          'additionalPlain',
          'descriptionBody',
          'descriptionBodyPlain',
          'opening',
          'openingPlain',
        ]),
      ),
  ),
);
await record(
  'workable-huggingface',
  'https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true',
  json((d) => ({
    ...d,
    description: clip(d.description, 300),
    jobs: (d.jobs as Json[]).slice(0, KEEP).map((j) => trimJob(j, ['description'])),
  })),
);
const stories = await record(
  'hn-stories',
  'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10',
  json((d) => ({
    hits: (d.hits as Json[])
      .slice(0, 4)
      .map((h) => ({ objectID: h.objectID, title: h.title, created_at: h.created_at })),
  })),
);
const thread = (JSON.parse(stories) as { hits: Json[] }).hits.find((h) =>
  /who is hiring/i.test(String(h.title)),
);
await record(
  'hn-thread',
  `https://hn.algolia.com/api/v1/items/${thread?.objectID}`,
  json((d) => ({
    id: d.id,
    title: d.title,
    children: (d.children as Json[]).slice(0, 6).map((c) => ({
      id: c.id,
      author: c.author,
      created_at: c.created_at,
      text: clip(c.text, 2500),
      children: [],
    })),
  })),
);
await record(
  'remoteok',
  'https://remoteok.com/api',
  json((d) => {
    const all = d as unknown as Json[];
    return [all[0], ...all.slice(1, 1 + KEEP).map((j) => trimJob(j, ['description']))];
  }),
);
await record(
  'wwr',
  'https://weworkremotely.com/remote-jobs.rss',
  (t) => {
    const items = t.split('<item>');
    const head = items[0] ?? '';
    const kept = items.slice(1, 1 + KEEP).map((i) => i.split('</item>')[0] ?? '');
    const clipDesc = (i: string) =>
      i.replace(
        /<description>([\s\S]*?)<\/description>/,
        (_m, d: string) => `<description>${d.slice(0, TEXT)}</description>`,
      );
    return `${head}${kept.map((i) => `<item>${clipDesc(i)}</item>`).join('\n')}\n  </channel>\n</rss>\n`;
  },
  'rss',
);
await record(
  'remotive-engineer',
  'https://remotive.com/api/remote-jobs?limit=100&search=engineer',
  json((d) => ({
    ...d,
    jobs: (d.jobs as Json[]).slice(0, KEEP).map((j) => trimJob(j, ['description'])),
  })),
);
await record(
  'himalayas-engineer',
  'https://himalayas.app/jobs/api/search?q=engineer',
  json((d) => ({
    ...d,
    jobs: (d.jobs as Json[]).slice(0, KEEP).map((j) => trimJob(j, ['description'])),
  })),
);
await record(
  'arbeitnow',
  'https://www.arbeitnow.com/api/job-board-api',
  json((d) => ({
    ...d,
    data: (d.data as Json[]).slice(0, KEEP).map((j) => trimJob(j, ['description'])),
  })),
);
await record(
  'jobicy-engineer',
  'https://jobicy.com/api/v2/remote-jobs?count=50&tag=engineer',
  json((d) => ({
    ...d,
    jobs: (d.jobs as Json[]).slice(0, KEEP).map((j) => trimJob(j, ['jobDescription'])),
  })),
);

// Personio's XML: the first positions, each description section clipped.
const personioXml = (t: string) => {
  const parts = t.split('<position>');
  const kept = parts.slice(1, 1 + KEEP).map((p) => p.split('</position>')[0] ?? '');
  const clipValues = (p: string) =>
    p.replace(
      /<!\[CDATA\[([\s\S]*?)\]\]>/g,
      (_m, v: string) => `<![CDATA[${v.slice(0, TEXT / 3)}]]>`,
    );
  return `${parts[0] ?? ''}${kept.map((p) => `<position>${clipValues(p)}</position>`).join('\n')}\n</workzag-jobs>\n`;
};
// A German board (every position described in German), and Personio's own, whose position is
// written in English only: described under ?language=en alone.
await record('personio-ottonova', 'https://ottonova.jobs.personio.de/xml', personioXml, 'xml');
await record('personio-personio', 'https://personio.jobs.personio.de/xml', personioXml, 'xml');
await record(
  'personio-personio-en',
  'https://personio.jobs.personio.de/xml?language=en',
  personioXml,
  'xml',
);
const recruiteeOffer = (o: Json) => {
  const { translations: _t, open_questions: _q, ...rest } = o;
  return trimJob(rest, ['description', 'requirements']);
};
await record(
  'recruitee-channable',
  'https://channable.recruitee.com/api/offers/',
  json((d) => {
    const offers = d.offers as Json[];
    // The first few and a remote one.
    const remote = offers.find((o) => o.remote === true);
    const kept = [...offers.slice(0, KEEP - 1), ...(remote ? [remote] : [])];
    return { offers: kept.map(recruiteeOffer) };
  }),
);
// Teamtailor's JSON Feed, three pages (the next_url chain), a job or two from each.
const teamtailorPage = (n: number) =>
  json((d) => ({
    ...d,
    items: (d.items as Json[]).slice(0, n).map((i) => {
      const posting = i._jobposting as Json | undefined;
      return {
        ...trimJob(i, ['content_html']),
        ...(posting ? { _jobposting: trimJob(posting, ['description']) } : {}),
      };
    }),
  }));
await record('teamtailor-eworgmbh', 'https://eworgmbh.teamtailor.com/jobs.json', teamtailorPage(2));
await record(
  'teamtailor-eworgmbh-2',
  'https://eworgmbh.teamtailor.com/jobs.json?page=2&per_page=100',
  teamtailorPage(1),
);
await record(
  'teamtailor-eworgmbh-3',
  'https://eworgmbh.teamtailor.com/jobs.json?page=3&per_page=100',
  teamtailorPage(1),
);
// JOIN's company page, down to the Next.js data the reader takes the company's id from.
await record(
  'join-join',
  'https://join.com/companies/join',
  (t) => {
    const data = JSON.parse(
      t.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '{}',
    ) as Json;
    const state = ((data.props as Json).pageProps as Json).initialState as Json;
    const co = state.company as Json;
    const jobs = state.jobs as Json;
    const kept = {
      props: {
        pageProps: {
          initialState: {
            company: { id: co.id, name: co.name, domain: co.domain, url: co.url },
            jobs: { pagination: jobs.pagination, items: (jobs.items as Json[]).slice(0, 2) },
          },
        },
      },
      page: data.page,
      query: data.query,
    };
    const title = t.match(/<title>[^<]*<\/title>/)?.[0] ?? '';
    return `<!DOCTYPE html><html><head>${title}</head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(kept)}</script></body></html>\n`;
  },
  'html',
);
await record(
  'join-join-jobs',
  'https://join.com/api/public/companies/54/jobs?page=1&pageSize=5',
  json((d) => d),
);
await record(
  'breezy-breezy',
  'https://breezy.breezy.hr/json?verbose=true',
  json((d) => (d as unknown as Json[]).slice(0, KEEP).map((j) => trimJob(j, ['description']))),
);

writeFileSync(join(OUT, 'responses.json'), `${JSON.stringify(recorded, null, 2)}\n`);
process.stdout.write(`recorded ${recorded.length} responses into ${OUT}\n`);
