// The job detail: the posting's text read from real captures (PostingSamples), its key facts,
// its tabs and primary action, and when a site wants a sign-in first.
import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

private typealias Block = PostingDescription.Block

private func headings(_ blocks: [Block]) -> [String] {
    blocks.compactMap { if case let .heading(t) = $0 { t } else { nil } }
}

private func everything(_ blocks: [Block]) -> String {
    blocks.map {
        switch $0 {
        case let .heading(t), let .paragraph(t): t
        case let .list(items, _): items.joined(separator: "\n")
        }
    }.joined(separator: "\n")
}

/// The list right under a heading.
private func list(after heading: String, in blocks: [Block]) -> [String]? {
    guard let i = blocks.firstIndex(of: .heading(heading)), i + 1 < blocks.count, case let .list(items, _) = blocks[i + 1] else { return nil }
    return items
}

@Suite struct PostingDescriptionTests {
    @Test func djinniLosesThePagesChromeAndKeepsThePosting() {
        let d = PostingDescription.parse(PostingSamples.djinni, title: "AI Product Engineer / AI Solutions Engineer", company: "Red Rocket Software")
        let text = everything(d.blocks)
        // The capture's header, the page's chrome and what follows the posting are gone.
        for gone in ["Page header", "Structured data", "Open in Djinni mobile app", "Error", "All jobs", "$$", "Responds Quickly",
                     "Similar jobs", "Published 17 August", "We use cookies", "PwC"] {
            #expect(!text.contains(gone), "\(gone)")
        }
        guard case let .paragraph(first)? = d.blocks.first else { Issue.record("starts with \(String(describing: d.blocks.first))"); return }
        #expect(first.hasPrefix("We are looking for an AI Product Engineer"))
        // Its own sections become headings, their bullets lists.
        #expect(headings(d.blocks) == ["What you will do", "What this role is about", "Requirements", "Nice to have", "Required languages"])
        let requirements = list(after: "Requirements", in: d.blocks) ?? []
        #expect(requirements.count == 13)
        // "-" on its own line, the item's text on the next: one item.
        #expect(requirements.last?.hasPrefix("English level sufficient") == true)
        #expect(list(after: "What you will do", in: d.blocks)?.last?.hasPrefix("Collaborate closely") == true)
        // The JobPosting fields are kept for the key facts.
        #expect(d.structured["employmentType"] == "FULL_TIME")
        #expect(d.structured["jobLocationType"] == "TELECOMMUTE")
        #expect(d.date("datePosted") != nil)
    }

    @Test func djinniInUkrainianReadsTheSameWay() {
        let d = PostingDescription.parse(PostingSamples.djinniUkrainian, title: "Senior Python Engineer", company: "Adaptiq")
        let text = everything(d.blocks)
        for gone in ["Помилка", "Відкрити в застосунку Djinni", "Всі вакансії", "Adaptiq 🔥", "Опубліковано", "Схожі вакансії", "Visarsoft"] {
            #expect(!text.contains(gone), "\(gone)")
        }
        // "Who we are:" and the rest are headings without their colons.
        #expect(Array(headings(d.blocks).prefix(6)) == ["Who we are", "About the Product", "Key Responsibilities", "Requirements", "Nice to Have", "What We Offer"])
        #expect(headings(d.blocks).contains("Вимоги до володіння мовами"))
        #expect(list(after: "Requirements", in: d.blocks)?.first == "5+ years of backend engineering experience with Python.")
        #expect(d.structured["estimatedSalary"]?.contains("maxValue: 5000") == true)
    }

    @Test func greenhouseKeepsItsHeadingsAndHasNoStructuredData() {
        let d = PostingDescription.parse(PostingSamples.greenhouse, title: "Staff Backend Engineer - Core Product", company: "Kalepa")
        #expect(d.structured.isEmpty)
        #expect(d.blocks.first == .heading("About Kalepa"))
        #expect(headings(d.blocks).contains("You'll be right at home if you"))
        #expect(list(after: "You'll be right at home if you", in: d.blocks)?.first == "Have 8+ years of software engineering experience.")
        // A line of facts with a colon in it isn't a heading.
        #expect(d.blocks.contains(.paragraph("Salary range: $100k – $185k USD*")))
        #expect(!everything(d.blocks).contains("Back to jobs"))
    }

    @Test func workableNumbersItsStepsAndKeepsItsSalary() {
        let d = PostingDescription.parse(PostingSamples.workable, title: "Senior Product Engineer", company: "Modash.io")
        // Its "Description" heading repeats the card's title: the text starts under it.
        guard case let .paragraph(first)? = d.blocks.first else { Issue.record("starts with \(String(describing: d.blocks.first))"); return }
        #expect(first.hasPrefix("Hey, I'm Dima."))
        #expect(d.blocks.contains(.list(["Turn customer pain into product decisions."], start: 1)))
        #expect(d.blocks.contains(.list(["Take work from problem to production."], start: 2)))
        #expect(headings(d.blocks).contains("Our stack"))
        #expect(d.structured["baseSalary"]?.contains("minValue: 80000.00") == true)
        #expect(KeyFacts.salary(d.structured["baseSalary"] ?? "") == "EUR 80,000–110,000 a year")
    }

    @Test func aPageThatPutsItsNavigationFirstStartsAtTheTitle() {
        let d = PostingDescription.parse(
            PostingSamples.arbeitnow,
            title: "Full Stack Developer PHP / TypeScript in Hamburg oder Remote (m/w/d)",
            company: "DEMV Systems Gmbh"
        )
        let text = everything(d.blocks)
        for gone in ["Popular", "Tax Calculator", "Aachen", "Home | DEMV", "Jobs at DEMV", "Produktmanager", "6 hours"] {
            #expect(!text.contains(gone), "\(gone)")
        }
        #expect(d.blocks.first == .heading("Innerhalb des Teams gibt es folgende spannende Aufgaben"))
        #expect(list(after: "Innerhalb des Teams gibt es folgende spannende Aufgaben", in: d.blocks)?.count == 9)
    }

    @Test func textWithoutTheCapturesHeaderIsReadAsItIs() {
        let blocks = PostingDescription.blocks(text: "We build tools.\n\nWhat you'll do\n- Ship\n- Review\n\nAbout **us**: a small team.")
        #expect(blocks == [
            .paragraph("We build tools."),
            .heading("What you'll do"),
            .list(["Ship", "Review"], start: nil),
            .paragraph("About **us**: a small team."),
        ])
        // Inline markdown renders; text that isn't markdown stays as it is.
        #expect(String(PostingDescription.inline("About **us**").characters) == "About us")
        #expect(String(PostingDescription.inline("$100k – $185k USD*").characters) == "$100k – $185k USD*")
        // Links from the page: http(s) stays clickable, anything else is plain text.
        let links = PostingDescription.inline("[apply](https://jobs.example.com/1) [cv](file:///etc/hosts) [app](x-apple.systempreferences:)")
        #expect(links.runs.compactMap(\.link).map(\.absoluteString) == ["https://jobs.example.com/1"])
        #expect(String(links.characters) == "apply cv app")
        #expect(PostingDescription.blocks(text: "").isEmpty)
    }

    @Test func breadcrumbsBadgesAndWrappedItemsAreTidied() {
        // As Djinni pages without a title heading read (Luxoft, GlobalLogic).
        let text = """
        - All jobs
        - Tech Leadership

        🪖 DefTech Product

        -
        Responsibilities:

        • Design the architecture of the platform.
        - Documents software development using
        management tool.

        We use cookies to improve your experience.
        """
        #expect(PostingDescription.blocks(text: text) == [
            .heading("Responsibilities"),
            .list(["Design the architecture of the platform.", "Documents software development using management tool."], start: nil),
        ])
    }
}

@Suite struct JobDetailTextTests {
    private func component(_ key: String, _ note: String) -> Applyant_V1_ScoreComponent {
        .with {
            $0.key = key
            $0.note = note
            $0.weight = 10
            $0.value = 1
        }
    }

    @Test func keyFactsComeFromTheScorersReadingAndTheJobPostingFields() {
        var p = posting(874, score: 82, title: "AI Product Engineer / AI Solutions Engineer", company: "Red Rocket Software")
        p.breakdown = [
            component("location", "Remote (europe, UA) · counts ×0.8: core fit 63%"),
            component("role", "seniority not stated · One of the roles you're after"),
            component("employment", "Full-time · outstaffing"),
            component("language", "English (professional) · you have B1"),
        ]
        let d = PostingDescription.parse(PostingSamples.djinni, title: p.title, company: p.company)
        let facts = KeyFacts.rows(p, description: d) { _ in "17 Sep 2026" }
        #expect(facts == [
            KeyFact("Workplace", "Remote (europe, UA)"),
            KeyFact("Employment", "Full-time · outstaffing"),
            KeyFact("Language", "English (professional)"),
            KeyFact("Posted", "17 Sep 2026"),
        ])

        // Without a breakdown the JobPosting fields say it; the posting's salary text wins.
        var bare = posting(855, score: 85, title: "Senior Product Engineer", company: "Modash.io")
        bare.salaryText = "€80k–110k"
        let workable = PostingDescription.parse(PostingSamples.workable, title: bare.title, company: bare.company)
        let rows = KeyFacts.rows(bare, description: workable) { _ in "1 Jul 2025" }
        // A tile keeps two places and counts the rest; its tooltip has them all.
        #expect(rows.first == KeyFact("Workplace", "Remote (Estonia, Latvia +4)", full: "Remote (Estonia, Latvia, Romania, Slovakia, Lithuania, Poland)"))
        #expect(rows.contains(KeyFact("Employment", "Full-time")))
        #expect(rows.contains(KeyFact("Salary", "€80k–110k")))
        let arbeitnow = PostingDescription.parse(PostingSamples.arbeitnow)
        #expect(KeyFacts.rows(posting(1, score: 60, title: "x"), description: arbeitnow).contains(KeyFact("Location", "Hamburg, DE")))
        #expect(KeyFacts.salary("MonetaryAmount, currency: USD, maxValue: 5000, minValue: 3000") == "USD 3,000–5,000")
        #expect(KeyFacts.employmentName("CONTRACTOR") == "Contract")
    }

    @Test func tabsAndThePrimaryActionFollowWhereTheJobStands() {
        #expect(DetailTab.available(hasApplication: false, hasCompany: true) == [.job, .company])
        #expect(DetailTab.available(hasApplication: true, hasCompany: true) == [.job, .application, .company])
        #expect(DetailTab.shown(.application, in: [.job, .company]) == .job)
        #expect(DetailTab.shown(.company, in: [.job, .company]) == .company)

        let p = posting(1, score: 75, title: "Backend")
        #expect(JobAction.primary(posting: p, application: nil) == .prepare)
        var skipped = p
        skipped.stage = .skipped
        #expect(JobAction.primary(posting: skipped, application: nil) == .none)
        let blocked = application(9, posting: 1, stage: .readyForReview, blockers: ["2 unconfirmed facts", "salary missing"])
        #expect(JobAction.primary(posting: p, application: blocked) == .approve(enabled: false, help: "2 unconfirmed facts\nsalary missing"))
        guard case .approve(true, _) = JobAction.primary(posting: p, application: application(9, posting: 1, stage: .readyForReview)) else {
            Issue.record("a ready application is approved")
            return
        }
        #expect(JobAction.primary(posting: p, application: application(9, posting: 1, stage: .applied)) == .review)
        #expect(JobAction.primary(posting: p, application: application(9, posting: 1, stage: .preparing)) == .review)
    }

    @Test func aSignInNoteOffersTheSitesSignIn() {
        var app = application(19, posting: 1, stage: .needsCandidate)
        app.postingURL = "https://djinni.co/jobs/812345-ai-engineer/"
        #expect(SignInHint.of(app) == nil)
        app.note = "no application form: the apply page asks you to sign in first"
        #expect(SignInHint.of(app) == SignInHint(host: "djinni.co", url: "https://djinni.co/login"))
        #expect(SignInHint.of(app)?.title == "Sign in to djinni.co…")
        // Sent since (by hand): the old note asks for nothing any more.
        app.stage = .applied
        #expect(SignInHint.of(app) == nil)

        // A blocker says it, on another site: its https origin (the form's, when it's elsewhere).
        var other = application(20, posting: 2, stage: .readyForReview, blockers: ["Sign In required to apply"])
        other.postingURL = "http://www.example.com/careers/42"
        #expect(SignInHint.of(other) == SignInHint(host: "example.com", url: "https://www.example.com"))
        other.formURL = "https://jobs.lever.co/acme/42/apply"
        #expect(SignInHint.of(other)?.url == "https://jobs.lever.co")
    }

    @Test func longPlaceListsAreSummedUpForTheirTile() {
        #expect(KeyFacts.shortened("Remote (europe, UA)") == "Remote (europe, UA)")
        #expect(KeyFacts.shortened("Remote (A, B, C)") == "Remote (A, B +1)")
        let many = (1...71).map { "Country \($0)" }.joined(separator: ", ")
        #expect(KeyFacts.shortened("Remote (\(many))") == "Remote · 71 countries")
        #expect(KeyFacts.shortened("Hybrid") == "Hybrid")
    }

    @Test func evidenceNamesTheProjectNotItsSlug() {
        let r = RequirementMatch.with {
            $0.text = "Led a team"
            $0.facts = [
                .with { $0.projectSlug = "tech-lead-at-nda"; $0.text = "Led 6 engineers"; $0.status = .confirmed },
                .with { $0.projectSlug = "acme-api"; $0.text = "Built billing"; $0.status = .unconfirmed },
                .with { $0.text = "10 years of Go"; $0.status = .confirmed },
            ]
        }
        #expect(MatchText.evidence(r, projects: ["acme-api": "Acme API"]) == [
            "Tech lead at nda: Led 6 engineers", "Acme API: Built billing (unconfirmed)", "10 years of Go",
        ])
        #expect(MatchText.factsLabel(1) == "1 fact")
        #expect(MatchText.factsLabel(2) == "2 facts")
    }

    @Test func nextAndPreviousJobStepThroughTheList() {
        let rows = [posting(1, score: 90, title: "A"), posting(2, score: 80, title: "B"), posting(3, score: 70, title: "C")]
            .map { ListItem(posting: $0, application: nil) }
        #expect(ListSelection.step(1, from: 1, in: rows)?.postingId == 2)
        #expect(ListSelection.step(-1, from: 2, in: rows)?.postingId == 1)
        #expect(ListSelection.step(1, from: 3, in: rows) == nil)
        #expect(ListSelection.step(-1, from: 1, in: rows) == nil)
        // Nothing open (or the open one isn't in this list): the first, or the last.
        #expect(ListSelection.step(1, from: nil, in: rows)?.postingId == 1)
        #expect(ListSelection.step(-1, from: 99, in: rows)?.postingId == 3)
        #expect(ListSelection.step(1, from: nil, in: []) == nil)
    }

    @Test func goingToASectionLeavesNothingPicked() {
        var nav = Navigation()
        nav.section = .new
        nav.postingId = 4
        nav.reviewing = 9
        nav.go(to: .new)
        #expect(nav.postingId == 4)
        nav.go(to: .saved)
        #expect(nav.section == .saved && nav.postingId == nil && nav.reviewing == nil)
    }

    @Test func theTitleBarsCapsuleStaysShort() {
        let now = Date()
        #expect(ActivityText.pausedSince(now, now: now) == "Paused since " + now.formatted(date: .omitted, time: .shortened))
        let earlier = now.addingTimeInterval(-3 * 86_400)
        #expect(ActivityText.pausedSince(earlier, now: now).hasPrefix("Paused since "))
        #expect(ActivityText.pausedSince(earlier, now: now) != ActivityText.pausedSince(now, now: now))
        #expect(ActivityText.pill("scoring 3 postings") == "Scoring 3 postings")
        #expect(ActivityText.pill("scoring 3 postings · reading a source · sending Acme") == "Scoring 3 postings +2")
    }

    @Test func theNextJobIsTheOneThatTookItsPlace() {
        let rows = [posting(1, score: 90, title: "A"), posting(2, score: 80, title: "B"), posting(3, score: 70, title: "C")]
            .map { ListItem(posting: $0, application: nil) }
        #expect(ListSelection.next(after: 2, before: rows, now: [rows[0], rows[2]])?.postingId == 3)
        #expect(ListSelection.next(after: 3, before: rows, now: [rows[0], rows[1]])?.postingId == 2)
        #expect(ListSelection.next(after: 2, before: rows, now: rows)?.postingId == 2)
        #expect(ListSelection.next(after: 1, before: [rows[0]], now: []) == nil)
    }

    @Test func goodMatchesSitJustUnderTheAutoPrepareThreshold() {
        #expect(JobLists.goodMatchScore(threshold: nil) == 70)
        #expect(JobLists.goodMatchScore(threshold: 80) == 70)
        #expect(JobLists.goodMatchScore(threshold: 65) == 65)
        #expect(JobLists.goodMatchScore(threshold: 0) == 70)
        #expect(JobLists.hiddenLine(0, below: 70) == nil)
        #expect(JobLists.hiddenLine(1, below: 70) == "1 lower match (under 70) hidden")
    }

    @Test func theSourceChipNamesTheBoardOrTheATS() {
        #expect(Source.site("https://djinni.co/jobs/874-ai-product-engineer/") == "Djinni")
        #expect(Source.site("https://job-boards.eu.greenhouse.io/nuitee/jobs/1") == "Greenhouse")
        #expect(Source.site("https://www.arbeitnow.co.uk/jobs/x") == "Arbeitnow")
        #expect(Source.site("https://t.me/s/remote_jobs/12") == "Telegram")
        #expect(Source.site("https://www.elevenlabs.io/careers/1") == "elevenlabs.io")
        #expect(OverviewText.section(forStep: "found") == .new)
        #expect(OverviewText.section(forStep: "prepared") == .toReview)
        #expect(OverviewText.section(forStep: "offer") == .offers)
    }
}
