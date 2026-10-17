// The main window, CleanMyMac-style: one deep colour world behind everything (the open
// section's), a slim rail of section icons on the left, the section's list in a glass panel
// and the picked item beside it. Home, Chat and Settings use the whole window beside the rail.
// No system chrome: the traffic lights sit over the world, with the section's name small in
// the middle of the title bar and what Applyant is doing at its right.
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
        HStack(spacing: 0) {
            Group {
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
            .frame(width: listWidth)
            .frame(maxHeight: .infinity)
            .listPanel()
            .padding(.bottom, 12)
            ColumnHandle(width: $listWidth)
            Detail(store: store)
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

/// The window's top: the section's name in the middle (CleanMyMac's "Smart Care"), and what
/// Applyant is doing now at the right.
private struct TitleBar: View {
    let store: AppStore

    var body: some View {
        VStack {
            ZStack {
                Text(store.navigation.section.railTitle)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.78))
                    .contentTransition(.opacity)
                    .animation(Theme.Motion.fade, value: store.navigation.section)
                    // The title bar stays the window's handle.
                    .allowsHitTesting(false)
                HStack {
                    Spacer()
                    ActivityPill(store: store)
                }
                .padding(.trailing, 14)
            }
            .frame(height: MainView.titleBar)
            Spacer()
        }
    }
}

/// What Applyant is doing now, or what it waits for: a small glass capsule in the title bar.
/// Hidden on Home, which says it in its tiles.
struct ActivityPill: View {
    let store: AppStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if store.connection == .connected, store.navigation.section != .overview, let line = store.activityLine {
            let paused = store.activity.paused != nil || store.backgroundPausedAt != nil
            HStack(spacing: 7) {
                if paused {
                    Image(systemName: "pause.circle.fill").foregroundStyle(Theme.warning).font(.system(size: 11))
                } else {
                    LiveDot(color: Theme.magenta, size: 5)
                }
                Text(line)
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(.white.opacity(0.8))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .id(line)
                    .transition(reduceMotion ? .opacity : .push(from: .bottom))
            }
            .frame(maxWidth: 380, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 11)
            .padding(.vertical, 5)
            .background(Color.black.opacity(0.22), in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.glassEdge, lineWidth: 0.75))
            .clipShape(Capsule())
            .animation(Theme.Motion.smooth, value: line)
            .help(line)
            .onTapGesture {
                store.navigation.section = .overview
                store.navigation.select(nil)
            }
            .transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
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

/// The sections as a slim rail of icons in their groups (Jobs, Applications, Me, System): the
/// picked one sits in a glowing glass pill that slides from section to section, counts glow
/// as small badges, and a label comes out beside an icon under the pointer. ⌥⌘↑ and ⌥⌘↓ step
/// through the sections, ⌥⌘1…9 jump to the first nine. Pause and Resume are at its foot.
struct IconRail: View {
    @Bindable var store: AppStore
    @Namespace private var pill
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.vertical) {
                VStack(spacing: 3) {
                    ForEach(Section.Group.allCases, id: \.self) { group in
                        if group != .top {
                            Capsule().fill(Color.white.opacity(0.12)).frame(width: 18, height: 2).padding(.vertical, 7)
                        }
                        ForEach(Section.allCases.filter { $0.group == group }) { section in
                            RailItem(
                                section: section,
                                picked: store.navigation.section == section,
                                count: section == .skipped ? 0 : store.count(section),
                                pill: pill
                            ) { go(section) }
                        }
                    }
                }
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.never)
            PauseButton(store: store)
                .padding(.top, 8)
                .padding(.bottom, 16)
        }
        .frame(width: Theme.railWidth)
        .padding(.top, MainView.titleBar + 6)
        .background(alignment: .trailing) {
            // The rail's own strip: a little darker than the world, with a hairline.
            LinearGradient(colors: [Color.black.opacity(0.2), Color.black.opacity(0.08)], startPoint: .leading, endPoint: .trailing)
                .overlay(alignment: .trailing) { Rectangle().fill(Color.white.opacity(0.06)).frame(width: 1) }
        }
        .background { shortcuts }
        // The label of the icon under the pointer comes out beside the rail, over the list:
        // drawn here, outside the rail's scroll view, so nothing cuts it off.
        .overlayPreferenceValue(RailHover.self) { hovered in
            GeometryReader { geo in
                if let hovered {
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
        guard section != store.navigation.section else { return }
        withAnimation(Theme.Motion.pick(Theme.Motion.snappy, reduceMotion: reduceMotion)) {
            store.navigation.section = section
        }
        store.navigation.postingId = nil
        store.navigation.reviewing = nil
    }

    private var shortcuts: some View {
        ZStack {
            Button("Previous section") { store.navigation.section.neighbour(-1).map(go) }
                .keyboardShortcut(.upArrow, modifiers: [.command, .option])
            Button("Next section") { store.navigation.section.neighbour(1).map(go) }
                .keyboardShortcut(.downArrow, modifiers: [.command, .option])
            ForEach(Array(Section.allCases.prefix(9).enumerated()), id: \.offset) { i, section in
                Button(section.railTitle) { go(section) }
                    .keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: [.command, .option])
            }
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }
}

private struct RailItem: View {
    let section: ApplyantKit.Section
    let picked: Bool
    let count: Int
    let pill: Namespace.ID
    let action: () -> Void
    @State private var hovering = false
    @State private var arrivals = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let world = Theme.world(section)
        Button(action: action) {
            ZStack {
                if picked {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(LinearGradient(colors: [world.main.opacity(0.55), world.second.opacity(0.3)], startPoint: .topLeading, endPoint: .bottomTrailing))
                        .overlay {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .strokeBorder(LinearGradient(colors: [.white.opacity(0.7), .white.opacity(0.1)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1)
                        }
                        .shadow(color: world.main.opacity(0.7), radius: 12)
                        .matchedGeometryEffect(id: "pill", in: pill)
                } else if hovering {
                    RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(0.08))
                }
                Image(systemName: Self.symbol(section))
                    .symbolVariant(picked ? .fill : .none)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(picked ? AnyShapeStyle(.white) : AnyShapeStyle(Color.white.opacity(hovering ? 0.9 : 0.6)))
                    .shadow(color: picked ? .white.opacity(0.5) : .clear, radius: 4)
                    .symbolEffect(.bounce, value: reduceMotion ? 0 : arrivals)
            }
            .frame(width: 48, height: 40)
            .overlay(alignment: .topTrailing) {
                if count > 0 {
                    Text(count > 99 ? "99+" : "\(count)")
                        .font(Theme.number(9.5, weight: .heavy))
                        .foregroundStyle(.white)
                        .contentTransition(.numericText(value: Double(count)))
                        .padding(.horizontal, 4.5)
                        .frame(minWidth: 17, minHeight: 15)
                        .background(Capsule().fill(LinearGradient(colors: [world.main, world.second], startPoint: .top, endPoint: .bottom)))
                        .overlay(Capsule().strokeBorder(.white.opacity(0.5), lineWidth: 0.75))
                        .shadow(color: world.main.opacity(0.8), radius: 4)
                        .offset(x: 7, y: -4)
                        .transition(.scale.combined(with: .opacity))
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

/// Pauses or resumes search, scoring and the rest of the background work, without quitting: a
/// small round glass button at the rail's foot, ringed in orange while paused.
struct PauseButton: View {
    let store: AppStore
    @State private var hovering = false

    var body: some View {
        let paused = store.backgroundPausedAt != nil
        Button { Task { await store.setBackgroundPaused(!paused) } } label: {
            Image(systemName: paused ? "play.fill" : "pause.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(paused ? Theme.warning : Color.white.opacity(0.85))
                .frame(width: 38, height: 38)
                .background(Circle().fill(Color.white.opacity(hovering ? 0.16 : 0.09)))
                .overlay(Circle().strokeBorder(paused ? AnyShapeStyle(Theme.warning.opacity(0.8)) : AnyShapeStyle(Theme.glassEdge), lineWidth: paused ? 1.5 : 1))
                .shadow(color: paused ? Theme.warning.opacity(0.5) : .clear, radius: 8)
                .contentTransition(.symbolEffect(.replace))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(paused ? "Resume" : "Pause")
        .help(paused
            ? "Resume background work: whatever came due while paused runs now"
            : "Pause searching, scoring, research and mail until you resume (interview answers and approved applications still go through)")
    }
}

// MARK: - The detail

/// What an action was refused for, inside a sheet (the main window's alert is behind it).
struct ErrorBanner: View {
    let store: AppStore

    var body: some View {
        if let error = store.lastError {
            HStack(alignment: .firstTextBaseline) {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.warning).font(.callout).textSelection(.enabled)
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // A newly picked job comes in from a little below, out of a blur; the one before fades.
        ZStack { content }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(Theme.Motion.pick(Theme.Motion.smooth, reduceMotion: reduceMotion), value: store.navigation.postingId)
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
                .transition(.page(reduceMotion: reduceMotion))
        } else {
            let section = store.navigation.section
            if store.items(section).isEmpty {
                // The list says why it's empty; nothing to repeat here.
                Color.clear
            } else {
                EmptyState(title: "Pick one on the left", systemImage: section.symbol, detail: "\(store.count(section)) in \(section.title).", art: Art(section))
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let section = store.navigation.section
        let groups = store.groups(section)
        let items = groups.flatMap(\.items)
        let world = Theme.world(section)
        VStack(alignment: .leading, spacing: 0) {
            ModuleHeader(section: section, subtitle: note ?? subtitle(section, items: items.count)) {
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
                                PostingRow(item: item, live: live)
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
        .task(id: note) {
            // A newer note cancels this wait; only an uninterrupted one clears it.
            guard note != nil, (try? await Task.sleep(for: .seconds(4))) != nil else { return }
            note = nil
        }
        .task { await store.loadPreferences() }
        .sheet(isPresented: $addingPosting) { AddPostingSheet(store: store) { addingPosting = false } }
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
                .accessibilityLabel("Add posting…")
            Button { Task { note = await store.rescore() } } label: { Image(systemName: "arrow.clockwise") }
                .help("Score every verified or scored posting again (what was read before is reused)")
                .accessibilityLabel("Re-score all")
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
        HStack(spacing: 10) {
            PillPicker(items: NewFilter.allCases, title: \.title, selection: $store.navigation.newFilter, tint: Theme.world(.new).main)
                .help("Good matches score \(store.goodMatchScore) or more. The ones at or above your threshold are prepared on their own and wait in To review.")
            if let hidden = JobLists.hiddenLine(store.newHidden, below: store.goodMatchScore) {
                Text(hidden)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.tertiaryText)
                    .lineLimit(2)
                    .contentTransition(.numericText())
                    .animation(Theme.Motion.snappy, value: hidden)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A job in a list: its score ring, what and where it is, and its chips. Preparing ones shimmer.
struct PostingRow: View {
    let item: ListItem
    var live = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ScoreRing(score: item.score, size: 38)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Theme.text)
                    .lineLimit(2)
                if !item.subtitle.isEmpty {
                    Text(item.subtitle)
                        .font(.system(size: 12.5))
                        .foregroundStyle(Theme.secondaryText)
                        .lineLimit(1)
                }
                if !item.chips.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(item.chips, id: \.text) { ChipView(chip: $0) }
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
                Text("Add a posting").font(.system(size: 20, weight: .bold))
            }
            Text("Paste a job posting's link. It's verified, read and scored like the ones search finds.")
                .font(.callout).foregroundStyle(Theme.secondaryText)
            TextField("URL", text: $url, prompt: Text("https://jobs.example.com/backend-engineer"))
                .textFieldStyle(.roundedBorder)
                .onSubmit(add)
            if let outcome {
                VStack(alignment: .leading, spacing: 2) {
                    Label(outcome.line, systemImage: outcome.ok ? "checkmark.circle" : "exclamationmark.triangle")
                        .foregroundStyle(outcome.ok ? Theme.text : Theme.warning)
                    if let detail = outcome.detail {
                        Text(detail).font(.callout).foregroundStyle(Theme.secondaryText).padding(.leading, 22)
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
