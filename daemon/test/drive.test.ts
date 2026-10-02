// Google Drive knowledge sources (phase 16): a local fake of the Drive REST API answers with
// recorded export responses (a Google Doc as Markdown, a Sheet as CSV, an uploaded PDF), and
// the real sync_source handler turns them into unconfirmed facts with drive evidence.
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mailboxes, sources } from '../src/db/schema.ts';
import { listFacts } from '../src/domain/knowledge/facts.ts';
import {
  type DriveAccess,
  driveFileId,
  GoogleDrive,
} from '../src/domain/knowledge/sources/drive.ts';
import { addSource, SourceError } from '../src/domain/knowledge/sources/registry.ts';
import { syncSource } from '../src/domain/knowledge/sync.ts';
import { MailService } from '../src/integrations/mail-service.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import { EventBus } from '../src/queue/events.ts';
import { Worker } from '../src/queue/worker.ts';
import { FileSecrets } from '../src/secrets/file-backend.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { handlers, quietLog, testDeps } from './helpers/deps.ts';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/drive/${name}`, import.meta.url)));
const CV_PDF = readFileSync(fileURLToPath(new URL('./fixtures/cv/cv.pdf', import.meta.url)));

const DOC_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const SHEET_ID = '1SkillsSheet0123456789abcdefghij';
const PDF_ID = '1CvPdfUpload0123456789abcdefghij';

interface FakeDrive {
  origin: string;
  server: Server;
  requests: string[];
  auth: string[];
}

/** The four Drive calls a read makes, answered from the recorded responses. */
async function fakeDrive(): Promise<FakeDrive> {
  const d: FakeDrive = { origin: '', server: null as never, requests: [], auth: [] };
  const meta: Record<string, unknown> = {
    [DOC_ID]: JSON.parse(fixture('case-study.meta.json').toString()),
    [SHEET_ID]: JSON.parse(fixture('skills.meta.json').toString()),
    [PDF_ID]: {
      id: PDF_ID,
      name: 'CV 2026.pdf',
      mimeType: 'application/pdf',
      size: String(CV_PDF.length),
      modifiedTime: '2026-09-01T08:00:00.000Z',
    },
  };
  d.server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    d.requests.push(`${u.pathname}${u.search}`);
    d.auth.push(String(req.headers.authorization));
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const m = /^\/files\/([\w-]+)(\/export)?$/.exec(u.pathname);
    const id = m?.[1] ?? '';
    if (!m || !meta[id]) {
      return json(404, {
        error: { code: 404, message: `File not found: ${id}.`, errors: [{ reason: 'notFound' }] },
      });
    }
    if (m[2]) {
      const mime = u.searchParams.get('mimeType');
      if (id === DOC_ID && mime === 'text/markdown') {
        res.writeHead(200, { 'content-type': 'text/markdown' });
        return res.end(fixture('case-study.md'));
      }
      if (id === SHEET_ID && mime === 'text/csv') {
        res.writeHead(200, { 'content-type': 'text/csv' });
        return res.end(fixture('skills.csv'));
      }
      return json(400, { error: { message: 'Export only supports Docs Editors files.' } });
    }
    if (u.searchParams.get('alt') === 'media') {
      if (id !== PDF_ID)
        return json(403, {
          error: {
            message: 'Only files with binary content can be downloaded.',
            errors: [{ reason: 'fileNotDownloadable' }],
          },
        });
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end(CV_PDF);
    }
    return json(200, meta[id]);
  });
  await new Promise<void>((r) => d.server.listen(0, '127.0.0.1', r));
  d.origin = `http://127.0.0.1:${(d.server.address() as AddressInfo).port}`;
  return d;
}

describe('drive links', () => {
  it('turns Docs, Drive and open?id= links into the file id', () => {
    expect(driveFileId(`https://docs.google.com/document/d/${DOC_ID}/edit?usp=sharing`)).toBe(
      DOC_ID,
    );
    expect(driveFileId(`https://drive.google.com/file/d/${PDF_ID}/view`)).toBe(PDF_ID);
    expect(driveFileId(`https://drive.google.com/open?id=${SHEET_ID}`)).toBe(SHEET_ID);
    expect(driveFileId(` ${DOC_ID} `)).toBe(DOC_ID);
    expect(() => driveFileId('https://example.com/d/1AbCdEfGhIjKlMnOp')).toThrow(
      /not a Google Drive link/,
    );
    expect(() => driveFileId('https://drive.google.com/drive/my-drive')).toThrow(/no file id/);
  });
});

describe('sync_source on Drive files', () => {
  let drive: FakeDrive;
  let t: TempDb;
  let bus: EventBus;
  let fake: FakeProvider;
  let worker: Worker;
  let access: DriveAccess | null;
  const now = new Date('2026-09-29T10:00:00Z');

  beforeAll(async () => {
    drive = await fakeDrive();
  });
  afterAll(() => {
    drive.server.close();
  });

  beforeEach(() => {
    t = tempDb();
    bus = new EventBus();
    fake = new FakeProvider('claude');
    drive.requests = [];
    access = {
      drive: async () =>
        new GoogleDrive({ auth: { accessToken: async () => 'drive-token' }, api: drive.origin }),
    };
    worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      deps: {
        ...testDeps({ dir: t.dir, db: t.db, providers: [fake] }),
        drive: { drive: () => (access ? access.drive() : Promise.resolve(null)) },
      },
      handlers: handlers({ sync_source: syncSource }),
      log: quietLog,
      concurrency: 1,
      leaseMs: 60_000,
      pollMs: 10,
      maxAttempts: 3,
    });
    worker.start();
  });

  afterEach(async () => {
    await worker.stop();
    t.cleanup();
  });

  const note = (id: number) =>
    t.db.select().from(sources).where(eq(sources.id, id)).get()?.syncNote ?? '';

  it('exports a Google Doc as Markdown and stores facts with drive evidence', async () => {
    fake.push({
      output: {
        projects: [
          {
            name: 'Harbor',
            kind: 'project',
            summary: 'Call analytics for sales teams',
            role: null,
            period: null,
            stack: ['Python', 'FastAPI'],
          },
        ],
        facts: [
          {
            text: 'Designed the streaming call-analysis pipeline that replaced the nightly batch',
            kind: 'personal_contribution',
            project: 'Harbor',
            evidence: [{ locator: '#What I built', quote: 'I designed the streaming pipeline' }],
          },
          {
            text: 'Cut transcription cost by 35% in the first quarter',
            kind: 'impact',
            project: 'Harbor',
            evidence: [{ locator: '#Results', quote: null }],
          },
          {
            text: 'Maria Petrou built the dashboards on top of the scoring API',
            kind: 'team_context',
            project: 'Harbor',
            evidence: [{ locator: '#What I built', quote: null }],
          },
        ],
      },
    });
    const { source } = addSource(t.db, bus, {
      project: null,
      kind: 'drive',
      locator: `https://docs.google.com/document/d/${DOC_ID}/edit?usp=sharing`,
      now,
    });
    expect(source.locator).toBe(DOC_ID);
    await worker.idle();

    // Metadata, then the export as Markdown (headings kept for the locators), with the token.
    expect(drive.requests).toEqual([
      `/files/${DOC_ID}?supportsAllDrives=true&fields=id%2Cname%2CmimeType%2CmodifiedTime%2Csize%2CwebViewLink`,
      `/files/${DOC_ID}/export?mimeType=text%2Fmarkdown`,
    ]);
    expect(drive.auth.every((a) => a === 'Bearer drive-token')).toBe(true);
    const prompt = fake.requests[0]?.prompt ?? '';
    expect(prompt).toContain('Source: Drive · Harbor case study · Google Doc · edited 2026-08-14');
    expect(prompt).toContain('## **What I built**');
    expect(prompt).toContain('"#<nearest heading>"');

    const facts = listFacts(t.db);
    expect(facts).toHaveLength(3);
    expect(facts.every((f) => f.status === 'unconfirmed' && f.origin === 'extracted')).toBe(true);
    expect(facts.find((f) => f.kind === 'impact')?.evidence[0]).toMatchObject({
      sourceKind: 'drive',
      sourceLocator: DOC_ID,
      locator: '#Results',
    });
    expect(note(source.id)).toMatch(
      /^3 new facts, 0 already known, 0 dropped · 1 projects created · Drive · Harbor case study/,
    );
  });

  it('reads a Sheet as CSV and an uploaded PDF through the document path', async () => {
    fake.push({ output: { projects: [], facts: [] } });
    fake.push({ output: { projects: [], facts: [] } });
    addSource(t.db, bus, { project: null, kind: 'drive', locator: SHEET_ID, now });
    await worker.idle();
    addSource(t.db, bus, {
      project: null,
      kind: 'drive',
      locator: `https://drive.google.com/file/d/${PDF_ID}/view?usp=drive_link`,
      now,
    });
    await worker.idle();
    expect(fake.requests[0]?.prompt).toContain('Backend,Python,8');
    expect(fake.requests[1]?.prompt).toContain('Drive · CV 2026.pdf · pdf');
    expect(fake.requests[1]?.prompt).toContain('[page 2]');
    expect(drive.requests).toContain(`/files/${PDF_ID}?supportsAllDrives=true&alt=media`);
  });

  it('records why a file cannot be read: not shared, or no Google account', async () => {
    const { source: missing } = addSource(t.db, bus, {
      project: null,
      kind: 'drive',
      locator: '1NotSharedWithMe0123456789abcdef',
      now,
    });
    await worker.idle();
    expect(note(missing.id)).toMatch(/^sync failed: Google Drive has no file .* shared with it/);

    access = null;
    const { source: noGoogle } = addSource(t.db, bus, {
      project: null,
      kind: 'drive',
      locator: DOC_ID,
      now,
    });
    await worker.idle();
    expect(note(noGoogle.id)).toMatch(/consent doesn.t include Drive: download the document/);
    expect(fake.requests).toHaveLength(0);
    expect(() =>
      addSource(t.db, bus, { project: null, kind: 'drive', locator: 'https://example.com/x', now }),
    ).toThrow(SourceError);
  });

  it('comes from the connected Gmail account only', async () => {
    const mail = new MailService({
      read: t.read,
      secrets: new FileSecrets(`${t.dir}/secrets.json`),
      google: { clientId: 'client-1', driveApi: drive.origin },
    });
    expect(await mail.drive()).toBeNull();
    t.db
      .insert(mailboxes)
      .values({
        kind: 'imap',
        address: 'me@example.com',
        settings: {},
        status: 'connected',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(await mail.drive()).toBeNull();
    t.db
      .update(mailboxes)
      .set({ kind: 'gmail', settings: { clientId: 'client-1' } })
      .run();
    expect(await mail.drive()).toBeInstanceOf(GoogleDrive);
  });
});
