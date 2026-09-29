// Emailed security codes (Greenhouse sends an 8-character one to "suspicious" submissions).
// When delivery meets a code field after pressing submit, it reads the code from the connected
// mailbox: new mail since just before the submission, newest first, polled until it arrives.
import type { Mailbox, MailMessage } from '../../integrations/mailbox.ts';

const CODE_WORDS =
  /(security|verification|confirmation|one[- ]time|access)\s*(code|pin)|\bcode\b|\botp\b/i;

/**
 * The code in an email, or null. Looks for a 4–10 character token of letters and digits right
 * after a code phrase ("security code: AB12CD34", "paste this code …: AB12CD34"), or a line
 * that holds nothing but such a token when the email talks about a code.
 */
export function extractSecurityCode(msg: Pick<MailMessage, 'subject' | 'text'>): string | null {
  const text = `${msg.subject}\n${msg.text}`;
  if (!CODE_WORDS.test(text)) return null;
  // A digit in it, or all capitals (6+): ordinary words never pass for a code.
  const token = (t: string) =>
    /^[A-Za-z0-9]{4,10}$/.test(t) && (/\d/.test(t) || /^[A-Z]{6,10}$/.test(t));
  // "code … : TOKEN" on the same line (or the next one).
  const near =
    /(?:code|pin|otp)\b[^\n]{0,120}?[:\s]\s*\n?\s*([A-Za-z0-9]{4,10})\s*(?:$|[\s.,)])/gim;
  for (const m of text.matchAll(near)) {
    const t = m[1] ?? '';
    if (token(t)) return t;
  }
  // A line that is only the code (the usual big bold code in the middle of the email).
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (token(t)) return t;
  }
  // Anywhere in the text: a 6–10 character mix of letters and digits ("Use AB12CD to continue").
  for (const m of text.matchAll(/\b([A-Za-z0-9]{6,10})\b/g)) {
    const t = m[1] ?? '';
    if (/\d/.test(t) && /[A-Za-z]/.test(t)) return t;
  }
  return null;
}

export interface WaitForCodeOptions {
  /** When the form was submitted; mail from a minute before counts (clocks differ). */
  since: Date;
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
  progress?(message: string): void;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Polls the mailbox for the code; null when it didn't come in time. */
export async function waitForSecurityCode(
  mailbox: Mailbox,
  o: WaitForCodeOptions,
): Promise<string | null> {
  const from = new Date(o.since.getTime() - 60_000);
  const deadline = Date.now() + o.timeoutMs;
  const sleep = o.sleep ?? defaultSleep;
  for (;;) {
    o.signal?.throwIfAborted();
    const { messages } = await mailbox.sync(null, {
      since: from,
      limit: 25,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    const fresh = messages
      .filter((m) => m.date.getTime() >= from.getTime())
      .sort((a, b) => b.date.getTime() - a.date.getTime());
    for (const m of fresh) {
      const code = extractSecurityCode(m);
      if (code) return code;
    }
    if (Date.now() + o.pollMs > deadline) return null;
    o.progress?.('waiting for the emailed security code');
    await sleep(o.pollMs, o.signal);
  }
}
