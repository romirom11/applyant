// Home, the screen the window opens on, built like CleanMyMac's Smart Care but dense: a
// greeting and a line on where things stand, a compact grid of glass tiles (a number that says
// what it counts, a caption and a 3D object peeking in from the corner; on a wide window the
// funnel's tile too), how it's going opening right under the grid when its tile is clicked
// (the funnel and the success metrics, for 7 days, 30 days or all time), the strip of what
// Applyant is working on while it works, and the next few jobs ready to send beside the round
// button.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct HomeView: View {
    @Bindable var store: AppStore
    /// How it's going, open for this visit only. `--show-how-its-going` opens it at launch (for
    /// screenshots).
    @State private var showsMetrics = CommandLine.arguments.contains("--show-how-its-going")
    /// The column's width, measured: the grid, the panel's notch and the round button follow it.
    @State private var measured: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let input = store.homeInput
        let live = HomeText.live(input)
        GeometryReader { geo in
            // Until measured, the window less the page's margins.
            let total = measured > 0 ? measured : max(min(geo.size.width, 1500) - Theme.pagePadding * 2, 0)
            let columns = HomeGrid.columns(width: total)
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                    greeting(input)
                        // The greeting takes the width offered, whatever the grid's fixed widths
                        // add up to: the column's measure.
                        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { measured = $0 }
                    HomeGridView(
                        store: store, input: input, live: live, columns: columns, total: total,
                        tileHeight: HomeGrid.tileHeight(window: geo.size.height), showsMetrics: $showsMetrics
                    )
                    if columns < 4 {
                        MetricsLine(store: store, showsMetrics: $showsMetrics)
                    }
                    if showsMetrics {
                        // Hangs from what opened it: the funnel's tile, or the line's chevron.
                        let anchor = columns < 4
                            ? 24
                            : total - HomeGrid.width(.funnel, columns: columns, total: total, spacing: Theme.blockSpacing) / 2
                        AnchoredPanel(anchorX: anchor) {
                            HomeMetrics(store: store, width: total - Theme.cardPadding * 2) { toggleMetrics() }
                        }
                        .transition(.reveal(reduceMotion: reduceMotion))
                    }
                    if let live {
                        ActivityStrip(tile: live.tile, live: live)
                            .transition(.blurIn(reduceMotion: reduceMotion))
                    }
                    HStack(alignment: .center, spacing: Theme.blockSpacing) {
                        UpNextCard(store: store, input: input)
                            .frame(maxWidth: .infinity)
                        // The round button stands in the last column, centred on it.
                        actionButton(input, live: live)
                            .frame(width: HomeGrid.width(.tile(.ready), columns: columns, total: total, spacing: Theme.blockSpacing))
                    }
                    .entrance(3)
                }
                .animation(Theme.Motion.pick(Theme.Motion.smooth, reduceMotion: reduceMotion), value: live)
                .animation(Theme.Motion.pick(Theme.Motion.disclose, reduceMotion: reduceMotion), value: showsMetrics)
                .padding(.horizontal, Theme.pagePadding)
                .padding(.top, 10)
                .padding(.bottom, 28)
                .frame(maxWidth: 1500)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.automatic)
        }
        .focusedSceneValue(\.showsHowItsGoing, $showsMetrics)
        .task {
            await store.openProfile()
            await store.openSearch()
        }
        .task(id: store.overviewWindow) { await store.openOverview() }
    }

    private func toggleMetrics() {
        withAnimation(Theme.Motion.pick(Theme.Motion.disclose, reduceMotion: reduceMotion)) { showsMetrics.toggle() }
    }

    private func greeting(_ input: HomeInput) -> some View {
        let name = store.candidateProfile?.profile.first { $0.key == "full_name" }?.values.first
        return VStack(alignment: .leading, spacing: 4) {
            Text(HomeText.greeting(name: name, at: Date()))
                .textRole(.display)
            Text(HomeText.state(input))
                .textRole(.prose, color: Theme.secondaryText)
                .contentTransition(.numericText())
                .animation(Theme.Motion.smooth, value: HomeText.state(input))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .entrance(0)
    }

    /// The round button, right after what it acts on: Review (or Browse, or Search).
    private func actionButton(_ input: HomeInput, live: HomeLive?) -> some View {
        let action = HomeText.action(input)
        return VStack(spacing: 8) {
            RoundActionButton(
                title: action.title,
                size: 86,
                working: live != nil,
                progress: live?.fraction
            ) {
                store.navigation.section = action.section
                // To review opens on its first job: the review starts right away.
                store.navigation.select(action == .search ? nil : store.items(action.section).first)
            }
            .keyboardShortcut(.return, modifiers: .command)
            .help(action == .review ? "Open To review on its first job (⌘↩)" : action == .browse ? "Open New's good matches (⌘↩)" : "Open Search (⌘↩)")
            Text("⌘↩").textRole(.meta)
        }
    }
}

extension FocusedValues {
    /// Home's How it's going, for View › Show How It's Going.
    @Entry var showsHowItsGoing: Binding<Bool>?
}

// MARK: - The grid

/// The tiles in two rows of three (four on a wide window, with the funnel's tile), all the same
/// height; the one Applyant works on is tinted in its colour.
private struct HomeGridView: View {
    let store: AppStore
    let input: HomeInput
    let live: HomeLive?
    let columns: Int
    let total: CGFloat
    let tileHeight: CGFloat
    @Binding var showsMetrics: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.blockSpacing) {
            ForEach(Array(HomeGrid.rows(columns: columns).enumerated()), id: \.offset) { r, row in
                HStack(spacing: Theme.blockSpacing) {
                    ForEach(Array(row.enumerated()), id: \.element) { i, slot in
                        let size = CGSize(width: HomeGrid.width(slot, columns: columns, total: total, spacing: Theme.blockSpacing), height: tileHeight)
                        Group {
                            switch slot {
                            case let .tile(tile):
                                HomeTileView(store: store, tile: tile, figure: HomeText.figure(tile, input), live: live?.tile == tile ? live : nil, size: size)
                            case .funnel:
                                FunnelTile(store: store, showsMetrics: $showsMetrics, size: size)
                            }
                        }
                        .frame(width: size.width, height: size.height)
                        .entrance(1 + r * 2 + i / 2)
                    }
                }
            }
        }
    }
}

/// One tile: its label, the big number and the caption saying what it counts, its 3D object
/// peeking in from the top right; tinted in its colour, with what it's doing as its caption,
/// while Applyant works on it. A click (or Space when focused) opens its section.
private struct HomeTileView: View {
    let store: AppStore
    let tile: HomeTile
    let figure: HomeFigure
    let live: HomeLive?
    let size: CGSize
    @State private var hovering = false
    @State private var pointer: CGPoint = .zero

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous)
        let tint = HomeTileView.color(tile)
        let art: CGFloat = min(88, size.height * 0.56)
        Button { open(tile.section) } label: {
            ZStack(alignment: .topLeading) {
                // The object peeks in from the corner, cut by the tile's edge.
                ArtView(live != nil ? HomeTileView.liveArt(tile) : HomeTileView.art(tile), size: art, tilt: hovering ? pointer : .zero)
                    .offset(x: size.width - art * 0.82, y: -art * 0.14)
                    .accessibilityHidden(true)
                content
                    .padding(Theme.cardPadding)
                    .frame(width: size.width, height: size.height, alignment: .topLeading)
            }
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .background {
                if live != nil {
                    shape.fill(LinearGradient(colors: [tint.opacity(0.06), tint.opacity(0.22)], startPoint: .top, endPoint: .bottom))
                        .transition(.opacity)
                }
            }
            .clipShape(shape)
            .onContinuousHover { phase in
                switch phase {
                case let .active(at):
                    hovering = true
                    pointer = CGPoint(x: (at.x / max(size.width, 1) - 0.5) * 2, y: (at.y / max(size.height, 1) - 0.5) * 2)
                case .ended:
                    hovering = false
                    pointer = .zero
                }
            }
            .animation(Theme.Motion.smooth, value: live)
        }
        .buttonStyle(.tile(tint: live != nil ? tint : nil))
        .help("Open \(tile.section.title)")
    }

    /// The label on top; the number and its one-line caption at the bottom, so every number in
    /// a row stands on the same baseline.
    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text(tile.title).textRole(.label).lineLimit(1)
                if live != nil {
                    LiveDot(color: HomeTileView.color(tile), size: 6)
                } else if tile == .needsYou && figure.value > 0 {
                    LiveDot(color: Theme.warning, size: 6)
                }
            }
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 2) {
                CountingNumber(value: figure.value)
                    .font(Theme.figure)
                    .foregroundStyle(Theme.text)
                caption
            }
        }
    }

    @ViewBuilder
    private var caption: some View {
        if let live {
            Text(live.title)
                .textRole(.body, color: Theme.text)
                .lineLimit(1)
                .contentTransition(.opacity)
        } else if let done = figure.done {
            HStack(spacing: 6) {
                Circle().fill(Theme.good).frame(width: 7, height: 7)
                Text(done).textRole(.body, color: Theme.secondaryText).lineLimit(1)
            }
        } else {
            Text(figure.caption).textRole(.body, color: Theme.secondaryText).lineLimit(1)
        }
    }

    private func open(_ section: ApplyantKit.Section) {
        store.navigation.section = section
        store.navigation.select(nil)
    }

    // MARK: Each tile's colour and object

    /// The colour a working tile is tinted in: blues and greens, amber for what needs you.
    static func hue(_ tile: HomeTile) -> Double {
        switch tile {
        case .ready: 0.62
        case .needsYou: 0.1
        case .new: 0.47
        case .questions: 0.55
        case .applied: 0.58
        case .search: 0.52
        }
    }

    static func color(_ tile: HomeTile) -> Color { Color(hue: hue(tile), saturation: 0.6, brightness: 1) }

    static func art(_ tile: HomeTile) -> Art {
        switch tile {
        case .ready: .toReview
        case .needsYou: .profile
        case .new: .newJobs
        case .questions: .questions
        case .applied: .applied
        case .search: .search
        }
    }

    static func liveArt(_ tile: HomeTile) -> Art {
        switch tile {
        case .ready, .needsYou: .writing
        case .applied: .sending
        case .search: .searching
        case .new: .newJobs
        case .questions: .questions
        }
    }
}

/// The wide grid's last tile, built like the others: how far the postings got (found ›
/// applied › interviews › offers). A click opens the funnel and the metrics right under the
/// grid, the panel's notch pointing back at it.
private struct FunnelTile: View {
    let store: AppStore
    @Binding var showsMetrics: Bool
    let size: CGSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let art: CGFloat = min(88, size.height * 0.56)
        Button {
            withAnimation(Theme.Motion.pick(Theme.Motion.disclose, reduceMotion: reduceMotion)) { showsMetrics.toggle() }
        } label: {
            ZStack(alignment: .topLeading) {
                ArtView(.overview, size: art)
                    .offset(x: size.width - art * 0.82, y: -art * 0.14)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 6) {
                        Text("How it's going · " + OverviewText.title(store.overviewWindow)).textRole(.label).lineLimit(1)
                        // Beside the label: what the tile opens, and that it's open.
                        Image(systemName: showsMetrics ? "chevron.up" : "chevron.down")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(Theme.glyph)
                            .accessibilityHidden(true)
                    }
                    Spacer(minLength: 0)
                    if let report = store.overview {
                        FunnelStrip(HomeText.funnelSummary(OverviewText.funnel(report.funnel)).map {
                            FunnelStrip.Step(id: $0.id, count: $0.count, label: OverviewText.stepLabel($0.id))
                        }, size: .large)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                }
                .padding(Theme.cardPadding)
                .frame(width: size.width, height: size.height, alignment: .topLeading)
            }
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .clipShape(RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous))
        }
        .buttonStyle(.tile(selected: showsMetrics))
        .accessibilityValue(showsMetrics ? "Expanded" : "Collapsed")
        .help("Show the funnel and the goals")
    }
}

/// The narrow grid has no funnel tile: the same disclosure as a line under the grid, the
/// funnel's four numbers beside it.
private struct MetricsLine: View {
    let store: AppStore
    @Binding var showsMetrics: Bool

    var body: some View {
        HStack(alignment: .center, spacing: Theme.Space.xl) {
            DisclosureLine("How it's going · " + OverviewText.title(store.overviewWindow), isExpanded: $showsMetrics)
            if let report = store.overview {
                FunnelStrip(HomeText.funnelSummary(OverviewText.funnel(report.funnel)).map {
                    FunnelStrip.Step(id: $0.id, count: $0.count, label: OverviewText.stepLabel($0.id))
                }, size: .small)
                .frame(maxWidth: 420)
                .accessibilityElement(children: .combine)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
    }
}

// MARK: - What's under way

/// Under the grid while Applyant works: the working tile's object, its live line and how far it
/// is, and the list it works through.
private struct ActivityStrip: View {
    let tile: HomeTile
    let live: HomeLive

    var body: some View {
        HStack(alignment: .center, spacing: Theme.blockSpacing) {
            ArtView(HomeTileView.liveArt(tile), size: 58)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    LiveDot(color: HomeTileView.color(tile), size: 6)
                    Text(live.title)
                        .textRole(.heading)
                        .lineLimit(1)
                        .contentTransition(.opacity)
                }
                if let note = live.note {
                    Text(note)
                        .textRole(.body, color: Theme.secondaryText)
                        .lineLimit(1)
                        .contentTransition(.numericText())
                }
                if let fraction = live.fraction {
                    Meter(value: fraction, color: Theme.accent, height: 5).frame(maxWidth: 320)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !live.items.isEmpty {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(Array(live.items.prefix(4).enumerated()), id: \.element.id) { index, item in
                        LiveItemRow(item: item, current: !item.done && live.items.firstIndex { !$0.done } == index)
                            .transition(.opacity)
                    }
                }
                .frame(maxWidth: 380, alignment: .leading)
                .animation(Theme.Motion.smooth, value: live.items)
            }
        }
        .padding(.horizontal, Theme.cardPadding)
        .padding(.vertical, 12)
        .glass(tint: HomeTileView.color(tile))
        .accessibilityElement(children: .combine)
    }
}

/// A line of the live list: done (a check), under way (a spinner) or waiting.
private struct LiveItemRow: View {
    let item: HomeLiveItem
    let current: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: item.done ? "checkmark.circle.fill" : current ? "circle.dotted" : "circle")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(item.done ? Theme.good : current ? Theme.text : Theme.glyph)
                .symbolEffect(.rotate, options: .repeating, isActive: current)
                .contentTransition(.symbolEffect(.replace))
            Text(item.title)
                .textRole(.itemTitle, color: item.done || current ? Theme.text : Theme.secondaryText)
                .lineLimit(1)
            Spacer(minLength: 8)
            if let detail = item.detail {
                Text(detail).textRole(.meta).lineLimit(1)
            }
        }
    }
}

// MARK: - Up next

/// The next few jobs ready to send, in To review's order: a click opens one there (nothing is
/// ever sent from Home).
private struct UpNextCard: View {
    let store: AppStore
    let input: HomeInput

    var body: some View {
        let jobs = HomeText.upNext(input)
        VStack(alignment: .leading, spacing: Theme.rowSpacing) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Up next").textRole(.heading)
                if let line = HomeText.upNextLine(shown: jobs.count, total: input.ready) {
                    MetaLine(line)
                }
                Spacer()
                if input.ready > jobs.count {
                    Button {
                        store.navigation.section = .toReview
                        store.navigation.select(nil)
                    } label: {
                        Text("See All")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.accent)
                            .padding(.vertical, 4)
                            .padding(.horizontal, 2)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Open To review")
                }
            }
            if jobs.isEmpty {
                Text(HomeText.upNextEmpty(input))
                    .textRole(.body, color: Theme.secondaryText)
                    .padding(.vertical, 6)
            } else {
                VStack(spacing: 2) {
                    ForEach(jobs) { job in
                        UpNextRow(item: job) {
                            store.navigation.section = .toReview
                            store.navigation.select(job)
                        }
                    }
                }
            }
        }
        .padding(Theme.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glass()
    }
}

private struct UpNextRow: View {
    let item: ListItem
    let open: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                ScoreRing(score: item.score, size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.title).textRole(.itemTitle).lineLimit(1)
                    if !item.subtitle.isEmpty {
                        Text(item.subtitle).textRole(.meta).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Theme.glyph)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(hovering ? Theme.glassFillHover : .clear, in: RoundedRectangle(cornerRadius: Theme.rowRadius, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Theme.Motion.fade, value: hovering)
        .help("Open in To review")
    }
}

// MARK: - How it's going

/// The panel under the grid: one line on how it's going with the window and a close button,
/// the whole funnel as one strip (a step opens the list its postings are in now), the success
/// metrics as equal cards, and what they measure folded away under them.
private struct HomeMetrics: View {
    @Bindable var store: AppStore
    /// The panel's inner width: three cards a row from 900 points, else two.
    let width: CGFloat
    let close: () -> Void
    @State private var showsDefinitions = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.blockSpacing) {
            header
            if let report = store.overview {
                FunnelStrip(OverviewText.funnel(report.funnel).map {
                    FunnelStrip.Step(id: $0.id, count: $0.count, label: OverviewText.stepLabel($0.id), conversion: $0.shortConversion)
                }, size: .small) { step in
                    guard let list = OverviewText.section(forStep: step.id) else { return }
                    store.navigation.section = list
                    store.navigation.select(nil)
                }
                EqualHeightGrid(report.metrics.map(MetricItem.init), columns: width >= 900 ? 3 : 2) { item in
                    MetricCard(metric: item.metric)
                }
                DisclosureLine("What these measure", isExpanded: $showsDefinitions)
                if showsDefinitions {
                    definitions(report.metrics)
                        .transition(.reveal(reduceMotion: reduceMotion))
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 120)
            }
        }
        .animation(Theme.Motion.pick(Theme.Motion.disclose, reduceMotion: reduceMotion), value: showsDefinitions)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            if let report = store.overview {
                Text(OverviewText.summary(report)).textRole(.heading).lineLimit(1)
                MetaLine(OverviewText.since(report))
                    .help("Postings first seen in the window, and how far each got")
            }
            Spacer(minLength: 8)
            PillPicker(items: OverviewText.windows, title: OverviewText.title, selection: $store.overviewWindow, accessibilityLabel: "Window")
                .help("Postings first seen in the window, and how far each got")
            Button(action: close) {
                Image(systemName: "chevron.up")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Theme.glyph)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .help("Hide How it's going (Esc)")
            .accessibilityLabel("Hide How it's going")
        }
    }

    /// Each metric's name beside what it measures, at reading measure.
    private func definitions(_ metrics: [OverviewMetric]) -> some View {
        Grid(alignment: .topLeading, horizontalSpacing: Theme.Space.l, verticalSpacing: Theme.Space.s) {
            ForEach(metrics.filter { !$0.definition.isEmpty }, id: \.key) { m in
                GridRow(alignment: .firstTextBaseline) {
                    Text(OverviewText.name(m)).textRole(.itemTitle).lineLimit(1)
                    Prose(m.definition, size: .compact)
                }
            }
        }
    }
}

/// A metric for the equal-height grid (the report's metrics aren't Identifiable).
private struct MetricItem: Identifiable {
    let id: String
    let metric: OverviewMetric

    init(_ metric: OverviewMetric) {
        id = metric.key
        self.metric = metric
    }
}

/// A success metric in four one-line rows: its name and standing, the number, what it's out
/// of, and the goal. What it measures is under the pointer and read by VoiceOver.
private struct MetricCard: View {
    let metric: OverviewMetric
    @State private var appeared = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(OverviewText.name(metric)).textRole(.itemTitle).lineLimit(1)
                Spacer(minLength: 4)
                mark(OverviewText.standing(metric))
            }
            Text(OverviewText.headline(metric))
                .font(Theme.figureSmall)
                .foregroundStyle(Theme.text)
                .lineLimit(1)
                .contentTransition(.numericText())
                .animation(Theme.Motion.snappy, value: OverviewText.headline(metric))
            Text(OverviewText.detail(metric)).textRole(.body, color: Theme.secondaryText).lineLimit(1)
            Text(OverviewText.goal(metric)).textRole(.label).lineLimit(1)
        }
        .help(metric.definition)
        .accessibilityElement(children: .combine)
        .accessibilityHint(metric.definition)
    }

    /// ✓ on target, ⚠ below it; nothing while there's no data, or with no target at all.
    @ViewBuilder
    private func mark(_ standing: OverviewText.Standing) -> some View {
        switch standing {
        case .met:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.good)
                .symbolEffect(.bounce, options: .nonRepeating, value: appeared)
                .onAppear { appeared = true }
                .accessibilityLabel("On target")
        case .missed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warning)
                .symbolEffect(.wiggle, options: .nonRepeating, value: appeared)
                .onAppear { appeared = true }
                .accessibilityLabel("Below target")
        case .noData, .watched:
            EmptyView()
        }
    }
}
