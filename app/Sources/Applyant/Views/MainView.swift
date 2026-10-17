// The main window, Mail-style: sections → the section's list → the selected item.
import AppKit
import ApplyantKit
import SwiftUI

struct MainView: View {
    @Bindable var store: AppStore
    /// "Approved: on its way", "Skipped": a moment over the bottom of the window.
    var toasts = Toasts()

    var body: some View {
        VStack(spacing: 0) {
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
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .bottom) { ToastHost(toasts: toasts) }

            ActivityBar(store: store)
        }
        .animation(Theme.Motion.smooth, value: store.activityLine == nil)
        .environment(toasts)
        .tint(Theme.accent)
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

    /// Settings and Chat use the whole window beside the sidebar.
    private var onePane: some View {
        NavigationSplitView {
            Sidebar(store: store)
                .navigationSplitViewColumnWidth(min: 190, ideal: 210)
        } detail: {
            if store.navigation.section == .chat {
                ChatView(store: store)
            } else {
                SettingsView(store: store)
            }
        }
    }
}

/// Before the first answer from the background service.
struct ServiceStarting: View {
    var body: some View {
        VStack(spacing: 14) {
            LiveSymbol(systemImage: "sparkles")
            Text("Starting Applyant…").font(.title3.weight(.semibold))
            Text("Waiting for its background service. The first start also fetches a browser for reading job pages, which can take a minute.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            ProgressView().controlSize(.small)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The background service isn't reachable: say so across the window instead of empty lists.
struct ServiceDown: View {
    let store: AppStore

    var body: some View {
        ContentUnavailableView {
            Label { Text("Applyant's background service isn't running") } icon: { LiveSymbol(systemImage: "bolt.horizontal.circle") }
        } description: {
            VStack(spacing: 6) {
                if case let .disconnected(reason) = store.connection { Text(reason).textSelection(.enabled) }
                Text("It does all the work: searching, scoring, writing and sending. macOS starts it at login and again after a crash, and Applyant keeps trying to reach it. If it stays down, the log says why.")
            }
        } actions: {
            Button("Retry") { store.retryConnection() }.buttonStyle(.primary)
            Button("Show Logs") { NSWorkspace.shared.open(UserPaths().logsDir) }.buttonStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Pauses or resumes search, scoring and the rest of the background work, without quitting.
struct PauseButton: View {
    let store: AppStore

    var body: some View {
        let paused = store.backgroundPausedAt != nil
        Button { Task { await store.setBackgroundPaused(!paused) } } label: {
            Label(paused ? "Resume" : "Pause", systemImage: paused ? "play.fill" : "pause.fill")
        }
        .help(paused
            ? "Resume background work: whatever came due while paused runs now"
            : "Pause searching, scoring, research and mail until you resume (interview answers and approved applications still go through)")
    }
}

/// A slim line along the window's bottom: what Applyant is doing now, or what it waits for.
/// While it works, the brand colours flow along its top edge.
struct ActivityBar: View {
    let store: AppStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let motion = EndlessMotion()

    var body: some View {
        if store.connection == .connected, let line = store.activityLine {
            let working = store.activity.paused == nil && store.backgroundPausedAt == nil
            HStack(spacing: 8) {
                Image(systemName: working ? "sparkles" : "pause.circle.fill")
                    .foregroundStyle(working ? AnyShapeStyle(Theme.brand) : AnyShapeStyle(Theme.warning))
                    .symbolEffect(.pulse, options: .repeating, isActive: working && motion.allowed)
                    .contentTransition(.symbolEffect(.replace))
                ZStack(alignment: .leading) {
                    Text(line)
                        .font(.callout).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                        .id(line)
                        .transition(reduceMotion ? .opacity : .push(from: .bottom))
                }
                .clipped()
                Spacer()
            }
            .animation(Theme.Motion.smooth, value: line)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .background(.bar)
            .overlay(alignment: .top) { FlowLine(flowing: working).id(working) }
            .transition(.move(edge: .bottom).combined(with: .opacity))
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
            .insetSurface(tint: Theme.warning)
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // A newly picked job comes in from a little below, out of a blur; the one before fades.
        ZStack { content }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .pageBackground()
            // The page runs up under the toolbar: no bar of the window's own colour over it.
            .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
            .animation(Theme.Motion.pick(Theme.Motion.smooth, reduceMotion: reduceMotion), value: store.navigation.postingId)
    }

    @ViewBuilder
    private var content: some View {
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
                EmptyState(
                    title: "Questions for you",
                    systemImage: ApplyantKit.Section.interview.symbol,
                    detail: "Applyant asks what your CV and repositories can't show: what you built yourself, the team, the results. Pick a question or a project on the left; your answers become facts that applications can use."
                )
            }
        } else if let posting = store.navigation.postingId {
            JobDetail(store: store, postingId: posting, applicationId: store.navigation.reviewing)
                .id(posting)
                .transition(.page(reduceMotion: reduceMotion))
        } else {
            let section = store.navigation.section
            if store.items(section).isEmpty {
                // The list says why it's empty; nothing to repeat here.
                Color.clear
            } else {
                EmptyState(title: "Nothing selected", systemImage: section.symbol, detail: "Pick one on the left.")
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
        // Above the sections, so it's there whichever one is open.
        .toolbar { ToolbarItem { PauseButton(store: store) } }
    }

    private func row(_ section: ApplyantKit.Section) -> some View {
        let count = store.count(section)
        return SidebarRow(section: section, count: count > 0 && section != .skipped ? count : 0)
            .foregroundStyle(section.isBuilt ? .primary : .secondary)
            .tag(section)
    }
}

/// A section in the sidebar: its symbol hops when something new arrives, and its count rolls
/// to the new number.
private struct SidebarRow: View {
    let section: ApplyantKit.Section
    let count: Int
    @State private var arrivals = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Label {
            HStack {
                Text(section.title)
                Spacer(minLength: 4)
                if count > 0 {
                    Text("\(count)")
                        .font(.caption.weight(.semibold))
                        .monospacedDigit()
                        .contentTransition(.numericText(value: Double(count)))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Color.primary.opacity(0.07), in: Capsule())
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .animation(Theme.Motion.pick(Theme.Motion.snappy, reduceMotion: reduceMotion), value: count)
        } icon: {
            // In the app's own accent, like everything else that's Applyant's.
            Image(systemName: section.symbol)
                .foregroundStyle(Theme.accent)
                .symbolEffect(.bounce, value: reduceMotion ? 0 : arrivals)
        }
        .onChange(of: count) { old, new in
            if new > old { arrivals += 1 }
        }
    }
}

/// A list of jobs: To review in its groups, New under its filter, the others as they are.
/// Every row opens the same job detail.
struct PostingList: View {
    @Bindable var store: AppStore
    /// What Re-score said, under the title for a few seconds.
    @State private var note: String?
    @State private var addingPosting = false

    var body: some View {
        let section = store.navigation.section
        let groups = store.groups(section)
        let items = groups.flatMap(\.items)
        Group {
            if items.isEmpty {
                emptyState(section)
            } else {
                List(selection: Binding(
                    get: { store.navigation.postingId.flatMap { id in items.first { $0.postingId == id }?.id } },
                    set: { id in if let item = items.first(where: { $0.id == id }) { store.navigation.select(item) } }
                )) {
                    ForEach(groups) { group in
                        if group.title.isEmpty {
                            rows(group.items, section: section)
                        } else {
                            SwiftUI.Section {
                                rows(group.items, section: section, live: group.id == JobLists.ReviewGroup.preparing.rawValue)
                            } header: {
                                Eyebrow(text: group.title, count: group.items.count, tint: groupTint(group.id))
                                    .padding(.vertical, 2)
                            }
                        }
                    }
                }
                // Approved, skipped or moved: rows slide out and in instead of jumping.
                .animation(Theme.Motion.smooth, value: items.map(\.id))
                // Another list, or New's other filter, is a list of its own: not hundreds of rows
                // animating out and in.
                .id(section == .new ? "\(section.rawValue).\(store.navigation.newFilter.rawValue)" : section.rawValue)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if section == .new { NewFilterBar(store: store) }
        }
        .navigationTitle(section.title)
        .navigationSubtitle(note ?? "")
        .toolbar {
            if section == .new {
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
        .task { await store.loadPreferences() }
        .sheet(isPresented: $addingPosting) { AddPostingSheet(store: store) { addingPosting = false } }
    }

    private func rows(_ items: [ListItem], section: ApplyantKit.Section, live: Bool = false) -> some View {
        ForEach(items) { item in
            PostingRow(item: item, live: live)
                .tag(item.id)
                .contextMenu { rowMenu(item, section: section) }
        }
    }

    private func groupTint(_ id: String) -> Color {
        switch JobLists.ReviewGroup(rawValue: id) {
        case .needsYou: Theme.warning
        case .ready: Theme.accent
        default: .secondary
        }
    }

    @ViewBuilder
    private func emptyState(_ section: ApplyantKit.Section) -> some View {
        let hidden = section == .new ? store.newHidden : 0
        let empty = hidden > 0 ? ActivityText.noGoodMatches(hidden: hidden, below: store.goodMatchScore) : store.emptyState(section)
        EmptyState(title: empty.title, systemImage: section.symbol, detail: empty.detail) {
            if section == .new {
                if hidden > 0 { Button("Show all") { store.navigation.newFilter = .all }.buttonStyle(.primary) }
                Button("Add posting…") { addingPosting = true }.buttonStyle(.secondary)
                if store.search.strategies.isEmpty {
                    Button("Open Search") { store.navigation.section = .search }.buttonStyle(.secondary)
                }
            }
        }
    }

    /// A row's menu: Set status for an application, Re-score in the posting sections.
    @ViewBuilder
    private func rowMenu(_ item: ListItem, section: ApplyantKit.Section) -> some View {
        if let id = item.applicationId, let app = store.applications[id] {
            SetStatusMenu(store: store, app: app)
        }
        if [.new, .saved, .skipped].contains(section), let p = store.postings[item.postingId], Score.canRescore(p) {
            Button("Re-score") { Task { note = await store.rescore([p.id]) } }
        }
    }
}

/// New's filter: the good matches first, or everything scored, and what the filter hides.
struct NewFilterBar: View {
    @Bindable var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            PillPicker(items: NewFilter.allCases, title: \.title, selection: $store.navigation.newFilter)
                .help("Good matches score \(store.goodMatchScore) or more. The ones at or above your threshold are prepared on their own and wait in To review.")
            if let hidden = JobLists.hiddenLine(store.newHidden, below: store.goodMatchScore) {
                Text(hidden)
                    .font(.caption).foregroundStyle(.secondary)
                    .contentTransition(.numericText())
                    .animation(Theme.Motion.snappy, value: hidden)
                    .padding(.leading, 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider().opacity(0.6) }
    }
}

/// A job in a list: its score ring, what and where it is, and its chips. Preparing ones shimmer.
struct PostingRow: View {
    let item: ListItem
    var live = false
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            ScoreRing(score: item.score, size: 34)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title).font(.headline).lineLimit(2)
                if !item.subtitle.isEmpty {
                    Text(item.subtitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                if !item.chips.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(item.chips, id: \.text) { ChipView(chip: $0) }
                    }
                    .padding(.top, 2)
                }
            }
            .shimmer(live)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 4)
        .background(
            RoundedRectangle(cornerRadius: Theme.innerRadius, style: .continuous)
                .fill(Color.primary.opacity(hovering ? 0.045 : 0))
                .padding(.horizontal, -6)
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .animation(Theme.Motion.fade, value: hovering)
    }
}

/// New → Add posting…: a URL → AddPosting (the same as `applyant jobs add` and the Share
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
                    .buttonStyle(.primary)
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
