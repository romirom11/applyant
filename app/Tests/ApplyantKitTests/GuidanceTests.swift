// What the app says so nobody has to guess (the UX audit's fixes): running work in plain words,
// empty lists that say what they wait for, the Approve confirmation, imported files copied into
// Applyant's own folder, required and optional connections, and preference choices.
import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

@MainActor
@Suite struct GuidanceTests {
    @Test func runningWorkReadsInPlainWords() {
        #expect(TaskText.phrase("score_posting") == "scoring a posting")
        #expect(TaskText.phrase("verify_posting", count: 3) == "checking 3 postings")
        #expect(TaskText.phrase("something_new") == "something new")
        #expect(TaskText.summary([1: "score_posting", 2: "score_posting", 3: "sync_source"]) == "reading a source, scoring 2 postings")
        var activity = Activity()
        #expect(ActivityText.line(activity, deliveries: [:]) { _ in "" } == nil)
        activity.running = [7: "prepare_application"]
        #expect(ActivityText.line(activity, deliveries: [:]) { _ in "" } == "Working: preparing an application")
        activity.paused = "Waiting for claude limit · resumes 15:45"
        #expect(ActivityText.line(activity, deliveries: [:]) { _ in "" }?.hasPrefix("Waiting for claude limit · resumes 15:45") == true)
    }

    @Test func anEmptyInboxSaysWhatItWaitsFor() {
        let idle = Activity()
        let none = ActivityText.empty(.inbox, activity: idle, postings: [], strategies: 0, searchStarted: true)
        #expect(none.title == "No postings yet")
        #expect(none.detail.contains("Add posting…") && none.detail.contains("Search"))
        let beforeSetup = ActivityText.empty(.inbox, activity: idle, postings: [], strategies: 0, searchStarted: false)
        #expect(beforeSetup.detail.contains("Preferences"))

        var found = Posting()
        found.stage = .found
        var verified = Posting()
        verified.stage = .verified
        let pending = ActivityText.empty(.inbox, activity: idle, postings: [found, verified], strategies: 1, searchStarted: true)
        #expect(pending.detail.hasPrefix("2 postings are being checked and scored"))

        var paused = Activity()
        paused.paused = "Waiting for claude limit · resumes 15:45"
        let waiting = ActivityText.empty(.inbox, activity: paused, postings: [found], strategies: 1, searchStarted: true)
        #expect(waiting.title == "Waiting" && waiting.detail.contains("resumes 15:45"))
        // Every list section explains itself.
        for section in [Section.readyToReview, .preparing, .interested, .skipped, .applied, .interviews, .offers] {
            #expect(!ActivityText.empty(section, activity: idle, postings: [], strategies: 0, searchStarted: true).detail.isEmpty, "\(section)")
        }
    }

    @Test func approveSaysWhereItGoesAndThatItIsSent() {
        var app = Application()
        app.company = "Helix"
        app.channel = "web_form"
        #expect(ApproveText.title(app) == "Send this application to Helix?")
        #expect(ApproveText.message(app).contains("the company's application form"))
        #expect(ApproveText.message(app).contains("can't be undone"))
        app.applyForm = .platform
        #expect(ApproveText.channel(app).contains("Easy Apply"))
        app.channel = "email"
        #expect(ApproveText.channel(app) == "email from your mailbox")
        app.channel = "telegram"
        #expect(ApproveText.channel(app).contains("Telegram"))
        #expect(ApproveText.retryMessage.contains("I submitted it"))

        // Back to review: only an approved application whose delivery stopped.
        app.stage = .approved
        #expect(!ApproveText.canReturnToReview(app))
        app.handOff = .with { $0.reason = "captcha" }
        #expect(ApproveText.canReturnToReview(app))
        #expect(!ApproveText.mayHaveBeenSent(app))
        app.handOff.reason = "Submit was already pressed, so this application may have been sent: no confirmation appeared"
        #expect(ApproveText.mayHaveBeenSent(app))
        app.handOff.reason = "Applyant pressed submit at 14:02 and was interrupted"
        #expect(ApproveText.mayHaveBeenSent(app))
        app.stage = .applied
        #expect(!ApproveText.canReturnToReview(app))
    }

    @Test func aReviewOpensInTheListItsStagePutsItIn() {
        var nav = Navigation()
        nav.showReview(application: 1, posting: 2, stage: .approved)
        #expect(nav.section == .applied && nav.reviewing == 1 && nav.postingId == 2)
        nav.showReview(application: 1, posting: 2, stage: .interview)
        #expect(nav.section == .interviews)
        nav.showReview(application: 1, posting: 2, stage: .offer)
        #expect(nav.section == .offers)
        nav.showReview(application: 1, posting: 2, stage: .preparing)
        #expect(nav.section == .preparing)
        nav.showReview(application: 1, posting: 2, stage: .needsCandidate)
        #expect(nav.section == .readyToReview)
        nav.showReview(application: 1, posting: 2)
        #expect(nav.section == .readyToReview)
    }

    @Test func reviewStringsAreReadable() {
        #expect(FieldText.source("override") == "set for this application")
        #expect(FieldText.source("profile") == "from your profile")
        #expect(FieldText.source("none") == "")
        var s = Applyant_V1_AnswerSentence()
        s.flag = "verifier:scope"
        s.note = "the fact is about one bug fix"
        #expect(ReviewRules.flagText(s) == "Claims more than its facts say: the fact is about one bug fix")
        s.flag = "some_new_flag"
        #expect(ReviewRules.flagText(s) == "Flagged: some new flag")
    }

    @Test func aPickedFileIsCopiedOnceAndNeverClobbered() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("applyant-import-\(UUID().uuidString)")
        let data = root.appendingPathComponent("data")
        let downloads = root.appendingPathComponent("Downloads")
        try fm.createDirectory(at: downloads, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let cv = downloads.appendingPathComponent("cv.pdf")
        try Data("one".utf8).write(to: cv)

        let copy = try ImportedFile.copy(cv, dataDir: data)
        #expect(copy.path == data.appendingPathComponent("files/imports/cv.pdf").path)
        #expect(try Data(contentsOf: copy) == Data("one".utf8))
        // The same file again: the same copy.
        #expect(try ImportedFile.copy(cv, dataDir: data) == copy)
        // A different file with that name: beside it, not over it.
        try Data("two".utf8).write(to: cv)
        let second = try ImportedFile.copy(cv, dataDir: data)
        #expect(second.lastPathComponent == "cv 2.pdf")
        #expect(try Data(contentsOf: copy) == Data("one".utf8))
        // A file already in the data directory, and a folder, stay where they are.
        #expect(try ImportedFile.copy(copy, dataDir: data) == copy)
        #expect(try ImportedFile.copy(downloads, dataDir: data) == downloads)
        #expect(throws: APIError.self) { try ImportedFile.copy(downloads.appendingPathComponent("gone.pdf"), dataDir: data) }

        #expect(ImportedFile.isCv("/a/cv.PDF") && ImportedFile.isCv("/a/cv.docx"))
        #expect(!ImportedFile.isCv("/a/notes.md"))
    }

    @Test func connectionsSayWhatIsRequired() {
        #expect(ConnectionText.claude.required && ConnectionText.claude.tag == "Required")
        for note in [ConnectionText.codex, ConnectionText.jev, ConnectionText.github, ConnectionText.mailbox,
                     ConnectionText.telegram, ConnectionText.captcha] {
            #expect(!note.required && note.tag == "Optional" && !note.purpose.isEmpty)
        }
        #expect(ConnectionText.jev.purpose.contains("Claude Haiku"))

        var status = OnboardingStatus()
        #expect(ConnectionText.claudeProblem(nil) == nil)
        #expect(ConnectionText.claudeProblem(status)?.contains("wasn't found") == true)
        status.claude.found = true
        #expect(ConnectionText.claudeProblem(status)?.contains("isn't signed in") == true)
        #expect(ConnectionText.signInCommand("Claude Code", status.claude) == "claude")
        #expect(ConnectionText.signInCommand("Codex", status.claude) == "codex login")
        status.claude.signedIn = true
        #expect(ConnectionText.claudeProblem(status) == nil)
        #expect(ConnectionText.signInCommand("Claude Code", status.claude) == nil)

        // The setup's footer isn't green while Claude is missing.
        var flow = OnboardingFlow(states: [.connections: "done", .importing: "done", .preferences: "done"], searchStarted: true)
        #expect(OnboardingText.search(flow, status: status).ok)
        status.claude.signedIn = false
        let waiting = OnboardingText.search(flow, status: status)
        #expect(!waiting.ok && waiting.text.contains("Claude Code"))
        flow = OnboardingFlow()
        #expect(!OnboardingText.search(flow, status: status).ok)
        #expect(OnboardingText.tool("Claude Code", Applyant_V1_ToolStatus()).contains("install Claude Code"))
    }

    @Test func theGithubSectionShowsTheCliSignIn() {
        var gh = Applyant_V1_ToolStatus()
        // Not installed: what still works, and the command that fixes it.
        var cli = ConnectionText.githubCli(gh)
        #expect(!cli.ok && cli.text.contains("isn't installed") && cli.command == "brew install gh && gh auth login")
        gh.found = true
        cli = ConnectionText.githubCli(gh)
        #expect(!cli.ok && cli.text.contains("isn't signed in") && cli.command == "gh auth login")
        gh.signedIn = true
        gh.account = "romirom11"
        cli = ConnectionText.githubCli(gh)
        #expect(cli.ok && cli.text.contains("signed in as romirom11") && cli.command == nil)
        // The account is offered as the login only while none is saved.
        #expect(ConnectionText.suggestedGithubLogin(saved: "", gh) == "romirom11")
        #expect(ConnectionText.suggestedGithubLogin(saved: "work-login", gh) == nil)
        gh.signedIn = false
        #expect(ConnectionText.suggestedGithubLogin(saved: "", gh) == nil)
    }

    @Test func preferenceChoicesKeepTheDaemonsKeys() {
        #expect(PreferenceChoices.keys(" Senior, lead ,") == ["senior", "lead"])
        #expect(PreferenceChoices.toggled("senior", "lead", among: PreferenceChoices.seniority) == "senior, lead")
        #expect(PreferenceChoices.toggled("lead, senior", "senior", among: PreferenceChoices.seniority) == "lead")
        // The choices' order, whatever order they were picked in.
        #expect(PreferenceChoices.toggled("head", "junior", among: PreferenceChoices.seniority) == "junior, head")
        #expect(PreferenceChoices.dealbreaker("outstaffing") == "Outstaffing or agency work")
        #expect(PreferenceChoices.weight("must") == "Must-haves")
        #expect(Set(PreferenceChoices.dealbreakers.map(\.key)) == Set(PreferencesForm.dealbreakers))
        #expect(PreferenceChoices.remote.map(\.key) == PreferencesForm.remoteOptions)
        #expect(PreferenceChoices.dailyCap(0).hasSuffix("none") && PreferenceChoices.dailyCap(10).hasSuffix("10"))
        var form = PreferencesForm(.with { $0.dailyCap = 10; $0.threshold = 80 })
        #expect(!form.hasChanges)
        form.dailyCap = 3
        #expect(form.changes.map { "\($0.key)=\($0.value)" } == ["daily_cap=3"])
    }

    @Test func rolesAreFreeTitlesTypedAsTokens() {
        // Any job title, in the candidate's words; commas, semicolons and new lines separate.
        #expect(RoleTokens.parse(" Chef;  CFO ,Backend   Engineer\nchef") == ["Chef", "CFO", "Backend Engineer"])
        #expect(RoleTokens.joined(["Chef", "CFO"]) == "Chef; CFO")
        #expect(RoleTokens.adding(" Sous chef ", to: "Chef; CFO") == "Chef; CFO; Sous chef")
        // Each once, whatever the case; several at a time.
        #expect(RoleTokens.adding("cfo, Pastry Chef;", to: "Chef; CFO") == "Chef; CFO; Pastry Chef")
        #expect(RoleTokens.removing("cfo", from: "Chef; CFO") == "Chef")
        #expect(RoleTokens.adding("", to: "") == "")
        #expect(RoleTokens.endsTitle("Chef,") && RoleTokens.endsTitle("Chef;") && !RoleTokens.endsTitle("Chef"))
        // At most 15.
        let many = (1 ... 20).map { "Role \($0)" }.joined(separator: ";")
        #expect(RoleTokens.parse(many).count == RoleTokens.limit)
        // The CV's titles that aren't chosen yet stay on offer.
        #expect(RoleTokens.offered(["Tech Lead", "Backend developer", "tech lead"], chosen: "backend Developer") == ["Tech Lead"])
        #expect(RoleTokens.summary([]) == "any role")
        #expect(RoleTokens.summary(["Chef", "CFO"]) == "Chef, CFO")
        #expect(RoleTokens.summary(["Chef", "CFO", "Baker", "Cook"]) == "Chef, CFO +2")
    }

    @Test func languagesAreRowsNotCodes() {
        let rows = LanguageRows.parse("en:b1, de:C1, uk:native, English C1, en:C2, xx:fluent")
        #expect(rows == [LanguageRow(code: "en", level: "B1"), LanguageRow(code: "de", level: "C1"), LanguageRow(code: "uk", level: "native")])
        #expect(LanguageRows.serialise(rows) == "en:B1, de:C1, uk:native")
        #expect(LanguageRows.adding("EL", to: "en:B1") == "en:B1, el:B2")
        #expect(LanguageRows.adding("en", to: "en:B1") == "en:B1")
        #expect(LanguageRows.setting("en", level: "C1", in: "en:B1, de:C1") == "en:C1, de:C1")
        #expect(LanguageRows.removing("de", from: "en:B1, de:C1") == "en:B1")
        #expect(LanguageRows.levels.map(\.key) == ["A1", "A2", "B1", "B2", "C1", "C2", "native"])
        let en = Locale(identifier: "en_US")
        #expect(LanguageRows.summary("en:B1, uk:native", locale: en) == "English B1, Ukrainian native")
    }

    @Test func countriesAndLanguagesAreFoundByName() {
        let en = Locale(identifier: "en_US")
        let countries = Places.countries(locale: en)
        #expect(countries.count > 200)
        #expect(countries.contains(NamedCode(code: "GR", name: "Greece")))
        // Only countries: no continents, no "world".
        #expect(countries.allSatisfy { $0.code.count == 2 })
        #expect(Places.countryName("gr", locale: en) == "Greece")
        #expect(Places.languageName("UK", locale: en) == "Ukrainian")
        #expect(Places.flag("GR") == "🇬🇷" && Places.flag("Greece").isEmpty)
        // Typing finds by the start of the name first, then a word in it, then anywhere.
        #expect(Places.search("gree", in: countries).map(\.code) == ["GR", "GL"])
        #expect(Places.search("united", in: countries).map(\.name).contains("United Kingdom"))
        #expect(Places.search("kingdom", in: countries).first?.code == "GB")
        // The code finds it too, and case and accents don't matter.
        #expect(Places.search("de", in: countries).first?.code == "DE")
        #expect(Places.search("COTE", in: countries).first?.code == "CI")
        #expect(Places.search("", in: countries).count == countries.count)
        #expect(Places.search("zzzz", in: countries).isEmpty)
        let languages = Places.languages(locale: en)
        #expect(Places.search("ukr", in: languages).first == NamedCode(code: "uk", name: "Ukrainian"))
        #expect(languages.allSatisfy { $0.code.count == 2 })
        // Lists of countries on the wire.
        #expect(CountryCodes.parse("cy, DE de") == ["CY", "DE"])
        #expect(CountryCodes.adding("gr", to: "CY") == "CY, GR")
        #expect(CountryCodes.removing("cy", from: "CY, GR") == "GR")
    }

    @Test func importingACvAlsoMakesItTheCvThatIsSent() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("applyant-store-\(UUID().uuidString)")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let cv = root.appendingPathComponent("cv.pdf")
        try Data("pdf".utf8).write(to: cv)

        let daemon = FakeDaemon()
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        store.dataDir = root.appendingPathComponent("data")
        let running = Task { await store.run() }
        defer { running.cancel() }
        try await eventually("connected") { store.connection == .connected }

        #expect(await store.importFile(cv))
        let copy = store.dataDir.appendingPathComponent("files/imports/cv.pdf").path
        #expect(daemon.knowledgeSources == [copy])
        #expect(daemon.profileValues["base_cv_file"] == copy)
        #expect(store.baseCvNote?.contains("cv.pdf") == true)

        // A second CV doesn't replace the one already set; notes aren't a CV at all.
        let other = root.appendingPathComponent("linkedin.pdf")
        try Data("other".utf8).write(to: other)
        #expect(await store.importFile(other))
        #expect(daemon.profileValues["base_cv_file"] == copy)

        // A GitHub repository pasted into Import is a repository, not a page.
        #expect(await store.importSource("https://github.com/me/solovei"))
        #expect(daemon.calls.contains { $0.hasPrefix("addKnowledgeSource github") })
    }

    @Test func factsToConfirmAreOneListAcrossProjects() async throws {
        let daemon = FakeDaemon()
        func fact(_ id: Int64, project: Int64?) -> Fact {
            .with {
                $0.id = id
                $0.text = "fact \(id)"
                $0.status = .unconfirmed
                if let project { $0.projectID = project; $0.projectSlug = "p\(project)" }
            }
        }
        daemon.projects = [.with { $0.id = 4; $0.name = "Solovei"; $0.slug = "p4" }]
        daemon.factsByRef[""] = [fact(1, project: 4), fact(2, project: nil), fact(3, project: 4)]
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let running = Task { await store.run() }
        defer { running.cancel() }
        try await eventually("connected") { store.connection == .connected }

        #expect(store.count(.projects) == 3)
        await store.openUnconfirmedFacts()
        let groups = store.unconfirmedFactGroups
        #expect(groups.map(\.name) == ["Profile", "Solovei"])
        #expect(groups.map { $0.facts.map(\.id) } == [[2], [1, 3]])

        // Back to review is the existing SetApplicationStage with Ready to review.
        var app = Application()
        app.id = 9
        app.stage = .approved
        daemon.applications[9] = app
        #expect(await store.returnToReview(application: 9))
        #expect(daemon.calls.contains("setStage 9 readyForReview"))
    }

    @Test func aFactRowSaysItsStatusKindAndEvidenceInOneLine() {
        var f = Fact()
        f.text = "Built the STT pipeline"
        f.kind = "personal_contribution"
        f.status = .unconfirmed
        f.evidence = [
            .with { $0.sourceKind = .file; $0.sourceLocator = "/x/cv.pdf"; $0.locator = "page 2"; $0.excerpt = "built the STT pipeline" },
            .with { $0.sourceKind = .github; $0.sourceLocator = "https://github.com/me/solovei"; $0.locator = "commit:1a2b3c4d"; $0.excerpt = "built the STT pipeline" },
        ]
        #expect(FactsText.detailLine(f) == "Unconfirmed · Personal contribution · File · cv.pdf · page 2 (+1)")
        // The quotes are shown once each, on request; the tooltip has every evidence line.
        #expect(FactsText.quotes(f) == ["built the STT pipeline"])
        #expect(FactsText.tooltip(f).contains("GitHub · github.com/me/solovei · commit:1a2b3c4d\n“built the STT pipeline”"))
        f.status = .confirmed
        f.origin = "interview"
        #expect(FactsText.detailLine(f).hasPrefix("Personal contribution · From the interview · File"))
    }

    @Test func repositorySuggestionsReadAndSearch() {
        let day: TimeInterval = 86_400
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let solovei = RepoSuggestion(url: "https://github.com/me/soloveim", fullName: "me/soloveim", description: "Call analytics", pushedAt: now.addingTimeInterval(-70 * day), isPrivate: true, reason: "its name is close to Solovei")
        let other = RepoSuggestion(url: "https://github.com/me/ua-tv", fullName: "me/ua-tv", description: "Ukrainian TV playlist", pushedAt: nil)
        #expect(RepoText.cardLine(solovei, now: now) == "me/soloveim · pushed 2 months ago — its name is close to Solovei")
        #expect(RepoText.cardLine(other, now: now) == "me/ua-tv")
        #expect(RepoText.detailLine(solovei, now: now) == "Call analytics · pushed 2 months ago")
        #expect(solovei.name == "soloveim")
        #expect(RepoText.search("tv ukr", in: [solovei, other]).map(\.id) == [other.id])
        #expect(RepoText.search("", in: [solovei, other]).count == 2)
        #expect(RepoText.problem("gh isn't signed in: run `gh auth login`").command == "gh auth login")
        #expect(RepoText.problem("`gh` not found: install it").command == "brew install gh && gh auth login")
        #expect(RepoText.problem("repository suggestions need a newer Applyant").command == nil)
    }

    @Test func repositorySuggestionsAreAskedOncePerProjectAndAgainAfterAdding() async throws {
        let daemon = FakeDaemon()
        daemon.projects = [.with { $0.id = 4; $0.name = "Solovei"; $0.slug = "solovei" }]
        daemon.repoSuggestions = RepoSuggestions(
            matches: [RepoSuggestion(url: "https://github.com/me/soloveim", fullName: "me/soloveim", reason: "its name is close to Solovei")],
            others: [RepoSuggestion(url: "https://github.com/me/other", fullName: "me/other")],
            accounts: ["me"]
        )
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let running = Task { await store.run() }
        defer { running.cancel() }
        try await eventually("connected") { store.connection == .connected }

        let first = await store.loadRepoSuggestions(project: 4)
        #expect(first?.matches.map(\.fullName) == ["me/soloveim"])
        _ = await store.loadRepoSuggestions(project: 4)
        #expect(daemon.calls.filter { $0.hasPrefix("suggestRepositories") }.count == 1)

        // Adding the repository asks again (it's no longer on offer); a page doesn't.
        daemon.repoSuggestions = RepoSuggestions(others: [RepoSuggestion(url: "https://github.com/me/other", fullName: "me/other")], accounts: ["me"])
        #expect(await store.addKnowledgeSource(to: 4, "https://github.com/me/soloveim"))
        #expect(daemon.calls.filter { $0.hasPrefix("suggestRepositories") }.count == 2)
        #expect(store.repoSuggestions[4]?.matches.isEmpty == true)
        #expect(await store.addKnowledgeSource(to: 4, "https://solovei.example/about"))
        #expect(daemon.calls.filter { $0.hasPrefix("suggestRepositories") }.count == 2)

        // A daemon that can't look (gh not signed in) is remembered as the line to show.
        daemon.repoProblem = "gh isn't signed in"
        let failed = await store.loadRepoSuggestions(project: 4, refresh: true)
        #expect(failed?.problem == "gh isn't signed in")
        #expect(store.repoSuggestions[4]?.problem == "gh isn't signed in")
    }

    @Test func theLanguagesToWorkInFollowTheOnesSpoken() {
        #expect(WorkingLanguages.parse("de, uk") == ["de", "uk"])
        #expect(WorkingLanguages.toggled("ru", in: "de, uk") == "de, uk, ru")
        #expect(WorkingLanguages.toggled("de", in: "de, uk") == "uk")
        // A language no longer spoken can't be one to work in.
        #expect(WorkingLanguages.keeping("de, uk", spoken: ["uk", "en"]) == "uk")
        var form = PreferencesForm()
        form["languages"] = "de:C1, uk:native"
        form["working_languages"] = "de, uk"
        #expect(form.changes.contains { $0.key == "working_languages" && $0.value == "de, uk" })
    }

    @Test func dictationKeepsWhatWasTypedAndAddsWhatIsSaid() {
        var t = DictationText(base: "I built the pipeline.")
        t.partial = "and the"
        #expect(t.text == "I built the pipeline. and the")
        // The recogniser revises the phrase in progress until it's final.
        t.partial = "And the analysis layer"
        t.commit()
        t.partial = " two of us "
        #expect(t.text == "I built the pipeline. And the analysis layer two of us")
        t.commit()
        t.commit()
        #expect(t.committed == ["And the analysis layer", "two of us"])
        #expect(DictationText(base: "").text == "")
        #expect(DictationText(base: "typed only ").text == "typed only ")

        // The button offers the languages you speak and the Mac's own, one locale per language.
        let supported = ["en-US", "en-GB", "uk-UA", "de-DE", "fr-FR", "ru-RU"]
        let offered = DictationLanguages.offered(supported: supported, spoken: ["uk", "de", "en"], system: ["en-GB", "el-GR"])
        #expect(offered == ["en-GB", "uk-UA", "de-DE"])
        #expect(DictationLanguages.offered(supported: supported, spoken: [], system: ["el-GR"]) == supported.sorted())
        #expect(DictationLanguages.initial(saved: "uk-UA", offered: offered) == "uk-UA")
        #expect(DictationLanguages.initial(saved: "fr-FR", offered: offered) == "en-GB")
        #expect(DictationLanguages.name("uk-UA", among: offered) == "Ukrainian")
        #expect(DictationLanguages.name("en-GB", among: ["en-GB", "en-US"]) == "English (United Kingdom)")
    }

    @Test func theAssistantsAnswerIsKeptAsADocument() throws {
        // The prompt asks for what the assistant has, and for nothing invented.
        #expect(AssistantNotes.prompt.contains("Never guess"))
        #expect(AssistantNotes.prompt.contains("What I want next"))
        #expect(AssistantNotes.problem("  ") == "Paste the assistant's answer first.")
        #expect(AssistantNotes.problem("Too short.")?.contains("very short") == true)
        #expect(AssistantNotes.problem(AssistantNotes.prompt)?.contains("That's the prompt") == true)
        let answer = String(repeating: "Worked at Acme as a backend engineer from 2021 to 2024. ", count: 6)
        #expect(AssistantNotes.problem(answer) == nil)

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("applyant-notes-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let day = Date(timeIntervalSince1970: 1_790_000_000)
        let first = try AssistantNotes.save(answer, dataDir: dir, date: day)
        #expect(first.path.hasPrefix(ImportedFile.folder(dataDir: dir).path))
        #expect(first.lastPathComponent == AssistantNotes.fileName(day))
        #expect(try String(contentsOf: first, encoding: .utf8).hasPrefix("# What an AI assistant remembers about me\n\nWorked at Acme"))
        // A second answer the same day doesn't replace the first.
        let second = try AssistantNotes.save(answer, dataDir: dir, date: day)
        #expect(second.lastPathComponent == AssistantNotes.fileName(day).replacingOccurrences(of: ".md", with: " 2.md"))
    }
}
