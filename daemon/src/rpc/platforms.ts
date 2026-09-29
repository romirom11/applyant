// Guarded platforms (phase 14): caps, resume after a challenge, the sign-in window, and whether
// a captcha solver is set up. validate → domain → proto.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import type { Guardrails, PlatformKey, PlatformStatus } from '../browser/guardrails.ts';
import { type LoginWindow, LoginWindowError } from '../browser/login-window.ts';
import { PLATFORM_KEYS } from '../db/schema.ts';
import {
  type ApplyantService,
  type Platform,
  PlatformSchema,
} from '../gen/applyant/v1/applyant_pb.js';

type Impl = ServiceImpl<typeof ApplyantService>;

export interface PlatformServices {
  guardrails: Guardrails;
  login: LoginWindow;
  /** Whether a CapMonster key is stored. */
  captchaConfigured(): Promise<boolean>;
}

export function platformToPb(s: PlatformStatus): Platform {
  return create(PlatformSchema, {
    platform: s.platform,
    name: s.name,
    searchesPerDay: s.searchesPerDay,
    applicationsPerDay: s.applicationsPerDay,
    searchesToday: s.searchesToday,
    applicationsToday: s.applicationsToday,
    ...(s.pausedAt ? { pausedAt: timestampFromDate(s.pausedAt) } : {}),
    ...(s.pauseReason ? { pauseReason: s.pauseReason } : {}),
    ...(s.signedInAt ? { signedInAt: timestampFromDate(s.signedInAt) } : {}),
  });
}

function platformKey(raw: string): PlatformKey {
  const key = raw.trim().toLowerCase();
  if (!(PLATFORM_KEYS as readonly string[]).includes(key)) {
    throw new ConnectError(
      `unknown platform "${raw}": use ${PLATFORM_KEYS.join(' or ')}`,
      Code.InvalidArgument,
    );
  }
  return key as PlatformKey;
}

function cap(n: number | undefined, what: string): number | undefined {
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < 0 || n > 500) {
    throw new ConnectError(`${what} must be a whole number from 0 to 500`, Code.InvalidArgument);
  }
  return n;
}

export function platformRpcs(
  p: PlatformServices | null,
): Pick<Impl, 'listPlatforms' | 'setPlatformCaps' | 'resumePlatform' | 'signIn'> {
  const need = (): PlatformServices => {
    if (!p) throw new ConnectError('platforms are not available here', Code.Unavailable);
    return p;
  };
  return {
    async listPlatforms() {
      const s = need();
      const open = s.login.openFor();
      return {
        platforms: s.guardrails.list().map(platformToPb),
        captchaSolver: await s.captchaConfigured().catch(() => false),
        ...(open ? { signInOpen: open.url } : {}),
      };
    },
    setPlatformCaps(req) {
      const s = need();
      const key = platformKey(req.platform);
      const searches = cap(req.searchesPerDay, 'searches per day');
      const applications = cap(req.applicationsPerDay, 'applications per day');
      return {
        platform: platformToPb(
          s.guardrails.setCaps(key, {
            ...(searches !== undefined ? { searches } : {}),
            ...(applications !== undefined ? { applications } : {}),
          }),
        ),
      };
    },
    resumePlatform(req) {
      const s = need();
      return { platform: platformToPb(s.guardrails.resume(platformKey(req.platform))) };
    },
    async signIn(req) {
      const s = need();
      if (!req.target.trim()) {
        throw new ConnectError('sign in where? give linkedin, xing or a URL', Code.InvalidArgument);
      }
      try {
        const t = await s.login.open(req.target, { force: req.force });
        return { url: t.url, ...(t.platform ? { platform: t.platform } : {}) };
      } catch (err) {
        if (err instanceof LoginWindowError) {
          throw new ConnectError(err.message, Code.FailedPrecondition);
        }
        if (err instanceof Error && /^sign in where\?/.test(err.message)) {
          throw new ConnectError(err.message, Code.InvalidArgument);
        }
        throw err;
      }
    },
  };
}
