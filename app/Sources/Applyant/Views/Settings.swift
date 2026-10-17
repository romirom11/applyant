// Settings (phase 14): a list of panes like every other section, the picked one beside it.
// General: the setup, the profile, projects, preferences and the CV template. Connections: the
// mailbox (MailboxConnect.swift), the captcha solver's key (set or not, never shown) and Telegram
// (phone → code → the 2FA password), for private channels and Telegram applications. Sites:
// LinkedIn and Xing (sign-in, a pause and Resume, the daily caps against today's use) and any
// other site's sign-in. Models & Keys, Sites' sign-in sheet and Stored keys are in
// SettingsModels.swift.
import ApplyantAPI
import ApplyantKit
import SwiftUI

/// Settings' panes, the rows of its list; the last one picked stays.
enum SettingsPane: String, CaseIterable, Identifiable {
    case general = "General"
    case connections = "Connections"
    case sites = "Sites"
    case models = "Models & Keys"

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .general: "gearshape"
        case .connections: "envelope"
        case .sites: "globe"
        case .models: "cpu"
        }
    }

    /// What the pane has, under its title.
    var subtitle: String {
        switch self {
        case .general: "The setup, your profile, projects, preferences and CV template"
        case .connections: "The mailbox, the captcha solver and Telegram"
        case .sites: "LinkedIn, Xing and any other site Applyant signs in to"
        case .models: "Which model does each job, and the keys stored for them"
        }
    }
}

/// Settings' list column: its panes, each with one line of where it stands.
struct SettingsList: View {
    @Bindable var store: AppStore
    @AppStorage("settings.pane") private var pane: SettingsPane = .general

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ModuleHeader(section: .settings, subtitle: "Setup, connections, sites and models").columnHeader()
            CardList(
                selection: Binding(get: { pane }, set: { if let picked = $0 { pane = picked } }),
                order: SettingsPane.allCases,
                tint: Theme.world(.settings).main
            ) {
                ForEach(SettingsPane.allCases) { pane in
                    SelectableCard(id: pane, padding: 11) { row(pane) }
                }
            }
        }
        .navigationTitle("Settings")
        .task {
            await store.openSettings()
            await store.openProfile()
            await store.openPreferences()
            await store.openModels()
            await store.openSecrets()
        }
    }

    private func row(_ pane: SettingsPane) -> some View {
        let warns = pane == .connections && SettingsText.connectionsNeedYou(store.mailbox)
        return HStack(spacing: 12) {
            IconTile(systemImage: pane.symbol, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(pane.rawValue).textRole(.rowTitle).lineLimit(1)
                Text(status(pane))
                    .textRole(.meta, color: warns ? Theme.warning : nil)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
    }

    /// "Roman Kudin · 21 projects", "Gmail connected", "Djinni · LinkedIn · Xing", "Claude · 14 roles".
    private func status(_ pane: SettingsPane) -> String {
        switch pane {
        case .general:
            let name = store.candidateProfile?.profile.first { $0.key == "full_name" }?.values.first
            return SettingsText.general(name: name, projects: store.knowledgeProjects.count)
        case .connections: return SettingsText.connections(store.mailbox, telegram: store.telegram)
        case .sites: return SettingsText.sites(store.platforms, secrets: store.secretNames)
        case .models: return SettingsText.models(store.roles)
        }
    }
}

/// The picked Settings pane, across the detail's whole width.
struct SettingsDetail: View {
    @Bindable var store: AppStore
    @AppStorage("settings.pane") private var pane: SettingsPane = .general
    @State private var editingProfile = false
    @State private var editingProjects = false
    @State private var editingPreferences = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                PageHeader(title: pane.rawValue, subtitle: pane.subtitle, systemImage: pane.symbol)
                switch pane {
                case .general: general
                case .connections: connections
                case .sites: sites
                case .models:
                    ModelsCard(store: store)
                    StoredKeysCard(store: store)
                }
            }
            .buttonStyle(.secondary)
            .pageColumn()
        }
        .id(pane)
        .sheet(isPresented: $editingProfile) { ProfileSheet(store: store) { editingProfile = false }.worldSheet() }
        .sheet(isPresented: $editingProjects) { ProjectsSheet(store: store) { editingProjects = false }.worldSheet() }
        .sheet(isPresented: $editingPreferences) {
            PreferencesSheet(store: store) {
                editingPreferences = false
                Task { await store.openPreferences() }
            }
            .worldSheet()
        }
    }

    @ViewBuilder
    private var general: some View {
        Card(title: "You") {
            LabeledRow("Setup", note: OnboardingText.search(store.onboarding, status: store.setup).text) {
                Button("Open Setup…") { Task { await store.openOnboarding() } }.fixedSize()
            }
            LabeledRow("Profile", note: profileLine) {
                Button("Edit Profile…") { editingProfile = true }.fixedSize()
            }
            LabeledRow("Projects", note: "\(store.knowledgeProjects.count) projects") {
                Button("Projects and Sources…") { editingProjects = true }.fixedSize()
            }
            LabeledRow("Preferences", note: PreferencesText.summary(store.searchPreferences)) {
                Button("Edit Preferences…") { editingPreferences = true }.fixedSize()
            }
        }
        CvTemplateCard(store: store)
    }

    @ViewBuilder
    private var connections: some View {
        Card(title: "Mailbox") {
            MailboxRows(store: store)
            Text("Replies move applications on, security codes are read during delivery, and approved email applications are sent from it. Passwords and secrets stay in Applyant's secrets (the Keychain).")
                .textRole(.meta)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: Theme.measure, alignment: .leading)
        }
        Card(title: "Captcha solver", accessory: { ConnectionTag(note: ConnectionText.captcha) }) {
            CaptchaRows(store: store)
        }
        Card(title: "Telegram", accessory: { ConnectionTag(note: ConnectionText.telegram) }) {
            TelegramRows(store: store)
        }
    }

    @ViewBuilder
    private var sites: some View {
        if let open = PlatformText.signInOpen(store.platforms) {
            Callout(.warning, title: open)
        }
        ForEach(store.platforms?.platforms ?? [], id: \.platform) { platform in
            PlatformCard(store: store, platform: platform)
        }
        SitesCard(store: store)
    }

    private var profileLine: String {
        let entries = store.candidateProfile?.profile ?? []
        let value = { (key: String) in entries.first { $0.key == key }?.values.first }
        return [value("full_name"), value("email"), value("location")].compactMap { $0 }.joined(separator: " · ")
            .nonEmpty ?? "Name, contacts and the base CV that application forms use"
    }
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

/// LinkedIn or Xing: signed in or not, a pause and Resume, and the daily caps against today's use.
struct PlatformCard: View {
    let store: AppStore
    let platform: Platform
    @State private var searches = 0
    @State private var applications = 0

    var body: some View {
        Card(title: platform.name, accessory: { ChipView(chip: PlatformText.chip(platform)) }) {
            LabeledRow("Account", note: PlatformText.status(platform)) {
                HStack {
                    Button(platform.hasSignedInAt ? "Sign In Again" : "Sign In") {
                        Task { await store.signIn(platform.platform) }
                    }
                    if platform.hasPausedAt {
                        Button("Resume") { Task { await store.resumePlatform(platform.platform) } }
                    }
                }
                .fixedSize()
            }
            LabeledRow("Daily caps", note: PlatformText.usage(platform)) {
                VStack(alignment: .leading, spacing: Theme.Space.xs) {
                    Stepper("Searches a day: \(searches)", value: $searches, in: 0 ... 50)
                    Stepper("Applications a day: \(applications)", value: $applications, in: 0 ... 50)
                    if searches != Int(platform.searchesPerDay) || applications != Int(platform.applicationsPerDay) {
                        Button("Save Caps") {
                            Task {
                                await store.setPlatformCaps(
                                    platform.platform, searches: Int32(searches), applications: Int32(applications)
                                )
                            }
                        }
                    }
                }
                .textRole(.body)
                .fixedSize()
            }
        }
        .onAppear { reset() }
        .onChange(of: platform) { reset() }
    }

    private func reset() {
        searches = Int(platform.searchesPerDay)
        applications = Int(platform.applicationsPerDay)
    }
}

/// The CapMonster key as a Form section (the setup's Connections step).
struct CaptchaSection: View {
    let store: AppStore

    var body: some View {
        SwiftUI.Section {
            CaptchaRows(store: store)
        } header: {
            ConnectionHeader(title: "Captcha solver", note: ConnectionText.captcha)
        }
    }
}

/// The CapMonster key: stored or not (never shown), and Save / Replace (Settings and the setup's
/// Connections step).
struct CaptchaRows: View {
    let store: AppStore

    var body: some View {
        StoredKeyField(label: "CapMonster key", stored: store.platforms?.captchaSolver == true) { key in
            await store.setCaptchaKey(key)
        } status: {
            Text(PlatformText.captcha(store.platforms)).textRole(.body)
            if let solver = store.platforms?.captchaSolver {
                ChipView(chip: Chip(text: solver ? "Key stored" : "No key", tone: solver ? .good : .neutral))
            }
        }
        Text("Stored with Applyant's secrets (the Keychain); it's never shown again.").textRole(.meta)
    }
}

/// Required or Optional, as a small capsule beside a connection's name.
struct ConnectionTag: View {
    let note: ConnectionNote

    var body: some View {
        Text(note.tag)
            .font(.system(size: 11, weight: .semibold))
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background((note.required ? Theme.warning : Theme.secondaryText).opacity(0.18), in: Capsule())
            .foregroundStyle(note.required ? Theme.chipText(.warning) : Theme.secondaryText)
            .help(note.purpose)
    }
}

/// A connection's section header: its name, Required or Optional, and what it's for.
struct ConnectionHeader: View {
    let title: String
    let note: ConnectionNote

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(title)
                ConnectionTag(note: note)
            }
            Text(note.purpose).textRole(.meta).textCase(nil)
        }
    }
}

/// Telegram as a Form section (the setup's Connections step).
struct TelegramSection: View {
    let store: AppStore

    var body: some View {
        SwiftUI.Section {
            TelegramRows(store: store)
        } header: {
            ConnectionHeader(title: "Telegram", note: ConnectionText.telegram)
        }
    }
}

/// Telegram connect (phone → code → the 2FA password), for private channels and Telegram
/// applications.
struct TelegramRows: View {
    let store: AppStore
    @State private var phone = ""
    @State private var apiId = ""
    @State private var apiHash = ""
    @State private var code = ""
    @State private var password = ""
    @State private var confirmingDisconnect = false

    var body: some View {
        let t = store.telegram
        Group {
            HStack(alignment: .firstTextBaseline) {
                Text(TelegramText.status(t)).textRole(.body)
                Spacer()
                ChipView(chip: TelegramText.chip(t))
            }
            switch t?.state {
            case .connected?:
                Button("Disconnect…", role: .destructive) { confirmingDisconnect = true }
                    .confirmationDialog("Disconnect Telegram?", isPresented: $confirmingDisconnect) {
                        Button("Disconnect", role: .destructive) { Task { await store.disconnectTelegram() } }
                    } message: {
                        Text("Private channels stop being read and Telegram applications can't be sent until you connect again.")
                    }
            case .waitingCode?:
                HStack {
                    TextField("The code Telegram sent you", text: $code)
                        .textFieldStyle(.glass)
                    Button("Verify") {
                        let value = code
                        code = ""
                        Task { await store.connectTelegram(.code(value)) }
                    }
                    .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty)
                    Button("Cancel") { Task { await store.connectTelegram(.cancel(true)) } }
                }
            case .waitingPassword?:
                HStack {
                    SecureField("Two-step verification password", text: $password)
                        .textFieldStyle(.glass)
                    Button("Sign In") {
                        let value = password
                        password = ""
                        Task { await store.connectTelegram(.password(value)) }
                    }
                    .disabled(password.isEmpty)
                    Button("Cancel") { Task { await store.connectTelegram(.cancel(true)) } }
                }
            default:
                if t?.apiConfigured != true {
                    Text("Telegram asks every app for its own key: sign in at my.telegram.org, open API development tools, create an app and copy the two values here.")
                        .textRole(.meta).fixedSize(horizontal: false, vertical: true)
                    TextField("App api_id", text: $apiId)
                        .textFieldStyle(.glass)
                    SecureField("App api_hash", text: $apiHash)
                        .textFieldStyle(.glass)
                }
                HStack {
                    TextField("Phone (+30…)", text: $phone)
                        .textFieldStyle(.glass)
                    Button("Connect") {
                        let start = Applyant_V1_ConnectTelegramStart.with {
                            $0.phone = phone
                            if !apiId.isEmpty { $0.apiID = apiId }
                            if !apiHash.isEmpty { $0.apiHash = apiHash }
                        }
                        apiHash = ""
                        Task { await store.connectTelegram(.start(start)) }
                    }
                    .disabled(phone.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            Text("Only the session is kept, in Applyant's secrets (the Keychain). Telegram applications are sent from this account after you approve them.")
                .textRole(.meta).fixedSize(horizontal: false, vertical: true)
        }
    }
}
