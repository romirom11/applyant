# Gap audit: the implementation against the PRD and the TDD

Done on 2026-09-30, after all 16 phases of the plan were built. The plan (`05`) was derived from the PRD and the TDD, so phases being done doesn't prove the documents are covered. This audit read the PRD and the TDD directly and checked the code against them. The items below are the gaps; each gets ticked here when it's closed.

## Verdict

The daemon covers nearly all of the TDD, and the PRD's core loop can be used from the Mac app. The gaps are:

- nothing measures the PRD's four success metrics or the funnel;
- scores don't update when knowledge grows;
- several PRD actions still need the terminal or don't exist;
- much of the outside-world code has only run against fakes.

## Blocks everyday use

- [ ] **Re-score when knowledge changes.** `score_posting` is queued only by verify, by startup for unscored postings, and by `ScorePostings` (which the app never calls). Postings scored before the CV/GitHub import or the interview keep their low scores and never prepare on their own. Needed: queue a re-match from the commits of `sync_source`, interview turns, confirm/edit fact and review edits, plus a "Re-score" action.
- [ ] **Correct a status by hand.** PRD: "Every status can be corrected by hand, in the app or from the CLI". There is no RPC, no CLI command and no app action. Needed: `SetApplicationStage`, `applyant applications status <id> <stage>`, and an action on the application.

## Noticeable gaps

- [ ] **Overview: the funnel and the four PRD metrics.** Nothing computes the dead-link rate, the interested rate, the review time, unsupported claims, applications per week or the interview rate. The Overview section is a placeholder.
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
