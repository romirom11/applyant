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
        #expect(OnboardingText.tool("Claude Code", .with { $0.found = false; $0.error = "not in ~/.local/bin" }) == "Claude Code not found: not in ~/.local/bin")
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
