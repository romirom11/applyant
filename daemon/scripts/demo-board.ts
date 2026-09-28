// A local job board for checking the whole loop by hand without applying anywhere real:
// two synthetic postings (JSON-LD JobPosting, a description, an application form on the page)
// that accept submissions and log exactly what arrived.
//
//   node scripts/demo-board.ts [--port 4400] [--log /tmp/demo-board.jsonl]
//
//   /jobs/lumen-ai-engineer   clean form: standard fields, one question, CV upload, consent
//   /jobs/northwind-platform  standard fields only (quick to prepare)
//   /jobs/tallyhall-founding  a question the knowledge base can't answer (Prepare hands it to
//                             the candidate) and a reCAPTCHA before submit (Deliver hands off)
import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4400' },
    log: { type: 'string', default: '/tmp/demo-board.jsonl' },
  },
});
const PORT = Number(values.port);
const LOG = values.log as string;

interface Posting {
  slug: string;
  title: string;
  company: string;
  salary: [number, number];
  description: string;
  questions: Array<{ id: string; label: string; required: boolean }>;
  captcha: boolean;
}

const POSTINGS: Posting[] = [
  {
    slug: 'northwind-platform',
    title: 'Backend Engineer, LLM Platform',
    company: 'Northwind Labs',
    salary: [65000, 85000],
    description: `Northwind Labs runs an internal LLM platform for 40 product teams: model gateway, RAG services and evaluation tooling. We're hiring a backend engineer to grow it.

What you'll do
- Build and run Python services around self-hosted and API models.
- Own retrieval services on PostgreSQL and pgvector.
- Improve CI/CD, observability and on-call for the platform.

Requirements
- Backend engineering in Python (FastAPI or similar).
- LLM integrations and RAG in production.
- PostgreSQL, Docker, Linux.

Nice to have
- vLLM or Ollama.
- Prometheus and Grafana.

Remote within Europe. Full-time.`,
    questions: [],
    captcha: false,
  },
  {
    slug: 'lumen-ai-engineer',
    title: 'Senior AI Engineer',
    company: 'Lumen Health',
    salary: [70000, 90000],
    description: `Lumen Health builds an AI assistant that listens to clinic phone calls, transcribes them and turns them into structured follow-ups for care teams. We're hiring a Senior AI Engineer to own the pipeline from audio to insight.

What you'll do
- Design and run the speech-to-text and LLM analysis pipeline in production (Python, FastAPI, queues).
- Build retrieval (RAG) over call history with PostgreSQL and pgvector.
- Ship LLM features end to end: prompts, structured outputs, evaluation, monitoring.
- Work with a small, remote-first team across Europe.

Requirements
- 5+ years of backend engineering, mostly Python.
- Production experience with LLM integrations and RAG.
- Speech-to-text (Whisper or similar) in production.
- PostgreSQL, Docker, CI/CD.
- Fluent English.

Nice to have
- Self-hosted models (vLLM, Ollama).
- TypeScript.

Fully remote within EU time zones. Full-time.`,
    questions: [
      {
        id: 'q_llm',
        label: 'Tell us about an LLM system you built and ran in production.',
        required: true,
      },
    ],
    captcha: false,
  },
  {
    slug: 'tallyhall-founding',
    title: 'Founding Engineer',
    company: 'Tallyhall',
    salary: [60000, 80000],
    description: `Tallyhall is an early-stage startup building an operations platform for small service companies: CRM, invoicing and scheduling in one place. We're a team of three and hiring our first engineer.

What you'll do
- Build product end to end: TypeScript, React, Node.js, PostgreSQL.
- Set up infrastructure and CI/CD from scratch.
- Talk to customers and decide what to build next.

Requirements
- Full-stack experience with TypeScript, React and Node.js.
- You have built a product from zero.
- PostgreSQL and Docker.

Nice to have
- Experience with invoicing or CRM systems.
- LLM features in a product.

Remote (Europe). Full-time.`,
    questions: [
      {
        id: 'q_why',
        label: 'Why do you want to join Tallyhall as our first engineer?',
        required: true,
      },
      {
        id: 'q_hobby',
        label:
          'What was the last thing you built just for fun, outside work, and what did you learn?',
        required: true,
      },
    ],
    captcha: true,
  },
];

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

function page(p: Posting): string {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: p.title,
    description: p.description,
    datePosted: new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10),
    validThrough: new Date(Date.now() + 30 * 86400_000).toISOString(),
    employmentType: 'FULL_TIME',
    hiringOrganization: { '@type': 'Organization', name: p.company },
    jobLocationType: 'TELECOMMUTE',
    applicantLocationRequirements: { '@type': 'Country', name: 'European Union' },
    baseSalary: {
      '@type': 'MonetaryAmount',
      currency: 'EUR',
      value: {
        '@type': 'QuantitativeValue',
        minValue: p.salary[0],
        maxValue: p.salary[1],
        unitText: 'YEAR',
      },
    },
  };
  const questions = p.questions
    .map(
      (q) => `<div class="f"><label for="${q.id}">${esc(q.label)}${q.required ? ' *' : ''}</label>
<textarea id="${q.id}" name="${q.id}" rows="5" ${q.required ? 'required' : ''}></textarea></div>`,
    )
    .join('\n');
  const captcha = p.captcha
    ? `<div class="f"><iframe title="reCAPTCHA" width="304" height="78" src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI&co=aHR0cDovL2xvY2FsaG9zdA..&hl=en&size=normal"></iframe></div>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(p.title)} · ${esc(p.company)}</title>
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:0 16px}.f{margin:12px 0}label{display:block;font-weight:600}input,textarea{width:100%;padding:6px}</style>
</head><body>
<p><a href="/">${esc(p.company)} careers</a></p>
<h1>${esc(p.title)}</h1>
<p>${esc(p.company)} · Remote (EU) · €${p.salary[0].toLocaleString('en')}–${p.salary[1].toLocaleString('en')} a year · Full-time</p>
${p.description
  .split('\n\n')
  .map((para) => `<p>${esc(para).replaceAll('\n', '<br>')}</p>`)
  .join('\n')}
<h2 id="apply">Apply for this job</h2>
<form method="post" action="/apply/${p.slug}" enctype="multipart/form-data">
<div class="f"><label for="first_name">First name *</label><input id="first_name" name="first_name" required></div>
<div class="f"><label for="last_name">Last name *</label><input id="last_name" name="last_name" required></div>
<div class="f"><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
<div class="f"><label for="phone">Phone</label><input id="phone" name="phone" type="tel"></div>
<div class="f"><label for="location">Location (city, country) *</label><input id="location" name="location" required></div>
<div class="f"><label for="linkedin">LinkedIn profile</label><input id="linkedin" name="linkedin" type="url"></div>
<div class="f"><label for="github">GitHub</label><input id="github" name="github" type="url"></div>
<div class="f"><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" accept=".pdf" required></div>
<div class="f"><label for="salary">Salary expectation (EUR, gross per year) *</label><input id="salary" name="salary" required></div>
<div class="f"><label for="work_auth">Are you authorised to work in the EU? *</label>
<select id="work_auth" name="work_auth" required><option value="">Select…</option><option>Yes</option><option>No</option></select></div>
${questions}
<div class="f"><label><input type="checkbox" name="consent" value="yes" required> I agree to the processing of my data for this application *</label></div>
${captcha}
<button type="submit">Submit application</button>
</form></body></html>`;
}

function index(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Demo board</title></head><body>
<h1>Open roles</h1><ul>${POSTINGS.map((p) => `<li><a href="/jobs/${p.slug}">${esc(p.title)} · ${esc(p.company)}</a></li>`).join('')}</ul></body></html>`;
}

/** Field names and short values from a multipart body (file contents summarised). */
function summarise(body: Buffer, contentType: string): Record<string, string> {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (!boundary) return { raw: body.toString('utf8').slice(0, 2000) };
  const out: Record<string, string> = {};
  for (const part of body.toString('latin1').split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part)?.[1];
    if (!name) continue;
    const file = /filename="([^"]*)"/.exec(part)?.[1];
    const value = part.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
    out[name] =
      file !== undefined
        ? `<file ${file} · ${value.length} bytes · ${value.startsWith('%PDF') ? 'PDF' : 'not a PDF'}>`
        : Buffer.from(value, 'latin1').toString('utf8');
  }
  return out;
}

function send(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (req.method === 'POST' && path.startsWith('/apply/')) {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const slug = path.slice('/apply/'.length);
      const fields = summarise(Buffer.concat(chunks), req.headers['content-type'] ?? '');
      appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), slug, fields })}\n`);
      process.stdout.write(`application received for ${slug}: ${Object.keys(fields).join(', ')}\n`);
      send(
        res,
        200,
        `<!doctype html><title>Application received</title><h1>Thank you!</h1><p>Your application has been received. We'll be in touch.</p>`,
      );
    });
    return;
  }
  if (path === '/') return send(res, 200, index());
  const posting = POSTINGS.find((p) => path === `/jobs/${p.slug}`);
  if (posting) return send(res, 200, page(posting));
  send(res, 404, '<!doctype html><title>Not found</title><h1>Page not found</h1>');
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`demo board on http://127.0.0.1:${PORT} · submissions → ${LOG}\n`);
});
