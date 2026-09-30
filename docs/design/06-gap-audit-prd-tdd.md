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
- [x] **Model roles in the app.** `ListRoles` / `SetRole` / `ResetRoles` exist, but only the CLI uses them. This also blocks the opt-in to classify email with a cloud model from Settings.
  - Done (2026-09-30): Settings → Models lists every role with what it does, its route, default and fallback; a menu changes the route (Jev offered only for the four decision roles, the on-device model only for `email_classify`; the daemon's refusal is shown), Reset per role and "Reset all to defaults". "Read replies with a cloud model" routes `email_classify` to `claude:haiku` (off resets it), with the privacy trade-off in one line (`app/Sources/Applyant/Views/SettingsModels.swift`, `ApplyantKit/Roles.swift`). Tests: `app/Tests/ApplyantKitTests/GapParityTests.swift`.
- [x] **A facts browser.** `ListFacts` / `EditFact` / `RejectFact` aren't used by the app, so drafted facts can't be reviewed or rejected outside a review screen.
  - Done (2026-09-30): each project's pane and the Profile pane list their facts: status chip, kind, origin, evidence (source · locator · excerpt), with Confirm, Edit (saved in the candidate's words, confirmed), Reject (after a confirmation) and "Confirm all N". The filter is "To confirm" (default) or "All" (rejected last, struck through). It uses `ListFacts`, `ConfirmFact` (by ids), `EditFact`, `RejectFact`; counts and an open review refresh after each change (`Views/Knowledge.swift`, `ApplyantKit/Facts.swift`).
- [x] **CV Edit on the review card.** `EditCv` is CLI-only.
  - Done (2026-09-30): "Edit…" on the CV card (tailored CV, not yet approved or sent) opens the CV line by line: summary, each project's bullets, education, and the left-out lines with their reason. Edit (the words become a confirmed fact), Remove, or "Put back…" for a left-out line, all through `EditCv`. The sheet shows "Rendering…" until the new PDF is ready, then Preview opens it; the card's Preview follows the same way, from the application events. Skills can't be edited, as in the CLI.
- [x] **Notifications for mail status changes.** An interview invite ("Helix invites you to a tech call") never pops up; only ready-for-review, needs-you and hand-off do.
  - Done (2026-09-30): `ApplicationEvent.from_mail` (proto) is set when a mail sync moved the application: the stage event carries task_kind `sync_mail` (`mail-status.ts`, `mapping.ts`); the candidate's own "Which application is this?" answer doesn't set it. The app posts, from live events only, "<Company> invites you to an interview" / "made you an offer" / "isn't moving forward", with the role and the email's subject, and Open shows the application under Interviews / Offers / Applied (`NotificationDelegate.swift`, `MailText.statusNotification`). The text is plain, not written by the on-device model. Tests: `daemon/test/mail-status.test.ts`, `GapParityTests.swift`.
- [x] **Sign in to any site from the app.** `SignIn` accepts any URL (Workday, Djinni), but the app offers LinkedIn and Xing only, and saving the login to the Keychain is CLI-only.
  - Done (2026-09-30): Settings → Sites → "Sign in to a site…" takes a URL (a bare host gets https://; linkedin and xing work too) and calls `SignIn`. "Also keep this site's login" first stores `{"username","password"}` with `SetSecret` under the same `login.<site>` name as the CLI's `--save-login` (`SiteLogin.secretName` mirrors `loginSecretName`; the test cases were checked against it in node). The password is never shown again.
- [x] **Review quick actions.** "Shorter" and "Use another project…" are missing; the evidence panel can't edit a fact; "adapted from an earlier answer" doesn't say which one or when.
  - Done (2026-09-30): `RedraftAnswer` (proto) stores the ask on the answer (`answers.redraft`, migration `0021_redraft`) and prepares the application again: only that answer goes back to the same writer run, with "make it clearly shorter" and/or "answer it from the project X" in its prompt and that project's facts (confirmed first, up to 20) added to what it may cite; the verifier checks the new draft as usual and the ask is cleared when it's saved (`review.ts` `redraftAnswer`, `writer-context.ts`, `writer.ts`, `prepare.ts`). A choice question, no ask or an unknown project is refused. `Answer.adapted` names the earlier answer's application (company, title), its question, stage and date (sent, or drafted), and the footer reads "adapted from the answer sent to Orbit (Sep 12)" with the question as its tooltip. The review card has Shorter and "Use another project…" (a menu of projects; "Redrafting shorter, from Lantern…" while it runs), and the evidence panel has Edit… per fact (`EditFact`: confirmed in the candidate's words; the open review refreshes, so the answer's flags clear as after Confirm). Tests: `daemon/test/redraft.test.ts`, `ReviewQuickActionTests`. No CLI command for the quick actions yet.
- [x] **Knowledge sources.** A single source can't be removed. Local folders and Drive folders are refused.
  - Done (2026-09-30): `DeleteSource` (and `applyant candidate source remove <id>`) drops the source's evidence and the extracted, unedited facts left with no other evidence; the candidate's own words (interview, review edits, edited facts) and facts another source also gave stay; re-matching is requested as after a sync, and a `source.removed` event is emitted (`sources/registry.ts`). A local folder (`file` source whose locator ends in `/`) and a Drive folder link (`folder:<id>`, children listed page by page through the Drive client, subfolders recursed) expand to their readable files: at most 200 files, 50 MB per file, 100 MB in all, depth 6; hidden files and folders, dependency/build folders, symlinks and binary files are skipped; each fact's locator starts with the file's path (`sources/folder.ts`, `drive.ts`). The app has Remove… on each source (the confirmation says what goes and what stays), folder rows marked as folders, and a file-or-folder picker. Tests: `daemon/test/folder-sources.test.ts` (fixture folder, fake Drive API), `SetupParityTests`. A folder is extracted as one material, so past 150k characters later files aren't seen (the label says how many).
- [x] **Live delivery progress.** `deliver.ts` emits progress, but the app shows only "Approved · delivering"; the PRD asks for "Filling 14/16 fields · solving captcha".
  - Done (2026-09-30): the form engine's progress now counts ("filling 14/16: Email") and says when a file went in ("uploaded Resume/CV"). The app folds the delivery task's live `task.progress` events into `DeliveryProgress` per application ("Step 2 · Filling 14/16 fields · Resume/CV uploaded · solving captcha"; also opening the form, pressing "Next", reading the emailed security code), shown as the application's chip in lists and on the review screen, and in the menu bar as "Delivering to Helix: …" above the other running work. It goes when the task ends. Tests: `DeliveryProgressTests.swift`.

## Minor

- [x] Add a posting by URL in the app (today only the Share extension does it).
  - Done (2026-09-30): Inbox toolbar "Add posting…" → a sheet → `AddPosting` (as `jobs add` and the Share extension); it says added / already in Applyant · stage / refused, and the list refreshes.
- [x] "✓ apply form verified" without how long ago.
  - Done (2026-09-30): "✓ apply form verified 3 h ago" from `form_read_at`.
- [x] Agent runs lists only search runs; `agent_runs` (role, model, tokens, duration) is written and never read.
  - Done (2026-09-30): `ListAgentRuns` (role, provider/model, tokens, duration, cost, outcome/error, the task and the entity it was for, with a name for postings, applications, companies and sources); Agent runs has a Search runs / Model runs switch; CLI `applyant runs models [--role] [-n]`.
- [x] No candidate notes or company contacts on an application.
  - Done (2026-09-30): `applications.notes` and `application_contacts` (name, role, email, LinkedIn, note; `0022_notes_contacts`); `SetApplicationNotes`, `AddApplicationContact`, `DeleteApplicationContact`; Notes and Contacts cards on the application screen at every stage; CLI `applications notes <id> [text…] [--clear]`, `applications contacts list|add|remove`.
- [x] Company research isn't used for interview prep.
  - Done (2026-09-30): at interview or offer the application's screen shows an "Interview prep" card built in the app from the company profile (summary, product, news, stack, red flags, each with its sources) and the application's own answers ("what you told them"); no model run. The PRD asks for nothing more (research "supplies material for … interview preparation"); generated practice questions would be a new model role.
- [x] A custom CV template is only a folder (`$APPLYANT_HOME/cv-template/`), with no UI.
  - Done (2026-09-30): Settings → CV template shows the active one (Clean · default, or the custom one's name, folder and files, and why a broken one isn't used), "Use a custom template…" (the app reads the picked folder and sends its files, so the daemon needs no access to it; `SetCvTemplate` checks `index.html` has `{{cv}}`, writes beside and swaps) and "Reset to default" (`ResetCvTemplate`). A custom folder without `{{cv}}` now falls back to Clean instead of failing the render. CLI `applyant cv-template show|set <dir>|reset`. No preview render (no RPC renders a sample CV).
- [x] Stored keys can't be deleted in the app.
  - Done (2026-09-30): Settings → Stored keys lists secret names only (`ListSecrets`), each with what it's for, and Delete… after a confirmation that says what stops working (`DeleteSecret`). Settings' captcha and mailbox lines refresh afterwards.
- [x] The CLI lacks `jobs search`.
  - Done (2026-09-30): `applyant jobs search <words…> [--by-score]`: `ListPostings.query`, every word in the title, company, URL or text (case-insensitive; postings have no FTS table).
- Drive hidden from onboarding (2026-09-30, the owner's request: no material in Google Drive): the Connections step has no Drive row and texts say the consent covers Gmail and Calendar. `drive` stays a source kind; a pasted Docs link is still read through a connected Google mailbox.

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
