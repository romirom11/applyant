// The main window, CleanMyMac-style: one deep colour world behind everything (the open
// section's), a slim rail of section icons on the left, the section's list in a glass panel
// and the picked item beside it. Home, Chat and Settings use the whole window beside the rail.
// No system chrome: the traffic lights sit over the world, and what Applyant is doing (with
// Pause and Resume) at the title bar's right.
import AppKit
import ApplyantKit
import SwiftUI

struct MainView: View {
    @Bindable var store: AppStore
    /// "Approved: on its way", "Skipped": a moment over the bottom of the window.
    var toasts = Toasts()
    /// The list column's width, dragged at its edge.
    @AppStorage("listColumnWidth") private var listWidth: Double = 360
    /// The top of the window: the traffic lights and the title.
    static let titleBar: CGFloat = 40

    var body: some View {
        ZStack {
            WorldBackground(section: store.navigation.section)
            HStack(spacing: 0) {
                IconRail(store: store)
                    .zIndex(2)
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
                .padding(.top, Self.titleBar)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .overlay { MomentHost(toasts: toasts) }
            .overlay(alignment: .bottom) { ToastHost(toasts: toasts) }
            TitleBar(store: store)
        }
        .ignoresSafeArea()
        // .secondary and .tertiary everywhere are Theme's greys, not the system's.
        .themeForeground()
        .environment(toasts)
        .tint(Theme.accent)
        // Always the dark world, like CleanMyMac: the window and everything in it.
        .preferredColorScheme(.dark)
        .environment(\.colorScheme, .dark)
        .modifier(BisectKey())
        .sheet(isPresented: $store.showOnboarding) {
            OnboardingView(store: store)
                .frame(minWidth: 900, idealWidth: 980, minHeight: 640, idealHeight: 720)
                .worldSheet()
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

    /// The job lists: an empty one takes the whole window, its art large in the middle.
    private static let jobLists: Set<ApplyantKit.Section> = [.toReview, .new, .saved, .skipped, .applied, .interviews, .offers]

    @ViewBuilder
    private var threePanes: some View {
        let section = store.navigation.section
        if Self.jobLists.contains(section) && store.items(section).isEmpty {
            PostingList(store: store, alone: true)
                .padding(.trailing, 12)
                .padding(.bottom, 12)
        } else {
            columns
        }
    }

    private var columns: some View {
        GeometryReader { geo in
            // However wide it was dragged, the list leaves the detail room for its header.
            let width = min(CGFloat(listWidth), max(290, geo.size.width - 12 - 470))
            HStack(spacing: 0) {
                listColumn
                    .frame(width: width)
                    .frame(maxHeight: .infinity)
                    .listPanel()
                    .padding(.bottom, 12)
                ColumnHandle(width: $listWidth)
                Detail(store: store)
            }
        }
    }

    @ViewBuilder
    private var listColumn: some View {
        switch store.navigation.section {
        case .interview: InterviewList(store: store)
        case .search: SearchList(store: store)
        case .agentRuns: RunsList(store: store)
        case .companies: CompaniesList(store: store)
        case .whichApplication: WhichApplicationList(store: store)
        case .profile: ProfileColumn(store: store)
        case .projects: ProjectsList(store: store)
        default: PostingList(store: store)
        }
    }

    /// Home, Settings and Chat use the whole window beside the rail.
    @ViewBuilder
    private var onePane: some View {
        switch store.navigation.section {
        case .overview: HomeView(store: store)
        case .chat: ChatView(store: store)
        default: SettingsView(store: store)
        }
    }
}

extension View {
    /// The list column's panel: a slab of dark glass with a lit edge.
    func listPanel() -> some View {
        let shape = RoundedRectangle(cornerRadius: Theme.panelRadius, style: .continuous)
        return background {
            shape.fill(Color.black.opacity(0.2))
                .overlay { shape.fill(Theme.glassFill) }
        }
        .clipShape(shape)
        .overlay { shape.strokeBorder(Theme.glassEdge, lineWidth: 1) }
    }
}

/// Between the list and the detail: dragged, the list gets wider or narrower.
private struct ColumnHandle: View {
    @Binding var width: Double
    @State private var start: Double?
    @State private var hovering = false

    var body: some View {
        Capsule()
            .fill(Color.white.opacity(hovering || start != nil ? 0.35 : 0))
            .frame(width: 3, height: 44)
            .frame(width: 12)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .onHover { inside in
                hovering = inside
                if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { drag in
                        let from = start ?? width
                        start = from
                        width = min(max(from + drag.translation.width, 290), 520)
                    }
                    .onEnded { _ in start = nil }
            )
            .animation(Theme.Motion.fade, value: hovering)
            .accessibilityHidden(true)
    }
}

/// The window's top: what Applyant is doing now at the right, with Pause or Resume. The
/// section's name isn't repeated here: the list's own header says it.
private struct TitleBar: View {
    let store: AppStore

    var body: some View {
        VStack {
            HStack(spacing: 8) {
                Spacer()
                if store.connection == .connected {
                    ActivityPill(store: store)
                    if store.backgroundPausedAt == nil { PauseButton(store: store) }
                }
            }
            .padding(.trailing, 14)
            .frame(height: MainView.titleBar)
            .animation(Theme.Motion.snappy, value: store.backgroundPausedAt)
            Spacer()
        }
    }
}

/// What Applyant is doing now, or that it's paused, in a small glass capsule short enough
/// never to be cut (the whole line is its tooltip). Paused, it says since when and offers
/// Resume, on every section; the work under way is left to Home's tiles there.
struct ActivityPill: View {
    let store: AppStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let since = store.backgroundPausedAt {
            HStack(spacing: 8) {
                Image(systemName: "pause.circle.fill").foregroundStyle(Theme.warning).font(.system(size: 11))
                Text(ActivityText.pausedSince(since))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.text)
                Button("Resume") { Task { await store.setBackgroundPaused(false) } }
                    .buttonStyle(.secondary)
                    .controlSize(.mini)
                    .help("Resume background work: whatever came due while paused runs now")
            }
            .fixedSize()
            .padding(.leading, 11)
            .padding(.trailing, 4)
            .padding(.vertical, 3)
            .capsule()
            .help(store.activityLine ?? "")
            .transition(.opacity.combined(with: .scale(scale: 0.9)))
        } else if store.navigation.section != .overview, let line = store.activityLine {
            // A limit's pause says only that; the rest of the line is its tooltip.
            let short = ActivityText.pill(store.activity.paused ?? line)
            HStack(spacing: 7) {
                if store.activity.paused != nil {
                    Image(systemName: "pause.circle.fill").foregroundStyle(Theme.warning).font(.system(size: 11))
                } else {
                    LiveDot(color: Theme.magenta, size: 5)
                }
                Text(short)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.text)
                    .id(short)
                    .transition(reduceMotion ? .opacity : .push(from: .bottom))
            }
            .fixedSize()
            .padding(.horizontal, 11)
            .padding(.vertical, 5)
            .capsule()
            .animation(Theme.Motion.smooth, value: short)
            .help(line)
            .onTapGesture { store.navigation.go(to: .overview) }
            .transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
    }
}

private extension View {
    /// The title bar's dark glass capsule.
    func capsule() -> some View {
        background(Color.black.opacity(0.22), in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.glassEdge, lineWidth: 0.75))
            .clipShape(Capsule())
    }
}

/// Before the first answer from the background service.
struct ServiceStarting: View {
    var body: some View {
        VStack(spacing: 16) {
            ArtView(.searching, size: 150)
            Text("Starting Applyant…").font(.system(size: 22, weight: .bold))
            Text("Waiting for its background service. The first start also fetches a browser for reading job pages, which can take a minute.")
                .foregroundStyle(Theme.secondaryText)
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
        EmptyState(
            title: "Applyant's background service isn't running",
            systemImage: "bolt.horizontal.circle",
            detail: {
                var lines: [String] = []
                if case let .disconnected(reason) = store.connection { lines.append(reason) }
                lines.append("It does all the work: searching, scoring, writing and sending. macOS starts it at login and again after a crash, and Applyant keeps trying to reach it. If it stays down, the log says why.")
                return lines.joined(separator: "\n\n")
            }(),
            art: .settings
        ) {
            Button("Retry") { store.retryConnection() }.buttonStyle(.primary)
            Button("Show Logs") { NSWorkspace.shared.open(UserPaths().logsDir) }.buttonStyle(.secondary)
        }
    }
}

// MARK: - The rail

/// The sections in their groups (Jobs, Applications, Me, System), as icons with their names
/// beside them, or as icons alone (View › Hide Labels; a name then comes out beside the icon
/// under the pointer). The picked one sits in a glowing glass pill that slides from section to
/// section; counts are small neutral badges, orange only for what needs the candidate. The Go
/// menu steps through them (⌥⌘↑, ⌥⌘↓) and jumps to the first nine (⌥⌘1…9).
struct IconRail: View {
    @Bindable var store: AppStore
    @AppStorage("railLabels") private var labels = true
    @Namespace private var pill
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The rail with its labels; Theme.railWidth without.
    static let labelledWidth: CGFloat = 192

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: labels ? .leading : .center, spacing: labels ? 1 : 3) {
                ForEach(Section.Group.allCases, id: \.self) { group in
                    if group != .top {
                        if labels {
                            Text(group.rawValue.uppercased())
                                .font(Theme.eyebrow)
                                .tracking(1)
                                .foregroundStyle(Theme.tertiaryText)
                                .padding(.leading, 10)
                                .padding(.top, 12)
                                .padding(.bottom, 3)
                        } else {
                            Capsule().fill(Color.white.opacity(0.12)).frame(width: 18, height: 2).padding(.vertical, 7)
                        }
                    }
                    ForEach(Section.allCases.filter { $0.group == group }) { section in
                        RailItem(
                            section: section,
                            picked: store.navigation.section == section,
                            count: section == .skipped ? 0 : store.count(section),
                            urgent: section == .toReview && !store.review(.needsYou).isEmpty,
                            labelled: labels,
                            pill: pill
                        ) { go(section) }
                    }
                }
            }
            .padding(.horizontal, labels ? 10 : 0)
            .padding(.top, 6)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.never)
        .frame(width: labels ? Self.labelledWidth : Theme.railWidth)
        .padding(.top, MainView.titleBar + 6)
        .background(alignment: .trailing) {
            // The rail's own strip: a little darker than the world, with a hairline.
            LinearGradient(colors: [Color.black.opacity(0.2), Color.black.opacity(0.08)], startPoint: .leading, endPoint: .trailing)
                .overlay(alignment: .trailing) { Rectangle().fill(Color.white.opacity(0.06)).frame(width: 1) }
        }
        .animation(Theme.Motion.pick(Theme.Motion.snappy, reduceMotion: reduceMotion), value: labels)
        // Icons alone: the label of the one under the pointer comes out beside the rail, over
        // the list, drawn here outside the rail's scroll view so nothing cuts it off.
        .overlayPreferenceValue(RailHover.self) { hovered in
            GeometryReader { geo in
                if !labels, let hovered {
                    let frame = geo[hovered.bounds]
                    RailLabel(title: hovered.section.railTitle)
                        .frame(height: 26)
                        .offset(x: frame.maxX + 6, y: frame.midY - 13)
                        .transition(.opacity)
                        .id(hovered.section)
                }
            }
            .allowsHitTesting(false)
        }
    }

    private func go(_ section: ApplyantKit.Section) {
        withAnimation(Theme.Motion.pick(Theme.Motion.snappy, reduceMotion: reduceMotion)) {
            store.navigation.go(to: section)
        }
    }
}

private struct RailItem: View {
    let section: ApplyantKit.Section
    let picked: Bool
    let count: Int
    /// To review while something in it needs the candidate: its badge is orange.
    let urgent: Bool
    let labelled: Bool
    let pill: Namespace.ID
    let action: () -> Void
    @State private var hovering = false
    @State private var arrivals = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            Group {
                if labelled {
                    HStack(spacing: 10) {
                        icon.frame(width: 22)
                        Text(section.railTitle)
                            .font(.system(size: 13, weight: picked ? .semibold : .medium))
                            .foregroundStyle(picked ? AnyShapeStyle(.white) : AnyShapeStyle(Color.white.opacity(hovering ? 0.92 : 0.72)))
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        if count > 0 { badge }
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 32)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background { highlight(radius: 10) }
                } else {
                    icon
                        .frame(width: 48, height: 40)
                        .background { highlight(radius: 14) }
                        .overlay(alignment: .topTrailing) {
                            if count > 0 { badge.offset(x: 7, y: -4) }
                        }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .anchorPreference(key: RailHover.self, value: .bounds) { hovering ? RailHover.Hovered(section: section, bounds: $0) : nil }
        .animation(Theme.Motion.snappy, value: hovering)
        .animation(Theme.Motion.snappy, value: count)
        .onChange(of: count) { old, new in
            if new > old { arrivals += 1 }
        }
        .accessibilityLabel(section.railTitle + (count > 0 ? ", \(count)" : ""))
        .accessibilityAddTraits(picked ? .isSelected : [])
    }

    private var icon: some View {
        Image(systemName: Self.symbol(section))
            .symbolVariant(picked ? .fill : .none)
            .font(.system(size: labelled ? 15 : 17, weight: .semibold))
            .foregroundStyle(picked ? AnyShapeStyle(.white) : AnyShapeStyle(Color.white.opacity(hovering ? 0.9 : 0.6)))
            .symbolEffect(.bounce, value: reduceMotion ? 0 : arrivals)
    }

    /// The picked section's pill (it slides to the next one), or the pointer's glass. The pill
    /// is the app's one selection colour, as everywhere else (white on it reads at 5.5:1); the
    /// section's world only glows around it.
    @ViewBuilder
    private func highlight(radius: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        if picked {
            let world = Theme.world(section)
            shape
                .fill(Theme.accentFill)
                .overlay { shape.strokeBorder(Color.white.opacity(0.22), lineWidth: 0.75) }
                .shadow(color: world.main.opacity(0.45), radius: 10)
                .matchedGeometryEffect(id: "pill", in: pill)
        } else if hovering {
            shape.fill(Color.white.opacity(0.08))
        }
    }

    /// One neutral style for every count; orange only for what needs the candidate.
    private var badge: some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(Theme.number(10, weight: .bold))
            .foregroundStyle(urgent ? Theme.warning : Theme.secondaryText)
            .contentTransition(.numericText(value: Double(count)))
            .padding(.horizontal, 5)
            .frame(minWidth: 18, minHeight: 16)
            .background(Capsule().fill(urgent ? Theme.warning.opacity(0.2) : Color.white.opacity(0.13)))
            .background(Capsule().fill(Theme.base))
            .transition(.scale.combined(with: .opacity))
    }

    /// The rail's glyph: Home is the house the window opens on, the rest their own symbol.
    static func symbol(_ section: ApplyantKit.Section) -> String {
        switch section {
        case .overview: "house"
        case .toReview: "checklist"
        case .new: "tray.full"
        case .interview: "questionmark.bubble"
        case .whichApplication: "envelope.badge"
        default: section.symbol
        }
    }
}

/// The rail icon under the pointer, and where it is: its label is drawn beside it.
private struct RailHover: PreferenceKey {
    struct Hovered {
        let section: ApplyantKit.Section
        let bounds: Anchor<CGRect>
    }

    static let defaultValue: Hovered? = nil
    static func reduce(value: inout Hovered?, nextValue: () -> Hovered?) { value = value ?? nextValue() }
}

/// A section's name beside its rail icon: a small capsule of dark glass.
private struct RailLabel: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Theme.toastFill, in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.glassEdge, lineWidth: 0.75))
            .shadow(color: .black.opacity(0.35), radius: 8, y: 3)
            .fixedSize()
    }
}

/// Pauses search, scoring and the rest of the background work, without quitting: a small
/// round glass button in the title bar. Paused, the status capsule beside it offers Resume.
struct PauseButton: View {
    let store: AppStore
    @State private var hovering = false

    var body: some View {
        Button { Task { await store.setBackgroundPaused(true) } } label: {
            Image(systemName: "pause.fill")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Color.white.opacity(0.85))
                .frame(width: 26, height: 26)
                .background(Circle().fill(Color.white.opacity(hovering ? 0.16 : 0.09)))
                .overlay(Circle().strokeBorder(Theme.glassEdge, lineWidth: 1))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel("Pause")
        .help("Pause searching, scoring, research and mail until you resume (interview answers and approved applications still go through)")
        .transition(.opacity.combined(with: .scale(scale: 0.8)))
    }
}

// MARK: - The detail

/// What an action was refused for, inside a sheet (the main window's alert is behind it).
struct ErrorBanner: View {
    let store: AppStore

    var body: some View {
        if let error = store.lastError {
            HStack(alignment: .firstTextBaseline) {
                Label {
                    Text(error).textRole(.body)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warning)
                }
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button("Dismiss") { store.lastError = nil }.buttonStyle(.secondary).controlSize(.small)
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

    var body: some View {
        // Picking jobs is what the window is for: the next one fades in quickly (0.2 s) and the
        // one before goes at once, so ↓↓↓ never waits for the motion or stacks it up.
        ZStack { content }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(Theme.Motion.fade, value: store.navigation.postingId)
    }

    @ViewBuilder
    private var content: some View {
        if store.navigation.section == .profile {
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
                    detail: "Applyant asks what your CV and repositories can't show: what you built yourself, the team, the results. Pick a question or a project on the left; your answers become facts that applications can use.",
                    art: .questions
                )
            }
        } else if let posting = store.navigation.postingId {
            JobDetail(store: store, postingId: posting, applicationId: store.navigation.reviewing)
                .id(posting)
                .transition(.asymmetric(insertion: .opacity, removal: .identity))
        } else {
            let section = store.navigation.section
            let items = store.items(section)
            if items.isEmpty {
                // The list says why it's empty; nothing to repeat here.
                Color.clear
            } else {
                // A list with rows always has one open (split-views: the selection stays
                // visible); this shows only for the moment before the first is picked.
                EmptyState(title: "Pick one on the left", systemImage: section.symbol, detail: "\(items.count) in \(section.title).")
                    .task(id: section) {
                        if store.navigation.postingId == nil, let first = store.items(section).first {
                            store.navigation.select(first)
                        }
                    }
            }
        }
    }
}

// MARK: - The job lists

/// A list of jobs: To review in its groups, New under its filter, the others as they are.
/// Every row opens the same job detail.
struct PostingList: View {
    @Bindable var store: AppStore
    /// Empty, it's the whole window: the art and what to do, large in the middle.
    var alone = false
    /// What Re-score said, under the title for a few seconds.
    @State private var note: String?
    @State private var addingPosting = false
    @State private var connectingMailbox = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let section = store.navigation.section
        let groups = store.groups(section)
        let items = groups.flatMap(\.items)
        let world = Theme.world(section)
        VStack(alignment: .leading, spacing: 0) {
            // Alone and empty, the big art in the middle is the page's one picture.
            ModuleHeader(section: section, subtitle: note ?? subtitle(section, items: items.count), showsArt: !(alone && items.isEmpty)) {
                if section == .new { newActions }
            }
            .padding(.horizontal, 18)
            .padding(.top, 16)
            .padding(.bottom, 10)
            if section == .new { NewFilterBar(store: store).padding(.horizontal, 16).padding(.bottom, 6) }
            if items.isEmpty {
                emptyState(section)
            } else {
                CardList(
                    selection: Binding(
                        get: { store.navigation.postingId.flatMap { id in items.first { $0.postingId == id }?.id } },
                        set: { id in if let item = items.first(where: { $0.id == id }) { store.navigation.select(item) } }
                    ),
                    order: items.map(\.id),
                    tint: world.main
                ) {
                    ForEach(groups) { group in
                        if !group.title.isEmpty {
                            CardListHeader(title: group.title, count: group.items.count, tint: groupTint(group.id, world: world))
                        }
                        let live = group.id == JobLists.ReviewGroup.preparing.rawValue
                        ForEach(group.items) { item in
                            SelectableCard(id: item.id) {
                                PostingRow(item: item, chips: item.chips(in: section), live: live)
                            }
                            .sheen(live, radius: 15)
                            .contextMenu { rowMenu(item, section: section) }
                            .transition(.rowOut(reduceMotion: reduceMotion))
                        }
                    }
                }
                // Approved, skipped or moved: rows slide out and in instead of jumping.
                .animation(Theme.Motion.pick(Theme.Motion.smooth, reduceMotion: reduceMotion), value: items.map(\.id))
                // Another list, or New's other filter, is a list of its own: not hundreds of rows
                // animating out and in.
                .id(section == .new ? "\(section.rawValue).\(store.navigation.newFilter.rawValue)" : section.rawValue)
            }
        }
        .navigationTitle(section.title)
        .focusedSceneValue(\.listCommands, ListCommands(
            next: ListSelection.step(1, from: store.navigation.postingId, in: items).map { item in { store.navigation.select(item) } },
            previous: ListSelection.step(-1, from: store.navigation.postingId, in: items).map { item in { store.navigation.select(item) } }
        ))
        .task(id: note) {
            // A newer note cancels this wait; only an uninterrupted one clears it.
            guard note != nil, (try? await Task.sleep(for: .seconds(4))) != nil else { return }
            note = nil
        }
        .task { await store.loadPreferences() }
        .sheet(isPresented: $addingPosting) { AddPostingSheet(store: store) { addingPosting = false } }
        .sheet(isPresented: $connectingMailbox) { MailboxConnectSheet(store: store) { connectingMailbox = false }.worldSheet() }
    }

    /// "19 need you · 80 ready" under the title.
    private func subtitle(_ section: ApplyantKit.Section, items: Int) -> String {
        switch section {
        case .toReview:
            let waiting = store.count(.toReview)
            let preparing = store.review(.preparing).count
            return "\(waiting) waiting for you" + (preparing > 0 ? " · \(preparing) being prepared" : "")
        case .new:
            return store.navigation.newFilter == .good ? "\(items) good match\(items == 1 ? "" : "es")" : "\(items) scored"
        default:
            return items == 0 ? "" : "\(items) job\(items == 1 ? "" : "s")"
        }
    }

    private var newActions: some View {
        HStack(spacing: 6) {
            Button { addingPosting = true } label: { Image(systemName: "plus") }
                .help("Add a job posting by its URL: it's verified and scored like any other")
                .accessibilityLabel("Add Posting…")
            Button { Task { note = await store.rescore() } } label: { Image(systemName: "arrow.clockwise") }
                .help("Score every verified or scored posting again (what was read before is reused)")
                .accessibilityLabel("Re-score All")
        }
        .buttonStyle(.secondary)
        .controlSize(.small)
    }

    private func groupTint(_ id: String, world: Theme.World) -> Color {
        switch JobLists.ReviewGroup(rawValue: id) {
        case .needsYou: Theme.warning
        case .ready: world.main
        default: Theme.secondaryText
        }
    }

    @ViewBuilder
    private func emptyState(_ section: ApplyantKit.Section) -> some View {
        let hidden = section == .new ? store.newHidden : 0
        let empty = hidden > 0 ? ActivityText.noGoodMatches(hidden: hidden, below: store.goodMatchScore) : store.emptyState(section)
        EmptyState(
            title: empty.title,
            systemImage: section.symbol,
            detail: empty.detail,
            art: section == .toReview ? .allCaughtUp : Art(section),
            artSize: alone ? 220 : 150
        ) {
            // Every empty list names its next step, as a button.
            switch section {
            case .new:
                if hidden > 0 { Button("Show All") { store.navigation.newFilter = .all }.buttonStyle(.primary) }
                Button("Add Posting…") { addingPosting = true }.buttonStyle(.secondary)
                if store.search.strategies.isEmpty {
                    Button("Open Search") { store.navigation.go(to: .search) }.buttonStyle(.secondary)
                }
            case .saved, .skipped:
                Button("Open New") { store.navigation.go(to: .new) }.buttonStyle(.primary)
            case .applied:
                Button("Open To Review") { store.navigation.go(to: .toReview) }.buttonStyle(.primary)
            case .interviews, .offers:
                if MailText.problem(store.mailbox) != nil {
                    Button("Reconnect Mailbox…") { connectingMailbox = true }.buttonStyle(.primary)
                    Button("Open Applied") { store.navigation.go(to: .applied) }.buttonStyle(.secondary)
                } else {
                    Button("Open Applied") { store.navigation.go(to: .applied) }.buttonStyle(.primary)
                }
            default:
                EmptyView()
            }
        }
    }

    /// A row's menu: Set Status for an application, Re-score in the posting sections.
    @ViewBuilder
    private func rowMenu(_ item: ListItem, section: ApplyantKit.Section) -> some View {
        if let id = item.applicationId, let app = store.applications[id], !StageRules.targets(from: app.stage).isEmpty {
            Menu("Set Status") { SetStatusItems(store: store, app: app) }
        }
        if [.new, .saved, .skipped].contains(section), let p = store.postings[item.postingId], Score.canRescore(p) {
            Button("Re-score") { Task { note = await store.rescore([p.id]) } }
        }
    }
}

/// New's filter: the good matches first, or everything scored, each with its count; what the
/// filter hides is its tooltip.
struct NewFilterBar: View {
    @Bindable var store: AppStore

    var body: some View {
        let good = store.count(.new)
        let all = store.navigation.newFilter == .good ? good + store.newHidden : store.items(.new).count
        PillPicker(
            items: NewFilter.allCases,
            title: { "\($0.title) \($0 == .good ? good : all)" },
            selection: $store.navigation.newFilter,
            tint: Theme.world(.new).main,
            accessibilityLabel: "Show"
        )
        .help(
            "Good matches score \(store.goodMatchScore) or more. The ones at or above your threshold are prepared on their own and wait in To review."
                + (JobLists.hiddenLine(store.newHidden, below: store.goodMatchScore).map { " " + $0 + "." } ?? "")
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A job in a list: its score ring, what and where it is, and its chips. Preparing ones shimmer.
struct PostingRow: View {
    let item: ListItem
    /// Its chips in this list (ListItem.chips(in:)): none that only repeat the list.
    var chips: [Chip]? = nil
    var live = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ScoreRing(score: item.score, size: 38)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .textRole(.rowTitle)
                    .lineLimit(2)
                if !item.subtitle.isEmpty {
                    Text(item.subtitle)
                        .textRole(.meta)
                        .lineLimit(1)
                }
                if let chips = chips ?? Optional(item.chips), !chips.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(chips, id: \.text) { ChipView(chip: $0, help: $0.help) }
                    }
                    .padding(.top, 3)
                }
            }
            .shimmer(live)
            Spacer(minLength: 0)
        }
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
            HStack(spacing: 12) {
                ArtView(.newJobs, size: 48)
                Text("Add a Posting").font(.system(size: 20, weight: .bold))
            }
            Text("Paste a job posting's link. It's verified, read and scored like the ones search finds.")
                .textRole(.body, color: Theme.secondaryText)
            TextField("URL", text: $url, prompt: Text("https://jobs.example.com/backend-engineer"))
                .textFieldStyle(.roundedBorder)
                .onSubmit(add)
            if let outcome {
                VStack(alignment: .leading, spacing: 2) {
                    Label(outcome.line, systemImage: outcome.ok ? "checkmark.circle" : "exclamationmark.triangle")
                        .foregroundStyle(outcome.ok ? Theme.text : Theme.warning)
                    if let detail = outcome.detail {
                        Text(detail).textRole(.body, color: Theme.secondaryText).padding(.leading, 22)
                    }
                }
                .textSelection(.enabled)
            }
            HStack {
                if adding { ProgressView().controlSize(.small) }
                Spacer()
                Button(outcome == nil ? "Cancel" : "Done", action: close).buttonStyle(.secondary)
                Button("Add", action: add)
                    .buttonStyle(.primary)
                    .keyboardShortcut(.defaultAction)
                    .disabled(adding || url.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(22)
        .frame(width: 480)
        .background { WorldBackground(section: .new) }
        .environment(\.colorScheme, .dark)
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

struct BisectKey: ViewModifier {
    func body(content: Content) -> some View {
        if ProcessInfo.processInfo.environment["BISECT_KEYENV"] != nil {
            content.environment(\.controlActiveState, .key)
        } else {
            content
        }
    }
}
