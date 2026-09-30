# Gap audit: the implementation against the PRD and the TDD

Done on 2026-09-30, after all 16 phases of the plan were built. The plan (`05`) was derived from the PRD and the TDD, so phases being done doesn't prove the documents are covered. This audit read the PRD and the TDD directly and checked the code against them. The items below are the gaps; each gets ticked here when it's closed.

## Verdict

The daemon covers nearly all of the TDD, and the PRD's core loop can be used from the Mac app. The gaps are:

- nothing measures the PRD's four success metrics or the funnel;
- scores don't update when knowledge grows;
- several PRD actions still need the terminal or don't exist;
- much of the outside-world code has only run against fakes.

## Blocks everyday use

- [x] **Re-score when knowledge changes.** `score_posting` is queued only by verify, by startup for unscored postings, and by `ScorePostings` (which the app never calls). Postings scored before the CV/GitHub import or the interview keep their low scores and never prepare on their own. Needed: queue a re-match from the commits of `sync_source`, interview turns, confirm/edit fact and review edits, plus a "Re-score" action.
  - Done (2026-09-30): a new `rematch_postings` task (`daemon/src/domain/scoring/rematch.ts`). `requestRematch` is called after a `sync_source` commit that added or dropped facts, an interview turn that saved facts, EditFact / RejectFact (`rpc/candidate.ts`), review answer edits (`review.ts`) and CV line edits (`cv/store.ts`). A burst shares one queued sweep, which runs 30 s later and waits while `embed_facts` is pending. It re-runs retrieval for open postings only: verified or scored, not skipped or closed, and no application past review. Only postings with a match key their stored matches lack get `score_posting`, and those prepare on their own when they cross the threshold. Confirming a fact doesn't sweep, because status isn't part of a match key. In the app, "Re-score" on the posting detail, and "Re-score all" plus a per-row item in the Inbox, both call `ScorePostings`. Tests: `daemon/test/rematch.test.ts`, `app/Tests/ApplyantKitTests/OverviewTests.swift`.
- [x] **Correct a status by hand.** PRD: "Every status can be corrected by hand, in the app or from the CLI". There is no RPC, no CLI command and no app action. Needed: `SetApplicationStage`, `applyant applications status <id> <stage>`, and an action on the application.
  - Done (2026-09-30): the `SetApplicationStage` RPC, `applyant applications status <id> <stage>`, and a "Set status" menu on the review screen and on application rows (`app/Sources/Applyant/Views/Applications.swift`). The possible statuses are applied, interview, offer, rejected and a new `withdrawn`. Applied can be set from any stage, for an application sent outside Applyant or to undo a misread reply. Interview, offer, rejected and withdrawn can only be set once the application was sent. It refuses stages only the pipeline sets, the current stage, and any change while the application is being prepared or delivered, and says why (FailedPrecondition). The change is recorded as an `application.stage` event marked "(set by hand)", and nothing is delivered (`daemon/src/domain/applications/manual-stage.ts`). Posting statuses were already covered by SkipPosting / MarkInterested. Tests: `daemon/test/application-stage.test.ts`.

## Noticeable gaps

- [x] **Overview: the funnel and the four PRD metrics.** Nothing computes the dead-link rate, the interested rate, the review time, unsupported claims, applications per week or the interview rate. The Overview section is a placeholder.
  - Done (2026-09-30): `daemon/src/domain/overview.ts` computes the funnel (found → verified → interested → prepared → approved → applied → interview → offer) for postings first seen in the window. It also computes the four PRD metrics: live forms among the shortlisted, the interested rate, the median review time and unsupported claims in sent answers. Two watched numbers come with them: applications per week and the interview rate. The window is 7 days, 30 days or all time. The `GetOverview` RPC serves it, and `applyant overview [--window 7d|30d|all]` prints it.
  - Migration `0020_overview` adds `applications.review_started_at`, `interview_at` and `offer_at`, and backfills the last two from the stage events. `review_started_at` is set the first time GetApplication opens an application waiting for review.
  - The app's Overview section is built: a window picker, the funnel and metric cards (`app/Sources/Applyant/Views/Overview.swift`, `ApplyantKit/Overview.swift`). Tests: `daemon/test/overview.test.ts` and `OverviewTests.swift`.
- [ ] **Model roles in the app.** `ListRoles` / `SetRole` / `ResetRoles` exist, but only the CLI uses them. This also blocks the opt-in to classify email with a cloud model from Settings.
- [ ] **A facts browser.** `ListFacts` / `EditFact` / `RejectFact` aren't used by the app, so drafted facts can't be reviewed or rejected outside a review screen.
- [ ] **CV Edit on the review card.** `EditCv` is CLI-only.
- [ ] **Notifications for mail status changes.** An interview invite ("Helix invites you to a tech call") never pops up; only ready-for-review, needs-you and hand-off do.
- [ ] **Sign in to any site from the app.** `SignIn` accepts any URL (Workday, Djinni), but the app offers LinkedIn and Xing only, and saving the login to the Keychain is CLI-only.
- [ ] **Review quick actions.** "Shorter" and "Use another project…" are missing; the evidence panel can't edit a fact; "adapted from an earlier answer" doesn't say which one or when.
- [ ] **Knowledge sources.** A single source can't be removed. Local folders and Drive folders are refused.
- [ ] **Live delivery progress.** `deliver.ts` emits progress, but the app shows only "Approved · delivering"; the PRD asks for "Filling 14/16 fields · solving captcha".

## Minor

- [ ] Add a posting by URL in the app (today only the Share extension does it).
- [ ] "✓ apply form verified" without how long ago.
- [ ] Agent runs lists only search runs; `agent_runs` (role, model, tokens, duration) is written and never read.
- [ ] No candidate notes or company contacts on an application.
- [ ] Company research isn't used for interview prep.
- [ ] A custom CV template is only a folder (`$APPLYANT_HOME/cv-template/`), with no UI.
- [ ] Stored keys can't be deleted in the app.
- [ ] The CLI lacks `jobs search`.

## Deviations on purpose (recorded in the plan)

- 8a: a plain launchd agent instead of SMAppService; ad-hoc signed, not notarised; `app/` is a SwiftPM package.
- 16b: no App Group; the Share extension reads `endpoint.json` through a sandbox exception.
- 4: no owned ATS test boards; public read-only and synthetic fixtures only.
- 6: a stuck delivery stays `approved` with a hand-off record; repeatable form sections always hand off.
- 5: one writer run and one batched verifier per application.
- 13a/13b: Gmail through plain fetch; IMAP polled every 5 minutes, not IDLE; calendar events only from `.ics` attachments.
- 16a: the preferences draft is built by rules, not an agent.
- 12: a failed company research isn't retried.
- 10: at most 50 new postings per run; Himalayas and Jobicy start switched off.

## Run only against fakes so far

- Web-form delivery on a real ATS (nothing has been submitted anywhere), real CapMonster solves, security codes from a real mailbox.
- Gmail, Calendar and Drive (a local fake Google API); IMAP sync has no test.
- LinkedIn and Xing search, Easy Apply and Xing apply (local copies of the pages).
- Telegram sign-in and sending (a fake client).
- Throughput: two workers share one queue; a new search run once waited behind ~90 verifications.
