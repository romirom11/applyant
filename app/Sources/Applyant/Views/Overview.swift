// Home, the screen the window opens on, built like CleanMyMac's Smart Care but dense: a
// greeting and a line on where things stand, a compact grid of glass tiles (a number that says
// what it counts, a caption and a 3D object peeking in from the corner; on a wide window the
// funnel's tile too), the strip of what Applyant is working on while it works, the next few
// jobs ready to send beside the round button, and, folded away under them, how it's going: the
// funnel (found → … → offer) and the success metrics, for 7 days, 30 days or all time.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct HomeView: View {
    @Bindable var store: AppStore
    @AppStorage("home.showsMetrics") private var showsMetrics = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let input = store.homeInput
        let live = HomeText.live(input)
        GeometryReader { geo in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    greeting(input)
                    HomeGridView(store: store, input: input, live: live, tileHeight: HomeGrid.tileHeight(window: geo.size.height), showsMetrics: $showsMetrics)
                    if let live {
                        ActivityStrip(tile: live.tile, live: live)
                            .transition(.blurIn(reduceMotion: reduceMotion))
                    }
                    HStack(alignment: .center, spacing: 16) {
                        UpNextCard(store: store, input: input)
                        actionButton(input, live: live)
                    }
                    .entrance(3)
                    metrics
                        .padding(.top, 6)
                }
                .animation(Theme.Motion.pick(Theme.Motion.smooth, reduceMotion: reduceMotion), value: live)
                .padding(.horizontal, 26)
                .padding(.top, 10)
                .padding(.bottom, 28)
                .frame(maxWidth: 1500)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.automatic)
        }
        .task {
            await store.openProfile()
            await store.openSearch()
        }
        .task(id: store.overviewWindow) { await store.openOverview() }
    }

    private func greeting(_ input: HomeInput) -> some View {
        let name = store.candidateProfile?.profile.first { $0.key == "full_name" }?.values.first
        return VStack(alignment: .leading, spacing: 4) {
            Text(HomeText.greeting(name: name, at: Date()))
                .font(Theme.displayTitle)
                .foregroundStyle(Theme.text)
            Text(HomeText.state(input))
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.secondaryText)
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
            Text("⌘↩").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.tertiaryText)
        }
        .frame(width: 150)
    }

    /// How it's going, folded away under a disclosure (the wide grid's funnel tile opens it too).
    private var metrics: some View {
        VStack(alignment: .leading, spacing: 14) {
            Button {
                withAnimation(Theme.Motion.pick(Theme.Motion.snappy, reduceMotion: reduceMotion)) { showsMetrics.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Theme.secondaryText)
                        .rotationEffect(.degrees(showsMetrics ? 90 : 0))
                    Text("How it's going").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                    Text("The funnel and the success metrics").font(.system(size: 13)).foregroundStyle(Theme.secondaryText)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(showsMetrics ? "Shown" : "Hidden")
            if showsMetrics {
                HomeMetrics(store: store)
                    .transition(.opacity)
            }
        }
    }
}

// MARK: - The grid

/// The tiles in two rows of three (four on a wide window, with the funnel's tile), all the same
/// height; the one Applyant works on is tinted in its colour.
private struct HomeGridView: View {
    let store: AppStore
    let input: HomeInput
    let live: HomeLive?
    let tileHeight: CGFloat
    @Binding var showsMetrics: Bool
    private let spacing: CGFloat = 14

    var body: some View {
        GeometryReader { geo in
            let columns = HomeGrid.columns(width: geo.size.width)
            VStack(spacing: spacing) {
                ForEach(Array(HomeGrid.rows(columns: columns).enumerated()), id: \.offset) { r, row in
                    HStack(spacing: spacing) {
                        ForEach(Array(row.enumerated()), id: \.element) { i, slot in
                            Group {
                                switch slot {
                                case let .tile(tile):
                                    HomeTileView(store: store, tile: tile, figure: HomeText.figure(tile, input), input: input, live: live?.tile == tile ? live : nil)
                                case .funnel:
                                    FunnelTile(store: store, showsMetrics: $showsMetrics)
                                }
                            }
                            .frame(width: HomeGrid.width(slot, columns: columns, total: geo.size.width, spacing: spacing), height: tileHeight)
                            .entrance(1 + r * 2 + i / 2)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .frame(height: tileHeight * 2 + spacing)
    }
}

/// One tile: its label, the big number and the caption saying what it counts, its 3D object
/// peeking in from the top right; tinted in its colour, with what it's doing as its caption,
/// while Applyant works on it. A click opens its section.
private struct HomeTileView: View {
    let store: AppStore
    let tile: HomeTile
    let figure: HomeFigure
    let input: HomeInput
    let live: HomeLive?
    @State private var hovering = false
    @State private var pointer: CGPoint = .zero

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
        let tint = HomeTileView.color(tile)
        GeometryReader { geo in
            let art: CGFloat = min(88, geo.size.height * 0.56)
            ZStack(alignment: .topLeading) {
                // The object peeks in from the corner, cut by the tile's edge.
                ArtView(live != nil ? HomeTileView.liveArt(tile) : HomeTileView.art(tile), size: art, tilt: hovering ? pointer : .zero)
                    .offset(x: geo.size.width - art * 0.82, y: -art * 0.14)
                content
                    .padding(16)
                    .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
            .background {
                ZStack {
                    shape.fill(hovering ? Theme.glassFillHover : Theme.glassFill)
                    if live != nil {
                        shape.fill(LinearGradient(colors: [tint.opacity(0.06), tint.opacity(0.22)], startPoint: .top, endPoint: .bottom))
                            .transition(.opacity)
                    }
                }
            }
            .clipShape(shape)
            .overlay { shape.strokeBorder(live != nil ? AnyShapeStyle(tint.opacity(0.55)) : AnyShapeStyle(Theme.glassEdge), lineWidth: 1) }
            .contentShape(shape)
            .onContinuousHover { phase in
                switch phase {
                case let .active(at):
                    hovering = true
                    pointer = CGPoint(x: (at.x / max(geo.size.width, 1) - 0.5) * 2, y: (at.y / max(geo.size.height, 1) - 0.5) * 2)
                case .ended:
                    hovering = false
                    pointer = .zero
                }
            }
            .onTapGesture { open(tile.section) }
            .animation(Theme.Motion.fade, value: hovering)
            .animation(Theme.Motion.smooth, value: live)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .help("Open \(tile.section.title)")
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(tile.title).font(Theme.tileLabel).foregroundStyle(Theme.secondaryText)
                if live != nil {
                    LiveDot(color: HomeTileView.color(tile), size: 6)
                } else if tile == .needsYou && figure.value > 0 {
                    LiveDot(color: Theme.warning, size: 6)
                }
            }
            Spacer(minLength: 0)
            CountingNumber(value: figure.value)
                .font(Theme.number(36))
                .foregroundStyle(Theme.text)
            if let live {
                Text(live.title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                    .contentTransition(.opacity)
            } else if let done = figure.done {
                HStack(spacing: 6) {
                    Circle().fill(Theme.good).frame(width: 7, height: 7)
                    Text(done).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.good)
                }
            } else {
                Text(figure.caption).font(.system(size: 13)).foregroundStyle(Theme.secondaryText).lineLimit(1)
            }
            extras
        }
    }

    private func open(_ section: ApplyantKit.Section) {
        store.navigation.section = section
        store.navigation.select(nil)
    }

    /// Applied's way on to Interviews and Offers; Search's Resume while paused.
    @ViewBuilder
    private var extras: some View {
        switch tile {
        case .applied:
            HStack(spacing: 6) {
                Button("Interviews \(input.interviews)") { open(.interviews) }
                Button("Offers \(input.offers)") { open(.offers) }
            }
            .buttonStyle(.secondary)
            .controlSize(.small)
            .padding(.top, 6)
        case .search where input.pausedAt != nil:
            Button { Task { await store.setBackgroundPaused(false) } } label: { Label("Resume", systemImage: "play.fill") }
                .buttonStyle(.secondary)
                .controlSize(.small)
                .padding(.top, 6)
        default:
            EmptyView()
        }
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

/// The wide grid's last tile: how far the postings got, in a few numbers (found → applied →
/// interview → offer). A click unfolds the funnel and the metrics under Up next.
private struct FunnelTile: View {
    let store: AppStore
    @Binding var showsMetrics: Bool
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text("How it's going").font(Theme.tileLabel).foregroundStyle(Theme.secondaryText)
                Text("· " + OverviewText.title(store.overviewWindow)).font(Theme.tileLabel).foregroundStyle(Theme.tertiaryText)
                Spacer()
                Image(systemName: showsMetrics ? "chevron.up" : "chevron.down")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Theme.secondaryText)
            }
            Spacer(minLength: 0)
            if let report = store.overview {
                HStack(alignment: .center, spacing: 12) {
                    let steps = HomeText.funnelSummary(OverviewText.funnel(report.funnel))
                    ForEach(Array(steps.enumerated()), id: \.element.id) { i, step in
                        if i > 0 {
                            Image(systemName: "chevron.right").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.tertiaryText)
                        }
                        VStack(alignment: .leading, spacing: 0) {
                            Text("\(step.count)")
                                .font(Theme.number(30))
                                .foregroundStyle(Theme.text)
                                .contentTransition(.numericText(value: Double(step.count)))
                            Text(step.label.lowercased()).font(.system(size: 13)).foregroundStyle(Theme.secondaryText).lineLimit(1)
                        }
                    }
                }
                .minimumScaleFactor(0.8)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(hovering ? Theme.glassFillHover : Theme.glassFill, in: shape)
        .overlay { shape.strokeBorder(Theme.glassEdge, lineWidth: 1) }
        .contentShape(shape)
        .onHover { hovering = $0 }
        .onTapGesture {
            withAnimation(Theme.Motion.pick(Theme.Motion.snappy, reduceMotion: reduceMotion)) { showsMetrics.toggle() }
        }
        .animation(Theme.Motion.fade, value: hovering)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .help(showsMetrics ? "Hide the funnel and the metrics" : "Show the funnel and the metrics")
    }
}

// MARK: - What's under way

/// Under the grid while Applyant works: the working tile's object, its live line and how far it
/// is, and the list it works through.
private struct ActivityStrip: View {
    let tile: HomeTile
    let live: HomeLive

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            ArtView(HomeTileView.liveArt(tile), size: 58)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    LiveDot(color: HomeTileView.color(tile), size: 6)
                    Text(live.title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                        .contentTransition(.opacity)
                }
                if let note = live.note {
                    Text(note)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.secondaryText)
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
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .glass(radius: 18, tint: HomeTileView.color(tile))
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
                .foregroundStyle(item.done ? Theme.good : current ? Theme.text : Theme.tertiaryText)
                .symbolEffect(.rotate, options: .repeating, isActive: current)
                .contentTransition(.symbolEffect(.replace))
            Text(item.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(item.done || current ? Theme.text : Theme.secondaryText)
                .lineLimit(1)
            Spacer(minLength: 8)
            if let detail = item.detail {
                Text(detail)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.secondaryText)
                    .lineLimit(1)
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
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Up next").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                if let line = HomeText.upNextLine(shown: jobs.count, total: input.ready) {
                    Text(line).font(.system(size: 13)).foregroundStyle(Theme.secondaryText)
                }
                Spacer()
                if input.ready > jobs.count {
                    Button("See all") {
                        store.navigation.section = .toReview
                        store.navigation.select(nil)
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                }
            }
            if jobs.isEmpty {
                Text(HomeText.upNextEmpty(input))
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.secondaryText)
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
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glass(radius: 18)
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
                    Text(item.title).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    if !item.subtitle.isEmpty {
                        Text(item.subtitle).font(.system(size: 12.5)).foregroundStyle(Theme.secondaryText).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Theme.tertiaryText)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(hovering ? Theme.glassFillHover : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Theme.Motion.fade, value: hovering)
        .help("Open in To review")
    }
}

// MARK: - How it's going

/// Under the disclosure: the funnel in its window, and the PRD's success metrics as tiles.
private struct HomeMetrics: View {
    @Bindable var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.blockSpacing) {
            HStack(alignment: .firstTextBaseline) {
                if let report = store.overview {
                    Text(OverviewText.since(report) + " · postings first seen in the window, and how far each got")
                        .font(.system(size: 13)).foregroundStyle(Theme.secondaryText)
                }
                Spacer()
                PillPicker(items: OverviewText.windows, title: OverviewText.title, selection: $store.overviewWindow)
            }
            if let report = store.overview {
                let rows = OverviewText.funnel(report.funnel)
                let top = max(rows.first?.count ?? 0, 1)
                HStack(alignment: .top, spacing: Theme.blockSpacing) {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            let list = OverviewText.section(forStep: row.id)
                            FunnelRowView(row: row, share: Double(row.count) / Double(top), index: index)
                                .contentShape(Rectangle())
                                // A step opens the list its postings are in now.
                                .onTapGesture {
                                    guard let list else { return }
                                    store.navigation.section = list
                                    store.navigation.select(nil)
                                }
                                .help(list.map { "Open \($0.title)" } ?? "")
                        }
                    }
                    .padding(Theme.cardPadding + 2)
                    .frame(width: 360)
                    .glass()
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), spacing: Theme.blockSpacing, alignment: .top)], spacing: Theme.blockSpacing) {
                        ForEach(Array(report.metrics.enumerated()), id: \.element.key) { _, metric in
                            MetricCard(metric: metric)
                        }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 120)
            }
        }
    }
}

struct FunnelRowView: View {
    let row: FunnelRow
    /// The step's count against the first step's, for the bar.
    let share: Double
    /// Its place in the funnel: the bars grow one after another, and shift colour down it.
    var index = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.label).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.text)
                Spacer()
                Text("\(row.count)")
                    .font(Theme.number(20, weight: .bold))
                    .foregroundStyle(Theme.text)
                    .contentTransition(.numericText(value: Double(row.count)))
                    .animation(Theme.Motion.snappy, value: row.count)
            }
            Meter(value: share, color: Color(hue: 0.62 - Double(index) * 0.022, saturation: 0.55, brightness: 1), height: 6, delay: Stagger.delay(index, step: 0.06))
            if let conversion = row.conversion {
                Text(conversion).font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
            }
        }
    }
}

struct MetricCard: View {
    let metric: OverviewMetric
    @State private var appeared = false

    var body: some View {
        let standing = OverviewText.standing(metric)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(metric.label).font(Theme.tileLabel).foregroundStyle(Theme.text)
                Spacer()
                mark(standing)
            }
            Text(metric.display)
                .font(Theme.number(26))
                .foregroundStyle(Theme.text)
                .contentTransition(.numericText())
                .animation(Theme.Motion.snappy, value: metric.display)
            Text(OverviewText.target(metric)).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.secondaryText)
            if !metric.definition.isEmpty {
                Text(metric.definition).font(.system(size: 12)).foregroundStyle(Theme.tertiaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.cardPadding)
        .glass(tint: standing == .met ? Theme.good : standing == .missed ? Theme.warning : nil)
    }

    @ViewBuilder
    private func mark(_ standing: OverviewText.Standing) -> some View {
        switch standing {
        case .met:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.good).help("On target")
                .symbolEffect(.bounce, options: .nonRepeating, value: appeared)
                .onAppear { appeared = true }
        case .missed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warning).help("Below target")
                .symbolEffect(.wiggle, options: .nonRepeating, value: appeared)
                .onAppear { appeared = true }
        case .noData:
            Text("No data yet").font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
        case .watched:
            Text("Watched").font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
        }
    }
}
