// Subscription limits pause a provider, not the system. The CLIs say so in text
// ("You've hit your session limit · resets 3:45pm"; Codex: "You've hit your usage limit …
// try again at 3:45 PM" or "… try again in 2 hours 5 minutes") and, for Claude, in a
// `rate_limit_event` with the reset time. Either becomes `pause_provider` until the reset.

/** When the reset time can't be read, check again after this long. */
export const UNKNOWN_RESET_MS = 30 * 60_000;

const LIMIT_TEXT = [
  /\bhit your (?:[\w-]+\s+)?limit\b/i,
  /\busage limit reached\b/i,
  /\b(?:5-hour|five-hour|weekly|session) limit reached\b/i,
  /\byou've reached your (?:usage )?limit\b/i,
];

/** Server-side throttling is retried by the CLI itself and is explicitly not a quota. */
const NOT_A_LIMIT = /not your usage limit/i;

export function isLimitMessage(text: string): boolean {
  if (NOT_A_LIMIT.test(text)) return false;
  return LIMIT_TEXT.some((re) => re.test(text));
}

export interface LimitHit {
  resetsAt: Date;
  /** False when the reset time was not stated and UNKNOWN_RESET_MS was used. */
  exact: boolean;
  message: string;
}

/** Recognises a limit message and works out when it resets. Null when `text` isn't one. */
export function parseLimitMessage(text: string, now: Date): LimitHit | null {
  if (!isLimitMessage(text)) return null;
  const message = text.trim().split('\n')[0]?.slice(0, 300) ?? '';
  const resetsAt = parseResetTime(text, now);
  return resetsAt
    ? { resetsAt, exact: true, message }
    : { resetsAt: new Date(now.getTime() + UNKNOWN_RESET_MS), exact: false, message };
}

/** A `rate_limit_event` reset stamp: epoch seconds or milliseconds. */
export function resetFromEpoch(value: number): Date {
  return new Date(value < 1e12 ? value * 1000 : value);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface Clock {
  hour: number;
  minute: number;
}

function parseClock(expr: string): Clock | null {
  const m =
    /(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?m\.?\b/i.exec(expr) ??
    /\b(\d{1,2})[:.](\d{2})\b/.exec(expr);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'p' && hour < 12) hour += 12;
  if (ampm === 'a' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Offset of `tz` from UTC at instant `at`, in ms (positive east of UTC). */
function tzOffsetMs(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - (at - (at % 1000));
}

function validZone(tz: string | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** Wall-clock parts of `at` in `tz` (or local time when tz is null). */
function wallParts(at: Date, tz: string | null) {
  if (!tz) {
    return { y: at.getFullYear(), mo: at.getMonth(), d: at.getDate(), dow: at.getDay() };
  }
  const shifted = new Date(at.getTime() + tzOffsetMs(at.getTime(), tz));
  return {
    y: shifted.getUTCFullYear(),
    mo: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    dow: shifted.getUTCDay(),
  };
}

/** The instant of a wall-clock time in `tz` (local time when tz is null). */
function fromWall(y: number, mo: number, d: number, c: Clock, tz: string | null): Date {
  if (!tz) return new Date(y, mo, d, c.hour, c.minute, 0, 0);
  const guess = Date.UTC(y, mo, d, c.hour, c.minute);
  const first = guess - tzOffsetMs(guess, tz);
  return new Date(guess - tzOffsetMs(first, tz));
}

const DURATION_UNITS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
};

/** "2 days 3 hours 5 minutes" · "45 min" · "1h 30m" → ms; null when there's no amount. */
function parseDuration(expr: string): number | null {
  let ms = 0;
  let any = false;
  for (const m of expr.matchAll(
    /(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b/gi,
  )) {
    const unit = DURATION_UNITS[(m[2] ?? '').toLowerCase()[0] ?? ''];
    if (!unit) continue;
    ms += Number(m[1]) * unit;
    any = true;
  }
  return any ? ms : null;
}

export function parseResetTime(text: string, now: Date): Date | null {
  // Older CLIs: "Claude AI usage limit reached|1759000000".
  const epoch = /\|(\d{10,13})\b/.exec(text);
  if (epoch?.[1]) return resetFromEpoch(Number(epoch[1]));

  // Codex: "… or try again in 2 days 3 hours."
  const within = /\btry again in\s+([^\n·|]+)/i.exec(text);
  if (within?.[1]) {
    const ms = parseDuration(within[1]);
    if (ms !== null) return new Date(now.getTime() + ms);
  }

  // Claude: "resets 3:45pm (Europe/Athens)"; Codex: "try again at Oct 3rd, 2026 5:43 PM".
  const m =
    /\b(?:resets?|try again)\s+(?:at\s+|on\s+)?([^\n·|]+?)(?:\s*\(([^)]+)\))?\s*(?:[.·|]|$)/im.exec(
      text,
    );
  if (!m?.[1]) return null;
  const expr = m[1].trim();
  const tz = validZone(m[2]?.trim());
  const clock = parseClock(expr) ?? { hour: 0, minute: 0 };
  const today = wallParts(now, tz);

  const month = new RegExp(
    `\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
    'i',
  ).exec(expr);
  if (month?.[1] && month[2]) {
    const mo = MONTHS.indexOf(month[1].toLowerCase().slice(0, 3));
    let at = fromWall(today.y, mo, Number(month[2]), clock, tz);
    if (at.getTime() < now.getTime() - 86_400_000)
      at = fromWall(today.y + 1, mo, Number(month[2]), clock, tz);
    return at;
  }

  const day = new RegExp(`\\b(${DAYS.join('|')})[a-z]*\\b`, 'i').exec(expr);
  if (day?.[1]) {
    const target = DAYS.indexOf(day[1].toLowerCase().slice(0, 3));
    let ahead = (target - today.dow + 7) % 7;
    let at = fromWall(today.y, today.mo, today.d + ahead, clock, tz);
    if (at.getTime() <= now.getTime()) {
      ahead += 7;
      at = fromWall(today.y, today.mo, today.d + ahead, clock, tz);
    }
    return at;
  }

  if (!parseClock(expr)) return null;
  let at = fromWall(today.y, today.mo, today.d, clock, tz);
  if (at.getTime() <= now.getTime()) at = fromWall(today.y, today.mo, today.d + 1, clock, tz);
  return at;
}
