import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSource } from '../src/domain/knowledge/sources/file.ts';
import { SourceReadError } from '../src/domain/knowledge/sources/material.ts';
import { detectFormat, NodeTextExtractor } from '../src/domain/knowledge/text/extract.ts';
import { htmlToText } from '../src/domain/knowledge/text/html.ts';
import { pdfToText } from '../src/domain/knowledge/text/pdf.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/cv/${name}`, import.meta.url));

describe('PDF → text (pdfjs-dist)', () => {
  it('reads the fixture CV page by page, exactly as expected', async () => {
    const { pages } = await pdfToText(readFileSync(fixture('cv.pdf')));
    expect(pages).toHaveLength(2);
    const text = pages.map((p, i) => `[page ${i + 1}]\n${p}`).join('\n\n');
    expect(`${text}\n`).toBe(readFileSync(fixture('cv.expected.txt'), 'utf8'));
  });

  it('keeps lines, numbers and non-ASCII punctuation intact', async () => {
    const { pages } = await pdfToText(readFileSync(fixture('cv.pdf')));
    const lines = (pages[0] ?? '').split('\n');
    expect(lines).toContain('Nightingale — Acme Voice, Senior Backend Engineer, 2021–2024');
    expect(lines).toContain(
      'Led a team of 4 engineers that shipped speech-to-text and LLM summarisation of sales calls.',
    );
    expect(pages[1]).toContain('English (C1), Greek (native), German (B1)');
  });
});

describe('file sources', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'applyant-files-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('gives the extractor page markers and page locators for a multi-page PDF', async () => {
    const m = await readFileSource(fixture('cv.pdf'), new NodeTextExtractor());
    expect(m.label).toBe('cv.pdf · pdf · 2 pages');
    expect(m.text.startsWith('[page 1]\nAlex Example')).toBe(true);
    expect(m.text).toContain('[page 2]\nSkills');
    expect(m.locatorRules).toMatch(/page N/);
    expect(m.authorship).toBeNull();
  });

  it('reads markdown and HTML documents', async () => {
    const md = join(dir, 'notes.md');
    writeFileSync(md, '# Architecture\n\nThe pipeline uses Kafka.\n');
    const m = await readFileSource(md, new NodeTextExtractor());
    expect(m.text).toBe('# Architecture\n\nThe pipeline uses Kafka.');
    expect(m.locatorRules).toMatch(/section/);

    const page = htmlToText(
      '<html><head><title>Case study</title></head><body><nav>Home · Blog</nav><h1>Moving to Kafka</h1><p>We moved billing events to Kafka.</p><ul><li>3 brokers</li><li>6 topics</li></ul></body></html>',
      null,
    );
    expect(page.title).toBe('Case study');
    expect(page.text).toContain('## Moving to Kafka');
    expect(page.text).toContain('- 3 brokers\n- 6 topics');
  });

  it('fails permanently on a missing file or an unreadable format', async () => {
    const missing = readFileSource(join(dir, 'nope.pdf'), new NodeTextExtractor());
    await expect(missing).rejects.toBeInstanceOf(SourceReadError);
    await expect(missing).rejects.toMatchObject({ permanent: true });

    const bin = join(dir, 'photo.bin');
    writeFileSync(bin, Buffer.from([0, 1, 2, 3, 255, 0, 7]));
    await expect(readFileSource(bin, new NodeTextExtractor())).rejects.toMatchObject({
      permanent: true,
      message: expect.stringMatching(/supported are PDF, DOCX, HTML and plain-text/),
    });
  });

  it('detects formats by content, not only by name', () => {
    expect(detectFormat('cv', new TextEncoder().encode('%PDF-1.7 ...'))).toBe('pdf');
    expect(detectFormat('cv.docx', new TextEncoder().encode('PK\u0003\u0004...'))).toBe('docx');
    expect(detectFormat('README', new TextEncoder().encode('# hello'))).toBe('text');
  });
});
