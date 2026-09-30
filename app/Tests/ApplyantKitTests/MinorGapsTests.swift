// Minor gaps: Add posting from the Inbox, when the apply form was read, model runs, an
// application's notes and contacts, interview prep, and the CV template in Settings.
import ApplyantAPI
import Foundation
import SwiftProtobuf
import Testing
@testable import ApplyantKit

@MainActor
private func connected(_ daemon: FakeDaemon) async throws -> (AppStore, Task<Void, Never>) {
    let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
    let run = Task { await store.run() }
    try await eventually("connected") { store.connection == .connected }
    return (store, run)
}

private func stamp(_ date: Date) -> Google_Protobuf_Timestamp { Google_Protobuf_Timestamp(date: date) }

@MainActor
@Suite struct MinorGapsTests {
    @Test func addPostingSaysAddedAlreadyKnownOrRefused() async throws {
        var known = posting(1, score: 80, title: "Backend Engineer", company: "Helix")
        known.canonicalURL = "https://jobs.example.com/helix/1"
        let daemon = FakeDaemon(postings: [known])
        let (store, run) = try await connected(daemon)
        defer { run.cancel() }

        let added = try #require(await store.addPosting("  jobs.example.com/orbit/7 "))
        #expect(daemon.calls.contains("addPosting https://jobs.example.com/orbit/7"))
        #expect(added == .added(title: nil, company: nil, url: "https://jobs.example.com/orbit/7"))
        #expect(added.line == "Added: https://jobs.example.com/orbit/7 — it'll be verified and scored")
        #expect(added.ok)
        // The postings list is loaded again: the new one is in it.
        #expect(store.postings.values.contains { $0.canonicalURL == "https://jobs.example.com/orbit/7" })
        #expect(daemon.calls.filter { $0 == "listPostings" }.count >= 2)

        let again = try #require(await store.addPosting("https://jobs.example.com/helix/1"))
        #expect(again.line == "Already in Applyant · scored")
        #expect(again.detail == "Backend Engineer at Helix")

        let refused = try #require(await store.addPosting("https://example.com/not-a-job"))
        #expect(refused == .refused("that page isn't a job posting"))
        #expect(!refused.ok)
        // Said in the sheet, not in the alert.
        #expect(store.lastError == nil)
        #expect(await store.addPosting("not a url") == .refused("That isn't a web address."))
        #expect(await store.addPosting("   ") == nil)

        let titled = AddPostingOutcome.from(posting(9, score: 0, title: "AI Engineer", company: "Orbit"), created: true)
        #expect(titled.line == "Added: AI Engineer at Orbit — it'll be verified and scored")
    }

    @Test func theApplyFormSaysWhenItWasRead() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var p = posting(1, score: 80, title: "Backend")
        #expect(PostingText.formVerified(p, now: now) == nil)
        p.formStatus = "verified"
        #expect(PostingText.formVerified(p, now: now) == "✓ apply form verified")
        p.formReadAt = stamp(now.addingTimeInterval(-3 * 3600 - 120))
        #expect(PostingText.formVerified(p, now: now) == "✓ apply form verified 3 h ago")
        #expect(Ago.text(now.addingTimeInterval(-20), now: now) == "just now")
        #expect(Ago.text(now.addingTimeInterval(-12 * 60), now: now) == "12 min ago")
        #expect(Ago.text(now.addingTimeInterval(-2 * 86400), now: now) == "2 d ago")
    }

    @Test func modelRunsReadAsRoleRouteTokensDurationOutcomeAndEntity() async throws {
        let ok = AgentRun.with {
            $0.id = 2
            $0.role = "application_writer"
            $0.provider = "claude"
            $0.model = "sonnet"
            $0.durationMs = 4200
            $0.inputTokens = 12345
            $0.outputTokens = 1100
            $0.outcome = "ok"
            $0.entityKind = "application"
            $0.entityID = 9
            $0.entityLabel = "Backend Engineer at Helix"
        }
        let failed = AgentRun.with {
            $0.id = 1
            $0.role = "verifier"
            $0.provider = "codex"
            $0.durationMs = 125_000
            $0.outcome = "invalid_output"
            $0.error = "no JSON in the answer"
            $0.entityKind = "posting"
            $0.entityID = 12
        }
        #expect(AgentRunText.role(ok) == "Application writer")
        #expect(AgentRunText.line(ok) == "claude/sonnet · 12k in · 1.1k out · 4.2 s")
        #expect(AgentRunText.entity(ok) == "Backend Engineer at Helix")
        #expect(AgentRunText.outcome(ok) == Chip(text: "OK", tone: .good))
        #expect(AgentRunText.problem(ok) == nil)
        #expect(AgentRunText.line(failed) == "codex · 2 min 5 s")
        #expect(AgentRunText.entity(failed) == "posting 12")
        #expect(AgentRunText.outcome(failed) == Chip(text: "Invalid output", tone: .warning))
        #expect(AgentRunText.problem(failed) == "no JSON in the answer")
        #expect(AgentRunText.duration(850) == "850 ms")

        let daemon = FakeDaemon()
        daemon.modelRuns = [ok, failed]
        let (store, run) = try await connected(daemon)
        defer { run.cancel() }
        await store.openAgentRuns()
        #expect(daemon.calls.contains("listAgentRuns 100"))
        #expect(store.agentRuns.map(\.id) == [2, 1])
    }

    @Test func notesAndContactsAreKeptOnTheApplication() async throws {
        let daemon = FakeDaemon(postings: [posting(5, score: 88, title: "AI Engineer", appId: 9)],
                                applications: [application(9, posting: 5, stage: .applied)])
        let (store, run) = try await connected(daemon)
        defer { run.cancel() }
        await store.openApplication(9)

        #expect(await store.setApplicationNotes(application: 9, notes: "Call with Anna on Tuesday"))
        #expect(daemon.calls.contains("setApplicationNotes 9 Call with Anna on Tuesday"))
        #expect(store.applicationDetails[9]?.notes == "Call with Anna on Tuesday")

        // The form needs a name, an email or a LinkedIn link; nothing is sent without.
        #expect(ContactForm(role: "recruiter").problem == "Give at least a name, an email or a LinkedIn link.")
        #expect(ContactForm(email: "anna.acme.com").problem == "That email address has no @.")
        #expect(await !store.addApplicationContact(application: 9, ContactForm(note: "met at a meetup")))
        #expect(store.lastError == "Give at least a name, an email or a LinkedIn link.")
        #expect(!daemon.calls.contains { $0.hasPrefix("addApplicationContact") })
        store.lastError = nil

        let form = ContactForm(name: " Anna Berg ", role: "recruiter", email: "anna@acme.com", linkedin: "linkedin.com/in/annaberg")
        #expect(form.request(9).name == "Anna Berg" && !form.request(9).hasNote)
        #expect(await store.addApplicationContact(application: 9, form))
        #expect(daemon.calls.contains("addApplicationContact 9 Anna Berg recruiter anna@acme.com"))
        #expect(await store.addApplicationContact(application: 9, ContactForm(email: "cto@acme.com")))
        let contacts = try #require(store.applicationDetails[9]?.contacts)
        #expect(contacts.count == 2)
        #expect(ContactText.title(contacts[0]) == "Anna Berg · recruiter")
        #expect(ContactText.mailto(contacts[0])?.absoluteString == "mailto:anna@acme.com")
        #expect(ContactText.linkedin(contacts[0])?.absoluteString == "https://linkedin.com/in/annaberg")
        #expect(ContactText.title(contacts[1]) == "cto@acme.com")
        #expect(ContactText.linkedin(contacts[1]) == nil)

        #expect(await store.deleteApplicationContact(contacts[0].id))
        #expect(store.applicationDetails[9]?.contacts.map(\.email) == ["cto@acme.com"])
        #expect(await !store.deleteApplicationContact(99))
        #expect(store.lastError == "no contact 99")
    }

    @Test func interviewPrepIsBuiltFromTheCompanyAndTheAnswers() async throws {
        var app = application(9, posting: 5, stage: .interview)
        app.answers = [
            .with {
                $0.number = 1
                $0.question = "Why Acme?"
                $0.kind = "text"
                $0.status = "answered"
                $0.active = true
                $0.sentences = [.with { $0.text = "I built call analysis." }, .with { $0.text = "Acme does it at scale." }]
            },
            .with { $0.number = 2; $0.question = "Salary?"; $0.status = "needs_candidate"; $0.active = true },
            .with { $0.number = 3; $0.question = "Remote?"; $0.kind = "choice"; $0.choice = "Yes"; $0.status = "answered"; $0.active = true },
        ]
        let company = Company.with {
            $0.id = 4
            $0.name = "Acme"
            $0.summary = "Acme builds call analytics."
            $0.postings = [.with { $0.id = 5 }]
            $0.sections = [
                .with { $0.key = "funding"; $0.label = "Funding"; $0.findings = [.with { $0.text = "Series B" }] },
                .with { $0.key = "stack"; $0.label = "Stack"; $0.findings = [.with { $0.text = "Go and Postgres"; $0.sources = ["https://acme.example.test/blog/stack"] }] },
                .with { $0.key = "news"; $0.label = "News"; $0.findings = [.with { $0.text = "Opened Berlin"; $0.date = "2026-08" }] },
            ]
            $0.redFlags = [.with { $0.kind = "layoffs"; $0.severity = "low"; $0.text = "10% cut in 2024"; $0.sources = ["https://news.example.test/acme"] }]
        }
        let prep = InterviewPrep.build(company: company, application: app)
        #expect(prep.company == "Acme")
        #expect(prep.sections.map(\.title) == ["Summary", "News", "Stack", "Red flags"])
        #expect(prep.sections[1].items.first?.text == "2026-08: Opened Berlin")
        #expect(prep.sections[2].items.first?.sources == [PrepSource(label: "acme.example.test/blog/stack", url: URL(string: "https://acme.example.test/blog/stack")!)])
        #expect(prep.sections[3].items.first?.text == "Layoffs · low: 10% cut in 2024")
        #expect(prep.answers == [
            PrepAnswer(id: 1, question: "Why Acme?", answer: "I built call analysis. Acme does it at scale."),
            PrepAnswer(id: 3, question: "Remote?", answer: "Yes"),
        ])
        #expect(prep.note == nil)
        #expect(InterviewPrep.applies(app))
        #expect(!InterviewPrep.applies(application(1, posting: 1, stage: .applied)))
        #expect(InterviewPrep.build(company: nil, application: app).note == "No company profile yet: run Company research to prepare with it.")

        // The store loads the posting's company for it.
        let daemon = FakeDaemon(postings: [posting(5, score: 88, title: "AI Engineer", appId: 9)], applications: [app])
        daemon.companies = [company]
        let (store, run) = try await connected(daemon)
        defer { run.cancel() }
        #expect(store.interviewPrep(app).sections.isEmpty)
        await store.openInterviewPrep(posting: 5)
        #expect(daemon.calls.contains("company posting(5)"))
        #expect(store.interviewPrep(app).sections.count == 4)
    }

    @Test func theCvTemplateIsReadFromAFolderSetAndReset() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cvt-\(UUID().uuidString)/Letterhead")
        defer { try? FileManager.default.removeItem(at: dir.deletingLastPathComponent()) }
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("fonts"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dir.appendingPathComponent(".git"), withIntermediateDirectories: true)
        try Data("<html>{{cv}}</html>".utf8).write(to: dir.appendingPathComponent("index.html"))
        try Data("body{}".utf8).write(to: dir.appendingPathComponent("style.css"))
        try Data([0, 1, 2]).write(to: dir.appendingPathComponent("fonts/Inter.woff2"))
        try Data("x".utf8).write(to: dir.appendingPathComponent(".DS_Store"))
        try Data("x".utf8).write(to: dir.appendingPathComponent(".git/HEAD"))

        let files = try CvTemplateText.read(folder: dir)
        #expect(files.map(\.path) == ["fonts/Inter.woff2", "index.html", "style.css"])
        #expect(throws: CvTemplateText.ReadError.tooBig) { try CvTemplateText.read(folder: dir, maxBytes: 10) }

        let daemon = FakeDaemon()
        let (store, run) = try await connected(daemon)
        defer { run.cancel() }
        await store.openCvTemplate()
        let bundled = try #require(store.cvTemplate)
        #expect(CvTemplateText.title(bundled) == "Clean · default")
        #expect(CvTemplateText.files(bundled) == "index.html, style.css")

        #expect(await store.useCvTemplate(folder: dir))
        #expect(daemon.calls.contains("setCvTemplate Letterhead [\"fonts/Inter.woff2\", \"index.html\", \"style.css\"]"))
        #expect(store.cvTemplate.map(CvTemplateText.title) == "Letterhead · custom")

        // Without {{cv}} the daemon refuses; its reason is shown and the template stays.
        try Data("<html></html>".utf8).write(to: dir.appendingPathComponent("index.html"))
        #expect(await !store.useCvTemplate(folder: dir))
        #expect(store.lastError == "index.html has no {{cv}}: that's where the CV goes")
        #expect(store.cvTemplate?.custom == true)

        // A folder without index.html isn't sent.
        store.lastError = nil
        try FileManager.default.removeItem(at: dir.appendingPathComponent("index.html"))
        #expect(await !store.useCvTemplate(folder: dir))
        #expect(store.lastError == "A template needs an index.html (with {{cv}} where the CV goes).")

        await store.resetCvTemplate()
        #expect(store.cvTemplate?.custom == false)
        #expect(daemon.calls.contains("resetCvTemplate"))
        let many = CvTemplateInfo.with { $0.files = (1 ... 8).map { "f\($0).png" } }
        #expect(CvTemplateText.files(many, shown: 2) == "f1.png, f2.png + 6 more")
    }
}
