// drive sources: a Google Doc, Sheet or Slides deck, or a PDF / DOCX / text file kept in the
// candidate's Google Drive. Read through the Drive REST API with the phase-13 Google consent
// (`drive.readonly`); plain fetch like gmail.ts and gcal.ts.
//   metadata        files.get fields=id,name,mimeType,modifiedTime,size,webViewLink
//   Google formats  files.export → text/markdown (Docs, so headings survive for locators),
//                   text/csv (Sheets: the first sheet), text/plain (Slides)
//   other files     files.get alt=media → the usual document-to-text path (PDF, DOCX, text)
//   folders         files.list q='<id>' in parents, page by page; every file in it (and in its
//                   subfolders, a few levels down) read as above into one folder material
// The locator is the file id ("folder:<id>" for a folder); a Drive or Docs link is turned into
// it when the source is added.
import type { GoogleAuth } from '../../../integrations/google-oauth.ts';
import { extractFromBuffer } from '../text/extract.ts';
import {
  FOLDER_LIMITS,
  type FolderLimits,
  type FolderPart,
  folderMaterial,
  skippedName,
} from './folder.ts';
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

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** A Drive folder's locator starts with this; the rest is the folder id. */
export const DRIVE_FOLDER_PREFIX = 'folder:';

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
  /** One page of a folder's children (not trashed), by name. */
  children(
    folderId: string,
    pageToken: string | null,
    signal?: AbortSignal,
  ): Promise<{ files: DriveFile[]; nextPageToken: string | null }>;
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
  const path = /\/(?:d|folders)\/([\w-]{10,})/.exec(url.pathname)?.[1];
  const id = path ?? url.searchParams.get('id');
  if (!id || !/^[\w-]{10,}$/.test(id)) {
    throw new SourceReadError(`no file id in the Drive link "${s}"`, true);
  }
  return id;
}

/** A source locator from a link: the file id, or "folder:<id>" for a Drive folder link. */
export function driveLocator(input: string): string {
  const s = input.trim();
  if (s.startsWith(DRIVE_FOLDER_PREFIX)) {
    return DRIVE_FOLDER_PREFIX + driveFileId(s.slice(DRIVE_FOLDER_PREFIX.length));
  }
  const id = driveFileId(s);
  return /\/folders\/[\w-]{10,}/.test(s) ? DRIVE_FOLDER_PREFIX + id : id;
}

export class DriveError extends SourceReadError {}

export class GoogleDrive implements DriveApi {
  private readonly o: { auth: Pick<GoogleAuth, 'accessToken'>; api: string; fetch: FetchFn };

  constructor(o: { auth: Pick<GoogleAuth, 'accessToken'>; api?: string; fetch?: FetchFn }) {
    this.o = { auth: o.auth, api: o.api ?? DRIVE_API, fetch: o.fetch ?? fetch };
  }

  private async get(id: string, query: Record<string, string>, signal?: AbortSignal) {
    const path = `/files/${encodeURIComponent(id)}${query.mimeType ? '/export' : ''}`;
    const q = new URLSearchParams({ supportsAllDrives: 'true', ...query });
    if (query.mimeType) q.delete('supportsAllDrives');
    return this.call(id, path, q, signal);
  }

  private async call(id: string, path: string, q: URLSearchParams, signal?: AbortSignal) {
    const token = await this.o.auth.accessToken();
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

  async children(
    folderId: string,
    pageToken: string | null,
    signal?: AbortSignal,
  ): Promise<{ files: DriveFile[]; nextPageToken: string | null }> {
    const q = new URLSearchParams({
      q: `'${folderId.replace(/[^\w-]/g, '')}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink)',
      pageSize: '100',
      orderBy: 'name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await this.call(folderId, '/files', q, signal);
    const j = (await res.json()) as {
      nextPageToken?: string;
      files?: Array<Partial<DriveFile> & { size?: string }>;
    };
    return {
      files: (j.files ?? []).flatMap((f) =>
        f.id
          ? [
              {
                id: f.id,
                name: f.name ?? f.id,
                mimeType: f.mimeType ?? 'application/octet-stream',
                modifiedTime: f.modifiedTime ?? null,
                size: f.size ? Number(f.size) : null,
                webViewLink: f.webViewLink ?? null,
              },
            ]
          : [],
      ),
      nextPageToken: j.nextPageToken ?? null,
    };
  }
}

export async function readDriveSource(
  locator: string,
  access: DriveAccess | null | undefined,
  signal: AbortSignal,
  limits: FolderLimits = FOLDER_LIMITS,
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
  const l = locator.trim();
  const id = driveFileId(
    l.startsWith(DRIVE_FOLDER_PREFIX) ? l.slice(DRIVE_FOLDER_PREFIX.length) : l,
  );
  const file = await api.file(id, signal);
  if (file.mimeType === DRIVE_FOLDER_MIME) return readDriveFolder(api, file, limits, signal);
  const read = await readDriveFile(api, file, signal);
  return {
    label: `Drive · ${file.name} · ${read.label}${file.modifiedTime ? ` · edited ${file.modifiedTime.slice(0, 10)}` : ''}`,
    title: file.name,
    text: clip(read.text),
    locatorRules: read.paged
      ? '"page N" for the [page N] marker the text sits under, optionally followed by the section heading'
      : '"#<nearest heading>" for the section the text is in (or "#top" before the first heading; a sheet: "row N")',
    authorship: null,
  };
}

/** One Drive file's text: Google formats exported, the rest downloaded and extracted. */
async function readDriveFile(
  api: DriveApi,
  file: DriveFile,
  signal: AbortSignal,
): Promise<{ text: string; label: string; format: string; paged: boolean }> {
  const google = EXPORTS[file.mimeType];
  let text: string;
  let label: string;
  let format = 'text';
  let paged = false;
  if (google) {
    text = await api.exportText(file.id, google.mime, signal);
    label = google.label;
    format =
      google.mime === 'text/csv' ? 'csv' : google.mime === 'text/markdown' ? 'markdown' : 'text';
  } else if (file.mimeType === DRIVE_FOLDER_MIME) {
    throw new SourceReadError(`${file.name} is a folder`, true);
  } else if (file.mimeType.startsWith('application/vnd.google-apps.')) {
    throw new SourceReadError(`${file.name} is a ${file.mimeType} that has no text`, true);
  } else {
    if (file.size !== null && file.size > MAX_DOWNLOAD_BYTES) {
      throw new SourceReadError(`${file.name} is larger than 50 MB`, true);
    }
    const bytes = await api.download(file.id, signal);
    if (file.mimeType.startsWith('text/')) {
      text = Buffer.from(bytes).toString('utf8');
      label = 'text';
    } else {
      const doc = await extractFromBuffer(file.name, bytes).catch((err: Error) => {
        throw new SourceReadError(`can't read ${file.name} from Drive: ${err.message}`, true);
      });
      text = pagesToText(doc.pages);
      label = doc.format;
      format = doc.format;
      paged = doc.format === 'pdf' && doc.pages.length > 1;
    }
  }
  text = text.replace(/^\uFEFF/, '').trim();
  if (!text) throw new SourceReadError(`${file.name} on Drive has no text`, true);
  return { text, label, format, paged };
}

/**
 * A Drive folder: its files, then its subfolders' (depth-first, by name), under the same
 * limits as a local folder. Files that can't be read are skipped, not fatal.
 */
async function readDriveFolder(
  api: DriveApi,
  folder: DriveFile,
  limits: FolderLimits,
  signal: AbortSignal,
): Promise<SourceMaterial> {
  const parts: FolderPart[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  let listed = 0;
  const full = () => parts.length >= limits.maxFiles || bytes >= limits.maxTotalBytes;

  const walk = async (id: string, prefix: string, depth: number): Promise<void> => {
    const children: DriveFile[] = [];
    let token: string | null = null;
    do {
      const page = await api.children(id, token, signal);
      children.push(...page.files);
      token = page.nextPageToken;
      listed += page.files.length;
      // A huge folder isn't listed to the end: more than the limit can't be read anyway.
    } while (token && listed < limits.maxFiles * 5);
    const folders: DriveFile[] = [];
    for (const f of children) {
      const rel = `${prefix}${f.name}`;
      if (f.mimeType === DRIVE_FOLDER_MIME) {
        if (skippedName(f.name, true)) continue;
        if (depth >= limits.maxDepth) skipped.push(`${rel}/ (too deep)`);
        else folders.push(f);
        continue;
      }
      if (skippedName(f.name, false)) continue;
      if (full()) {
        skipped.push(`${rel} (over the folder limit)`);
        continue;
      }
      if (f.size !== null && f.size > limits.maxFileBytes) {
        skipped.push(`${rel} (too large)`);
        continue;
      }
      if (f.size !== null && bytes + f.size > limits.maxTotalBytes) {
        skipped.push(`${rel} (over the folder limit)`);
        continue;
      }
      try {
        const read = await readDriveFile(api, f, signal);
        bytes += f.size ?? Buffer.byteLength(read.text);
        parts.push({ path: rel, format: read.format, text: read.text });
      } catch (err) {
        signal.throwIfAborted();
        // Not a document (an image, an archive): skipped. Drive failing for now is retried.
        if (!(err instanceof SourceReadError) || !err.permanent) throw err;
        skipped.push(`${rel} (${(err as Error).message})`);
      }
    }
    for (const f of folders) await walk(f.id, `${prefix}${f.name}/`, depth + 1);
  };
  await walk(folder.id, '', 0);
  return folderMaterial(
    folder.name,
    `Drive · ${folder.name}/${folder.modifiedTime ? ` · edited ${folder.modifiedTime.slice(0, 10)}` : ''}`,
    parts,
    skipped,
  );
}
