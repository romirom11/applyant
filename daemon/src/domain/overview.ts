// Overview: the funnel and the PRD's success metrics, from the job and application history the
// daemon keeps anyway (no product analytics). Pure reads over one connection.
//
//   funnel   postings first seen in the window, and how far each got: found → verified →
//            interested (shortlisted: an application, marked interested) → prepared → approved →
//            applied → interview → offer. Reached stages are kept (interview_at, offer_at), so a
//            later rejection doesn't erase an interview.
//   metrics  the four "done when" metrics (PRD) and the two watched funnel numbers:
//     1 live_forms           shortlisted postings whose form was read as live (a form, email or
//                            Telegram) of those read at all                        ≥ 95%
//     2 interested           shortlisted postings the candidate approved or marked interested,
//                            of those they decided on (skipped counts against)      ≥ 50%
//     3 review_time          median minutes from first opening an application for review
//                            (review_started_at) to approving it                    ≤ 15 min
//     4 unsupported_claims   sentences in sent answers that are still flagged, or cite a fact
//                            since rejected or deleted                              0
//     applications_per_week  applied in the window, per week
//     interview_rate         of those applied in the window, the share that reached interview
import { sql } from 'drizzle-orm';
import type { Conn } from '../db/client.ts';
import { getPreferences } from './scoring/prefs.ts';

export const OVERVIEW_WINDOWS = ['7d', '30d', 'all'] as const;
export type OverviewWindow = (typeof OVERVIEW_WINDOWS)[number];

const WINDOW_DAYS: Record<OverviewWindow, number | null> = { '7d': 7, '30d': 30, all: null };
const DAY_MS = 86_400_000;

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
}

export interface Ratio {
  numerator: number;
  denominator: number;
  ratio: number | null;
}

export interface Metric {
  key: string;
  label: string;
  definition: string;
  target: string;
  display: string;
  met: boolean | null;
  value: number | null;
  ratio: Ratio | null;
}

export interface Overview {
  window: OverviewWindow;
  since: Date | null;
  funnel: FunnelStep[];
  metrics: Metric[];
}

export function windowStart(window: OverviewWindow, now: Date): Date | null {
  const days = WINDOW_DAYS[window];
  return days === null ? null : new Date(now.getTime() - days * DAY_MS);
}

function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, ratio: denominator > 0 ? numerator / denominator : null };
}

const pct = (r: Ratio) =>
  r.ratio === null ? '—' : `${Math.round(r.ratio * 100)}% · ${r.numerator} of ${r.denominator}`;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** `col >= since`, or always true for all time. */
function inWindow(col: ReturnType<typeof sql.raw>, since: number | null) {
  return since === null ? sql`${col} IS NOT NULL` : sql`${col} >= ${since}`;
}

export function computeOverview(conn: Conn, window: OverviewWindow, now: Date): Overview {
  const sinceDate = windowStart(window, now);
  const since = sinceDate?.getTime() ?? null;
  const threshold = getPreferences(conn).threshold;

  // Shortlisted: put in front of the candidate as worth applying to.
  const shortlisted = sql`(a.id IS NOT NULL OR p.decision = 'interested' OR (p.score IS NOT NULL AND p.score >= ${threshold}))`;

  const f =
    conn.get<Record<string, number | null>>(sql`
    SELECT
      COUNT(*) AS found,
      SUM(CASE WHEN p.verified_at IS NOT NULL AND p.stage <> 'failed_verification' THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN a.id IS NOT NULL OR p.decision = 'interested' THEN 1 ELSE 0 END) AS interested,
      SUM(CASE WHEN a.prepared_at IS NOT NULL THEN 1 ELSE 0 END) AS prepared,
      SUM(CASE WHEN a.approved_at IS NOT NULL THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN a.applied_at IS NOT NULL THEN 1 ELSE 0 END) AS applied,
      SUM(CASE WHEN a.interview_at IS NOT NULL THEN 1 ELSE 0 END) AS interview,
      SUM(CASE WHEN a.offer_at IS NOT NULL THEN 1 ELSE 0 END) AS offer
    FROM postings p LEFT JOIN applications a ON a.posting_id = p.id
    WHERE ${inWindow(sql.raw('p.first_seen_at'), since)}
  `) ?? {};
  const n = (k: string) => Number(f[k] ?? 0);
  const funnel: FunnelStep[] = [
    ['found', 'Found'],
    ['verified', 'Verified'],
    ['interested', 'Interested'],
    ['prepared', 'Prepared'],
    ['approved', 'Approved'],
    ['applied', 'Applied'],
    ['interview', 'Interview'],
    ['offer', 'Offer'],
  ].map(([key, label]) => ({
    key: key as string,
    label: label as string,
    count: n(key as string),
  }));

  // 1. Live forms among shortlisted postings found in the window (unread forms don't count).
  const forms = conn.get<{ live: number | null; judged: number | null }>(sql`
    SELECT
      SUM(CASE WHEN p.form_status IN ('verified', 'email', 'telegram') THEN 1 ELSE 0 END) AS live,
      SUM(CASE WHEN p.form_status IS NOT NULL THEN 1 ELSE 0 END) AS judged
    FROM postings p LEFT JOIN applications a ON a.posting_id = p.id
    WHERE ${shortlisted} AND ${inWindow(sql.raw('p.first_seen_at'), since)}
  `);
  const live = ratio(Number(forms?.live ?? 0), Number(forms?.judged ?? 0));

  // 2. Interested rather than skipped, by when the candidate decided.
  const verdicts = conn.get<{ yes: number | null; decided: number | null }>(sql`
    SELECT
      SUM(CASE WHEN p.decision = 'skipped' THEN 0 ELSE 1 END) AS yes,
      COUNT(*) AS decided
    FROM postings p LEFT JOIN applications a ON a.posting_id = p.id
    WHERE ${shortlisted}
      AND (p.decision IS NOT NULL OR a.approved_at IS NOT NULL)
      AND ${inWindow(sql.raw('COALESCE(p.decided_at, a.approved_at)'), since)}
  `);
  const interested = ratio(Number(verdicts?.yes ?? 0), Number(verdicts?.decided ?? 0));

  // 3. Review time: first opened for review → approved.
  const reviews = conn
    .all<{ ms: number }>(sql`
    SELECT approved_at - review_started_at AS ms FROM applications
    WHERE review_started_at IS NOT NULL AND approved_at IS NOT NULL
      AND approved_at >= review_started_at
      AND ${inWindow(sql.raw('approved_at'), since)}
  `)
    .map((r) => r.ms / 60_000);
  const reviewMedian = median(reviews);

  // 4. Unsupported claims in what was sent.
  const claims = conn.get<{ bad: number | null }>(sql`
    SELECT COUNT(*) AS bad FROM answer_sentences s
    JOIN answers an ON an.id = s.answer_id
    JOIN applications a ON a.id = an.application_id
    WHERE a.applied_at IS NOT NULL AND ${inWindow(sql.raw('a.applied_at'), since)}
      AND (s.flag <> 'none' OR EXISTS (
        SELECT 1 FROM json_each(s.fact_ids_json) j LEFT JOIN facts fa ON fa.id = j.value
        WHERE fa.id IS NULL OR fa.status = 'rejected'))
  `);
  const unsupported = Number(claims?.bad ?? 0);
  const sentAnswers = conn.get<{ n: number | null }>(sql`
    SELECT COUNT(*) AS n FROM answer_sentences s
    JOIN answers an ON an.id = s.answer_id
    JOIN applications a ON a.id = an.application_id
    WHERE a.applied_at IS NOT NULL AND ${inWindow(sql.raw('a.applied_at'), since)}
  `);
  const sentSentences = Number(sentAnswers?.n ?? 0);
  // Claims the candidate corrected in review (their words became review_edit facts).
  const corrected = Number(
    conn.get<{ n: number | null }>(sql`
      SELECT COUNT(*) AS n FROM facts WHERE origin = 'review_edit'
        AND ${inWindow(sql.raw('created_at'), since)}
    `)?.n ?? 0,
  );

  // Applications per week and the interview rate, by when they were sent.
  const sent = conn.get<{ applied: number | null; interview: number | null; first: number | null }>(
    sql`
    SELECT COUNT(*) AS applied,
      SUM(CASE WHEN interview_at IS NOT NULL THEN 1 ELSE 0 END) AS interview,
      MIN(applied_at) AS first
    FROM applications WHERE applied_at IS NOT NULL AND ${inWindow(sql.raw('applied_at'), since)}
  `,
  );
  const applied = Number(sent?.applied ?? 0);
  const spanMs =
    since !== null ? now.getTime() - since : sent?.first ? now.getTime() - Number(sent.first) : 0;
  const weeks = Math.max(1, spanMs / (7 * DAY_MS));
  const perWeek = applied / weeks;
  const interviews = ratio(Number(sent?.interview ?? 0), applied);

  const metrics: Metric[] = [
    {
      key: 'live_forms',
      label: 'Shortlist has no dead postings',
      definition:
        'Shortlisted postings whose Apply leads to a live application form (a form, email or Telegram), of those whose form was read',
      target: '≥ 95%',
      display: pct(live),
      met: live.ratio === null ? null : live.ratio >= 0.95,
      value: live.ratio,
      ratio: live,
    },
    {
      key: 'interested',
      label: 'Shortlist is relevant',
      definition:
        'Shortlisted postings you approved or marked interested, of those you decided on (skips count against)',
      target: '≥ 50%',
      display: pct(interested),
      met: interested.ratio === null ? null : interested.ratio >= 0.5,
      value: interested.ratio,
      ratio: interested,
    },
    {
      key: 'review_time',
      label: 'An application takes little of your time',
      definition:
        'Median time from first opening an application for review to approving it (review plus edits)',
      target: '≤ 15 min',
      display:
        reviewMedian === null
          ? '—'
          : `${Math.round(reviewMedian)} min median · ${reviews.length} review${reviews.length === 1 ? '' : 's'}`,
      met: reviewMedian === null ? null : reviewMedian <= 15,
      value: reviewMedian,
      ratio: null,
    },
    {
      key: 'unsupported_claims',
      label: 'The agent never invents experience',
      definition:
        'Sentences in sent answers still flagged by the checks, or citing a fact since rejected as untrue',
      target: '0',
      display:
        sentSentences === 0 && unsupported === 0
          ? `— · ${corrected} corrected in review`
          : `${unsupported} of ${sentSentences} sent · ${corrected} corrected in review`,
      met: sentSentences === 0 ? null : unsupported === 0,
      value: unsupported,
      ratio: ratio(unsupported, sentSentences),
    },
    {
      key: 'applications_per_week',
      label: 'Applications per week',
      definition: 'Applications sent in the window, per week',
      target: '',
      display: `${perWeek.toFixed(1)} / week · ${applied} sent`,
      met: null,
      value: perWeek,
      ratio: null,
    },
    {
      key: 'interview_rate',
      label: 'Interview rate',
      definition: 'Applications sent in the window that reached an interview',
      target: '',
      display: pct(interviews),
      met: null,
      value: interviews.ratio,
      ratio: interviews,
    },
  ];
  return { window, since: sinceDate, funnel, metrics };
}
