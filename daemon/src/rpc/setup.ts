// GetSetupStatus: can this daemon do its work here? Agent CLIs, the native helper, secrets.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { ServiceImpl } from '@connectrpc/connect';
import {
  type ApplyantService,
  type SetupStatus,
  SetupStatusSchema,
  type ToolStatus,
  ToolStatusSchema,
} from '../gen/applyant/v1/applyant_pb.js';
import type { CliStatus, ToolCheck } from '../models/cli-status.ts';
import type { NativeHelper } from '../native/client.ts';
import type { Secrets } from '../secrets/secrets.ts';

type Impl = ServiceImpl<typeof ApplyantService>;

export interface SetupContext {
  cli: CliStatus;
  native: NativeHelper;
  secrets: Secrets;
  home: string;
  startedAt: Date;
}

function toolToPb(t: ToolCheck): ToolStatus {
  return create(ToolStatusSchema, {
    found: t.found,
    path: t.path ?? '',
    foundVia: t.via ?? '',
    version: t.version ?? '',
    signedIn: t.signedIn,
    error: t.error ?? '',
  });
}

export async function setupStatus(o: SetupContext, refresh = false): Promise<SetupStatus> {
  const [checks, native] = await Promise.all([o.cli.check(refresh), o.native.ping()]);
  return create(SetupStatusSchema, {
    claude: toolToPb(checks.tools.claude),
    codex: toolToPb(checks.tools.codex),
    nativeHelper: native,
    secretsBackend: o.secrets.backend,
    pid: BigInt(process.pid),
    home: o.home,
    startedAt: timestampFromDate(o.startedAt),
    checkedAt: timestampFromDate(checks.checkedAt),
  });
}

export function setupRpcs(o: SetupContext): Pick<Impl, 'getSetupStatus'> {
  return {
    async getSetupStatus(req) {
      return { status: await setupStatus(o, req.refresh) };
    },
  };
}
