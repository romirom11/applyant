// Gap audit (noticeable gaps): model roles, the facts browser, CV edits on the review card,
// notifications for statuses a reply set, signing in to any site, and deleting stored keys.
import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

@MainActor
private func connected(_ daemon: FakeDaemon) async throws -> (AppStore, Task<Void, Never>) {
    let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
    let run = Task { await store.run() }
    try await eventually("connected") { store.connection == .connected }
    return (store, run)
}

private func fact(_ id: Int64, _ text: String, _ status: FactStatus, kind: String = "personal_contribution") -> Fact {
    .with {
        $0.id = id
        $0.text = text
        $0.status = status
        $0.kind = kind
        $0.origin = "extracted"
        $0.evidence = [.with {
            $0.sourceKind = .github
            $0.sourceLocator = "https://github.com/me/solovei"
            $0.locator = "commit:1a2b3c4d"
            $0.excerpt = "Add the call-analysis pipeline"
        }]
    }
}

@MainActor
@Suite struct GapParityTests {
    @Test func modelRolesChangeResetAndTheEmailOptIn() async throws {
        let daemon = FakeDaemon()
        let (store, run) = try await connected(daemon)
        defer { run.cancel() }
        await store.openModels()
        #expect(store.roles.map(\.role) == ["field_classify", "email_classify"])
        #expect(!RolesText.cloudEmail(store.roles))
        #expect(RolesText.line(store.roles[0]) == "jev (default) · falls back to claude:haiku")
        #expect(RolesText.title("email_classify") == "Email classify")

        // Jev only for decisions, the on-device model only for email.
        #expect(RolesText.routes(for: store.roles[0]).first == "jev")
        #expect(!RolesText.routes(for: store.roles[0]).contains("apple"))
        #expect(RolesText.routes(for: store.roles[1]) == ["apple", "claude:haiku", "claude:sonnet", "codex"])
        let writer = RoleRoute.with { $0.role = "application_writer"; $0.route = "claude:opus"; $0.defaultRoute = "claude:opus" }
        #expect(!RolesText.routes(for: writer).contains("jev") && !RolesText.routes(for: writer).contains("apple"))

        // Opting in routes email_classify to a cloud model; opting out resets it.
        await store.setCloudEmail(true)
        #expect(daemon.calls.contains("setRole email_classify claude:haiku"))
        #expect(RolesText.cloudEmail(store.roles))
        #expect(RolesText.line(store.roles[1]) == "claude:haiku · default apple")
        await store.setCloudEmail(false)
        #expect(daemon.calls.contains("resetRoles email_classify"))
        #expect(!RolesText.cloudEmail(store.roles))

        // A route the daemon refuses is shown, nothing changes.
        #expect(await !store.setRole("field_classify", route: "apple"))
        #expect(store.lastError == "the on-device model only reads email (email_classify)")
        #expect(store.roles[0].route == "jev")

        await store.setRole("field_classify", route: "claude:sonnet")
        await store.resetRoles()
        #expect(daemon.calls.contains("resetRoles all"))
        #expect(store.roles.allSatisfy { !$0.overridden })
    }

    @Test func theFactsBrowserConfirmsEditsAndRejects() async throws {
        let daemon = FakeDaemon()
        daemon.factsByRef = [
            "3": [fact(1, "Built the call-analysis pipeline", .unconfirmed), fact(2, "Team of four", .confirmed, kind: "team_context"),
                  fact(3, "Wrong claim", .unconfirmed)],
            "profile": [fact(9, "MSc in Computer Science", .unconfirmed, kind: "education")],
        ]
        let (store, run) = try await connected(daemon)
        defer { run.cancel() }

        await store.openFacts(project: 3)
        await store.openFacts(project: nil)
        #expect(daemon.calls.contains("listFacts 3") && daemon.calls.contains("listFacts profile"))
        let project = try #require(store.facts["3"])
        #expect(FactsText.shown(project, filter: .toConfirm).map(\.id) == [1, 3])
        #expect(FactsText.counts(project) == "2 to confirm · 1 confirmed")
        #expect(FactsText.kind(project[1]) == "Team context")
        #expect(FactsText.chip(project[0]) == Chip(text: "Unconfirmed", tone: .warning))
        #expect(FactsText.evidence(project[0].evidence[0]) == "GitHub · github.com/me/solovei · commit:1a2b3c4d")

        await store.confirmFacts([1], project: 3)
        #expect(daemon.calls.contains("confirmFacts [1]"))
        #expect(store.facts["3"]?.first { $0.id == 1 }?.status == .confirmed)

        #expect(await store.editFact(9, text: "  MSc in CS, 2014 ", project: nil))
        #expect(daemon.calls.contains("editFact 9 MSc in CS, 2014"))
        #expect(store.facts["profile"]?.first?.status == .confirmed)
        #expect(FactsText.origin(try #require(store.facts["profile"]?.first)) == "Your words")
        #expect(await !store.editFact(9, text: "   ", project: nil))

        await store.rejectFacts([3], project: 3)
        let after = try #require(store.facts["3"])
        #expect(FactsText.shown(after, filter: .toConfirm).isEmpty)
        // Rejected ones only under All, last.
        #expect(FactsText.shown(after, filter: .all).map(\.id) == [1, 2, 3])
        #expect(FactsText.chip(after[2]) == Chip(text: "Rejected", tone: .neutral))
    }

    @Test func cvLinesAreEditedFromTheReviewCard() async throws {
        var app = application(9, posting: 5, stage: .readyForReview)
        app.cv = .with {
            $0.mode = "tailored"
            $0.status = "ready"
            $0.pdfPath = "/tmp/cv/9-aaa.pdf"
            $0.summary = [.with { $0.handle = "s1"; $0.text = "AI engineer who ships" }]
            $0.projects = [.with {
                $0.number = 1
                $0.name = "Solovei"
                $0.bullets = [.with { $0.handle = "p1.1"; $0.text = "Built the STT pipeline" }]
            }]
            $0.education = [.with { $0.handle = "e1"; $0.text = "MSc CS" }]
            $0.dropped = [.with { $0.line = .with { $0.handle = "d1"; $0.text = "Sales calls" }; $0.section = "summary"; $0.reason = "no fact says so" }]
        }
        let daemon = FakeDaemon(postings: [posting(5, score: 88, title: "AI Engineer", appId: 9)], applications: [app])
        let (store, run) = try await connected(daemon)
        defer { run.cancel() }
        await store.openApplication(9)
        let lines = CvText.lines(try #require(store.applicationDetails[9]).cv)
        #expect(lines.map(\.handle) == ["s1", "p1.1", "e1", "d1"])
        #expect(lines.map(\.section) == ["Summary", "Solovei", "Education", "Left out · no fact says so"])
        #expect(lines.map(\.dropped) == [false, false, false, true])
        #expect(CvText.canEdit(try #require(store.applicationDetails[9])))

        #expect(await store.editCv(application: 9, line: "s1", text: "AI engineer who ships to production"))
        #expect(daemon.calls.contains("editCv 9 s1 AI engineer who ships to production"))
        // The CV is rendered again: the old preview is gone until the new PDF is ready.
        let edited = try #require(store.applicationDetails[9])
        #expect(edited.cv.summary.first?.text == "AI engineer who ships to production")
        #expect(edited.cv.status == "planned" && !edited.cv.hasPdfPath)
        #expect(await store.editCv(application: 9, line: "s1", text: nil))
        #expect(store.applicationDetails[9]?.cv.summary.isEmpty == true)

        var sent = app
        sent.stage = .applied
        #expect(!CvText.canEdit(sent))
        var base = app
        base.cv.mode = "base"
        #expect(!CvText.canEdit(base))
    }

    @Test func aReplyThatMovesAnApplicationNotifiesOnlyWhenLive() async throws {
        var app = application(9, posting: 5, stage: .applied)
        app.company = "Helix Labs"
        app.title = "AI Engineer"
        let daemon = FakeDaemon(postings: [posting(5, score: 88, title: "AI Engineer", appId: 9)], applications: [app])
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        var notes: [StoreNotification] = []
        store.onNotify = { notes.append($0) }
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }

        // A mail sync read an invite: the application moves and a notification says so.
        daemon.applications[9]?.stage = .interview
        daemon.applications[9]?.emails = [.with { $0.label = "interview"; $0.subject = "Tech call next week" }]
        var moved = Applyant_V1_ApplicationEvent()
        moved.applicationID = 9
        moved.postingID = 5
        moved.stage = .interview
        moved.fromMail = true
        daemon.feed.yield(event(80, .application(moved)))
        try await eventually("notified") { notes.count == 1 }
        #expect(notes[0].kind == .statusChange)
        #expect(notes[0].title == "Helix Labs invites you to an interview")
        #expect(notes[0].body == "AI Engineer · “Tech call next week”")

        // Set by hand (not from mail): no status notification.
        daemon.applications[9]?.stage = .offer
        moved.stage = .offer
        moved.fromMail = false
        daemon.feed.yield(event(81, .application(moved)))
        try await eventually("offer") { store.applications[9]?.stage == .offer }
        #expect(notes.count == 1)

        // A replayed event (not live) never notifies.
        daemon.applications[9]?.stage = .rejected
        moved.stage = .rejected
        moved.fromMail = true
        await store.apply(event(82, .application(moved)), live: false)
        #expect(store.applications[9]?.stage == .rejected)
        #expect(notes.count == 1)

        var rejected = app
        rejected.stage = .rejected
        rejected.emails = [.with { $0.label = "rejection"; $0.subject = "Update on your application" }]
        #expect(MailText.statusNotification(rejected)?.title == "Helix Labs isn't moving forward")
        rejected.stage = .offer
        rejected.clearCompany()
        #expect(MailText.statusNotification(rejected)?.title == "The company made you an offer")
        #expect(MailText.statusNotification(rejected)?.body == "AI Engineer")
        rejected.stage = .applied
        #expect(MailText.statusNotification(rejected) == nil)
    }

    @Test func signingInToAnySiteCanKeepItsLogin() async throws {
        // The same secret name as the daemon's loginSecretName (checked against it in node).
        #expect(SiteLogin.secretName("https://acme.wd3.myworkdayjobs.com/en-US/careers") == "login.acme.wd3.myworkdayjobs.com-en-us-careers")
        #expect(SiteLogin.secretName("linkedin") == "login.linkedin")
        #expect(SiteLogin.secretName("HTTP://Jobs.Example.com/?a=b&c=d//") == "login.jobs.example.com-a-b-c-d")
        #expect(SiteLogin.secretName("https://a-very-long-subdomain.of-some-tenant.myworkdayjobs.com/en-US/External_Careers/login")
            == "login.a-very-long-subdomain.of-some-tenant.myworkdayjobs.com-e")
        #expect(SiteLogin.target("djinni.co") == "https://djinni.co")
        #expect(SiteLogin.target("LinkedIn") == "linkedin")
        #expect(SiteLogin.target("not a site") == nil)
        #expect(SiteLogin.target("ftp://x.com") == nil)

        let daemon = FakeDaemon()
        let (store, run) = try await connected(daemon)
        defer { run.cancel() }

        // Only signing in: no secret stored.
        #expect(await store.signIn(site: "djinni.co", username: "", password: "") != nil)
        #expect(daemon.calls.contains("signIn https://djinni.co"))
        #expect(daemon.secrets.isEmpty)

        // With a login: kept first, under the CLI's name, as {"username","password"}.
        #expect(await store.signIn(site: "https://acme.wd3.myworkdayjobs.com/en-US/careers", username: " me@example.com ", password: "pw") != nil)
        let value = try #require(daemon.secrets["login.acme.wd3.myworkdayjobs.com-en-us-careers"])
        let login = try JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: String]
        #expect(login == ["username": "me@example.com", "password": "pw"])
        #expect(store.secretNames == ["login.acme.wd3.myworkdayjobs.com-en-us-careers"])

        // A username without a password, or no site: refused before anything is stored.
        #expect(await store.signIn(site: "djinni.co", username: "me", password: "") == nil)
        #expect(await store.signIn(site: "  ", username: "", password: "") == nil)
        #expect(daemon.secrets.count == 1)
    }

    @Test func storedKeysAreListedByNameAndDeleted() async throws {
        let daemon = FakeDaemon()
        daemon.secrets = ["capmonster": "k", "login.djinni.co": "{}", "mail.password": "p"]
        daemon.platformList.captchaSolver = true
        let (store, run) = try await connected(daemon)
        defer { run.cancel() }
        await store.openSecrets()
        #expect(store.secretNames == ["capmonster", "login.djinni.co", "mail.password"])
        #expect(store.secretNames.map(SecretsText.purpose) == ["Captcha solver (CapMonster)", "Login for djinni.co", "Mailbox password"])

        await store.deleteSecret("capmonster")
        #expect(daemon.calls.contains("deleteSecret capmonster"))
        #expect(store.secretNames == ["login.djinni.co", "mail.password"])
        // Settings' captcha line follows.
        #expect(store.platforms?.captchaSolver == false)
    }
}
