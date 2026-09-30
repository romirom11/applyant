// App parity with the CLI for setup (phase 16): the profile, projects and knowledge sources,
// search strategies and sources, and preferences, edited from the app.
import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

@MainActor
@Suite struct SetupParityTests {
    @Test func theProfileFormSendsOnlyWhatChanged() {
        var form = ProfileForm(entries: [
            .with { $0.key = "full_name"; $0.values = ["Roman Kudin"] },
            .with { $0.key = "github_logins"; $0.values = ["romirom11", "old-login"] },
            .with { $0.key = "phone"; $0.values = ["+30 690"] },
        ])
        #expect(form["github_logins"] == "romirom11, old-login")
        #expect(!form.hasChanges)
        form["full_name"] = "  Roman Kudin "
        #expect(!form.hasChanges)
        form["email"] = "me@example.com"
        form["phone"] = ""
        form["commit_emails"] = "me@example.com, me@work.com"
        form[ProfileForm.baseCvKey] = "/Users/me/cv.pdf"
        let changes = Dictionary(uniqueKeysWithValues: form.changes.map { ($0.key, $0.value) })
        #expect(changes == [
            "email": "me@example.com", "phone": "", "commit_emails": "me@example.com, me@work.com",
            "base_cv_file": "/Users/me/cv.pdf",
        ])
        // Every key `candidate profile set` knows for forms is on the form.
        let keys = Set(ProfileForm.fields.map(\.key))
        for key in ["full_name", "email", "phone", "location", "work_authorization", "visa_sponsorship", "relocation",
                    "salary_expectation", "notice_period", "current_company", "current_title", "links.github",
                    "links.website", "links.linkedin", "github_logins", "commit_emails"] {
            #expect(keys.contains(key), "\(key)")
        }
    }

    @Test func folderSourcesAreLabelledAsFolders() {
        #expect(KnowledgeText.sourceKind(for: "/Users/me/Projects/") == .file)
        #expect(KnowledgeText.sourceKind(for: "https://drive.google.com/drive/folders/1AbC") == .drive)

        let local = KnowledgeSource.with { $0.kind = .file; $0.locator = "/Users/me/Projects/"; $0.folder = true }
        #expect(KnowledgeText.kindName(local) == "Folder")
        #expect(KnowledgeText.title(local) == "Projects")
        let drive = KnowledgeSource.with { $0.kind = .drive; $0.locator = "folder:1AbC"; $0.folder = true }
        #expect(KnowledgeText.kindName(drive) == "Drive folder")
        #expect(KnowledgeText.title(drive) == "1AbC")
        #expect(KnowledgeText.kindName(.with { $0.kind = .file; $0.locator = "/Users/me/cv.pdf" }) == "File")
        #expect(KnowledgeText.kindName(.with { $0.kind = .drive; $0.locator = "https://docs.google.com/document/d/1Ab" }) == "Google Drive")
        #expect(KnowledgeText.kindName(.drive, folder: true) == "Drive folder")
        #expect(KnowledgeText.kindName(.github, folder: true) == "GitHub")

        #expect(KnowledgeText.removedLine(factsRemoved: 0) == "Removed the source · no facts went with it")
        #expect(KnowledgeText.removedLine(factsRemoved: 1) == "Removed the source · 1 fact went with it")
        #expect(KnowledgeText.removedLine(factsRemoved: 7) == "Removed the source · 7 facts went with it")
    }

    @Test func knowledgeSourceKindsAndSyncState() {
        #expect(KnowledgeText.sourceKind(for: "/Users/me/cv.pdf") == .file)
        #expect(KnowledgeText.sourceKind(for: "https://github.com/me/solovei") == .github)
        #expect(KnowledgeText.sourceKind(for: "https://github.com/me") == .url)
        #expect(KnowledgeText.sourceKind(for: "https://docs.google.com/document/d/1Ab/edit") == .drive)
        #expect(KnowledgeText.sourceKind(for: "https://acme.dev/case-study") == .url)

        var s = KnowledgeSource.with { $0.kind = .github; $0.locator = "https://github.com/me/solovei" }
        #expect(KnowledgeText.title(s) == "github.com/me/solovei")
        #expect(KnowledgeText.syncState(s) == .waiting)
        #expect(KnowledgeText.syncLine(s) == "Waiting for its first sync")
        s.lastSyncedAt = .init(date: Date(timeIntervalSince1970: 1_790_000_000))
        s.syncNote = "12 new facts, 0 already known, 0 dropped"
        #expect(KnowledgeText.syncState(s) == .synced)
        #expect(KnowledgeText.syncLine(s).hasPrefix("Synced "))
        #expect(KnowledgeText.syncLine(s).hasSuffix("· 12 new facts, 0 already known, 0 dropped"))
        s.syncNote = "sync failed: 404 not found"
        #expect(KnowledgeText.chip(s) == Chip(text: "Failed", tone: .warning))
        #expect(KnowledgeText.syncLine(s) == "Sync failed: 404 not found")
        #expect(KnowledgeText.title(.with { $0.kind = .file; $0.locator = "/Users/me/cv.pdf" }) == "cv.pdf")

        let p = KnowledgeProject.with { $0.sourceCount = 1; $0.factCount = 24; $0.unconfirmedCount = 5 }
        #expect(KnowledgeText.projectLine(p) == "1 source · 24 facts (5 to confirm)")
    }

    @Test func aStrategyFormRoundTripsAndReplacesEverything() {
        var form = StrategyForm()
        #expect(form.problem != nil)
        form.name = " AI Engineer · Remote EU "
        form.queries = "ai engineer\n\n llm engineer \n-intern"
        form.remote = true
        form.locations = "Athens, Cyprus"
        form.sources = ""
        form.everyHours = 12
        let add = form.addRequest
        #expect(add.name == "AI Engineer · Remote EU")
        #expect(add.queries == ["ai engineer", "llm engineer", "-intern"])
        #expect(add.locations == ["remote", "Athens", "Cyprus"])
        #expect(add.sources == ["all"])
        #expect(add.everyMinutes == 720)
        #expect(!add.paused)

        let strategy = SearchStrategy.with {
            $0.id = 7
            $0.name = "Backend"
            $0.queries = ["backend engineer"]
            $0.locations = ["Remote", "Berlin"]
            $0.sources = ["greenhouse", "board:hn"]
            $0.everyMinutes = 360
            $0.state = "paused"
        }
        var edit = StrategyForm(strategy)
        #expect(edit.remote && edit.locations == "Berlin" && edit.sources == "greenhouse, board:hn")
        #expect(edit.everyHours == 6 && edit.paused)
        edit.queries = ""
        edit.remote = false
        let update = edit.updateRequest(7)
        #expect(update.strategy == "7")
        // An empty list is sent (it clears); the state follows the toggle.
        #expect(update.hasQueries && update.queries.values.isEmpty)
        #expect(update.locations.values == ["Berlin"])
        #expect(update.sources.values == ["greenhouse", "board:hn"])
        #expect(update.state == "paused" && update.everyMinutes == 360)
    }

    @Test func thePreferencesFormCoversEveryKeyPrefsSetTakes() {
        let prefs = SearchPreferences.with {
            $0.roles = ["backend", "ai_ml"]
            $0.basedIn = "GR"
            $0.remote = "preferred"
            $0.salary = .with { $0.amount = 4500; $0.currency = "EUR"; $0.period = "month" }
            $0.languages = ["en": "C1", "el": "native"]
            $0.dealbreakers = ["outstaffing"]
            $0.threshold = 70
            $0.weights = ["must": 35, "nice": 10, "role": 15, "location": 10, "remote": 10, "salary": 10,
                          "language": 5, "employment": 5, "company": 10]
        }
        var form = PreferencesForm(prefs)
        #expect(form["salary"] == "4500 EUR/month")
        #expect(form["languages"] == "el:native, en:C1")
        #expect(form["based_in"] == "GR")
        #expect(!form.hasChanges)
        form["seniority"] = "senior, lead"
        form["based_in"] = ""
        form.remote = "required"
        form.dealbreakers.insert("onsite")
        form.threshold = 75
        form.weights["salary"] = 20
        let changes = form.changes.map { "\($0.key)=\($0.value)" }
        #expect(changes == ["seniority=senior, lead", "based_in=", "remote=required", "dealbreakers=outstaffing,onsite",
                            "threshold=75", "weight.salary=20"])
        #expect(PreferencesText.summary(prefs).contains("dealbreakers: outstaffing"))
        #expect(PreferencesText.summary(nil) == "Not loaded yet")
    }

    @Test func boardAndCareerPageInput() {
        #expect(SourceInput.url("acme.com/careers") == "https://acme.com/careers")
        #expect(SourceInput.url(" https://boards.greenhouse.io/gitlab ") == "https://boards.greenhouse.io/gitlab")
        #expect(SourceInput.url("not a url") == nil)
        #expect(SourceInput.url("localhost") == nil)
        #expect(SourceInput.url("") == nil)
    }

    private func connected(_ daemon: FakeDaemon) async throws -> (AppStore, Task<Void, Never>) {
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        try await eventually("connected") { store.connection == .connected }
        return (store, run)
    }

    @Test func profileAndProjectsAgainstTheDaemon() async throws {
        let daemon = FakeDaemon()
        daemon.profileValues = ["full_name": "Roman Kudin"]
        let (store, run) = try await connected(daemon)
        defer { run.cancel() }

        await store.openProfile()
        var form = ProfileForm(entries: store.candidateProfile?.profile ?? [])
        #expect(form["full_name"] == "Roman Kudin")
        form["location"] = "Athens, Greece"
        form["email"] = "not-an-email"
        // The daemon's refusal stops the save and is shown; what saved before it stays.
        #expect(!(await store.saveProfile(form)))
        #expect(store.lastError?.contains("not an email") == true)
        form["email"] = "me@example.com"
        #expect(await store.saveProfile(form))
        #expect(daemon.profileValues["location"] == "Athens, Greece" && daemon.profileValues["email"] == "me@example.com")
        #expect(!daemon.calls.contains("setProfileValue full_name"))
        #expect(await store.setBaseCv("/Users/me/cv.pdf"))
        #expect(store.candidateProfile?.profile.contains { $0.key == "base_cv_file" } == true)

        // A project, a repo and a file in it, a sync, a rename, then removing it.
        let id = try #require(await store.createProject("  Solovei "))
        #expect(store.navigation.project == id)
        #expect(store.knowledgeProjects.map(\.name) == ["Solovei"])
        #expect(await store.createProject("   ") == nil)
        #expect(await store.addKnowledgeSource(to: id, "https://github.com/me/solovei"))
        #expect(await store.addKnowledgeSource(to: id, "/Users/me/solovei.md"))
        #expect(daemon.calls.contains("addKnowledgeSource project \(id) github https://github.com/me/solovei"))
        await store.openProject(id)
        #expect(store.projectSources[id]?.map(\.kind) == [.github, .file])
        #expect(store.knowledgeProject(id)?.sourceCount == 2)
        let source = try #require(store.projectSources[id]?.first)
        #expect(await store.syncKnowledge(source: source.id) == 1)
        #expect(await store.syncKnowledge(project: id) == 1)
        #expect(await store.syncKnowledge() == 1)
        #expect(daemon.calls.contains("syncSources source:\(source.id)"))
        #expect(daemon.calls.contains("syncSources \(id)"))
        #expect(daemon.calls.contains("syncSources profile"))
        // A profile source (no project).
        #expect(await store.addKnowledgeSource(to: nil, "https://docs.google.com/document/d/1Ab/edit"))
        #expect(store.candidateProfile?.profileSources.map(\.kind) == [.drive])

        // Removing a source: its facts go with it, the views reload.
        let fileSource = try #require(store.projectSources[id]?.last)
        #expect(await store.deleteSource(fileSource.id) == 2)
        #expect(daemon.calls.contains("deleteSource \(fileSource.id)"))
        #expect(store.projectSources[id]?.map(\.kind) == [.github])
        #expect(store.knowledgeProject(id)?.sourceCount == 1)

        #expect(await store.renameProject(id, to: "Solovei Voice"))
        #expect(store.knowledgeProject(id)?.name == "Solovei Voice")
        await store.deleteProject(id)
        #expect(store.knowledgeProjects.isEmpty)
        #expect(store.navigation.project == nil && store.projectSources[id] == nil)
    }

    @Test func strategiesSourcesAndPreferencesAgainstTheDaemon() async throws {
        let daemon = FakeDaemon()
        daemon.prefs = .with { $0.remote = "any"; $0.threshold = 70; $0.weights = ["must": 35] }
        let (store, run) = try await connected(daemon)
        defer { run.cancel() }

        // New strategy: nothing is sent without a name.
        #expect(await store.saveStrategy(StrategyForm()) == nil)
        #expect(store.lastError == "Give the strategy a name.")
        var form = StrategyForm()
        form.name = "AI Engineer"
        form.queries = "ai engineer"
        form.remote = true
        let id = try #require(await store.saveStrategy(form))
        #expect(store.navigation.search == .strategy(id))
        #expect(store.strategy(id)?.locations == ["remote"])
        // Edit: every field replaced.
        var edit = StrategyForm(try #require(store.strategy(id)))
        edit.name = "AI / LLM Engineer"
        edit.paused = true
        #expect(await store.saveStrategy(edit, id: id) == id)
        #expect(store.strategy(id)?.name == "AI / LLM Engineer" && store.strategy(id)?.state == "paused")
        #expect(daemon.calls.contains("updateStrategy \(id)"))
        await store.deleteStrategy(id)
        #expect(store.strategy(id) == nil && store.navigation.search == nil)

        // A board or career page by URL: the daemon works out what it is.
        store.lastError = nil
        #expect(await store.addBoardOrPage("not a url") == nil)
        #expect(store.lastError == "That isn't a web address.")
        let source = try #require(await store.addBoardOrPage("acme.com/careers"))
        #expect(daemon.calls.contains("addSearchSource  https://acme.com/careers"))
        #expect(store.navigation.search == .source(source.key))

        // Preferences after setup: only what changed, one key at a time; a refusal stops it.
        await store.openPreferences()
        var prefs = PreferencesForm(try #require(store.searchPreferences))
        prefs.dealbreakers = ["onsite", "outstaffing"]
        prefs.weights["must"] = 40
        prefs["salary"] = "4500 EUR"
        #expect(!(await store.savePreferences(prefs)))
        #expect(store.lastError == "say per month or per year")
        prefs["salary"] = "4500 EUR/month"
        #expect(await store.savePreferences(prefs))
        #expect(daemon.preferences == ["salary": "4500 EUR/month", "dealbreakers": "outstaffing,onsite", "weight.must": "40"])
    }
}
