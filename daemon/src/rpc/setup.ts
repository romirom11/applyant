// GetSetupStatus: can this daemon do its work here? Agent CLIs, the native helper, secrets, and
// (phase 16) the onboarding: the connections, the setup steps, the import's progress and
// whether search has started. SetSetupStep records a step; GetPreferencesDraft pre-fills
// Preferences from the imported CV.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import type { Conn } from '../db/client.ts';
import { getIdentities } from '../domain/knowledge/profile.ts';
import { preferencesDraft } from '../domain/setup/prefs-draft.ts';
import {
  importProgress,
  listSetupSteps,
  parseStep,
  SetupError,
  searchStarted,
  setSetupStep,
  setupDone,
} from '../domain/setup/steps.ts';
import {
  type ApplyantService,
  type Connection,
  ConnectionSchema,
  ImportProgressSchema,
  PreferenceSuggestionSchema,
  type SetupStatus,
  SetupStatusSchema,
  SetupStepSchema,
  type ToolStatus,
  ToolStatusSchema,
} from '../gen/applyant/v1/applyant_pb.js';
import { TELEGRAM_ACCOUNT_SECRET, TELEGRAM_SESSION_SECRET } from '../integrations/gramjs.ts';
import { currentMailbox } from '../integrations/mail-service.ts';
import type { CliStatus, ToolCheck } from '../models/cli-status.ts';
import { JEV_SECRET } from '../models/providers/jev.ts';
import type { NativeHelper } from '../native/client.ts';
import { runInTx } from '../queue/tx.ts';
import type { Secrets } from '../secrets/secrets.ts';
import type { RpcContext } from './postings.ts';

type Impl = ServiceImpl<typeof ApplyantService>;

export interface SetupContext {
  cli: CliStatus;
  native: NativeHelper;
  secrets: Secrets;
  home: string;
  startedAt: Date;
}

/** The CapMonster key's name in Secrets (phase 14). */
const CAPTCHA_SECRET = 'capmonster';

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

const conn = (connected: boolean, detail: string): Connection =>
  create(ConnectionSchema, { connected, detail });

/** The connections onboarding's first step lists, each with what it is or what it's for. */
async function connections(db: Conn, secrets: Secrets) {
  // Which secrets are stored is all this needs: names only, never the values (the Telegram
  // account's label aside, once a session exists).
  const stored = new Set(await secrets.list());
  const jev = stored.has(JEV_SECRET);
  const telegram = stored.has(TELEGRAM_SESSION_SECRET);
  const captcha = stored.has(CAPTCHA_SECRET);
  const account =
    telegram && stored.has(TELEGRAM_ACCOUNT_SECRET)
      ? await secrets.get(TELEGRAM_ACCOUNT_SECRET)
      : null;
  const logins = getIdentities(db).logins;
  const box = currentMailbox(db);
  const google = box?.kind === 'gmail' && box.status === 'connected';
  const mailbox =
    box?.status === 'connected'
      ? conn(true, `${box.address} (${box.kind === 'gmail' ? 'Gmail' : 'IMAP'})`)
      : box?.status === 'connecting'
        ? conn(false, 'waiting for Google consent in the browser')
        : box?.status === 'failed'
          ? conn(false, `failed: ${box.note ?? 'unknown error'}`)
          : conn(
              false,
              'Without it, replies don’t move applications and email applications can’t be sent',
            );
  const googleOnly = (what: string) =>
    google
      ? conn(true, `through ${box?.address}`)
      : conn(
          false,
          `Needs a Google mailbox (one consent covers Gmail, Calendar and Drive): ${what}`,
        );
  return {
    jev: jev
      ? conn(true, 'key stored')
      : conn(
          false,
          'Without it, small decisions (form fields, liveness) use claude:haiku and your subscription',
        ),
    github: logins.length
      ? conn(true, logins.join(', '))
      : conn(false, 'Without your login, no commit counts as your own work'),
    mailbox,
    calendar: googleOnly('interview invites become calendar events'),
    drive: googleOnly('Docs and Drive files as knowledge sources'),
    telegram: telegram
      ? conn(true, account ?? 'connected')
      : conn(
          false,
          'Public channels work without it; private ones and Telegram applications need it',
        ),
    captcha: captcha
      ? conn(true, 'CapMonster key stored')
      : conn(false, 'Without a CapMonster key, captchas go to you'),
  };
}

export async function setupStatus(
  o: SetupContext & { db?: Conn | undefined },
  refresh = false,
): Promise<SetupStatus> {
  const [checks, native] = await Promise.all([o.cli.check(refresh), o.native.ping()]);
  const status = create(SetupStatusSchema, {
    claude: toolToPb(checks.tools.claude),
    codex: toolToPb(checks.tools.codex),
    nativeHelper: native,
    secretsBackend: o.secrets.backend,
    pid: BigInt(process.pid),
    home: o.home,
    startedAt: timestampFromDate(o.startedAt),
    checkedAt: timestampFromDate(checks.checkedAt),
  });
  if (!o.db) return status;
  Object.assign(status, await connections(o.db, o.secrets));
  status.steps = listSetupSteps(o.db).map((s) =>
    create(SetupStepSchema, {
      step: s.step,
      state: s.state,
      ...(s.updatedAt ? { updatedAt: timestampFromDate(s.updatedAt) } : {}),
    }),
  );
  status.import = create(ImportProgressSchema, importProgress(o.db));
  status.searchStarted = searchStarted(o.db);
  status.setupDone = setupDone(o.db);
  return status;
}

export function setupRpcs(
  o: SetupContext & Partial<RpcContext>,
): Pick<Impl, 'getSetupStatus' | 'setSetupStep' | 'getPreferencesDraft'> {
  const need = (): RpcContext => {
    if (!o.db || !o.bus || !o.now) throw new ConnectError('no database', Code.Unavailable);
    return { db: o.db, bus: o.bus, now: o.now };
  };
  return {
    async getSetupStatus(req) {
      return { status: await setupStatus(o, req.refresh) };
    },

    async setSetupStep(req) {
      const c = need();
      let planId: number | null;
      try {
        const { step, state } = parseStep(req.step, req.state);
        planId = runInTx(c.db, c.bus, { now: c.now() }, (tx) => setSetupStep(tx, step, state));
      } catch (err) {
        if (err instanceof SetupError) throw new ConnectError(err.message, Code.InvalidArgument);
        throw err;
      }
      return { status: await setupStatus(o), planId: BigInt(planId ?? 0) };
    },

    getPreferencesDraft() {
      const c = need();
      return {
        suggestions: preferencesDraft(c.db).map((s) =>
          create(PreferenceSuggestionSchema, {
            key: s.key,
            value: s.value,
            reason: s.reason,
            factIds: s.factIds.map(BigInt),
          }),
        ),
      };
    },
  };
}
