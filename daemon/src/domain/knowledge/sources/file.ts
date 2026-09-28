// file sources: a CV, a LinkedIn PDF export, architecture notes, any local document.
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { type TextExtractor, UnsupportedDocumentError } from '../text/extract.ts';
import { clip, pagesToText, type SourceMaterial, SourceReadError } from './material.ts';

const MAX_FILE_BYTES = 50 * 1024 * 1024;

export async function readFileSource(
  path: string,
  extractor: TextExtractor,
): Promise<SourceMaterial> {
  let size: number;
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new SourceReadError(`${path} is not a file`, true);
    size = s.size;
  } catch (err) {
    if (err instanceof SourceReadError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    throw new SourceReadError(
      code === 'ENOENT'
        ? `file not found: ${path}`
        : `can't read ${path}: ${(err as Error).message}`,
      code === 'ENOENT' || code === 'EACCES',
    );
  }
  if (size > MAX_FILE_BYTES) throw new SourceReadError(`${path} is larger than 50 MB`, true);

  let extracted: Awaited<ReturnType<TextExtractor['extract']>>;
  try {
    extracted = await extractor.extract(path);
  } catch (err) {
    if (err instanceof UnsupportedDocumentError) throw new SourceReadError(err.message, true);
    throw new SourceReadError(`can't extract text from ${path}: ${(err as Error).message}`, true);
  }
  const text = pagesToText(extracted.pages).trim();
  if (!text) {
    throw new SourceReadError(
      `${basename(path)} has no text layer (a scanned PDF?); export it with selectable text`,
      true,
    );
  }
  const paged = extracted.format === 'pdf' && extracted.pages.length > 1;
  return {
    label: `${basename(path)} · ${extracted.format}${paged ? ` · ${extracted.pages.length} pages` : ''}`,
    title: extracted.title,
    text: clip(text),
    locatorRules: paged
      ? '"page N" for the [page N] marker the text sits under, optionally followed by the section heading, e.g. "page 2 · Experience"'
      : '"section: <nearest heading>" (or "start" if there is no heading above the text)',
    authorship: null,
  };
}
