// Documents → text. One interface: on macOS applyant-native (PDFKit, AppKit) reads PDF and
// DOCX, and these Node readers are the fallback and the Linux path.
import { open, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { NativeHelper } from '../../../native/client.ts';
import type { Logger } from '../../../util/log.ts';
import { htmlToText } from './html.ts';
import { pdfToText } from './pdf.ts';

export interface ExtractedText {
  format: 'pdf' | 'docx' | 'html' | 'text';
  /** Pages for paginated formats; one entry otherwise. */
  pages: string[];
  title: string | null;
}

export interface TextExtractor {
  extract(path: string): Promise<ExtractedText>;
}

export class UnsupportedDocumentError extends Error {}

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.rst',
  '.adoc',
  '.org',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
]);

export function detectFormat(path: string, head: Uint8Array): ExtractedText['format'] | null {
  const magic = Buffer.from(head.subarray(0, 5)).toString('latin1');
  if (magic === '%PDF-') return 'pdf';
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  // DOCX is a zip ("PK\x03\x04") with a .docx name.
  if (ext === '.docx' && magic.startsWith('PK')) return 'docx';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  // Unknown extension: accept it as text when it decodes as UTF-8 without NULs.
  const sample = Buffer.from(head.subarray(0, 4096));
  if (!sample.includes(0) && !sample.toString('utf8').includes('�')) return 'text';
  return null;
}

export class NodeTextExtractor implements TextExtractor {
  async extract(path: string): Promise<ExtractedText> {
    const data = await readFile(path);
    return extractFromBuffer(path, data);
  }
}

/** PDF and DOCX through applyant-native first; anything it can't read goes to `fallback`. */
export class NativeTextExtractor implements TextExtractor {
  private readonly native: NativeHelper;
  private readonly fallback: TextExtractor;
  private readonly log: Logger;

  constructor(native: NativeHelper, fallback: TextExtractor, log: Logger) {
    this.native = native;
    this.fallback = fallback;
    this.log = log;
  }

  async extract(path: string): Promise<ExtractedText> {
    const format = await sniff(path);
    if (this.native.available && (format === 'pdf' || format === 'docx')) {
      try {
        const got = await this.native.request<{ pages: string[]; title: string | null }>(
          'extract_text',
          { path, format },
        );
        // A PDF without a text layer reads as blank here; pdfjs gets the same chance.
        if (got.pages.some((p) => p.trim() !== '')) {
          return { format, pages: got.pages.map((p) => p.trim()), title: got.title ?? null };
        }
        this.log.info('applyant-native found no text; trying the Node reader', { path });
      } catch (err) {
        this.log.warn('applyant-native could not read the document; trying the Node reader', {
          path,
          err,
        });
      }
    }
    return this.fallback.extract(path);
  }
}

async function sniff(path: string): Promise<ExtractedText['format'] | null> {
  const fh = await open(path, 'r');
  try {
    const head = new Uint8Array(4096);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    return detectFormat(path, head.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

export async function extractFromBuffer(name: string, data: Uint8Array): Promise<ExtractedText> {
  const format = detectFormat(name, data);
  switch (format) {
    case 'pdf': {
      const { pages } = await pdfToText(data);
      return { format, pages, title: null };
    }
    case 'docx': {
      const mammoth = await import('mammoth');
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
      return { format, pages: [value.replace(/\n{3,}/g, '\n\n').trim()], title: null };
    }
    case 'html': {
      const { title, text } = htmlToText(Buffer.from(data).toString('utf8'), null);
      return { format, pages: [text], title };
    }
    case 'text':
      return { format, pages: [Buffer.from(data).toString('utf8').trim()], title: null };
    default:
      throw new UnsupportedDocumentError(
        `can't read ${name}: supported are PDF, DOCX, HTML and plain-text files`,
      );
  }
}
