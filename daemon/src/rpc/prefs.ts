// Preference RPCs: validate → domain → proto. Every change re-scores in the same transaction.
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import type { Conn } from '../db/client.ts';
import {
  getPreferences,
  PreferenceError,
  parsePreference,
  setPreference,
} from '../domain/scoring/prefs.ts';
import { rescoreAll, scoringContext } from '../domain/scoring/store.ts';
import {
  type ApplyantService,
  type Preferences as PbPreferences,
  PreferencesSchema,
} from '../gen/applyant/v1/applyant_pb.js';
import { runInTx } from '../queue/tx.ts';
import type { RpcContext } from './postings.ts';

type Impl = ServiceImpl<typeof ApplyantService>;

export function preferencesToPb(conn: Conn): PbPreferences {
  const { prefs, multipliers } = scoringContext(conn);
  return create(PreferencesSchema, {
    roles: prefs.roles,
    seniority: prefs.seniority,
    basedIn: prefs.basedIn ?? undefined,
    locations: prefs.locations,
    remote: prefs.remote,
    salary: prefs.salary ?? undefined,
    salaryFloor: prefs.salaryFloor ?? undefined,
    languages: prefs.languages,
    employment: prefs.employment,
    dealbreakers: prefs.dealbreakers,
    weights: prefs.weights,
    feedbackMultipliers: multipliers,
    threshold: prefs.threshold,
  });
}

export function prefsRpcs(c: RpcContext): Pick<Impl, 'getPreferences' | 'setPreference'> {
  return {
    getPreferences() {
      return { preferences: preferencesToPb(c.db) };
    },

    setPreference(req) {
      try {
        return runInTx(c.db, c.bus, { now: c.now() }, (tx) => {
          const parsed = parsePreference(req.key.trim(), req.value, getPreferences(tx.db));
          setPreference(tx.db, parsed.key, parsed.value, tx.now);
          const rescored = rescoreAll(tx.db, tx.now);
          return { preferences: preferencesToPb(tx.db), rescored };
        });
      } catch (err) {
        if (err instanceof PreferenceError)
          throw new ConnectError(err.message, Code.InvalidArgument);
        throw err;
      }
    },
  };
}
