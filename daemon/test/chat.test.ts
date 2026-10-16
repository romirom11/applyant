import { afterEach, describe, expect, it, vi } from 'vitest';
import { facts, projects } from '../src/db/schema.ts';
import { chatContext, clearChat, listChat, sendChat } from '../src/domain/knowledge/chat.ts';
import type { AgentRunner } from '../src/models/agent-runner.ts';
import { type TempDb, tempDb } from './helpers/db.ts';

let temp: TempDb | null = null;
afterEach(() => {
  temp?.cleanup();
  temp = null;
});

describe('candidate chat', () => {
  it('grounds a saved conversation in confirmed facts and excludes unconfirmed claims', async () => {
    temp = tempDb();
    const db = temp.db;
    const project = db
      .insert(projects)
      .values({
        slug: 'ordi',
        name: 'Ordi',
        role: 'Lead engineer',
        summary: 'Operations platform with AI agents',
      })
      .returning()
      .get();
    const good = db
      .insert(facts)
      .values({
        projectId: project.id,
        text: 'Built a Laravel API for Ordi.',
        kind: 'personal_contribution',
        status: 'confirmed',
        origin: 'interview',
      })
      .returning()
      .get();
    db.insert(facts)
      .values({
        projectId: project.id,
        text: 'Managed a team of 200.',
        kind: 'team_context',
        status: 'unconfirmed',
        origin: 'extracted',
      })
      .run();
    const context = chatContext(db, 'What did I build with Laravel?');
    expect(context.text).toContain('Operations platform with AI agents');
    expect(context.text).toContain('Built a Laravel API for Ordi.');
    expect(context.text).not.toContain('Managed a team of 200.');
    expect(context.factProjects.get(good.id)).toBe('ordi');

    const run = vi.fn().mockResolvedValue({
      kind: 'ok',
      output: {
        parts: [{ text: 'You built the Ordi Laravel API.', fact_ids: [good.id], project: 'ordi' }],
      },
    });
    const models = { run } as unknown as AgentRunner;
    const first = await sendChat(
      db,
      models,
      'What did I build?',
      new AbortController().signal,
      () => new Date('2026-10-02T16:00:00Z'),
    );
    expect(first.user.role).toBe('user');
    expect(first.assistant.factIds).toEqual([good.id]);
    expect(listChat(db).map((m) => m.role)).toEqual(['user', 'assistant']);
    await sendChat(
      db,
      models,
      'And my role?',
      new AbortController().signal,
      () => new Date('2026-10-02T16:01:00Z'),
    );
    expect(JSON.parse(run.mock.calls[1]?.[1].prompt ?? '{}').recent).toEqual([
      { role: 'user', text: 'What did I build?' },
      { role: 'assistant', text: 'You built the Ordi Laravel API.' },
    ]);
    clearChat(db);
    expect(listChat(db)).toEqual([]);
  });

  it('does not save a failed model answer', async () => {
    temp = tempDb();
    const run = vi
      .fn()
      .mockResolvedValue({ kind: 'failed', reason: 'model unavailable', route: null });
    await expect(
      sendChat(
        temp.db,
        { run } as unknown as AgentRunner,
        'Hello',
        new AbortController().signal,
        () => new Date(),
      ),
    ).rejects.toThrow('model unavailable');
    expect(listChat(temp.db)).toEqual([]);
  });

  it('rejects a project answer that cites an unlinked general fact', async () => {
    temp = tempDb();
    const db = temp.db;
    db.insert(projects).values({ slug: 'ordi', name: 'Ordi', role: 'Engineer' }).run();
    const general = db
      .insert(facts)
      .values({
        projectId: null,
        text: 'Used a Linear to Claude Code to preview deployment workflow.',
        kind: 'personal_contribution',
        status: 'confirmed',
        origin: 'extracted',
      })
      .returning()
      .get();
    const run = vi.fn().mockImplementation(async (_role, request) => {
      const output = {
        parts: [
          {
            text: 'I built this workflow for Ordi.',
            fact_ids: [general.id],
            project: 'ordi',
          },
        ],
      };
      return { kind: 'failed', reason: request.validate(output), route: null };
    });
    await expect(
      sendChat(
        db,
        { run } as unknown as AgentRunner,
        'Did I build this for Ordi?',
        new AbortController().signal,
        () => new Date(),
      ),
    ).rejects.toThrow('cited a fact that was not supplied');
    expect(listChat(db)).toEqual([]);

    const generalPart = {
      parts: [
        {
          text: 'I built this workflow for Ordi.',
          fact_ids: [general.id],
          project: null,
        },
      ],
    };
    const unscopedRun = vi.fn().mockImplementation(async (_role, request) => ({
      kind: 'failed',
      reason: request.validate(generalPart),
      route: null,
    }));
    await expect(
      sendChat(
        db,
        { run: unscopedRun } as unknown as AgentRunner,
        'Did I build this for Ordi?',
        new AbortController().signal,
        () => new Date(),
      ),
    ).rejects.toThrow('cited evidence outside the requested project');
    expect(listChat(db)).toEqual([]);
  });

  it('allows a project example and a separate uncited caveat naming that project', async () => {
    temp = tempDb();
    const db = temp.db;
    const project = db
      .insert(projects)
      .values({ slug: 'ordi', name: 'Ordi', role: 'Engineer' })
      .returning()
      .get();
    const projectFact = db
      .insert(facts)
      .values({
        projectId: project.id,
        text: 'Built the AI agent worker in Ordi.',
        kind: 'personal_contribution',
        status: 'confirmed',
        origin: 'extracted',
      })
      .returning()
      .get();
    const output = {
      parts: [
        {
          text: 'I built the AI agent worker in Ordi.',
          fact_ids: [projectFact.id],
          project: 'ordi',
        },
        {
          text: 'I cannot verify what proportion of Ordi was written by AI.',
          fact_ids: [],
          project: null,
        },
      ],
    };
    const run = vi.fn().mockImplementation(async (_role, request) => {
      const problem = request.validate(output);
      return problem ? { kind: 'failed', reason: problem, route: null } : { kind: 'ok', output };
    });
    const reply = await sendChat(
      db,
      { run } as unknown as AgentRunner,
      'Describe my AI work in Ordi.',
      new AbortController().signal,
      () => new Date(),
    );
    expect(reply.assistant.factIds).toEqual([projectFact.id]);
  });

  it('focuses a Ukrainian follow-up about Ordi on Ordi facts', () => {
    temp = tempDb();
    const db = temp.db;
    const project = db
      .insert(projects)
      .values({ slug: 'ordi', name: 'Ordi', role: 'Builder' })
      .returning()
      .get();
    const projectFact = db
      .insert(facts)
      .values({
        projectId: project.id,
        text: 'Built the Ordi agent worker.',
        kind: 'personal_contribution',
        status: 'confirmed',
        origin: 'extracted',
      })
      .returning()
      .get();
    const general = db
      .insert(facts)
      .values({
        projectId: null,
        text: 'Linear task to Claude Code worker to pull request.',
        kind: 'personal_contribution',
        status: 'confirmed',
        origin: 'extracted',
      })
      .returning()
      .get();
    const context = chatContext(db, 'ні, наведи приклад орді');
    expect(context.focusProject).toBe('ordi');
    expect(context.factProjects.has(projectFact.id)).toBe(true);
    expect(context.factProjects.has(general.id)).toBe(false);
    expect(context.text).not.toContain('Linear task');
  });
});
