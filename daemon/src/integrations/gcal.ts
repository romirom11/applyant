// Google Calendar (phase 13): an interview invite becomes an event on the candidate's primary
// calendar, linked to the application and the company. The Google consent that connected Gmail
// already includes `calendar.events`. Plain fetch over the two endpoints needed, like gmail.ts.
//
//   insert   POST /calendars/primary/events with our own event id
//   exists   409 → GET that id: the event is already there (or was deleted by the candidate,
//            status "cancelled": it is never made again)
//
// The event id is derived from the email (eventIdFor), so a re-sync, a retried task or a
// second assignment of the same email can never make a second event.
import { createHash } from 'node:crypto';
import type { EmailInvite, EventTime } from '../db/schema.ts';
import type { GoogleAuth } from './google-oauth.ts';

export const GCAL_API = 'https://www.googleapis.com/calendar/v3';

type FetchFn = typeof fetch;

export class CalendarError extends Error {}

export interface CalendarEvent {
  id: string;
  summary: string;
  description: string;
  location: string | null;
  start: EventTime;
  end: EventTime;
  /** What links the event back: the application, the company, the email. */
  links: { applicationId: number; company: string | null; emailId: number };
}

export interface CalendarResult {
  id: string;
  link: string | null;
  /** false: it was there already (from an earlier sync or attempt). */
  created: boolean;
  /** The candidate deleted it from their calendar. */
  cancelled: boolean;
}

export interface Calendar {
  upsertEvent(ev: CalendarEvent, signal?: AbortSignal): Promise<CalendarResult>;
}

/** Google's event ids are base32hex (0-9, a-v), 5–1024 characters: `ap` + sha256 hex. */
export function eventIdFor(key: string): string {
  return `ap${createHash('sha256').update(`applyant:${key}`).digest('hex').slice(0, 40)}`;
}

export class GoogleCalendar implements Calendar {
  private readonly o: {
    auth: Pick<GoogleAuth, 'accessToken'>;
    api: string;
    fetch: FetchFn;
    calendarId: string;
  };

  constructor(o: {
    auth: Pick<GoogleAuth, 'accessToken'>;
    api?: string;
    fetch?: FetchFn;
    calendarId?: string;
  }) {
    this.o = {
      auth: o.auth,
      api: o.api ?? GCAL_API,
      fetch: o.fetch ?? fetch,
      calendarId: o.calendarId ?? 'primary',
    };
  }

  private async call<T>(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<{ status: number; json: T }> {
    const token = await this.o.auth.accessToken();
    const res = await this.o.fetch(`${this.o.api}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => ({}))) as T;
    if (!res.ok && res.status !== 409) {
      const msg = (json as { error?: { message?: string } }).error?.message;
      throw new CalendarError(
        `Google Calendar ${init.method ?? 'GET'}: HTTP ${res.status}${msg ? ` ${msg}` : ''}`,
      );
    }
    return { status: res.status, json };
  }

  async upsertEvent(ev: CalendarEvent, signal?: AbortSignal): Promise<CalendarResult> {
    const base = `/calendars/${encodeURIComponent(this.o.calendarId)}/events`;
    const body = {
      id: ev.id,
      summary: ev.summary,
      description: ev.description,
      ...(ev.location ? { location: ev.location } : {}),
      start: ev.start,
      end: ev.end,
      extendedProperties: {
        private: {
          applyantApplicationId: String(ev.links.applicationId),
          applyantEmailId: String(ev.links.emailId),
          ...(ev.links.company ? { applyantCompany: ev.links.company } : {}),
        },
      },
      reminders: { useDefault: true },
    };
    const { status, json } = await this.call<{ id?: string; htmlLink?: string }>(
      base,
      { method: 'POST', body: JSON.stringify(body) },
      signal,
    );
    if (status !== 409) {
      return { id: json.id ?? ev.id, link: json.htmlLink ?? null, created: true, cancelled: false };
    }
    const existing = await this.call<{ id?: string; htmlLink?: string; status?: string }>(
      `${base}/${encodeURIComponent(ev.id)}`,
      { method: 'GET' },
      signal,
    );
    return {
      id: ev.id,
      link: existing.json.htmlLink ?? null,
      created: false,
      cancelled: existing.json.status === 'cancelled',
    };
  }
}

// ---- invites (.ics) ------------------------------------------------------------------------

/** Unfolded `NAME;PARAMS:value` lines of the first VEVENT, or null when there's none. */
function veventLines(
  ics: string,
): Array<{ name: string; params: Record<string, string>; value: string }> | null {
  const lines = ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toUpperCase() === 'BEGIN:VEVENT');
  if (start < 0) return null;
  const out: Array<{ name: string; params: Record<string, string>; value: string }> = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().toUpperCase() === 'END:VEVENT') break;
    const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    if (colon < 0) continue;
    const [name = '', ...rawParams] = line.slice(0, colon).split(';');
    const params: Record<string, string> = {};
    for (const p of rawParams) {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    }
    out.push({ name: name.toUpperCase(), params, value: line.slice(colon + 1) });
  }
  return out;
}

function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, '\n')
    .replace(/\\([,;\\])/g, '$1')
    .trim();
}

/** 20261007T140000Z · 20261007T140000 (+TZID) · 20261007 (VALUE=DATE) → a Calendar time. */
function eventTime(value: string, params: Record<string, string>): EventTime | null {
  const d = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (d || params.VALUE === 'DATE') {
    if (!d) return null;
    return { date: `${d[1]}-${d[2]}-${d[3]}` };
  }
  const t = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!t) return null;
  const local = `${t[1]}-${t[2]}-${t[3]}T${t[4]}:${t[5]}:${t[6]}`;
  if (t[7]) return { dateTime: `${local}Z` };
  // Google takes an IANA zone; Outlook's Windows names ("W. Europe Standard Time") it doesn't.
  const tz = params.TZID;
  if (tz && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$|^UTC$/.test(tz))
    return { dateTime: local, timeZone: tz };
  return null;
}

/** The time, place and title of a calendar invite; null for a cancellation or no usable time. */
export function parseInvite(ics: string | null | undefined): EmailInvite | null {
  if (!ics) return null;
  if (/^METHOD:CANCEL/im.test(ics)) return null;
  const lines = veventLines(ics);
  if (!lines) return null;
  const get = (n: string) => lines.find((l) => l.name === n);
  const dtStart = get('DTSTART');
  if (!dtStart) return null;
  const start = eventTime(dtStart.value, dtStart.params);
  if (!start) return null;
  const dtEnd = get('DTEND');
  let end = dtEnd ? eventTime(dtEnd.value, dtEnd.params) : null;
  if (!end) {
    // No end (or one we can't read): an hour, or the one day.
    if (start.date) {
      const next = new Date(`${start.date}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      end = { date: next.toISOString().slice(0, 10) };
    } else {
      const z = start.dateTime?.endsWith('Z');
      const t = new Date(z ? (start.dateTime as string) : `${start.dateTime}Z`);
      t.setUTCHours(t.getUTCHours() + 1);
      const iso = t.toISOString().slice(0, 19);
      end = z
        ? { dateTime: `${iso}Z` }
        : { dateTime: iso, ...(start.timeZone ? { timeZone: start.timeZone } : {}) };
    }
  }
  const summary = get('SUMMARY');
  const location = get('LOCATION');
  const uid = get('UID');
  return {
    start,
    end,
    summary: summary ? unescapeText(summary.value) || null : null,
    location: location ? unescapeText(location.value) || null : null,
    uid: uid?.value.trim() || null,
  };
}
