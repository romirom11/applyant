// A listing page as recipes see it: opened and settled in the headless reader, then captured
// for reader_builder (ARIA snapshot, a DOM outline for CSS fallbacks, the linked text) and as a
// fixture (the HTML with scripts removed and hidden elements marked, so it replays offline the
// way it looked live).
import type { Page } from 'playwright';

/** How much of each view the builder gets (characters). */
export const MAX_ARIA = 40_000;
export const MAX_OUTLINE = 30_000;
export const MAX_TEXT = 20_000;
/** Pages larger than this aren't kept as fixtures (the recipe still is). */
export const MAX_FIXTURE_HTML = 4_000_000;

export interface PageCapture {
  url: string;
  title: string;
  aria: string;
  outline: string;
  text: string;
  html: string;
}

/** Opens a listing page and lets its scripts render the list. */
export async function openListing(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (cut at ${max} characters)` : text;
}

/**
 * Marks every element the page doesn't display with `hidden`, so a fixture replayed without
 * the site's stylesheets shows (and hides) the same things. Visible elements are untouched.
 */
export async function markHidden(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of Array.from(document.body?.querySelectorAll('*') ?? [])) {
      if (el.hasAttribute('hidden')) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none') el.setAttribute('hidden', '');
    }
  });
}

/** The page's HTML without scripts: what a fixture replays (JavaScript never runs there). */
export async function fixtureHtml(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.documentElement.cloneNode(true) as HTMLElement;
    for (const el of Array.from(
      root.querySelectorAll(
        'script, noscript, template, link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"]',
      ),
    )) {
      el.remove();
    }
    return `<!doctype html>\n${root.outerHTML}`;
  });
}

/**
 * The page's visible text in reading order, with each link's address after its text as
 * ` <https://…>`: what a textPattern recipe runs over (plain innerText loses the links).
 */
export function linkedText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const BLOCK = new Set([
      'ADDRESS',
      'ARTICLE',
      'ASIDE',
      'BLOCKQUOTE',
      'BR',
      'DD',
      'DIV',
      'DL',
      'DT',
      'FIELDSET',
      'FIGURE',
      'FOOTER',
      'FORM',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'HEADER',
      'HR',
      'LI',
      'MAIN',
      'NAV',
      'OL',
      'P',
      'PRE',
      'SECTION',
      'TABLE',
      'TD',
      'TH',
      'TR',
      'UL',
    ]);
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD']);
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return (node as Text).data;
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const el = node as HTMLElement;
      const tag = el.tagName.toUpperCase();
      if (SKIP.has(tag) || el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true')
        return '';
      let inner = Array.from(el.childNodes, walk).join('');
      // The address right after the link's text, on the same line.
      if (tag === 'A' && (el as HTMLAnchorElement).href) {
        inner = `${inner.replace(/\s+$/, '')} <${(el as HTMLAnchorElement).href}>`;
      }
      return BLOCK.has(tag) ? `\n${inner}\n` : inner;
    };
    return (document.body ? walk(document.body) : '')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  });
}

/**
 * A compact outline of the DOM (tag#id.classes[role] "own text" → href), for CSS fallbacks:
 * the ARIA snapshot has no class names.
 */
function outline(page: Page, max: number): Promise<string> {
  return page.evaluate((limit) => {
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'PATH']);
    const lines: string[] = [];
    let size = 0;
    const walk = (el: Element, depth: number): void => {
      if (size > limit) return;
      const tag = el.tagName.toUpperCase();
      if (SKIP.has(tag) || el.hasAttribute('hidden')) return;
      let own = '';
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === Node.TEXT_NODE) own += (n as Text).data;
      }
      own = own.replace(/\s+/g, ' ').trim().slice(0, 80);
      const cls = Array.from(el.classList)
        .slice(0, 4)
        .map((c) => `.${c}`)
        .join('');
      const role = el.getAttribute('role');
      const href = tag === 'A' ? (el as HTMLAnchorElement).getAttribute('href') : null;
      const line = `${'  '.repeat(Math.min(depth, 30))}${tag.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}${role ? `[role=${role}]` : ''}${own ? ` "${own}"` : ''}${href ? ` → ${href.slice(0, 120)}` : ''}`;
      lines.push(line);
      size += line.length + 1;
      for (const child of Array.from(el.children)) walk(child, depth + 1);
    };
    if (document.body) walk(document.body, 0);
    return lines.join('\n');
  }, max);
}

/** Everything the builder reads, and the fixture. Marks hidden elements on the live page. */
export async function capturePage(page: Page): Promise<PageCapture> {
  await markHidden(page);
  const aria = await page
    .locator('body')
    .ariaSnapshot({ timeout: 15_000 })
    .catch((err: Error) => `(no ARIA snapshot: ${err.message.split('\n')[0]})`);
  return {
    url: page.url(),
    title: await page.title(),
    aria: cut(aria, MAX_ARIA),
    outline: cut(await outline(page, MAX_OUTLINE), MAX_OUTLINE),
    text: cut(await linkedText(page), MAX_TEXT),
    html: await fixtureHtml(page),
  };
}

/**
 * Serves a stored page at its own URL, with everything else refused: a fixture replays with no
 * network, exactly as it was captured.
 */
export async function openFixture(page: Page, url: string, html: string): Promise<void> {
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u === url || u.replace(/#.*$/, '') === url.replace(/#.*$/, '')) {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    return route.abort();
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}
