// The CV template (Settings → CV template, `applyant cv-template`): which one prints the tailored
// CV, replacing the custom one with files the client read, and going back to the bundled one.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import { BUNDLED_TEMPLATE } from '../domain/applications/cv/render.ts';
import {
  type ApplyantService,
  type CvTemplateInfo,
  CvTemplateInfoSchema,
} from '../gen/applyant/v1/applyant_pb.js';

type Impl = ServiceImpl<typeof ApplyantService>;

/** Where the name the candidate's folder had is kept (not a template file). */
const NAME_FILE = '.applyant-template-name';
const MAX_BYTES = 5 * 1024 * 1024;

function listFiles(root: string, dir = root): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .flatMap((e) =>
      e.isDirectory() ? listFiles(root, join(dir, e.name)) : [relative(root, join(dir, e.name))],
    )
    .sort();
}

/** Why a template folder can't be used, or null. */
function problemWith(dir: string): string | null {
  const index = join(dir, 'index.html');
  if (!existsSync(index)) return 'it has no index.html';
  if (!readFileSync(index, 'utf8').includes('{{cv}}')) return 'its index.html has no {{cv}}';
  return null;
}

export function cvTemplateInfo(dir: string | null): CvTemplateInfo {
  if (dir && existsSync(dir)) {
    const problem = problemWith(dir);
    const nameFile = join(dir, NAME_FILE);
    return create(CvTemplateInfoSchema, {
      custom: problem === null,
      name: existsSync(nameFile) ? readFileSync(nameFile, 'utf8').trim() : basename(dir),
      dir,
      files: listFiles(dir),
      problem: problem
        ? `The custom template can't be used (${problem}), so "Clean" prints the CV.`
        : undefined,
      installedAt: timestampFromDate(statSync(dir).mtime),
    });
  }
  return create(CvTemplateInfoSchema, {
    custom: false,
    name: 'Clean',
    dir: BUNDLED_TEMPLATE,
    files: listFiles(BUNDLED_TEMPLATE),
  });
}

function safePath(p: string): string {
  const n = normalize(p.replaceAll('\\', '/'));
  if (
    !n ||
    isAbsolute(n) ||
    n === '.' ||
    n.split(sep).includes('..') ||
    n.split(sep).some((s) => s.startsWith('.'))
  ) {
    throw new ConnectError(`"${p}" isn't a file inside the template folder`, Code.InvalidArgument);
  }
  return n;
}

export function setCvTemplate(
  dir: string,
  files: Array<{ path: string; content: Uint8Array }>,
  name: string | null,
): CvTemplateInfo {
  const seen = new Map<string, Uint8Array>();
  let total = 0;
  for (const f of files) {
    const p = safePath(f.path);
    total += f.content.byteLength;
    seen.set(p, f.content);
  }
  if (total > MAX_BYTES) {
    throw new ConnectError(
      "the template is over 5 MB; leave out what it doesn't need",
      Code.InvalidArgument,
    );
  }
  const index = seen.get('index.html');
  if (!index)
    throw new ConnectError('a CV template needs an index.html at its top', Code.InvalidArgument);
  if (!Buffer.from(index).toString('utf8').includes('{{cv}}')) {
    throw new ConnectError('index.html needs a {{cv}} where the CV goes', Code.InvalidArgument);
  }
  // Written next to the old one, then swapped, so a failed write leaves the old template.
  const next = `${dir}.new`;
  rmSync(next, { recursive: true, force: true });
  for (const [p, content] of seen) {
    mkdirSync(dirname(join(next, p)), { recursive: true });
    writeFileSync(join(next, p), content);
  }
  writeFileSync(join(next, NAME_FILE), `${name?.trim() || 'Custom'}\n`);
  rmSync(dir, { recursive: true, force: true });
  renameSync(next, dir);
  return cvTemplateInfo(dir);
}

export function resetCvTemplate(dir: string): CvTemplateInfo {
  rmSync(dir, { recursive: true, force: true });
  return cvTemplateInfo(dir);
}

export function cvTemplateRpcs(
  dir: string | null,
): Pick<Impl, 'getCvTemplate' | 'setCvTemplate' | 'resetCvTemplate'> {
  const need = (): string => {
    if (!dir) throw new ConnectError('this daemon has no template folder', Code.FailedPrecondition);
    return dir;
  };
  return {
    getCvTemplate() {
      return { template: cvTemplateInfo(dir) };
    },
    setCvTemplate(req) {
      return { template: setCvTemplate(need(), req.files, req.name ?? null) };
    },
    resetCvTemplate() {
      return { template: resetCvTemplate(need()) };
    },
  };
}
