// Projects from the app (phase 16, app parity with the CLI): rename, change, remove — with its
// sources and facts — and syncing one source by id.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { facts, sources, tasks } from '../src/db/schema.ts';
import { SourceKind } from '../src/gen/applyant/v1/applyant_pb.js';
import { EventBus } from '../src/queue/events.ts';
import { candidateRpcs } from '../src/rpc/candidate.ts';
import { type TempDb, tempDb } from './helpers/db.ts';

describe('projects from the app', () => {
  let t: TempDb;
  let rpc: Required<ReturnType<typeof candidateRpcs>>;
  const now = new Date('2026-09-30T10:00:00Z');

  beforeEach(() => {
    t = tempDb();
    rpc = candidateRpcs({ db: t.db, bus: new EventBus(), now: () => now }) as Required<
      ReturnType<typeof candidateRpcs>
    >;
  });
  afterEach(() => t.cleanup());

  // biome-ignore lint/suspicious/noExplicitAny: the handlers' second argument is unused
  const ctx = {} as any;
  const call = async <T>(p: T | Promise<T>) => await p;

  it('renames a project and changes what it says; the slug stays', async () => {
    const { project } = await call(
      rpc.createProject({ name: 'Solovei', stack: ['TS'] } as never, ctx),
    );
    const res = await call(
      rpc.updateProject(
        {
          project: 'solovei',
          name: 'Solovei Voice',
          summary: 'A voice agent',
          stack: { values: ['TypeScript', 'typescript', 'Swift'] },
        } as never,
        ctx,
      ),
    );
    expect(res.project?.name).toBe('Solovei Voice');
    expect(res.project?.slug).toBe(project?.slug);
    expect(res.project?.summary).toBe('A voice agent');
    expect(res.project?.stack).toEqual(['TypeScript', 'Swift']);
    // Unset fields stay; an empty one clears.
    const cleared = await call(
      rpc.updateProject({ project: 'Solovei Voice', summary: '' } as never, ctx),
    );
    expect(cleared.project?.summary).toBeUndefined();
    expect(cleared.project?.stack).toEqual(['TypeScript', 'Swift']);
  });

  it('refuses an empty name, a taken name and an unknown project', async () => {
    await call(rpc.createProject({ name: 'Solovei', stack: [] } as never, ctx));
    await call(rpc.createProject({ name: 'Ordi', stack: [] } as never, ctx));
    expect(() => rpc.updateProject({ project: 'ordi', name: ' ' } as never, ctx)).toThrow(
      /needs a name/,
    );
    expect(() => rpc.updateProject({ project: 'ordi', name: 'solovei' } as never, ctx)).toThrow(
      /already exists/,
    );
    expect(() => rpc.updateProject({ project: 'nope', name: 'X' } as never, ctx)).toThrow(
      /no project "nope"/,
    );
    expect(() => rpc.deleteProject({ project: 'nope' } as never, ctx)).toThrow(/no project/);
  });

  it('removes a project with its sources and facts; the profile and other projects stay', async () => {
    const { project } = await call(rpc.createProject({ name: 'Solovei', stack: [] } as never, ctx));
    await call(rpc.createProject({ name: 'Ordi', stack: [] } as never, ctx));
    await call(
      rpc.addSource(
        { project: 'solovei', kind: SourceKind.URL, locator: 'https://solovei.example/' } as never,
        ctx,
      ),
    );
    await call(
      rpc.addSource(
        { project: '', kind: SourceKind.URL, locator: 'https://me.example/' } as never,
        ctx,
      ),
    );
    const pid = Number(project?.id);
    t.db
      .insert(facts)
      .values([
        {
          projectId: pid,
          text: 'Built it',
          kind: 'other',
          status: 'confirmed',
          origin: 'extracted',
          createdAt: now,
          updatedAt: now,
        },
        {
          projectId: null,
          text: 'Speaks Greek',
          kind: 'other',
          status: 'confirmed',
          origin: 'extracted',
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();

    const res = await call(rpc.deleteProject({ project: 'Solovei' } as never, ctx));
    expect(res).toEqual({ sourcesRemoved: 1, factsRemoved: 1 });
    const left = await call(rpc.getCandidate({} as never, ctx));
    expect(left.projects?.map((p) => p.name)).toEqual(['Ordi']);
    expect(left.profileSources?.map((s) => s.locator)).toEqual(['https://me.example/']);
    expect(left.profileFactCount).toBe(1);
    expect(t.db.select().from(sources).all()).toHaveLength(1);
    expect(t.db.select().from(facts).where(eq(facts.projectId, pid)).all()).toHaveLength(0);
  });

  it('syncs one source by id', async () => {
    await call(rpc.createProject({ name: 'Solovei', stack: [] } as never, ctx));
    const a = await call(
      rpc.addSource(
        { project: 'solovei', kind: SourceKind.URL, locator: 'https://a.example/' } as never,
        ctx,
      ),
    );
    await call(
      rpc.addSource(
        { project: 'solovei', kind: SourceKind.URL, locator: 'https://b.example/' } as never,
        ctx,
      ),
    );
    // Let the first syncs finish so a new one can be queued.
    t.db.update(tasks).set({ status: 'done' }).run();
    const id = a.source?.id;
    const res = await call(rpc.syncSources({ target: `source:${id}`, force: true } as never, ctx));
    expect(res.sources?.map((s) => s.locator)).toEqual(['https://a.example/']);
    expect(res.enqueuedSourceIds).toEqual([id]);
    expect(() => rpc.syncSources({ target: 'source:999', force: false } as never, ctx)).toThrow(
      /no source 999/,
    );
  });
});
