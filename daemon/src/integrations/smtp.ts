// Sending through SMTP (every mailbox that isn't a Google account): nodemailer, with the
// mailbox's app password from `Secrets`. The message is composed once (composeMessage) and
// sent as is, so what the receipt keeps is byte for byte what went out.
import { createTransport } from 'nodemailer';
import { composeMessage, type OutgoingMessage, type SentReceipt } from './mailbox.ts';

export interface SmtpOptions {
  host: string;
  port: number;
  /** TLS from the start (465); otherwise STARTTLS when the server offers it. */
  secure: boolean;
  user: string;
  password: string;
  /** Tests only: accept a self-signed certificate. */
  allowSelfSigned?: boolean;
}

export async function smtpSend(
  o: SmtpOptions,
  from: string,
  msg: OutgoingMessage,
): Promise<SentReceipt> {
  const { raw, messageId } = await composeMessage(from, msg);
  const transport = createTransport({
    host: o.host,
    port: o.port,
    secure: o.secure,
    auth: { user: o.user, pass: o.password },
    ...(o.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
    connectionTimeout: 30_000,
    socketTimeout: 60_000,
  });
  try {
    const info = await transport.sendMail({ envelope: { from, to: [msg.to] }, raw });
    const accepted = ((info.accepted ?? []) as unknown[]).map((a) =>
      typeof a === 'string' ? a : String((a as { address?: string }).address ?? ''),
    );
    return { messageId, raw, accepted };
  } finally {
    transport.close();
  }
}
