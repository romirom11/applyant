import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import type { Db } from '../db/client.ts';
import type { ChatMessageRow } from '../db/schema.ts';
import { clearChat, listChat, sendChat } from '../domain/knowledge/chat.ts';
import { type ApplyantService, ChatMessageSchema } from '../gen/applyant/v1/applyant_pb.js';
import type { AgentRunner } from '../models/agent-runner.ts';

type Impl = ServiceImpl<typeof ApplyantService>;

function messageToPb(row: ChatMessageRow) {
  return create(ChatMessageSchema, {
    id: BigInt(row.id),
    role: row.role,
    text: row.text,
    factIds: row.factIds.map(BigInt),
    createdAt: timestampFromDate(row.createdAt),
  });
}

export function chatRpcs(c: {
  db: Db;
  models: AgentRunner;
  now: () => Date;
}): Pick<Impl, 'listChat' | 'sendChat' | 'clearChat'> {
  let busy = false;
  return {
    listChat() {
      return { messages: listChat(c.db).map(messageToPb) };
    },
    clearChat() {
      if (busy)
        throw new ConnectError(
          'Wait for the current answer before clearing chat',
          Code.FailedPrecondition,
        );
      clearChat(c.db);
      return {};
    },
    async sendChat(req, ctx) {
      const text = req.text.trim();
      if (!text || text.length > 4000)
        throw new ConnectError('message must be 1–4000 characters', Code.InvalidArgument);
      if (busy)
        throw new ConnectError('A chat answer is already being written', Code.FailedPrecondition);
      busy = true;
      try {
        const result = await sendChat(c.db, c.models, text, ctx.signal, c.now);
        return { user: messageToPb(result.user), assistant: messageToPb(result.assistant) };
      } catch (err) {
        if (err instanceof ConnectError) throw err;
        throw new ConnectError(err instanceof Error ? err.message : String(err), Code.Unavailable);
      } finally {
        busy = false;
      }
    },
  };
}
