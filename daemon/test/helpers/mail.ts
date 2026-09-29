// A scripted mailbox for tests: sync returns the messages the test put in (after the cursor, or
// since the date window), send records what would have gone out.

import type { MailAccess } from '../../src/integrations/mail-service.ts';
import type {
  Cursor,
  Mailbox,
  MailMessage,
  OutgoingMessage,
  SentReceipt,
  SyncOptions,
} from '../../src/integrations/mailbox.ts';
import { composeMessage } from '../../src/integrations/mailbox.ts';
import { EventBus } from '../../src/queue/events.ts';

export class FakeMailbox implements Mailbox {
  readonly address: string;
  readonly messages: MailMessage[] = [];
  readonly sent: OutgoingMessage[] = [];
  syncs = 0;
  /** Called before each sync (tests add a message "arriving" mid-wait here). */
  onSync: ((n: number) => void) | null = null;

  constructor(address = 'me@example.org') {
    this.address = address;
  }

  add(
    m: Partial<MailMessage> & Pick<MailMessage, 'fromAddress' | 'subject' | 'text'>,
  ): MailMessage {
    const msg: MailMessage = {
      key: String(this.messages.length + 1),
      messageId: `<m${this.messages.length + 1}@test>`,
      inReplyTo: null,
      references: [],
      fromName: null,
      to: [this.address],
      date: new Date(),
      ...m,
    };
    this.messages.push(msg);
    return msg;
  }

  async sync(cursor: Cursor, o: SyncOptions): Promise<{ messages: MailMessage[]; next: Cursor }> {
    this.onSync?.(++this.syncs);
    const after = cursor ? Number(cursor) : 0;
    const messages = this.messages.filter((m, i) =>
      cursor ? i + 1 > after : m.date.getTime() >= o.since.getTime(),
    );
    return { messages, next: String(this.messages.length) };
  }

  async send(msg: OutgoingMessage): Promise<SentReceipt> {
    this.sent.push(msg);
    const { raw, messageId } = await composeMessage(this.address, msg);
    return { messageId, raw, accepted: [msg.to] };
  }
}

export function fakeMail(box: Mailbox | null, o: Partial<MailAccess> = {}): MailAccess {
  return {
    open: async () => box,
    sinceDays: 7,
    codeTimeoutMs: 2_000,
    codePollMs: 50,
    ...o,
  };
}

export const newBus = () => new EventBus();
