import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

func freshSetup(_ states: [String: String] = [:]) -> OnboardingStatus {
    .with { s in
        s.steps = OnboardingStep.allCases.map { step in
            .with { $0.step = step.rawValue; $0.state = states[step.rawValue] ?? "pending" }
        }
        s.setupDone = s.steps.allSatisfy { $0.state != "pending" }
        s.searchStarted = states["preferences"] == "done"
        s.jev = .with { $0.connected = false; $0.detail = "Without it, small decisions use claude:haiku" }
    }
}

@MainActor
@Suite struct OnboardingTests {
    @Test func theStateMachineWalksTheFourStepsInOrder() {
        var flow = OnboardingFlow(status: freshSetup())
        #expect(flow.current == .connections)
        #expect(!flow.isFinished && !flow.searchStarted)
        // Forward only as far as the first unsettled step; nothing can jump past it.
        #expect(!flow.canOpen(.preferences))
        flow.open(.interview)
        #expect(flow.current == .connections)

        do { let ok = flow.settle(.connections, as: "skipped"); #expect(ok) }
        #expect(flow.current == .importing)
        do { let ok = flow.settle(.importing, as: "done"); #expect(ok) }
        #expect(flow.current == .preferences)
        // Preferences can't be skipped or left for later: search starts from it.
        #expect(OnboardingStep.preferences.skipState == nil)
        do { let ok = flow.settle(.preferences, as: "skipped"); #expect(!ok) }
        do { let ok = flow.settle(.preferences, as: "later"); #expect(!ok) }
        #expect(flow.current == .preferences && !flow.searchStarted)
        do { let ok = flow.settle(.preferences, as: "done"); #expect(ok) }
        #expect(flow.searchStarted)
        #expect(flow.current == .interview)
        // The interview's "Later" is its skip; "skipped" isn't.
        do { let ok = flow.settle(.interview, as: "skipped"); #expect(!ok) }
        do { let ok = flow.settle(.interview, as: "later"); #expect(ok) }
        #expect(flow.isFinished)
        // Everything is reachable once settled.
        flow.open(.connections)
        #expect(flow.current == .connections)
    }

    @Test func resumesAtTheFirstUnsettledStepAndTakesTheDaemonsWord() {
        var flow = OnboardingFlow(status: freshSetup(["connections": "done", "import": "skipped"]))
        #expect(flow.current == .preferences)
        #expect(flow.canOpen(.connections) && flow.canOpen(.preferences) && !flow.canOpen(.interview))
        flow.open(.connections)
        // Another client finished Preferences: the open step stays, and search has started.
        flow.merge(freshSetup(["connections": "done", "import": "skipped", "preferences": "done"]))
        #expect(flow.current == .connections)
        #expect(flow.searchStarted && flow.canOpen(.interview))
        #expect(OnboardingText.search(flow).hasPrefix("Search has started"))
        #expect(OnboardingText.search(OnboardingFlow()) == "Search starts when you finish Preferences.")
    }

    @Test func textsForConnectionsAndTheImport() {
        #expect(OnboardingText.connection(.with { $0.connected = true; $0.detail = "me@gmail.com (Gmail)" }) == "me@gmail.com (Gmail)")
        #expect(OnboardingText.connection(.with { $0.detail = "Without your login, …" }) == "Not connected · Without your login, …")
        #expect(OnboardingText.tool("Claude Code", .with { $0.found = false; $0.error = "not in ~/.local/bin" }) == "Claude Code not found: not in ~/.local/bin · install Claude Code, sign in, then press Check again")
        #expect(OnboardingText.tool("Codex", .with { $0.found = true; $0.path = "/x/codex"; $0.signedIn = false }).contains("codex login"))
        #expect(OnboardingText.importProgress(nil) == "Nothing imported yet")
        var s = freshSetup()
        s.import = .with { $0.sources = 2; $0.syncing = 1; $0.facts = 14; $0.projects = 3 }
        #expect(OnboardingText.importProgress(s) == "2 sources · 1 reading · 14 facts in 3 projects")
        #expect(OnboardingText.sourceKind(for: "https://docs.google.com/document/d/abc/edit") == .drive)
        #expect(OnboardingText.sourceKind(for: "https://example.dev/case-study") == .url)
    }

    @Test func showsOnFirstLaunchAndRunsTheStepsAgainstTheDaemon() async throws {
        let daemon = FakeDaemon()
        daemon.setupState = freshSetup()
        daemon.draft = [
            .with { $0.key = "roles"; $0.value = "backend, ai_ml"; $0.reason = "From your CV: \"Senior Backend Engineer\"" },
            .with { $0.key = "based_in"; $0.value = "GR"; $0.reason = "Your profile's location" },
        ]
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        #expect(store.showOnboarding)
        #expect(store.onboarding.current == .connections)

        // 1 · Connections: the GitHub login and the Jev key, then on.
        await store.setGithubLogin(" romirom11 ")
        #expect(daemon.profileValues["github_logins"] == "romirom11")
        #expect(store.setup?.github.connected == true)
        await store.setJevKey("jev-key")
        #expect(daemon.secrets["jev"] == "jev-key")
        #expect(await store.settleStep(.connections))
        #expect(store.onboarding.current == .importing)

        // 2 · Import: a CV path and a Google Doc.
        #expect(await store.importSource("/Users/me/cv.pdf"))
        #expect(await store.importSource("https://docs.google.com/document/d/1AbCdEfGhIjK/edit"))
        #expect(daemon.calls.contains("addKnowledgeSource file /Users/me/cv.pdf"))
        #expect(daemon.calls.contains { $0.hasPrefix("addKnowledgeSource drive ") })
        #expect(OnboardingText.importProgress(store.setup) .hasPrefix("2 sources · 2 reading"))
        #expect(await store.settleStep(.importing))

        // 3 · Preferences: pre-filled, a bad value keeps the step open, then search starts.
        await store.loadPreferencesDraft()
        #expect(store.preferencesDraft.map(\.key) == ["roles", "based_in"])
        #expect(!(await store.confirmPreferences([("roles", "backend"), ("salary", "4000 EUR")])))
        #expect(store.lastError == "say per month or per year")
        #expect(!store.onboarding.searchStarted)
        store.lastError = nil
        #expect(await store.confirmPreferences([("roles", "backend, ai_ml"), ("based_in", "GR"), ("salary", " ")]))
        #expect(daemon.preferences == ["roles": "backend, ai_ml", "based_in": "GR"])
        #expect(store.onboarding.searchStarted && store.setup?.searchStarted == true)
        #expect(store.onboarding.current == .interview)
        #expect(daemon.calls.contains("setSetupStep preferences done"))

        // 4 · Interview: "Later" settles it and closes the window; the setup stays reachable.
        #expect(await store.settleStep(.interview, as: "later"))
        #expect(!store.showOnboarding)
        #expect(store.setup?.setupDone == true)
        await store.openOnboarding()
        #expect(store.showOnboarding)
    }

    @Test func notShownWhenSetupIsDoneOrTheDaemonIsOlder() async throws {
        for state in [freshSetup(["connections": "done", "import": "done", "preferences": "done", "interview": "later"]), nil] {
            let daemon = FakeDaemon()
            daemon.setupState = state
            let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
            let run = Task { await store.run() }
            try await eventually("connected") { store.connection == .connected }
            #expect(!store.showOnboarding)
            run.cancel()
        }
    }
}

/// The Import step shows what was imported and how its reading goes, live from sync events; the
/// Connections step's Telegram and captcha key update the setup's state.
@MainActor
@Suite struct OnboardingImportTests {
    private func syncEvent(_ id: Int64, source: Int64, _ type: Applyant_V1_TaskEventType, message: String = "") -> DaemonEvent {
        var e = event(id, .task(.with {
            $0.taskID = 900 + id
            $0.taskKind = "sync_source"
            $0.entityID = source
            $0.type = type
        }))
        e.message = message
        return e
    }

    @Test func thePickedFileIsListedAndFollowsItsReadingLive() async throws {
        let daemon = FakeDaemon()
        daemon.setupState = freshSetup(["connections": "done"])
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        #expect(store.importRows.isEmpty)

        // Picked: listed at once, being read.
        #expect(await store.importSource("/Users/me/Documents/roman_cv.pdf"))
        let row = try #require(store.importRows.first)
        #expect(row.title == "roman_cv.pdf" && row.kind == "File" && row.state == .reading)
        #expect(row.line == "Reading roman_cv.pdf…")
        #expect(OnboardingText.importProgress(store.setup) == "1 source · 1 reading · 0 facts in 0 projects")

        // The daemon starts it, a transient failure, then it's read: no Refresh needed.
        daemon.feed.yield(syncEvent(1, source: row.id, .started))
        try await eventually("reading") { store.sourceSync[row.id] == .reading }
        daemon.feed.yield(syncEvent(2, source: row.id, .retry, message: "retry at 2026-09-30T12:00:00.000Z: fetch failed"))
        try await eventually("retrying") { store.importRows.first?.line == "Reading roman_cv.pdf… couldn't yet, trying again (fetch failed)" }

        daemon.profileSources[0].lastSyncedAt = .init(date: Date())
        daemon.profileSources[0].syncNote = "33 new facts, 0 already known, 0 dropped · 13 projects created · File · roman_cv.pdf · 2 pages"
        daemon.setupState?.import = .with { $0.sources = 1; $0.facts = 33; $0.projects = 13 }
        daemon.feed.yield(syncEvent(3, source: row.id, .done))
        try await eventually("read") { store.importRows.first?.state == .read }
        #expect(store.importRows.first?.line == "33 new facts · 13 projects created")
        #expect(store.sourceSync[row.id] == nil)
        #expect(OnboardingText.importProgress(store.setup) == "1 source · 33 facts in 13 projects")

        // A link that can't be read says why, in the list.
        #expect(await store.importSource("https://example.dev/case"))
        let link = try #require(store.importRows.first)
        #expect(link.title == "example.dev/case" && link.kind == "Page")
        daemon.profileSources[1].syncNote = "sync failed: HTTP 404"
        daemon.feed.yield(syncEvent(4, source: link.id, .done))
        try await eventually("failed") { store.importRows.first?.state == .failed }
        #expect(store.importRows.first?.line == "Sync failed: HTTP 404")

        // A refused import is the store's error (the step shows it inline), and nothing is listed.
        #expect(!(await store.importSource("/Users/me/missing.pdf")))
        #expect(store.lastError == "no file at /Users/me/missing.pdf")
        #expect(store.importRows.count == 2)
    }

    @Test func telegramAndTheCaptchaKeyUpdateTheConnections() async throws {
        let daemon = FakeDaemon()
        daemon.setupState = freshSetup()
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        let asked = daemon.calls.filter { $0 == "setupStatus" }.count

        await store.setCaptchaKey(" cm-key ")
        #expect(daemon.secrets["capmonster"] == "cm-key")
        #expect(store.platforms?.captchaSolver == true)
        await store.connectTelegram(.start(.with { $0.phone = "+30 690 000 0000" }))
        #expect(store.telegram?.state == .waitingCode)
        // Each asks the setup again, so the step's rows follow.
        #expect(daemon.calls.filter { $0 == "setupStatus" }.count == asked + 2)

        #expect(await store.setGithubLogin("romirom11, ro-work"))
        #expect(OnboardingText.githubLogins(store.setup) == "romirom11, ro-work")
        #expect(!(await store.setGithubLogin("  ")))
    }

    @Test func textsForTheImportList() {
        #expect(OnboardingText.readNote("33 new facts, 0 already known, 0 dropped · 13 projects created · File · cv.pdf · 2 pages") == "33 new facts · 13 projects created")
        #expect(OnboardingText.readNote("1 new facts, 4 already known, 0 dropped · 1 projects created · Page · acme.dev") == "1 new fact, 4 already known · 1 project created")
        #expect(OnboardingText.readNote("0 new facts, 0 already known, 0 dropped · Page · acme.dev") == "no new facts")
        #expect(OnboardingText.readNote("unchanged since the last sync · File · cv.pdf") == "Read · unchanged since the last time")
        #expect(OnboardingText.readNote("") == "Read")

        let denied = KnowledgeSource.with { $0.id = 1; $0.kind = .file; $0.locator = "/Users/me/Downloads/cv.pdf"; $0.syncNote = "sync failed: EPERM: operation not permitted, open '/Users/me/Downloads/cv.pdf'" }
        let row = OnboardingText.importRow(denied, sync: nil)
        #expect(row.state == .failed && row.line.contains("Privacy & Security"))
        #expect(OnboardingText.importRow(denied, sync: .failed("gave up after 3 attempts: boom")).line == "Couldn't read it: gave up after 3 attempts: boom")

        #expect(SourceSync.after(.queued, message: "", before: nil) == .reading)
        #expect(SourceSync.after(.progress, message: "page 2", before: nil) == .reading)
        #expect(SourceSync.after(.retry, message: "retry at 2026-09-30T12:00:00.000Z: fetch failed", before: .reading) == .retrying("fetch failed"))
        #expect(SourceSync.after(.done, message: "", before: .reading) == nil)
        #expect(SourceSync.after(.failed, message: "gave up", before: .reading) == .failed("gave up"))
        #expect(OnboardingText.githubLogins(nil) == "")
    }
}
