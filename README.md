# Applyant

Applyant is a personal macOS app for finding jobs, checking how well they fit, and preparing applications from facts you have reviewed. It can tailor a CV, draft answers and cover letters, fill application forms, and track what was sent. **Nothing is submitted until you approve an application.**

The app runs locally. A background service keeps the search, candidate profile, applications, and delivery state; the macOS app and `applyant` CLI use the same data.

## Install on macOS

This repository builds Applyant for the Mac on which you run it. You need Apple silicon, Xcode, Node.js 24 or newer, and pnpm. Sign in to the Claude Code CLI before using its model routes. The Codex CLI is needed only if you select a Codex route.

```sh
scripts/bundle.sh
applyant status
```

`bundle.sh` builds and signs the app, installs it at `/Applications/Applyant.app`, links the CLI at `~/.local/bin/applyant`, and opens the app. On first launch, the app sets up its background service. `applyant status` checks the service and reports which agent CLIs it found. Run `applyant --help` for the full CLI.

## Set up your profile

1. Open **Profile** and fill in your name, contact details, and other values application forms ask for. They become defaults; you can change any value for one application without changing your profile.
2. Under **Base CV**, choose your CV. Applyant keeps a local copy. A CV file added to profile sources can also become the base CV when its filename identifies it as a CV or résumé and no base CV is set yet.
3. Add projects and sources in **Profile** or **Projects**. Applyant extracts candidate facts from your CV, repositories, and other sources. Confirm, edit, or reject those facts before applications rely on them.
4. Set your target roles, location, salary, and other preferences in **Settings → Preferences**. In **Search → Searches**, edit the job titles and locations each search looks for. In **Search → Sources**, switch individual sites or whole groups on and off, or add a career page by URL. Djinni searches for the titles in each search; Jobico supplies its full list for those searches to filter.
5. In **Settings → Models**, choose a provider and model for each task. You can switch between Claude and Codex where supported; Jev handles selected small decisions, and the on-device model can classify replies. Changes apply to the next model run.

## Review jobs and applications

**Chat** in the sidebar lets you ask about your experience using your profile, projects and confirmed facts. Answers show which confirmed facts they used. The conversation stays in Applyant's local database; choose its provider and model under **Settings → Models → Candidate chat**.

- **Inbox** shows scored postings. Open one to see the fit breakdown. Choose **Interested** to prepare an application yourself.
- **Ready to review** contains prepared applications. Check the destination, every field, drafted answer, cited facts, CV, and any blockers before choosing **Approve and send…**.
- **Skip…** means a job is unsuitable, including when its posting link only opens a company homepage. You can use it from the posting or an unsent application review. Add a short reason if useful. The job moves to **Skipped** and can be returned to the Inbox. A skipped posting cannot be approved for sending.
- **Set status → Rejected** records an employer's rejection **after** an application was sent. It is not the action for passing on a job.
- **Preparing** shows work still in progress or waiting for information. **Applied**, **Interviews**, and **Offers** track applications after submission.

### CV and cover letter

When a form asks for a résumé, Applyant tries to make a tailored PDF from confirmed facts. The **CV** card shows what leads and what was left out. **Preview** opens the tailored PDF in tailored mode or your profile's base CV in base mode. **Use base CV instead** selects the CV saved in your profile for that application; **Use the tailored CV** switches back. If there are not enough confirmed facts to make a tailored CV, Applyant uses the base CV when available.

When a form has a cover letter field, Applyant drafts a letter for that role from the candidate facts and posting. Text fields receive text; file upload fields receive a PDF. Optional cover letter fields are drafted too. Review the draft before approval, and edit or replace it for a particular application if needed. Applyant does not create a separate letter when the form has no cover letter field.

### Sending and receipts

**Approve and send…** starts delivery only after required values, facts, and checked claims are ready. Applyant fills the reviewed values and selected CV. A captcha, sign-in, or uncertain submission can stop delivery and ask you to finish or verify it. It does not submit a second time merely because the result is unclear.

After a confirmed submission, **Submission receipt** shows when it was sent, how many values were sent, a short confirmation message when the site provides one, and the exact CV file used. It is a record of the submission, not another application form.

## Useful CLI commands

The app covers everyday use. The CLI offers the same data and more detailed inspection:

```sh
applyant status
applyant pause
applyant resume
applyant candidate show
applyant candidate profile set base_cv_file /absolute/path/to/cv.pdf
applyant candidate source add profile file /absolute/path/to/cv.pdf
applyant candidate fact list profile
applyant jobs list --by-score
applyant jobs show POSTING_ID
applyant jobs skip POSTING_ID --reason "application link opens the homepage"
applyant jobs unskip POSTING_ID
applyant applications list
applyant applications preview APPLICATION_ID
applyant applications cv show APPLICATION_ID
applyant config roles list
applyant config roles set application_writer codex
applyant config roles set application_writer codex:MODEL_ID
```

Replace the uppercase IDs with actual values. Use `applyant SECTION --help` for the remaining commands. Model IDs available in the app depend on the signed-in Codex account; **Other model…** accepts a supported model ID that is not listed.

## Develop and test

| Path | Purpose |
| --- | --- |
| `app/` | SwiftUI app and shared app logic |
| `daemon/` | Background service, CLI, browser automation, database, and tests |
| `native/` | macOS helper for Keychain, PDF text, and system events |
| `proto/` | API shared by the app and service |
| `scripts/` | App bundling and smoke checks |
| `docs/design/` | Product and technical design documents |

```sh
pnpm -C daemon install
pnpm -C daemon typecheck
pnpm -C daemon lint
pnpm -C daemon test
swift test --package-path app
swift test --package-path native
scripts/bundle.sh --no-install
```

Use Node.js 24 or newer for the daemon and bundle. Some browser tests need Playwright's Chromium; install it with `pnpm -C daemon exec playwright install --only-shell chromium`. On Linux, headed delivery tests need a display such as `xvfb`.

State is stored under `~/Library/Application Support/Applyant`, secrets in the macOS Keychain, and logs under `~/Library/Logs/Applyant`. The app is signed locally for this Mac; the build is not notarized for distribution.
