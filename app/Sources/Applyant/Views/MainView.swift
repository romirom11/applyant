// The main window, Mail-style: sections → the section's list → the selected item.
import AppKit
import ApplyantKit
import SwiftUI

struct MainView: View {
    @Bindable var store: AppStore

    var body: some View {
        Group {
            switch store.connection {
            case .disconnected:
                ServiceDown(store: store)
            case .connecting where store.reloads == 0:
                ServiceStarting()
            default:
                if store.navigation.section.isSinglePane { onePane } else { threePanes }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { ActivityBar(store: store) }
        .sheet(isPresented: $store.showOnboarding) {
            OnboardingView(store: store)
                .frame(minWidth: 900, idealWidth: 980, minHeight: 640, idealHeight: 720)
        }
        .alert(
            "Applyant",
            // The setup and the sheets show their own errors inline while they're open.
            isPresented: Binding(
                get: { store.lastError != nil && !store.showOnboarding && store.inlineErrorViews == 0 },
                set: { if !$0 { store.lastError = nil } }
            ),
            actions: { Button("OK") { store.lastError = nil } },
            message: { Text(store.lastError ?? "") }
        )
    }

    private var threePanes: some View {
        NavigationSplitView {
            Sidebar(store: store)
                .navigationSplitViewColumnWidth(min: 190, ideal: 210)
        } content: {
            Group {
                switch store.navigation.section {
                case .overview: OverviewFunnel(store: store)
                case .interview: InterviewList(store: store)
                case .search: SearchList(store: store)
                case .agentRuns: RunsList(store: store)
                case .companies: CompaniesList(store: store)
                case .whichApplication: WhichApplicationList(store: store)
                case .profile: ProfileEditor(store: store).navigationTitle("Profile")
                case .projects: ProjectsList(store: store)
                default: PostingList(store: store)
                }
            }
            .navigationSplitViewColumnWidth(min: 280, ideal: 330)
        } detail: {
            Detail(store: store)
        }
    }

    /// Settings is one page: it takes the whole window beside the sidebar.
    private var onePane: some View {
        NavigationSplitView {
            Sidebar(store: store)
                .navigationSplitViewColumnWidth(min: 190, ideal: 210)
        } detail: {
            SettingsView(store: store)
        }
    }
}

/// Before the first answer from the background service.
struct ServiceStarting: View {
    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Starting Applyant…").font(.title3)
            Text("Waiting for its background service. The first start also fetches a browser for reading job pages, which can take a minute.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The background service isn't reachable: say so across the window instead of empty lists.
struct ServiceDown: View {
    let store: AppStore

    var body: some View {
        ContentUnavailableView {
            Label("Applyant's background service isn't running", systemImage: "bolt.horizontal.circle")
        } description: {
            VStack(spacing: 6) {
                if case let .disconnected(reason) = store.connection { Text(reason).textSelection(.enabled) }
                Text("It does all the work: searching, scoring, writing and sending. macOS starts it at login and again after a crash, and Applyant keeps trying to reach it. If it stays down, the log says why.")
            }
        } actions: {
            Button("Retry") { store.retryConnection() }.buttonStyle(.borderedProminent)
            Button("Show Logs") { NSWorkspace.shared.open(UserPaths().logsDir) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A slim line along the window's bottom: what Applyant is doing now, or what it waits for.
struct ActivityBar: View {
    let store: AppStore

    var body: some View {
        if store.connection == .connected, let line = store.activityLine {
            HStack(spacing: 8) {
                if store.activity.paused == nil {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "pause.circle").foregroundStyle(.orange)
                }
                Text(line).font(.callout).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 5)
            .background(.bar)
            .overlay(alignment: .top) { Divider() }
        }
    }
}

/// What an action was refused for, inside a sheet (the main window's alert is behind it).
struct ErrorBanner: View {
    let store: AppStore

    var body: some View {
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
}

extension View {
    /// A sheet that shows the store's last error itself, along its bottom edge.
    func showsErrors(_ store: AppStore) -> some View {
        safeAreaInset(edge: .bottom, spacing: 0) {
            ErrorBanner(store: store).padding(.horizontal, 16).padding(.bottom, store.lastError == nil ? 0 : 12)
        }
        .onAppear {
            store.lastError = nil
            store.inlineErrorViews += 1
        }
        .onDisappear { store.inlineErrorViews = max(0, store.inlineErrorViews - 1) }
    }
}

struct Detail: View {
    let store: AppStore

    var body: some View {
        if store.navigation.section == .overview {
            OverviewMetrics(store: store)
        } else if store.navigation.section == .profile {
            ProfileSourcesPane(store: store)
        } else if store.navigation.section == .projects {
            ProjectDetail(store: store)
        } else if store.navigation.section == .search {
            SearchDetail(store: store)
        } else if store.navigation.section == .agentRuns {
            RunDetail(store: store)
        } else if store.navigation.section == .companies {
            CompanyDetail(store: store)
        } else if store.navigation.section == .whichApplication {
            WhichApplicationDetail(store: store)
        } else if store.navigation.section == .interview {
            if let target = store.navigation.interview {
                InterviewThreadView(store: store, target: target)
                    .id(target)
            } else {
                ContentUnavailableView(
                    "Questions for you",
                    systemImage: ApplyantKit.Section.interview.symbol,
                    description: Text("Applyant asks what your CV and repositories can't show: what you built yourself, the team, the results. Pick a question or a project on the left; your answers become facts that applications can use.")
                )
            }
        } else if let app = store.navigation.reviewing {
            ReviewApplication(store: store, applicationId: app)
                .id(app)
        } else if let posting = store.navigation.postingId {
            PostingDetail(store: store, postingId: posting)
                .id(posting)
        } else {
            let section = store.navigation.section
            if store.items(section).isEmpty {
                // The list says why it's empty; nothing to repeat here.
                Color.clear
            } else {
                ContentUnavailableView("Nothing selected", systemImage: section.symbol, description: Text("Pick one on the left."))
            }
        }
    }
}

struct Sidebar: View {
    @Bindable var store: AppStore

    var body: some View {
        List(selection: Binding(
            get: { store.navigation.section },
            set: { section in
                guard let section, section != store.navigation.section else { return }
                store.navigation.section = section
                store.navigation.postingId = nil
                store.navigation.reviewing = nil
            }
        )) {
            ForEach(Section.Group.allCases, id: \.self) { group in
                let sections = Section.allCases.filter { $0.group == group }
                if group == .top {
                    ForEach(sections) { row($0) }
                } else {
                    SwiftUI.Section(group.rawValue) {
                        ForEach(sections) { row($0) }
                    }
                }
            }
        }
        .listStyle(.sidebar)
    }

    private func row(_ section: ApplyantKit.Section) -> some View {
        let count = store.count(section)
        return Label(section.title, systemImage: section.symbol)
            .badge(count > 0 && section != .skipped ? count : 0)
            .foregroundStyle(section.isBuilt ? .primary : .secondary)
            .tag(section)
    }
}

struct PostingList: View {
    let store: AppStore
    /// What Re-score said, under the title for a few seconds.
    @State private var note: String?
    @State private var addingPosting = false

    var body: some View {
        let section = store.navigation.section
        let items = store.items(section)
        Group {
            if items.isEmpty {
                let empty = store.emptyState(section)
                ContentUnavailableView {
                    Label(empty.title, systemImage: section.symbol)
                } description: {
                    Text(empty.detail)
                } actions: {
                    if section == .inbox {
                        Button("Add posting…") { addingPosting = true }
                        if store.search.strategies.isEmpty {
                            Button("Open Search") { store.navigation.section = .search }
                        }
                    }
                }
            } else {
                List(items, selection: Binding(
                    get: { store.navigation.postingId.flatMap { id in items.first { $0.postingId == id }?.id } },
                    set: { select($0, in: items, section: section) }
                )) { item in
                    PostingRow(item: item)
                        .tag(item.id)
                        .contextMenu { rowMenu(item, section: section) }
                }
            }
        }
        .navigationTitle(section.title)
        .navigationSubtitle(note ?? "")
        .toolbar {
            if section == .inbox {
                ToolbarItem {
                    Button { addingPosting = true } label: {
                        Label("Add posting…", systemImage: "plus")
                    }
                    .help("Add a job posting by its URL: it's verified and scored like any other")
                }
                ToolbarItem {
                    Button { Task { note = await store.rescore() } } label: {
                        Label("Re-score all", systemImage: "arrow.clockwise")
                    }
                    .help("Score every verified or scored posting again (what was read before is reused)")
                }
            }
        }
        .task(id: note) {
            // A newer note cancels this wait; only an uninterrupted one clears it.
            guard note != nil, (try? await Task.sleep(for: .seconds(4))) != nil else { return }
            note = nil
        }
        .sheet(isPresented: $addingPosting) { AddPostingSheet(store: store) { addingPosting = false } }
    }

    /// A row's menu: Set status for an application, Re-score in the posting sections.
    @ViewBuilder
    private func rowMenu(_ item: ListItem, section: ApplyantKit.Section) -> some View {
        if let id = item.applicationId, let app = store.applications[id] {
            SetStatusMenu(store: store, app: app)
        }
        if [.inbox, .interested, .skipped].contains(section), let p = store.postings[item.postingId], Score.canRescore(p) {
            Button("Re-score") { Task { note = await store.rescore([p.id]) } }
        }
    }

    private func select(_ id: String?, in items: [ListItem], section: ApplyantKit.Section) {
        guard let item = items.first(where: { $0.id == id }) else { return }
        store.navigation.postingId = item.postingId
        // Application sections open the review; posting sections open the posting.
        let reviewSections: Set<ApplyantKit.Section> = [.readyToReview, .preparing, .applied, .interviews, .offers]
        store.navigation.reviewing = reviewSections.contains(section) ? item.applicationId : nil
    }
}

struct PostingRow: View {
    let item: ListItem

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ScoreBadge(score: item.score)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title).font(.headline).lineLimit(2)
                if !item.subtitle.isEmpty {
                    Text(item.subtitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                if !item.chips.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(item.chips, id: \.text) { ChipView(chip: $0) }
                    }
                }
            }
        }
        .padding(.vertical, 3)
    }
}

struct ScoreBadge: View {
    let score: Int32?

    var body: some View {
        Text(score.map { "\($0)" } ?? "–")
            .font(.system(.title3, design: .rounded).weight(.semibold))
            .monospacedDigit()
            .frame(width: 38)
            .foregroundStyle(color)
    }

    private var color: Color {
        guard let score else { return .secondary }
        return score >= 80 ? .green : score >= 60 ? .primary : .secondary
    }
}

struct ChipView: View {
    let chip: Chip

    var body: some View {
        Text(chip.text)
            .font(.caption)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(tint.opacity(0.15), in: Capsule())
            .foregroundStyle(tint == .secondary ? Color.secondary : tint)
    }

    private var tint: Color {
        switch chip.tone {
        case .accent: .accentColor
        case .warning: .orange
        case .good: .green
        case .neutral: .secondary
        }
    }
}

/// Inbox → Add posting…: a URL → AddPosting (the same as `applyant jobs add` and the Share
/// extension), and what happened: added, already known, or refused.
struct AddPostingSheet: View {
    let store: AppStore
    @State var url = ""
    @State var outcome: AddPostingOutcome?
    let close: () -> Void
    @State private var adding = false

    init(store: AppStore, url: String = "", outcome: AddPostingOutcome? = nil, close: @escaping () -> Void) {
        self.store = store
        _url = State(initialValue: url)
        _outcome = State(initialValue: outcome)
        self.close = close
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Add a posting").font(.headline)
            Text("Paste a job posting's link. It's verified, read and scored like the ones search finds.")
                .font(.callout).foregroundStyle(.secondary)
            TextField("URL", text: $url, prompt: Text("https://jobs.example.com/backend-engineer"))
                .textFieldStyle(.roundedBorder)
                .onSubmit(add)
            if let outcome {
                VStack(alignment: .leading, spacing: 2) {
                    Label(outcome.line, systemImage: outcome.ok ? "checkmark.circle" : "exclamationmark.triangle")
                        .foregroundStyle(outcome.ok ? Color.primary : Color.orange)
                    if let detail = outcome.detail {
                        Text(detail).font(.callout).foregroundStyle(.secondary).padding(.leading, 22)
                    }
                }
                .textSelection(.enabled)
            }
            HStack {
                if adding { ProgressView().controlSize(.small) }
                Spacer()
                Button(outcome == nil ? "Cancel" : "Done", action: close)
                Button("Add", action: add)
                    .keyboardShortcut(.defaultAction)
                    .disabled(adding || url.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 480)
    }

    private func add() {
        let input = url
        guard !adding, !input.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        adding = true
        Task {
            outcome = await store.addPosting(input)
            adding = false
            if outcome?.ok == true { url = "" }
        }
    }
}
