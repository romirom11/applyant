// PDF → text with pdfjs-dist in Node. On the Mac, applyant-native (PDFKit) takes over in
// phase 8a; this stays as the fallback and the Linux path.
import { fileURLToPath } from 'node:url';

export interface PdfText {
  /** One string per page, lines separated by "\n". */
  pages: string[];
}

/** pdfjs-dist's package directory (it has font data and character maps pdfjs loads by path). */
const PDFJS = fileURLToPath(new URL('./', import.meta.resolve('pdfjs-dist/package.json')));

export async function pdfToText(data: Uint8Array): Promise<PdfText> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdfjs takes ownership of the buffer it's given, so pass a copy.
  const task = getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: `${PDFJS}standard_fonts/`,
    // CID fonts (CJK, many Cyrillic CVs) need the character maps to map glyphs to text.
    cMapUrl: `${PDFJS}cmaps/`,
    cMapPacked: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      let lastY: number | null = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5] as number;
        // A jump in baseline without an explicit EOL is still a new line.
        if (lastY !== null && text && !text.endsWith('\n') && Math.abs(y - lastY) > 2) {
          text += '\n';
        }
        text += item.str;
        if (item.hasEOL) text += '\n';
        lastY = y;
      }
      pages.push(normalise(text));
      page.cleanup();
    }
    return { pages };
  } finally {
    await task.destroy();
  }
}

function normalise(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
