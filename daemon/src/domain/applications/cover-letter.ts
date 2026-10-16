// A file-upload cover letter uses the same fact-checked answer as a text field, printed as PDF.
import { join } from 'node:path';
import type { ReaderPool } from '../../browser/reader-pool.ts';
import type { StandardProfile } from '../knowledge/profile.ts';
import { renderPdf, storePdf } from './cv/render.ts';

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function coverLetterHtml(
  text: string,
  profile: StandardProfile,
  job: { title: string | null; company: string | null },
): string {
  const heading = [job.title, job.company].filter(Boolean).join(' · ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 23mm; }
    body { font: 11pt/1.55 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; color: #222; }
    h1 { font-size: 17pt; margin: 0 0 3mm; }
    .job { color: #555; margin: 0 0 12mm; }
    .letter { white-space: pre-wrap; }
  </style></head><body><h1>${escapeHtml(profile.full_name ?? '')}</h1>
  <p class="job">${escapeHtml(heading)}</p><p class="letter">${escapeHtml(text)}</p></body></html>`;
}

export async function renderCoverLetter(
  reader: Pick<ReaderPool, 'withPage'>,
  filesDir: string,
  applicationId: number,
  text: string,
  profile: StandardProfile,
  job: { title: string | null; company: string | null },
  signal: AbortSignal,
): Promise<string> {
  const pdf = await renderPdf(reader, coverLetterHtml(text, profile, job), signal);
  return storePdf(join(filesDir, 'cover-letter'), applicationId, pdf).path;
}
