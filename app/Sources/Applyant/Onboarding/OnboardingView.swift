// The first-launch setup (phase 16): 1 Connections · 2 Import · 3 Preferences (pre-filled from
// the CV; search starts when it's done) · 4 Interview (the phase-9 chat, or Later). Shown over
// the main window on the first launch while setup isn't done; the menu and Settings reopen it.
// The steps' rules live in ApplyantKit's OnboardingFlow.
import AppKit
import ApplyantAPI
import ApplyantKit
import SwiftUI
import UniformTypeIdentifiers

struct OnboardingView: View {
    @Bindable var store: AppStore

    var body: some View {
        let flow = store.onboarding
        VStack(spacing: 0) {
            HStack(spacing: 18) {
                ForEach(OnboardingStep.allCases) { step in
                    Button {
                        store.onboarding.open(step)
                    } label: {
                        StepBadge(step: step, state: flow.state(step), current: flow.current == step)
                    }
                    .buttonStyle(.plain)
                    .disabled(!flow.canOpen(step))
                }
                Spacer()
                Button("Close") {
                    store.lastError = nil
                    store.showOnboarding = false
                }
                .keyboardShortcut(.cancelAction)
            }
            .padding(16)
            Divider()
            VStack(alignment: .leading, spacing: 12) {
                Text("\(flow.current.number) · \(flow.current.title)").font(.title2.bold())
                Text(flow.current.summary).foregroundStyle(.secondary)
                Group {
                    switch flow.current {
                    case .connections: ConnectionsStep(store: store)
                    case .importing: ImportStep(store: store)
                    case .preferences: PreferencesStep(store: store)
                    case .interview: InterviewStep(store: store)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                // What a step's action was refused for (the main window's alert is behind this sheet).
                if store.inlineErrorViews == 0 { ErrorBanner(store: store) }
            }
            .padding(20)
            .onChange(of: flow.current) { store.lastError = nil }
            Divider()
            HStack {
                let search = OnboardingText.search(flow, status: store.setup)
                Text(search.text).font(.callout)
                    .foregroundStyle(search.ok ? AnyShapeStyle(.green) : flow.searchStarted ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                Spacer()
                if let skip = flow.current.skipState {
                    Button(skip == "later" ? "Later" : "Skip") {
                        Task { await store.settleStep(flow.current, as: skip) }
                    }
                }
                if flow.current != .preferences {
                    Button(flow.current == .interview ? "Done" : "Continue") {
                        Task { await store.settleStep(flow.current) }
                    }
                    .keyboardShortcut(.defaultAction)
                }
            }
            .padding(16)
        }
        .task { await store.refreshSetup(refresh: true) }
    }
}

private struct StepBadge: View {
    let step: OnboardingStep
    let state: String
    let current: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: state == "done" ? "checkmark.circle.fill" : state == "pending" ? "\(step.number).circle" : "arrow.uturn.forward.circle")
                .foregroundStyle(state == "done" ? .green : current ? .accentColor : .secondary)
            Text(step.title).fontWeight(current ? .semibold : .regular)
        }
    }
}

private struct ConnectionsStep: View {
    @Bindable var store: AppStore

    var body: some View {
        let s = store.setup
        Form {
            SwiftUI.Section {
                if let s {
                    ToolRow(name: "Claude Code", tool: s.claude)
                } else {
                    Text("Applyant's background service isn't answering yet.").foregroundStyle(.secondary)
                }
                Button("Check again") { Task { await store.refreshSetup(refresh: true) } }
            } header: {
                ConnectionHeader(title: "Claude Code", note: ConnectionText.claude)
            }
            SwiftUI.Section {
                if let s { ToolRow(name: "Codex", tool: s.codex) }
            } header: {
                ConnectionHeader(title: "Codex", note: ConnectionText.codex)
            }
            SwiftUI.Section {
                StoredKeyField(label: "Jev API key", stored: s?.jev.connected == true) { key in
                    await store.setJevKey(key)
                } status: {
                    Row(ok: s?.jev.connected == true, text: s.map { OnboardingText.connection($0.jev) } ?? "")
                }
            } header: {
                ConnectionHeader(title: "Jev", note: ConnectionText.jev)
            }
            SwiftUI.Section {
                GithubLoginField(store: store)
            } header: {
                ConnectionHeader(title: "GitHub", note: ConnectionText.github)
            }
            SwiftUI.Section {
                MailboxRows(store: store)
                Row(ok: s?.calendar.connected == true, text: "Calendar: " + (s.map { OnboardingText.connection($0.calendar) } ?? ""))
                Text("Gmail needs your own Google Cloud OAuth client (Connect mailbox… explains the steps); its consent covers Gmail and Calendar. Any other mailbox: IMAP + SMTP with an app password.")
                    .font(.caption).foregroundStyle(.secondary)
            } header: {
                ConnectionHeader(title: "Mailbox and Calendar", note: ConnectionText.mailbox)
            }
            // Optional: the same Telegram sign-in and CapMonster key as Settings.
            TelegramSection(store: store)
            CaptchaSection(store: store)
        }
        .formStyle(.grouped)
        // Telegram's state, the captcha key's and the mailbox's (Settings loads the same).
        .task { await store.openSettings() }
    }
}

/// The GitHub login(s): the saved value is shown in the field and under it, and saving says so.
private struct GithubLoginField: View {
    let store: AppStore
    @State private var logins = ""
    @State private var edited = false
    @State private var saving = false

    /// The field follows the saved value; with none saved, the account the GitHub CLI is signed
    /// in as is offered (Save keeps it).
    private func fill(_ saved: String) {
        guard !edited else { return }
        logins = saved.isEmpty
            ? (store.setup.flatMap { ConnectionText.suggestedGithubLogin(saved: saved, $0.gh) } ?? "")
            : saved
    }

    var body: some View {
        let saved = OnboardingText.githubLogins(store.setup)
        HStack {
            TextField("GitHub login(s)", text: Binding(get: { logins }, set: { logins = $0; edited = true }),
                      prompt: Text("your-login, work-login"))
            Button(saved.isEmpty ? "Save" : "Update") {
                let value = logins
                saving = true
                Task {
                    if await store.setGithubLogin(value) { edited = false }
                    saving = false
                }
            }
            .disabled(saving || logins.trimmingCharacters(in: .whitespaces).isEmpty
                || logins.trimmingCharacters(in: .whitespaces) == saved)
        }
        Row(ok: !saved.isEmpty, text: saved.isEmpty
            ? (store.setup.flatMap { ConnectionText.suggestedGithubLogin(saved: saved, $0.gh) }.map {
                "Not saved yet · \($0) is the account your GitHub CLI is signed in as: press Save to use it"
            } ?? "Not saved yet · without your login, no commit counts as your own work")
            : "Saved: \(saved) · commits by \(saved.contains(",") ? "these logins" : "this login") count as your own work")
        if let setup = store.setup {
            let cli = ConnectionText.githubCli(setup.gh)
            Row(ok: cli.ok, text: cli.text)
            if let command = cli.command {
                HStack(alignment: .firstTextBaseline) {
                    Text("Run this in Terminal, then press Check again:").font(.caption).foregroundStyle(.secondary)
                    CopyCommand(command: command)
                    Button("Check again") { Task { await store.refreshSetup(refresh: true) } }
                        .controlSize(.small)
                }
            }
        }
        Text("Applyant uses this Mac's own GitHub CLI sign-in and keeps no GitHub token.")
            .font(.caption).foregroundStyle(.secondary)
            .onAppear { fill(saved) }
            .onChange(of: saved) { fill(saved) }
            .onChange(of: store.setup?.gh.account) { fill(saved) }
    }
}

/// A key kept in Applyant's secrets. Once one is stored there is nothing to type: the status
/// row carries "Replace key…", and the field only appears for entering a new one.
struct StoredKeyField<Status: View>: View {
    let label: String
    let stored: Bool
    let save: (String) async -> Void
    @ViewBuilder let status: () -> Status
    @State private var key = ""
    @State private var replacing = false

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            status()
            Spacer()
            if stored && !replacing {
                Button("Replace key…") { replacing = true }
            }
        }
        if !stored || replacing {
            HStack {
                SecureField(label, text: $key)
                if stored {
                    Button("Cancel") {
                        key = ""
                        replacing = false
                    }
                }
                Button(stored ? "Replace key" : "Save key") {
                    let value = key
                    key = ""
                    replacing = false
                    Task { await save(value) }
                }
                .disabled(key.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }
}

/// What an AI assistant already knows about the candidate: a prompt to paste into ChatGPT,
/// Claude, Gemini or whichever they use, and a place for its answer.
struct AssistantNotesSection: View {
    let store: AppStore

    var body: some View {
        SwiftUI.Section {
            AssistantNotesBox(store: store)
        } header: {
            Text(AssistantNotesBox.title)
        } footer: {
            Text(AssistantNotesBox.note).font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// The two steps themselves (the setup shows them in a form section, the Profile in its
/// sources): copy the prompt, paste the answer back.
struct AssistantNotesBox: View {
    static let title = "What your AI assistant already knows about you"
    static let note = "If you've used ChatGPT, Claude or Gemini for a while, it remembers your projects, numbers and what you want next. Its answer is read like a document: everything in it starts as a fact you confirm, because an assistant's memory can be wrong."

    let store: AppStore
    @State private var answer = ""
    @State private var copied = false
    @State private var adding = false
    @State private var added = false
    @State private var showingPrompt = false

    var body: some View {
        HStack {
            Text("1 · Copy the prompt and paste it into the assistant you use.")
            Spacer()
            Button(showingPrompt ? "Hide prompt" : "Show prompt") { showingPrompt.toggle() }
            Button(copied ? "Copied" : "Copy prompt") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(AssistantNotes.prompt, forType: .string)
                copied = true
            }
            .buttonStyle(.borderedProminent)
        }
        if showingPrompt {
            ScrollView {
                Text(AssistantNotes.prompt).font(.callout).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 180)
        }
        VStack(alignment: .leading, spacing: 6) {
            Text("2 · Paste its whole answer here.")
            TextEditor(text: $answer)
                .font(.callout)
                .frame(minHeight: 90, maxHeight: 180)
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            HStack {
                if added {
                    Label("Added: it's being read into facts for you to confirm.", systemImage: "checkmark.circle.fill")
                        .font(.callout).foregroundStyle(.green)
                }
                Spacer()
                Button("Paste") {
                    if let text = NSPasteboard.general.string(forType: .string) { answer = text }
                }
                Button(adding ? "Adding…" : "Add what it knows") {
                    adding = true
                    added = false
                    let text = answer
                    Task {
                        if await store.importAssistantNotes(text) {
                            answer = ""
                            added = true
                        }
                        adding = false
                    }
                }
                .disabled(adding || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }
}

/// A command to run in Terminal, with a Copy button.
struct CopyCommand: View {
    let command: String
    @State private var copied = false

    var body: some View {
        HStack(spacing: 4) {
            Text(command).font(.caption.monospaced()).textSelection(.enabled)
            Button(copied ? "Copied" : "Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(command, forType: .string)
                copied = true
            }
            .controlSize(.mini)
        }
        .fixedSize()
    }
}

/// Claude Code or Codex: found and signed in, or what to do about it.
private struct ToolRow: View {
    let name: String
    let tool: Applyant_V1_ToolStatus

    var body: some View {
        Row(ok: tool.found && tool.signedIn, text: OnboardingText.tool(name, tool))
        if let command = ConnectionText.signInCommand(name, tool) {
            HStack {
                Text("Run this in Terminal, sign in, then press Check again:").font(.caption).foregroundStyle(.secondary)
                CopyCommand(command: command)
            }
        }
    }
}

private struct Row: View {
    let ok: Bool
    let text: String

    var body: some View {
        Label {
            Text(text).textSelection(.enabled)
        } icon: {
            Image(systemName: ok ? "checkmark.circle.fill" : "circle.dashed").foregroundStyle(ok ? .green : .secondary)
        }
    }
}

private struct ImportStep: View {
    @Bindable var store: AppStore
    @State private var link = ""
    @State private var picking = false
    /// What's being added right now (a file name or link), until the daemon has it.
    @State private var adding: String?
    @State private var editingProfile = false
    @State private var editingProjects = false

    var body: some View {
        Form {
            SwiftUI.Section("Your CV or LinkedIn PDF") {
                HStack {
                    Button("Choose a file…") { picking = true }
                    Text("PDF, DOCX or text").font(.caption).foregroundStyle(.secondary)
                }
                Text("Drafted into projects and facts in the background; you confirm the facts afterwards in Projects → Facts to confirm, before anything is sent.")
                    .font(.caption).foregroundStyle(.secondary)
                if let note = store.baseCvNote {
                    Label(note, systemImage: "doc.badge.arrow.up").font(.callout).foregroundStyle(.secondary)
                }
            }
            SwiftUI.Section {
                if let adding {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Adding \(adding)…").font(.callout)
                    }
                }
                let rows = store.importRows
                if rows.isEmpty && adding == nil {
                    Text("Nothing imported yet: choose your CV above.").font(.callout).foregroundStyle(.secondary)
                }
                ForEach(rows) { row in ImportRowView(row: row) }
            } header: {
                Text("Imported")
            } footer: {
                Text("So far: " + OnboardingText.importProgress(store.setup))
                    .font(.callout).foregroundStyle(.secondary)
            }
            SwiftUI.Section {
                HStack {
                    TextField("Link", text: $link, prompt: Text("https://github.com/you/repo · a portfolio page"))
                        .onSubmit(addLink)
                    Button("Add", action: addLink)
                        .disabled(adding != nil || link.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } header: {
                Text("GitHub repositories and pages")
            } footer: {
                Text("A repository shows what you built (save your GitHub login below first, so your commits count as yours). A Google Doc: download it as a PDF and add it as a file above.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            SwiftUI.Section("Your GitHub login") {
                GithubLoginField(store: store)
            }
            AssistantNotesSection(store: store)
            SwiftUI.Section("Profile and projects") {
                HStack {
                    Text("Your name, contacts, work authorization and base CV; projects with their repos, files and pages.")
                        .font(.callout)
                    Spacer()
                    Button("Edit profile…") { editingProfile = true }
                    Button("Projects and sources…") { editingProjects = true }
                }
            }
        }
        .formStyle(.grouped)
        // The list is the profile's sources: load them (sync events keep them current).
        .task { await store.openProfile() }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.pdf, .plainText, UTType(filenameExtension: "docx") ?? .data]) { result in
            switch result {
            case let .success(url): importFile(url)
            case let .failure(error): store.lastError = "Couldn't open the file: \(error.localizedDescription)"
            }
        }
        .sheet(isPresented: $editingProfile) { ProfileSheet(store: store) { editingProfile = false } }
        .sheet(isPresented: $editingProjects) {
            ProjectsSheet(store: store) {
                editingProjects = false
                Task { await store.refreshSetup() }
            }
        }
    }

    /// Applyant copies the picked file into its own folder and the daemon reads the copy (macOS
    /// keeps the background service out of Desktop, Documents and Downloads). A picked URL may be
    /// security-scoped: hold the access until the copy is made.
    private func importFile(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        adding = url.lastPathComponent
        Task {
            await store.importFile(url)
            if scoped { url.stopAccessingSecurityScopedResource() }
            adding = nil
        }
    }

    private func addLink() {
        let value = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, adding == nil else { return }
        adding = value
        Task {
            if await store.importSource(value) { link = "" }
            adding = nil
        }
    }
}

/// An imported source: "File · cv.pdf" and "Reading cv.pdf…" / "33 new facts · 13 projects
/// created" / the reason it failed.
private struct ImportRowView: View {
    let row: ImportRow

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Group {
                switch row.state {
                case .reading: ProgressView().controlSize(.small)
                case .read: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                case .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
            }
            .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(row.kind) · \(row.title)").lineLimit(1).truncationMode(.middle)
                    .help(row.locator)
                Text(row.line).font(.caption)
                    .foregroundStyle(row.state == .failed ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            Spacer()
        }
    }
}

private struct PreferencesStep: View {
    @Bindable var store: AppStore
    @State private var text: [String: String] = [:]
    @State private var remote = "any"
    @State private var dealbreakers: Set<String> = []
    /// The remote choice is the draft's until the candidate touches it.
    @State private var remoteTouched = false
    /// The CV's titles are put in once: removing them all doesn't bring them back.
    @State private var rolesFilled = false
    @State private var dailyCap = 10
    @State private var loaded = false
    @State private var saving = false

    var body: some View {
        Form {
            if let problem = ConnectionText.claudeProblem(store.setup) {
                SwiftUI.Section {
                    Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Button("Go to Connections") { store.onboarding.open(.connections) }
                }
            }
            if store.importReading {
                SwiftUI.Section {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Still reading your CV… the titles you held, where you are, your languages and seniority are filled in here when it's done. You can set things yourself meanwhile.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
            } else if loaded && store.preferencesDraft.isEmpty {
                SwiftUI.Section {
                    Text("Nothing was imported yet, so nothing is pre-filled: set what you're looking for below, or go back to Import first.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
            PreferenceControls(
                text: $text,
                remote: Binding(get: { remote }, set: { remote = $0; remoteTouched = true }),
                dealbreakers: $dealbreakers,
                complete: false,
                reasons: Dictionary(store.preferencesDraft.map { ($0.key, $0.reason) }, uniquingKeysWith: { a, _ in a }),
                suggestedRoles: store.preferencesDraft.first { $0.key == "roles" }.map { RoleTokens.parse($0.value) } ?? []
            )
            SwiftUI.Section("How much Applyant does on its own") {
                Stepper(PreferenceChoices.dailyCap(dailyCap), value: $dailyCap, in: 0 ... 50)
                Text("When a posting scores high enough, Applyant prepares an application for you to review. " + PreferenceChoices.dailyCapNote)
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                if saving {
                    ProgressView().controlSize(.small)
                    Text("Saving your preferences…").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Button(store.onboarding.searchStarted ? "Save preferences" : "Start searching") {
                    var pairs = ["roles", "seniority", "based_in", "based_city", "locations", "salary", "languages", "working_languages"].map { (key: $0, value: text[$0] ?? "") }
                    pairs.append((key: "remote", value: remote))
                    pairs.append((key: "daily_cap", value: String(dailyCap)))
                    pairs.append((key: "dealbreakers", value: PreferenceChoices.dealbreakers.map(\.key).filter(dealbreakers.contains).joined(separator: ",")))
                    saving = true
                    Task {
                        // A refused value stops here and is shown under the step.
                        await store.confirmPreferences(pairs)
                        saving = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(saving)
            }
        }
        .formStyle(.grouped)
        .task {
            guard !loaded else { return }
            await fill()
            loaded = true
        }
        // The CV finished reading while this step was open: take what it says now.
        .onChange(of: store.importReading) { _, reading in
            if !reading { Task { await fill() } }
        }
    }

    /// What's saved already (the step opened again after Start searching), then the draft from
    /// the CV into whatever is still empty.
    private func fill() async {
        if !loaded, let saved = await store.savedPreferences() {
            let form = PreferencesForm(saved)
            for (key, value) in form.text where !(value.isEmpty || !(text[key] ?? "").isEmpty) { text[key] = value }
            if !remoteTouched, !saved.remote.isEmpty { remote = saved.remote }
            if dealbreakers.isEmpty { dealbreakers = Set(saved.dealbreakers) }
            if saved.dailyCap > 0 { dailyCap = Int(saved.dailyCap) }
            if !(text["roles"] ?? "").isEmpty { rolesFilled = true }
        }
        await store.loadPreferencesDraft()
        for s in store.preferencesDraft {
            switch s.key {
            case "remote":
                if !remoteTouched, PreferenceChoices.remote.contains(where: { $0.key == s.value }) { remote = s.value }
            case "dealbreakers":
                if dealbreakers.isEmpty { dealbreakers = Set(PreferenceChoices.keys(s.value)) }
            case "roles":
                // The CV's titles start as chosen; whatever is removed stays on offer below.
                if !rolesFilled, (text["roles"] ?? "").isEmpty {
                    text["roles"] = RoleTokens.joined(RoleTokens.parse(s.value))
                    rolesFilled = true
                }
            default:
                if (text[s.key] ?? "").isEmpty { text[s.key] = s.value }
            }
        }
    }
}

private struct InterviewStep: View {
    @Bindable var store: AppStore

    var body: some View {
        HSplitView {
            InterviewList(store: store)
                .frame(minWidth: 240, idealWidth: 280)
            Group {
                if let target = store.navigation.interview {
                    InterviewThreadView(store: store, target: target).id(target)
                } else {
                    ContentUnavailableView(
                        "Pick a project",
                        systemImage: ApplyantKit.Section.interview.symbol,
                        description: Text("Applyant asks what your CV and repositories can't show. Or choose Later: the questions wait in Questions for you.")
                    )
                }
            }
            .frame(minWidth: 380)
        }
    }
}
