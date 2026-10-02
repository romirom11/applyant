// HTML → readable text: Mozilla Readability picks the main content (dropping navigation,
// footers and cookie banners), then block structure becomes line breaks and headings keep a
// "## " prefix so the extractor can cite sections.
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

export interface HtmlText {
  title: string | null;
  text: string;
}

const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tr',
  'ul',
]);
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe']);

interface NodeLike {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<NodeLike>;
}

function render(node: NodeLike, out: string[], skip: ReadonlySet<string> = SKIP): void {
  if (node.nodeType === 3) {
    out.push((node.textContent ?? '').replace(/\s+/g, ' '));
    return;
  }
  if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
  const tag = node.nodeName.toLowerCase();
  if (SKIP.has(tag) || skip.has(tag)) return;
  if (tag === 'br') {
    out.push('\n');
    return;
  }
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) {
    out.push(`\n\n${'#'.repeat(Math.min(Number(heading[1]) + 1, 6))} `);
  } else if (tag === 'li') {
    out.push('\n- ');
  } else if (tag === 'td' || tag === 'th') {
    out.push(' | ');
  } else if (BLOCK.has(tag)) {
    out.push('\n');
  }
  for (const child of Array.from(node.childNodes)) render(child, out, skip);
  // List items start their own line; a trailing break would leave blank lines between them.
  if (heading || (BLOCK.has(tag) && tag !== 'li')) out.push('\n');
}

function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Page furniture that a whole-page reading leaves out. */
const FURNITURE = new Set(['nav', 'footer', 'form', 'button', 'select', 'dialog']);

/**
 * The whole page as text, without Readability's choice of a main block: navigation, footers
 * and forms are left out, everything else is kept in order.
 */
export function wholePageText(html: string): HtmlText {
  const { document } = parseHTML(html);
  const out: string[] = [];
  const body =
    (document as unknown as { body?: NodeLike }).body ?? (document as unknown as NodeLike);
  render(body, out, FURNITURE);
  return { title: document.title?.trim() || null, text: tidy(out.join('')) };
}

/** `url` (when known) lets Readability resolve relative links; it isn't fetched. */
export function htmlToText(html: string, url: string | null): HtmlText {
  const { document } = parseHTML(html);
  const pageTitle = document.title?.trim() || null;
  let root: NodeLike = document as unknown as NodeLike;
  let title = pageTitle;
  try {
    const clone = parseHTML(html).document;
    if (url) {
      const base = clone.createElement('base');
      base.setAttribute('href', url);
      clone.head?.appendChild(base);
    }
    const article = new Readability(clone as unknown as Document, { keepClasses: false }).parse();
    if (article?.content && (article.textContent ?? '').trim().length > 200) {
      root = parseHTML(`<html><body>${article.content}</body></html>`)
        .document as unknown as NodeLike;
      title = article.title?.trim() || pageTitle;
    }
  } catch {
    // Readability can't cope with some documents: fall back to the whole body.
  }
  const out: string[] = [];
  const body = (root as unknown as { body?: NodeLike }).body ?? root;
  render(body, out);
  return { title, text: tidy(out.join('')) };
}
