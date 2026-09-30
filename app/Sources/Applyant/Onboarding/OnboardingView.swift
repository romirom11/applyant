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
                if let error = store.lastError {
                    HStack(alignment: .firstTextBaseline) {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange).font(.callout).textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        Button("Dismiss") { store.lastError = nil }.controlSize(.small)
                    }
                    .padding(10)
                    .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            .padding(20)
            .onChange(of: flow.current) { store.lastError = nil }
            Divider()
            HStack {
                Text(OnboardingText.search(flow)).font(.callout).foregroundStyle(flow.searchStarted ? .green : .secondary)
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
    @State private var jev = ""

    var body: some View {
        let s = store.setup
        Form {
            SwiftUI.Section("Agents on this Mac") {
                if let s {
                    Row(ok: s.claude.found && s.claude.signedIn, text: OnboardingText.tool("Claude Code", s.claude))
                    Row(ok: s.codex.found && s.codex.signedIn, text: OnboardingText.tool("Codex", s.codex))
                } else {
                    Text("The daemon isn't answering yet.").foregroundStyle(.secondary)
                }
                Button("Check again") { Task { await store.refreshSetup(refresh: true) } }
            }
            SwiftUI.Section("Jev") {
                Row(ok: s?.jev.connected == true, text: s.map { OnboardingText.connection($0.jev) } ?? "")
                HStack {
                    SecureField("Jev API key", text: $jev)
                    Button(s?.jev.connected == true ? "Replace key" : "Save key") {
                        let key = jev
                        jev = ""
                        Task { await store.setJevKey(key) }
                    }
                    .disabled(jev.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            SwiftUI.Section("GitHub") {
                GithubLoginField(store: store)
            }
            SwiftUI.Section("Mailbox and Google") {
                MailboxRows(store: store)
                Row(ok: s?.calendar.connected == true, text: "Calendar: " + (s.map { OnboardingText.connection($0.calendar) } ?? ""))
                Row(ok: s?.drive.connected == true, text: "Drive: " + (s.map { OnboardingText.connection($0.drive) } ?? ""))
                Text("Gmail: one Google consent covers Gmail, Calendar and Drive. Any other mailbox: IMAP + SMTP with an app password.")
                    .font(.caption).foregroundStyle(.secondary)
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
            ? "Not saved yet · without your login, no commit counts as your own work"
            : "Saved: \(saved) · commits by \(saved.contains(",") ? "these logins" : "this login") count as your own work")
        Text("Repositories belong to projects (Projects and sources…). Private ones are read with this Mac's git and GitHub CLI sign-in (`gh auth login` in Terminal); Applyant keeps no GitHub token.")
            .font(.caption).foregroundStyle(.secondary)
            .onAppear { if !edited { logins = saved } }
            .onChange(of: saved) { if !edited { logins = saved } }
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
                Text("Drafted into projects and facts in the background; you confirm facts before anything is sent.")
                    .font(.caption).foregroundStyle(.secondary)
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
            SwiftUI.Section("Links and Google Docs") {
                HStack {
                    TextField("Link", text: $link, prompt: Text("A portfolio page, a case study, a Docs or Drive link (a Drive folder works too)"))
                        .onSubmit(addLink)
                    Button("Add", action: addLink)
                        .disabled(adding != nil || link.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            SwiftUI.Section("GitHub") {
                GithubLoginField(store: store)
            }
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

    /// The daemon reads the file itself, by path. The app isn't sandboxed, but a picked URL may
    /// still be security-scoped: hold the access until the daemon has taken the path.
    private func importFile(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        adding = url.lastPathComponent
        Task {
            await store.importSource(url.path)
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
    @State private var values: [String: String] = [:]
    @State private var loaded = false
    @State private var saving = false

    /// The keys this step asks about, in order, with how to write them.
    private static let fields: [(key: String, label: String, hint: String)] = [
        ("roles", "Roles", "backend, ai_ml, fullstack, data, platform, founding …"),
        ("seniority", "Seniority", "senior, lead"),
        ("based_in", "Based in", "a country code: GR"),
        ("locations", "Also on-site/hybrid in", "country codes: CY, DE"),
        ("remote", "Remote", "required · preferred · any"),
        ("salary", "Target salary", "4500 EUR/month or 60k EUR/year"),
        ("languages", "Languages", "en:C1, el:native"),
        ("dealbreakers", "Dealbreakers", "outstaffing, onsite, location, language, employment, seniority"),
    ]

    var body: some View {
        Form {
            SwiftUI.Section("Pre-filled from your CV: adjust, then start searching") {
                ForEach(Self.fields, id: \.key) { field in
                    VStack(alignment: .leading, spacing: 2) {
                        TextField(field.label, text: Binding(
                            get: { values[field.key] ?? "" },
                            set: { values[field.key] = $0 }
                        ), prompt: Text(field.hint))
                        if let s = store.preferencesDraft.first(where: { $0.key == field.key }) {
                            Text(s.reason).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
            }
            HStack {
                if saving {
                    ProgressView().controlSize(.small)
                    Text("Saving your preferences…").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Start searching") {
                    let pairs = Self.fields.map { (key: $0.key, value: values[$0.key] ?? "") }
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
            await store.loadPreferencesDraft()
            for s in store.preferencesDraft where (values[s.key] ?? "").isEmpty { values[s.key] = s.value }
            loaded = true
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
                        description: Text("The agent asks what your sources can't show. Or choose Later: the Interview section keeps the questions.")
                    )
                }
            }
            .frame(minWidth: 380)
        }
    }
}
