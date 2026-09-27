// Regenerates cv.pdf from cv.html with the Chromium headless shell, then prints the text
// pdfjs-dist reads from it (compare with cv.expected.txt before replacing that file).
//   node test/fixtures/cv/render.ts [--write-expected]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { pdfToText } from '../../../src/domain/knowledge/text/pdf.ts';

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(readFileSync(here('cv.html'), 'utf8'));
  const pdf = await page.pdf({ format: 'A4', margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' } });
  writeFileSync(here('cv.pdf'), pdf);
  const { pages } = await pdfToText(pdf);
  const text = pages.map((p, i) => `[page ${i + 1}]\n${p}`).join('\n\n');
  if (process.argv.includes('--write-expected')) writeFileSync(here('cv.expected.txt'), `${text}\n`);
  process.stdout.write(`${text}\n`);
} finally {
  await browser.close();
}
