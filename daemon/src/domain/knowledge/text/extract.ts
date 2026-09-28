// Documents → text. One interface, so phase 8a can put applyant-native (PDFKit, AppKit) in
// front on macOS and keep these readers as the fallback.
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
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
