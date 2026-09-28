// Secrets are write-only over RPC: names can be listed, values are never returned.
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import type { ApplyantService } from '../gen/applyant/v1/applyant_pb.js';
import { assertSecretName, type Secrets } from '../secrets/secrets.ts';

type Impl = ServiceImpl<typeof ApplyantService>;

function validName(name: string): string {
  try {
    assertSecretName(name);
  } catch (err) {
    throw new ConnectError((err as Error).message, Code.InvalidArgument);
  }
  return name;
}

export function secretRpcs(
  secrets: Secrets,
): Pick<Impl, 'setSecret' | 'deleteSecret' | 'listSecrets'> {
  return {
    async setSecret(req) {
      if (req.value === '') throw new ConnectError('secret value is empty', Code.InvalidArgument);
      await secrets.set(validName(req.name), req.value);
      return {};
    },
    async deleteSecret(req) {
      return { deleted: await secrets.delete(validName(req.name)) };
    },
    async listSecrets() {
      return { names: await secrets.list() };
    },
  };
}
