// `applyant candidate interview` (a chat in the terminal) and `applyant interview …`: the agent
// interview that fills in what sources can't show, and the facts applications found missing.
import { createInterface, type Interface } from 'node:readline';
import type { Command } from 'commander';
import {
  type Event,
  type InterviewQuestion,
  TaskEventType,
} from '../gen/applyant/v1/applyant_pb.js';
import type { ApplyantClient } from './client.ts';
import { iso, table, truncate } from './format.ts';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const json = (value: unknown): void => out(JSON.stringify(value, null, 2));

export function questionJson(q: InterviewQuestion) {
  return {
    id: Number(q.id),
    project: q.projectSlug ?? null,
    application: q.applicationId === undefined ? null : Number(q.applicationId),
    job: q.application ?? null,
    text: q.text,
    context: q.context ?? null,
    status: q.status,
    origin: q.origin,
    note: q.note ?? null,
    createdAt: iso(q.createdAt),
    answeredAt: iso(q.answeredAt),
    answer: q.answer ?? null,
    facts: q.facts.map((f) => ({ id: Number(f.id), text: f.text, kind: f.kind })),
  };
}

function about(q: InterviewQuestion): string {
  if (q.applicationId !== undefined) return q.application ?? `application ${q.applicationId}`;
  return q.projectName ?? q.projectSlug ?? '(profile)';
}

function questionId(value: string): bigint {
  const n = Number(value.replace(/^[q#]/i, ''));
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`"${value}" is not a question id`);
  return BigInt(n);
}

function printQuestion(q: InterviewQuestion): void {
  const head = `── ${about(q)} · question ${q.id} `;
  out(`\n${head}${'─'.repeat(Math.max(4, 72 - head.length))}`);
  if (q.applicationId !== undefined) {
    out('The application asks this, and nothing Applyant knows answers it.');
    if (q.context) out(`(missing: ${q.context})`);
  } else if (q.context) {
    out(`(about: ${q.context})`);
  }
  if (q.note && q.status === 'open') out(`! ${q.note}`);
  out(q.text);
}

function printSaved(q: InterviewQuestion): void {
  if (q.facts.length === 0) {
    out(`  ${q.note ?? 'nothing saved from this answer'}`);
    return;
  }
  for (const f of q.facts)
    out(`  ✓ #${f.id} ${f.text}${f.projectSlug ? `  [${f.projectSlug}]` : ''}`);
}

function printThread(questions: InterviewQuestion[]): void {
  for (const q of questions) {
    out(`\nQ${q.id} (${q.status}): ${q.text}`);
    if (q.answer) out(`A: ${q.answer}`);
    for (const f of q.facts) out(`   ✓ #${f.id} ${f.text}`);
    if (q.note && q.status !== 'answered') out(`   ${q.note}`);
  }
}

/**
 * Lines from stdin, queued as they arrive: piped input (`printf 'answer\n' | applyant …`)
 * arrives before the chat asks for it, and readline would drop lines nobody was waiting for.
 */
class Lines {
  private readonly queue: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private closed = false;
  readonly rl: Interface;

  constructor() {
    this.rl = createInterface({ input: process.stdin, terminal: !!process.stdin.isTTY });
    this.rl.on('line', (line) => {
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = null;
        w(line);
      } else this.queue.push(line);
    });
    this.rl.on('close', () => {
      this.closed = true;
      this.waiting?.(null);
      this.waiting = null;
    });
  }

  /** The next line, or null once stdin has ended. */
  next(prompt: string): Promise<string | null> {
    process.stdout.write(prompt);
    const queued = this.queue.shift();
    if (queued !== undefined) {
      if (!process.stdin.isTTY) process.stdout.write(`${queued}\n`);
      return Promise.resolve(queued);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  close(): void {
    this.rl.close();
  }
}

/** Reads one answer (null at the end of input); a line ending in `\` continues on the next. */
async function readAnswer(lines: Lines): Promise<string | null> {
  const parts: string[] = [];
  for (;;) {
    const line = await lines.next(parts.length ? '… ' : '> ');
    if (line === null) return parts.length ? parts.join('\n').trim() : null;
    if (line.endsWith('\\')) {
      parts.push(line.slice(0, -1));
      continue;
    }
    parts.push(line);
    return parts.join('\n').trim();
  }
}

/**
 * The chat: a question, the answer, what it saved, the next question, until the interviewer has
 * nothing more to ask (about this project, or at all). The event stream is opened first, so
 * nothing the daemon does between two calls is missed.
 */
async function chat(c: ApplyantClient, project: string): Promise<void> {
  const ac = new AbortController();
  const lines = new Lines();
  const stop = () => {
    ac.abort();
    lines.close();
  };
  process.once('SIGINT', stop);
  const last = (await c.listEvents({ limit: 1 })).events.at(-1)?.id ?? 0n;
  const stream = c
    .watchEvents({ afterEventId: last }, { signal: ac.signal })
    [Symbol.asyncIterator]();
  /** The next interview event (or a failed interview task). */
  const nextEvent = async (): Promise<Event> => {
    for (;;) {
      const r = await stream.next();
      if (r.done) throw new Error('the event stream ended');
      const e = r.value.event;
      if (!e) continue;
      if (e.payload.case === 'interview') return e;
      if (
        e.payload.case === 'task' &&
        e.payload.value.taskKind.startsWith('interview_') &&
        e.payload.value.type === TaskEventType.FAILED
      ) {
        return e;
      }
    }
  };
  out(
    'Answer in your own words; the facts you give are saved as confirmed. End a line with \\ to go on;\n:skip leaves a question for later, :quit stops (open questions stay open).',
  );

  try {
    let res = await c.startInterview({ project });
    for (;;) {
      if (!res.question) {
        if (!res.pending) {
          out(res.message);
          return;
        }
        out(`… ${res.message}`);
        const e = await nextEvent();
        if (e.payload.case === 'interview' && e.payload.value.status === 'done') {
          out(e.message);
          if (project) return;
        } else if (e.payload.case !== 'interview' || e.payload.value.status === 'failed') {
          out(`! ${e.message}`);
          return;
        }
        res = await c.startInterview({ project });
        continue;
      }
      const q = res.question;
      printQuestion(q);
      const answer = await readAnswer(lines);
      if (answer === null || answer === ':quit' || answer === ':q') return;
      if (!answer) continue;
      if (answer === ':skip' || answer === ':later') {
        await c.dismissInterviewQuestion({ id: q.id });
        out('  (left for later)');
        if (project) return;
        res = await c.startInterview({ project });
        continue;
      }
      await c.answerInterviewQuestion({ id: q.id, text: answer });
      out('  … reading your answer');
      // The answer is read (facts saved), then a follow-up is asked, the thread is done, or
      // reading failed and the question is open again.
      let next: InterviewQuestion | undefined;
      let done: string | null = null;
      for (;;) {
        const e = await nextEvent();
        if (e.payload.case !== 'interview') {
          out(`! ${e.message}`);
          break;
        }
        const { questionId, status } = e.payload.value;
        if (status === 'answered' && questionId === q.id) {
          const thread = await c.getInterview({ target: { case: 'questionId', value: q.id } });
          const read = thread.questions.find((x) => x.id === q.id);
          if (read) printSaved(read);
          continue;
        }
        if (status === 'open' && questionId !== undefined) {
          const thread = await c.getInterview({
            target: { case: 'questionId', value: questionId },
          });
          next = thread.questions.find((x) => x.id === questionId);
          break;
        }
        if (status === 'done') {
          done = e.message;
          break;
        }
      }
      if (next) {
        res = { ...res, question: next, pending: false };
        continue;
      }
      if (done) out(`  ${done}`);
      if (project && done) return;
      res = await c.startInterview({ project });
    }
  } catch (err) {
    if (!ac.signal.aborted) throw err;
  } finally {
    process.off('SIGINT', stop);
    ac.abort();
    lines.close();
    await stream.return?.().catch(() => {});
  }
}

export function registerInterview(
  program: Command,
  candidate: Command,
  client: () => ApplyantClient,
): void {
  candidate
    .command('interview [project]')
    .description(
      'the agent interview, in the terminal: questions about your projects (and what applications need)',
    )
    .action(async (project: string | undefined) => {
      await chat(client(), project?.trim() ?? '');
    });

  const interview = program
    .command('interview')
    .description('the agent interview: open questions, transcripts, answers');
  interview
    .command('chat [project]')
    .description('same as `candidate interview`')
    .action(async (project: string | undefined) => {
      await chat(client(), project?.trim() ?? '');
    });
  interview
    .command('list')
    .description('questions waiting for you, and what each project is still missing')
    .option('--all', 'every question, answered and dismissed too')
    .option('--json', 'print JSON')
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const res = await client().listInterview({ all: !!opts.all });
      if (opts.json) {
        return json({
          questions: res.questions.map(questionJson),
          projects: res.projects.map((p) => ({
            project: p.project?.slug ?? null,
            gaps: p.gaps,
            open: p.open,
            asked: p.asked,
            busy: p.busy,
          })),
        });
      }
      if (res.questions.length) {
        out(
          table(
            ['ID', 'FOR', 'STATUS', 'QUESTION'],
            res.questions.map((q) => [
              `${q.id}`,
              truncate(about(q), 28),
              q.status,
              truncate(q.text, 80),
            ]),
          ),
        );
      } else {
        out(opts.all ? 'No interview questions yet.' : 'No questions waiting for you.');
      }
      const gaps = res.projects.filter((p) => p.gaps.length);
      if (gaps.length) {
        out('\nWhat projects are still missing:');
        for (const p of gaps) {
          const asked = p.asked ? ` · ${p.asked} asked` : '';
          out(`  ${p.project?.slug ?? '?'}: ${p.gaps.join(', ').replace(/_/g, ' ')}${asked}`);
        }
        out(
          '\nTalk about one: `applyant candidate interview <project>` (or no project: whatever is next).',
        );
      }
    });
  interview
    .command('show <target>')
    .description('the transcript of a project’s interview (slug) or of a question (its id)')
    .option('--json', 'print JSON')
    .action(async (target: string, opts: { json?: boolean }) => {
      // A number is a question; a project is named by its slug or name.
      const byId = /^[q#]?\d+$/i.test(target);
      const res = await client().getInterview({
        target: byId
          ? { case: 'questionId', value: questionId(target) }
          : { case: 'project', value: target },
      });
      if (opts.json) return json(res.questions.map(questionJson));
      if (res.project?.project) {
        const p = res.project;
        out(
          `${p.project?.name} [${p.project?.slug}]${p.gaps.length ? ` · missing: ${p.gaps.join(', ').replace(/_/g, ' ')}` : ' · no gaps'}`,
        );
      }
      if (res.questions.length === 0) out('Not interviewed yet.');
      printThread(res.questions);
      if (res.pending) out('\n… the interviewer is working on it');
    });
  interview
    .command('answer <id> [text...]')
    .description('answer a question (text, or stdin when none is given)')
    .action(async (idArg: string, words: string[]) => {
      let text = words.join(' ');
      if (!text) {
        for await (const chunk of process.stdin) text += chunk;
      }
      const res = await client().answerInterviewQuestion({ id: questionId(idArg), text });
      out(
        `Answered question ${res.question?.id}; the interviewer is reading it. See \`applyant interview show ${res.question?.id}\`.`,
      );
    });
  interview
    .command('dismiss <id>')
    .description(
      'leave a question for later (an application question is then yours to answer in review)',
    )
    .action(async (idArg: string) => {
      const res = await client().dismissInterviewQuestion({ id: questionId(idArg) });
      out(`Dismissed question ${res.question?.id}.`);
    });
}
