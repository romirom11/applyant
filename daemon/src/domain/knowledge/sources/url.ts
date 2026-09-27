// url sources: a portfolio page, a case study, a blog post, an online PDF. Plain HTTP first
// (readability over the served HTML); pages that render client-side are opened in the
// headless reader browser.
import type { ReaderPool } from '../../../browser/reader-pool.ts';
import { extractFromBuffer } from '../text/extract.ts';
import { htmlToText } from '../text/html.ts';
import { clip, pagesToText, type SourceMaterial, SourceReadError } from './material.ts';

/** Less readable text than this in the served HTML means the page renders client-side. */
const MIN_STATIC_TEXT = 400;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export async function readUrlSource(
  url: string,
  reader: ReaderPool,
  signal: AbortSignal,
): Promise<SourceMaterial> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/pdf,*/*;q=0.8' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
  } catch (err) {
    signal.throwIfAborted();
    throw new SourceReadError(`can't fetch ${url}: ${(err as Error).message}`, false);
  }
  if (res.status === 404 || res.status === 410) {
    throw new SourceReadError(`${url} returns HTTP ${res.status}`, true);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new SourceReadError(`${url} returns HTTP ${res.status}`, false);
  }
  if (res.status >= 400) throw new SourceReadError(`${url} returns HTTP ${res.status}`, true);

  const type = res.headers.get('content-type') ?? '';
  const body = new Uint8Array(await res.arrayBuffer());
  if (type.includes('pdf') || /\.pdf(?:$|[?#])/i.test(url)) {
    const doc = await extractFromBuffer('download.pdf', body).catch((err: Error) => {
      throw new SourceReadError(`can't read the PDF at ${url}: ${err.message}`, true);
    });
    return material(url, null, pagesToText(doc.pages), doc.pages.length > 1);
  }
  if (type && !/html|text\/plain|xml/.test(type)) {
    throw new SourceReadError(`${url} is ${type.split(';')[0]}, not a page or PDF`, true);
  }

  const html = Buffer.from(body).toString('utf8');
  let { title, text } = type.includes('text/plain')
    ? { title: null, text: html }
    : htmlToText(html, res.url || url);
  if (text.length < MIN_STATIC_TEXT && !type.includes('text/plain')) {
    const rendered = await reader.withPage(
      async (page) => {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
        return { html: await page.content(), finalUrl: page.url() };
      },
      { signal },
    );
    const again = htmlToText(rendered.html, rendered.finalUrl);
    if (again.text.length > text.length) ({ title, text } = again);
  }
  if (!text.trim()) throw new SourceReadError(`${url} has no readable text`, true);
  return material(url, title, text, false);
}

function material(url: string, title: string | null, text: string, paged: boolean): SourceMaterial {
  return {
    label: `${url}${title ? ` · ${title}` : ''}`,
    title,
    text: clip(text.trim()),
    locatorRules: paged
      ? '"page N" for the [page N] marker the text sits under'
      : '"#<nearest heading>" for the section the text is in (or "#top" before the first heading)',
    authorship: null,
  };
}
