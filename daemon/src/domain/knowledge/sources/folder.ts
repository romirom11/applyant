// Folder sources: a local folder, or a Drive folder, read as one source. Every readable file in
// it (the kinds a file source takes: PDF, DOCX, HTML, text) goes into one material under a
// "=== file: <relative path> ===" marker, so each fact cites the file it came from.
//   skipped   hidden files and folders, node_modules, symlinks, binary files, files over the
//             single-file cap, and anything past the file, byte or depth limits
import type { Dirent } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { detectFormat, type ExtractedText, type TextExtractor } from '../text/extract.ts';
import { MAX_FILE_BYTES } from './file.ts';
import {
  clip,
  MAX_MATERIAL_CHARS,
  pagesToText,
  type SourceMaterial,
  SourceReadError,
} from './material.ts';

export interface FolderLimits {
  /** Files read at most. */
  maxFiles: number;
  /** One file's cap (the same as a single file source). */
  maxFileBytes: number;
  /** Bytes read across the folder. */
  maxTotalBytes: number;
  /** Folder levels below the source that are still read. */
  maxDepth: number;
}

export const FOLDER_LIMITS: FolderLimits = {
  maxFiles: 200,
  maxFileBytes: MAX_FILE_BYTES,
  maxTotalBytes: 100 * 1024 * 1024,
  maxDepth: 6,
};

/** Folders that hold dependencies or build output, never the candidate's writing. */
const SKIPPED_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'target', 'dist', 'build']);

export function skippedName(name: string, dir: boolean): boolean {
  return name.startsWith('.') || (dir && SKIPPED_DIRS.has(name));
}

/** One file of a folder, read. */
export interface FolderPart {
  /** Relative to the folder, with "/" separators. */
  path: string;
  format: string;
  text: string;
}

export const FOLDER_LOCATOR_RULES =
  'the file\'s path as its "=== file: … ===" marker gives it, then " · " and the place inside the file: "page N" for a [page N] marker, else "section: <nearest heading>" (or "start"), e.g. "notes/architecture.md · section: Queue"';

/** The material for a folder's parts; `skipped` says what was left out and why. */
export function folderMaterial(
  name: string,
  where: string,
  parts: FolderPart[],
  skipped: string[],
): SourceMaterial {
  if (parts.length === 0) {
    throw new SourceReadError(
      `${where} has no readable files (PDF, DOCX, HTML or text)${skipped.length ? `; skipped: ${skipped.slice(0, 5).join(', ')}` : ''}`,
      true,
    );
  }
  let text = '';
  let shown = 0;
  for (const p of parts) {
    const block = `=== file: ${p.path} (${p.format}) ===\n${p.text}\n\n`;
    if (text.length + block.length > MAX_MATERIAL_CHARS && shown > 0) break;
    text += block;
    shown++;
  }
  const notShown = parts.length - shown;
  return {
    label: [
      `${where} · ${parts.length} files`,
      notShown ? `${notShown} past the reading limit` : null,
      skipped.length ? `${skipped.length} skipped` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    title: name,
    text: clip(text.trim()),
    locatorRules: FOLDER_LOCATOR_RULES,
    authorship: null,
    parts: parts.slice(0, shown).map((p) => ({ path: p.path, text: p.text })),
  };
}

export async function readFolderSource(
  locator: string,
  extractor: TextExtractor,
  limits: FolderLimits = FOLDER_LIMITS,
): Promise<SourceMaterial> {
  const root = locator.replace(/\/+$/, '') || '/';
  try {
    if (!(await stat(root)).isDirectory())
      throw new SourceReadError(`${root} is not a folder`, true);
  } catch (err) {
    if (err instanceof SourceReadError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    throw new SourceReadError(
      code === 'ENOENT'
        ? `folder not found: ${root}`
        : `can't read ${root}: ${(err as Error).message}`,
      code === 'ENOENT' || code === 'EACCES',
    );
  }

  const parts: FolderPart[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  let full = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skipped.push(`${relative(root, dir) || '.'}/ (can't be listed)`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const path = join(dir, e.name);
      const rel = relative(root, path).split('\\').join('/');
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (skippedName(e.name, true)) continue;
        if (depth >= limits.maxDepth) {
          skipped.push(`${rel}/ (too deep)`);
          continue;
        }
        await walk(path, depth + 1);
        continue;
      }
      if (!e.isFile() || skippedName(e.name, false)) continue;
      if (full) {
        skipped.push(`${rel} (over the folder limit)`);
        continue;
      }
      const part = await readPart(path, rel, extractor, limits, bytes).catch(
        (err: Error) => err.message,
      );
      if (typeof part === 'string') {
        skipped.push(`${rel} (${part})`);
        continue;
      }
      bytes += part.size;
      parts.push(part.part);
      if (parts.length >= limits.maxFiles || bytes >= limits.maxTotalBytes) full = true;
    }
  };
  await walk(root, 0);
  return folderMaterial(basename(root), `${basename(root)}/`, parts, skipped);
}

async function readPart(
  path: string,
  rel: string,
  extractor: TextExtractor,
  limits: FolderLimits,
  readSoFar: number,
): Promise<{ part: FolderPart; size: number }> {
  const { size } = await stat(path);
  if (size > limits.maxFileBytes) throw new Error('too large');
  if (readSoFar + size > limits.maxTotalBytes) throw new Error('over the folder limit');
  const fh = await open(path, 'r');
  let format: ExtractedText['format'] | null;
  try {
    const head = new Uint8Array(4096);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    format = detectFormat(path, head.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
  if (!format) throw new Error('binary');
  const doc = await extractor.extract(path);
  const text = pagesToText(doc.pages).trim();
  if (!text) throw new Error('no text');
  return { part: { path: rel, format: doc.format, text }, size };
}

/**
 * Evidence from a folder names its file. A locator that doesn't start with one of the parts'
 * paths gets the file whose text holds the quote, or the only file there is.
 */
export function fileLocator(
  parts: ReadonlyArray<{ path: string; text: string }>,
  locator: string | null,
  quote: string | null,
): string | null {
  if (locator && parts.some((p) => locator === p.path || locator.startsWith(`${p.path} `))) {
    return locator;
  }
  const squash = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
  const q = quote ? squash(quote) : '';
  const byQuote = q ? parts.find((p) => squash(p.text).includes(q)) : undefined;
  const file = byQuote ?? (parts.length === 1 ? parts[0] : undefined);
  if (!file) return locator;
  return locator ? `${file.path} · ${locator}` : file.path;
}
