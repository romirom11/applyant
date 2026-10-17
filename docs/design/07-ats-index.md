# 07 — The ATS index: search every company, not a watch list

## Why

Greenhouse, Ashby and Lever have no search across companies: their public APIs list one
company's board by its token. Applyant read only the boards on its watch list (34 on
2026-10-18, capped at 200 because every strategy read every board on every run), so a search
for "AI Engineer" saw 34 companies. Jobs on company boards are the ones the job boards don't
carry: of 238 postings found on company boards, 188 (79%) never showed up on any board read.

Web search (`site:` queries) and paid aggregators are out: results go stale, arrive late in the
index, and cost money.

## What

1. **The index** (`ats_companies`, `ats_jobs`): every company board Applyant knows on the ATSs,
   each read on its own schedule into a local store of its open jobs.
2. **Discovery** (`index_discover`, weekly and on demand): finds boards in Common Crawl's URL
   index (CDX API: free, robots-respecting, a month of the web per crawl), behind postings and
   their apply links, in the planner's results and in the Workable/SmartRecruiters job searches.
3. **The crawler** (`index_crawl`, every few minutes): reads the boards that are due, a budget
   per ATS per tick, politely paced; the list endpoints are the light ones (Greenhouse without
   `content=true`). How soon a board is read again depends on what it holds:

   | board                                   | read again |
   |-----------------------------------------|------------|
   | has jobs an active strategy matches     | 6 h        |
   | hiring, nothing matching                | 24 h       |
   | empty                                   | 3 days     |
   | failing                                 | 1 day × 2^fails, at most 14 days |
   | gone (404/410)                          | 30 days    |

4. **Search over the index**: the built-in source `board:ats-index`. A strategy run asks the
   local store for the open jobs its queries and locations match (no network), each listing
   carrying its board and company. Partial (it's a search), so absence doesn't close through
   it; the crawler's complete board reads do: a job gone from its board closes (or re-verifies)
   the postings linked through the index, by the same rules as absence.ts.
5. **The kind switches apply to the index**: "Greenhouse off" means its boards are neither read
   nor searched. The candidate can also leave single companies out.
6. **More ATSs** for DACH and the rest of Europe: Personio (`<co>.jobs.personio.de/xml`),
   Recruitee (`<co>.recruitee.com/api/offers/`), Teamtailor (`<co>.teamtailor.com/jobs.json`),
   JOIN, Breezy, as source kinds, in career-page detection and in the index.
7. **A Sources screen** in the app: every source grouped (the index per ATS with its companies,
   the cross-company job searches, watched companies, career pages and feeds, job boards,
   Telegram, LinkedIn and Xing), each with its switch.

The watch list stays for the candidate's own boards; boards found by matched jobs and by the
planner join the index instead (hot: read every 6 h from the start).

## Contract

`proto/applyant/v1/applyant.proto`: `GetAtsIndex`, `ListIndexCompanies`,
`SetIndexCompanyEnabled`, `DiscoverIndexCompanies` and their messages.
