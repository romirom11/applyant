// Model role RPCs: which provider and model answer each role (`applyant config roles`).
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import {
  type ApplyantService,
  type RoleRoute,
  RoleRouteSchema,
} from '../gen/applyant/v1/applyant_pb.js';
import {
  describeRoute,
  listRoles,
  RoleRoutingError,
  type RoleView,
  resetRoleRoutes,
  setRoleRoute,
} from '../models/roles.ts';
import { runInTx } from '../queue/tx.ts';
import type { RpcContext } from './postings.ts';

type Impl = ServiceImpl<typeof ApplyantService>;

export function roleToPb(v: RoleView): RoleRoute {
  return create(RoleRouteSchema, {
    role: v.role,
    route: describeRoute(v.route),
    defaultRoute: describeRoute(v.default),
    overridden: v.overridden,
    fallback: v.fallback ? describeRoute(v.fallback) : undefined,
    description: v.info,
  });
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RoleRoutingError) {
      throw new ConnectError(
        err.message,
        /^unknown role/.test(err.message) ? Code.NotFound : Code.InvalidArgument,
      );
    }
    throw err;
  }
}

export function configRpcs(c: RpcContext): Pick<Impl, 'listRoles' | 'setRole' | 'resetRoles'> {
  return {
    listRoles() {
      return { roles: listRoles(c.db).map(roleToPb) };
    },
    setRole(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => ({
          role: roleToPb(setRoleRoute(tx.db, req.role.trim(), req.route, tx.now)),
        })),
      );
    },
    resetRoles(req) {
      return guard(() =>
        runInTx(c.db, c.bus, { now: c.now() }, (tx) => ({
          roles: resetRoleRoutes(tx.db, req.role?.trim() || null),
        })),
      );
    },
  };
}
