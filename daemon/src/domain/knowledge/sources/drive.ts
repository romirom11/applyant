// drive sources: a Google Doc, Sheet or Slides deck, or a PDF / DOCX / text file kept in the
// candidate's Google Drive. Read through the Drive REST API with the phase-13 Google consent
// (`drive.readonly`); plain fetch like gmail.ts and gcal.ts.
//   metadata        files.get fields=id,name,mimeType,modifiedTime,size,webViewLink
//   Google formats  files.export → text/markdown (Docs, so headings survive for locators),
//                   text/csv (Sheets: the first sheet), text/plain (Slides)
//   other files     files.get alt=media → the usual document-to-text path (PDF, DOCX, text)
// The locator is the file id; a Drive or Docs link is turned into it when the source is added.
import type { GoogleAuth } from '../../../integrations/google-oauth.ts';
import { extractFromBuffer } from '../text/extract.ts';
import { clip, pagesToText, type SourceMaterial, SourceReadError } from './material.ts';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';

type FetchFn = typeof fetch;

/** Google's own formats, by MIME type → what they're exported as. */
const EXPORTS: Record<string, { mime: string; label: string }> = {
  'application/vnd.google-apps.document': { mime: 'text/markdown', label: 'Google Doc' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', label: 'Google Sheet' },
  'application/vnd.google-apps.presentation': { mime: 'text/plain', label: 'Google Slides' },
};

/** files.export's own cap (Google refuses bigger exports), and ours for downloads. */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  size: number | null;
  webViewLink: string | null;
}

/** What a drive read needs: the file's metadata and its content. */
export interface DriveApi {
  file(id: string, signal?: AbortSignal): Promise<DriveFile>;
  exportText(id: string, mime: string, signal?: AbortSignal): Promise<string>;
  download(id: string, signal?: AbortSignal): Promise<Uint8Array>;
}

/** Deps.drive: the candidate's Drive when a Google account is connected, else null. */
export interface DriveAccess {
  drive(): Promise<DriveApi | null>;
}

/**
 * The file id from what the candidate pasted: a Docs/Sheets/Slides link, a Drive file link,
 * an `open?id=` link, or the bare id.
 */
export function driveFileId(input: string): string {
  const s = input.trim();
  if (/^[\w-]{10,}$/.test(s)) return s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new SourceReadError(`not a Google Drive link or file id: "${s}"`, true);
  }
  if (!/(^|\.)google\.com$/.test(url.hostname)) {
    throw new SourceReadError(`not a Google Drive link: "${s}"`, true);
  }
  const path = /\/d\/([\w-]{10,})/.exec(url.pathname)?.[1];
  const id = path ?? url.searchParams.get('id');
  if (!id || !/^[\w-]{10,}$/.test(id)) {
    throw new SourceReadError(`no file id in the Drive link "${s}"`, true);
  }
  return id;
}

export class DriveError extends SourceReadError {}

export class GoogleDrive implements DriveApi {
  private readonly o: { auth: Pick<GoogleAuth, 'accessToken'>; api: string; fetch: FetchFn };

  constructor(o: { auth: Pick<GoogleAuth, 'accessToken'>; api?: string; fetch?: FetchFn }) {
    this.o = { auth: o.auth, api: o.api ?? DRIVE_API, fetch: o.fetch ?? fetch };
  }

  private async get(id: string, query: Record<string, string>, signal?: AbortSignal) {
    const token = await this.o.auth.accessToken();
    const path = `/files/${encodeURIComponent(id)}${query.mimeType ? '/export' : ''}`;
    const q = new URLSearchParams({ supportsAllDrives: 'true', ...query });
    if (query.mimeType) q.delete('supportsAllDrives');
    let res: Response;
    try {
      res = await this.o.fetch(`${this.o.api}${path}?${q}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
      });
    } catch (err) {
      signal?.throwIfAborted();
      throw new DriveError(`can't reach Google Drive: ${(err as Error).message}`, false);
    }
    if (res.ok) return res;
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; errors?: Array<{ reason?: string }> };
    };
    const reason = json.error?.errors?.[0]?.reason ?? '';
    const msg = json.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 404) {
      throw new DriveError(
        `Google Drive has no file ${id} that the connected account can open (is it shared with it?)`,
        true,
      );
    }
    if (res.status === 401 || reason === 'insufficientPermissions') {
      throw new DriveError(
        `Google Drive refused access (${msg}): connect Google again (\`applyant mail connect gmail\`)`,
        true,
      );
    }
    if (reason === 'exportSizeLimitExceeded') {
      throw new DriveError(`the file is too large for Google to export as text (${msg})`, true);
    }
    const retry = res.status === 429 || res.status >= 500 || /rateLimit/i.test(reason);
    throw new DriveError(`Google Drive: HTTP ${res.status} ${msg}`, !retry);
  }

  async file(id: string, signal?: AbortSignal): Promise<DriveFile> {
    const res = await this.get(
      id,
      { fields: 'id,name,mimeType,modifiedTime,size,webViewLink' },
      signal,
    );
    const j = (await res.json()) as Partial<DriveFile> & { size?: string };
    return {
      id: j.id ?? id,
      name: j.name ?? id,
      mimeType: j.mimeType ?? 'application/octet-stream',
      modifiedTime: j.modifiedTime ?? null,
      size: j.size ? Number(j.size) : null,
      webViewLink: j.webViewLink ?? null,
    };
  }

  async exportText(id: string, mime: string, signal?: AbortSignal): Promise<string> {
    return (await this.get(id, { mimeType: mime }, signal)).text();
  }

  async download(id: string, signal?: AbortSignal): Promise<Uint8Array> {
    return new Uint8Array(await (await this.get(id, { alt: 'media' }, signal)).arrayBuffer());
  }
}

export async function readDriveSource(
  locator: string,
  access: DriveAccess | null | undefined,
  signal: AbortSignal,
): Promise<SourceMaterial> {
  const api = await access?.drive().catch((err: Error) => {
    throw new SourceReadError(`Google Drive: ${err.message}`, true);
  });
  if (!api) {
    throw new SourceReadError(
      'Google Drive needs a connected Google account: `applyant mail connect gmail` (one consent covers Gmail, Calendar and Drive)',
      true,
    );
  }
  const id = driveFileId(locator);
  const file = await api.file(id, signal);
  const google = EXPORTS[file.mimeType];
  let text: string;
  let label: string;
  let paged = false;
  if (google) {
    text = await api.exportText(id, google.mime, signal);
    label = google.label;
  } else if (file.mimeType === 'application/vnd.google-apps.folder') {
    throw new SourceReadError(`${file.name} is a folder: add the documents in it one by one`, true);
  } else if (file.mimeType.startsWith('application/vnd.google-apps.')) {
    throw new SourceReadError(`${file.name} is a ${file.mimeType} that has no text`, true);
  } else {
    if (file.size !== null && file.size > MAX_DOWNLOAD_BYTES) {
      throw new SourceReadError(`${file.name} is larger than 50 MB`, true);
    }
    const bytes = await api.download(id, signal);
    if (file.mimeType.startsWith('text/')) {
      text = Buffer.from(bytes).toString('utf8');
      label = 'text';
    } else {
      const doc = await extractFromBuffer(file.name, bytes).catch((err: Error) => {
        throw new SourceReadError(`can't read ${file.name} from Drive: ${err.message}`, true);
      });
      text = pagesToText(doc.pages);
      label = doc.format;
      paged = doc.format === 'pdf' && doc.pages.length > 1;
    }
  }
  text = text.replace(/^﻿/, '').trim();
  if (!text) throw new SourceReadError(`${file.name} on Drive has no text`, true);
  return {
    label: `Drive · ${file.name} · ${label}${file.modifiedTime ? ` · edited ${file.modifiedTime.slice(0, 10)}` : ''}`,
    title: file.name,
    text: clip(text),
    locatorRules: paged
      ? '"page N" for the [page N] marker the text sits under, optionally followed by the section heading'
      : '"#<nearest heading>" for the section the text is in (or "#top" before the first heading; a sheet: "row N")',
    authorship: null,
  };
}
