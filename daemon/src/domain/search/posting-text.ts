// The posting's readable text, captured while the page is open for verification: what the
// extractor reads later.
//
//   page header      the labels shown around the title (workplace type, employment type,
//                    location): Readability drops them, but they are the posting's own
//                    classification ("Hybrid · Full time · Athens")
//   structured data  the JobPosting JSON-LD fields (salary, location, employment type)
//   body             Readability over the page, or the JSON-LD description if longer;
//                    embedded ATS frames when the page itself says little
//
// The JSON-LD node is returned too, so scoring can let structured fields win (structured.ts).
import type { Page } from 'playwright';
import type { ReaderPool } from '../../browser/reader-pool.ts';
import { htmlToText } from '../knowledge/text/html.ts';

export const MAX_POSTING_TEXT = 40_000;
/** Less main-page text than this: the posting probably lives in an embedded frame. */
const THIN_PAGE = 800;
/** How much of the page's top the header block keeps. */
const HEADER_CHARS = 600;

/** How the header line starts in the posting text (scoring parses the workplace label from it). */
export const PAGE_HEADER_PREFIX = 'Page header (labels shown around the title): ';

export interface PostingText {
  text: string;
  /** The page's JobPosting JSON-LD node, or null. */
  jsonLd: Record<string, unknown> | null;
}

/**
 * The page's first visible text pieces, one per element, joined with " | ", so labels that
 * render side by side ("Hybrid", "Full time") stay separate words.
 */
async function pageHeader(page: Page): Promise<string> {
  return page
    .evaluate((max) => {
      const skip = new Set([
        'SCRIPT',
        'STYLE',
        'NOSCRIPT',
        'TEMPLATE',
        'SVG',
        'NAV',
        'FOOTER',
        'BUTTON',
      ]);
      const parts: string[] = [];
      let length = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && length < max; node = walker.nextNode()) {
        let el = node.parentElement;
        let hidden = false;
        for (; el; el = el.parentElement) {
          if (skip.has(el.tagName)) {
            hidden = true;
            break;
          }
        }
        const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (hidden || !text || node.parentElement?.checkVisibility?.() === false) continue;
        parts.push(text);
        length += text.length + 3;
      }
      return parts.join(' | ').slice(0, max);
    }, HEADER_CHARS)
    .catch(() => '');
}

export async function readPostingText(page: Page): Promise<PostingText> {
  const html = await page.content();
  const main = htmlToText(html, page.url());
  const blocks = await page
    .evaluate(() =>
      [...document.querySelectorAll('script[type="application/ld+json"]')].map(
        (s) => s.textContent ?? '',
      ),
    )
    .catch(() => [] as string[]);
  const job = jobPostingNode(blocks);

  let body = main.text;
  const description =
    typeof job?.description === 'string'
      ? htmlToText(`<body>${job.description}</body>`, null).text
      : '';
  if (description.length > body.length) body = description;
  if (body.length < THIN_PAGE) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const text = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      if (text.trim().length > 200) body += `\n\n${text.trim()}`;
    }
  }
  const top = await pageHeader(page);
  const structured = job ? structuredLines(job) : [];
  const header = [
    main.title ? `# ${main.title}` : null,
    top ? `${PAGE_HEADER_PREFIX}${top}` : null,
    ...structured,
  ]
    .filter(Boolean)
    .join('\n');
  const text = `${header ? `${header}\n\n` : ''}${body}`.slice(0, MAX_POSTING_TEXT).trim();
  return { text, jsonLd: job };
}

/** Opens the posting in the reader and captures its text (re-reads, and postings verified before scoring). */
export async function fetchPostingText(
  reader: ReaderPool,
  url: string,
  signal: AbortSignal,
): Promise<PostingText> {
  return reader.withPage(
    async (page) => {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()}`);
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      return readPostingText(page);
    },
    { signal },
  );
}

type Node = Record<string, unknown>;

/** The first schema.org JobPosting node in a page's JSON-LD blocks (arrays and @graph included). */
export function jobPostingNode(blocks: string[]): Node | null {
  const visit = (node: unknown): Node | null => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item);
        if (found) return found;
      }
      return null;
    }
    if (!node || typeof node !== 'object') return null;
    const obj = node as Node;
    const type = obj['@type'];
    if ((Array.isArray(type) ? type : [type]).includes('JobPosting')) return obj;
    return visit(obj['@graph']);
  };
  for (const block of blocks) {
    try {
      const found = visit(JSON.parse(block));
      if (found) return found;
    } catch {
      // Malformed JSON-LD is common; ignore the block.
    }
  }
  return null;
}

function flat(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(flat).filter(Boolean).join('; ');
  return Object.entries(value as Node)
    .filter(([k]) => k !== '@context')
    .map(([k, v]) => {
      const s = flat(v);
      return s ? (k === '@type' ? s : `${k}: ${s}`) : '';
    })
    .filter(Boolean)
    .join(', ');
}

const STRUCTURED_FIELDS = [
  'title',
  'hiringOrganization',
  'employmentType',
  'jobLocationType',
  'jobLocation',
  'applicantLocationRequirements',
  'baseSalary',
  'estimatedSalary',
  'datePosted',
  'validThrough',
];

function structuredLines(job: Node): string[] {
  const lines: string[] = [];
  for (const field of STRUCTURED_FIELDS) {
    const value =
      field === 'hiringOrganization'
        ? ((job[field] as Node | undefined)?.name ?? job[field])
        : job[field];
    const text = flat(value).slice(0, 400);
    if (text) lines.push(`${field}: ${text}`);
  }
  return lines.length ? ['Structured data (JobPosting):', ...lines] : [];
}
