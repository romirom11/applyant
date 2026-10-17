// Home, the screen the window opens on, built like CleanMyMac's Smart Care: a greeting and a
// line on where things stand, a grid of glass tiles (a big number, a caption and a 3D object
// peeking in from the corner), the tile Applyant is working on lit up in its own colour with
// its live line and list, and one big round button. Below it, how it's going: the funnel
// (found → … → offer) and the success metrics, for 7 days, 30 days or all time.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct HomeView: View {
    @Bindable var store: AppStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let input = store.homeInput
        let live = HomeText.live(input)
        GeometryReader { geo in
            ScrollView {
                VStack(spacing: 0) {
                    VStack(spacing: 18) {
                        greeting(input)
                        BentoGrid(store: store, input: input, live: live)
                            .frame(maxHeight: .infinity)
                        actionButton(input, live: live)
                    }
                    .padding(.top, 6)
                    .frame(height: max(geo.size.height - 4, 600))
                    HomeMetrics(store: store)
                        .padding(.top, 36)
                        .padding(.bottom, 32)
                }
                .padding(.horizontal, 26)
                .frame(maxWidth: 1500)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.never)
        }
        .task {
            await store.openProfile()
            await store.openSearch()
        }
    }

    private func greeting(_ input: HomeInput) -> some View {
        let name = store.candidateProfile?.profile.first { $0.key == "full_name" }?.values.first
        return VStack(spacing: 6) {
            Text(HomeText.greeting(name: name, at: Date()))
                .font(Theme.displayTitle)
                .foregroundStyle(Theme.text)
            Text(HomeText.state(input))
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.secondaryText)
                .contentTransition(.numericText())
                .animation(Theme.Motion.smooth, value: HomeText.state(input))
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .entrance(0)
    }

    private func actionButton(_ input: HomeInput, live: HomeLive?) -> some View {
        let action = HomeText.action(input)
        return VStack(spacing: 10) {
            RoundActionButton(
                title: action.title,
                size: 88,
                working: live != nil,
                progress: live?.fraction
            ) {
                store.navigation.section = action.section
                // To review opens on its first job: the review starts right away.
                store.navigation.select(action == .search ? nil : store.items(action.section).first)
            }
            .keyboardShortcut(.return, modifiers: .command)
            .help(action == .review ? "Open To review on its first job (⌘↩)" : action == .browse ? "Open New's good matches (⌘↩)" : "Open Search (⌘↩)")
            Label("How it's going", systemImage: "chevron.down")
                .labelStyle(.titleAndIcon)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(Theme.tertiaryText)
        }
        .padding(.bottom, 6)
        .entrance(3)
    }
}

// MARK: - The grid

/// The tiles in two rows; the live one takes more of its row and its row more of the height,
/// and the others give way with a spring.
private struct BentoGrid: View {
    let store: AppStore
    let input: HomeInput
    let live: HomeLive?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let spacing: CGFloat = 14

    var body: some View {
        GeometryReader { geo in
            let heights = Bento.heights(live: live?.tile, total: geo.size.height, spacing: spacing, share: 0.6)
            VStack(spacing: spacing) {
                ForEach(Array(Bento.rows.enumerated()), id: \.offset) { r, row in
                    let widths = Bento.widths(row, live: live?.tile, total: geo.size.width, spacing: spacing, grow: 2.1, minimum: 190)
                    HStack(spacing: spacing) {
                        ForEach(Array(row.enumerated()), id: \.element) { i, tile in
                            HomeTileView(
                                store: store,
                                tile: tile,
                                figure: HomeText.figure(tile, input),
                                input: input,
                                live: live?.tile == tile ? live : nil
                            )
                            .frame(width: widths[i], height: heights[r])
                            .entrance(1 + r * 3 + i)
                        }
                    }
                }
            }
            .animation(Theme.Motion.pick(Theme.Motion.morph, reduceMotion: reduceMotion), value: live?.tile)
        }
    }
}

/// One tile: its label, the big number and caption, its 3D object peeking in from the top
/// right; or, while it works, its vivid colour, the live line in the middle and its object
/// floating there. A click opens its section.
private struct HomeTileView: View {
    let store: AppStore
    let tile: HomeTile
    let figure: HomeFigure
    let input: HomeInput
    let live: HomeLive?
    @State private var hovering = false
    @State private var pointer: CGPoint = .zero
    private let motion = EndlessMotion()

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 22, style: .continuous)
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                if let live {
                    LiveTileContent(tile: tile, live: live, size: geo.size, pointer: pointer)
                        .transition(.opacity)
                } else {
                    resting(geo.size)
                        .transition(.opacity)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
            .background {
                ZStack {
                    shape.fill(hovering ? Theme.glassFillHover : Theme.glassFill)
                    if live != nil {
                        HomeTileView.vivid(tile, moving: motion.ambient)
                            .transition(.opacity)
                    }
                    shape.fill(LinearGradient(colors: [.white.opacity(0.07), .clear], startPoint: .top, endPoint: .init(x: 0.5, y: 0.3)))
                }
            }
            .clipShape(shape)
            .overlay { shape.strokeBorder(Theme.glassEdge, lineWidth: 1) }
            .shadow(color: live != nil ? HomeTileView.color(tile).opacity(0.45) : .clear, radius: 24, y: 8)
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
            .scaleEffect(hovering ? 1.008 : 1)
            .animation(Theme.Motion.snappy, value: hovering)
            .animation(Theme.Motion.smooth, value: live)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .help("Open \(tile.section.title)")
    }

    private func open(_ section: ApplyantKit.Section) {
        store.navigation.section = section
        store.navigation.select(nil)
    }

    private func resting(_ size: CGSize) -> some View {
        let art = min(max(size.height * 0.86, 110), 196)
        return ZStack(alignment: .topLeading) {
            // The object peeks in from the corner, cut by the tile's edge.
            ArtView(HomeTileView.art(tile), size: art, tilt: hovering ? pointer : .zero)
                .offset(x: size.width - art * 0.72, y: -art * 0.24)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(tile.title).font(Theme.tileLabel).foregroundStyle(.white.opacity(0.85))
                    if tile == .needsYou && figure.value > 0 { LiveDot(color: Theme.warning, size: 6) }
                }
                Spacer(minLength: 0)
                CountingNumber(value: figure.value)
                    .font(Theme.number(min(46, max(size.height * 0.24, 30))))
                    .foregroundStyle(Theme.text)
                if let done = figure.done {
                    HStack(spacing: 6) {
                        Circle().fill(Theme.good).frame(width: 8, height: 8).shadow(color: Theme.good.opacity(0.8), radius: 4)
                        Text(done).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.good)
                    }
                } else {
                    Text(figure.caption).font(.system(size: 13.5, weight: .medium)).foregroundStyle(Theme.secondaryText)
                }
                extras
            }
            .padding(18)
            .frame(width: size.width, height: size.height, alignment: .topLeading)
        }
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

    static func hue(_ tile: HomeTile) -> Double {
        switch tile {
        case .ready: 0.87
        case .needsYou: 0.07
        case .new: 0.47
        case .questions: 0.93
        case .applied: 0.58
        case .search: 0.53
        }
    }

    static func color(_ tile: HomeTile) -> Color { Color(hue: hue(tile), saturation: 0.7, brightness: 1) }

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

    /// The working tile's vivid colour: translucent at its top, bright at its foot (CleanMyMac's
    /// "Analyzing your storage…"), with its own glow drifting in it.
    static func vivid(_ tile: HomeTile, moving: Bool) -> some View {
        let h = hue(tile)
        return ZStack {
            GlowField(
                base: NSColor(hue: h, saturation: 0.75, brightness: 0.45, alpha: 0.18),
                colors: [NSColor(hue: h, saturation: 0.6, brightness: 1, alpha: 1), NSColor(hue: (h + 0.06).truncatingRemainder(dividingBy: 1), saturation: 0.7, brightness: 0.9, alpha: 1)],
                moving: moving,
                intensity: 0.4
            )
            LinearGradient(
                stops: [
                    .init(color: Color(hue: h, saturation: 0.55, brightness: 0.6).opacity(0.05), location: 0),
                    .init(color: Color(hue: h, saturation: 0.6, brightness: 0.9).opacity(0.45), location: 0.55),
                    .init(color: Color(hue: h, saturation: 0.55, brightness: 1).opacity(0.95), location: 1),
                ],
                startPoint: .top, endPoint: .bottom
            )
        }
    }
}

/// The working tile: its live line in the middle and its object floating under it, or, with a
/// list to work through, the list with check marks beside the object.
private struct LiveTileContent: View {
    let tile: HomeTile
    let live: HomeLive
    let size: CGSize
    let pointer: CGPoint

    var body: some View {
        let art = HomeTileView.liveArt(tile)
        if live.items.isEmpty || size.width < 480 {
            VStack(spacing: 10) {
                Text(live.title)
                    .font(.system(size: min(26, max(size.height * 0.08, 18)), weight: .bold))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .contentTransition(.opacity)
                    .id(live.title)
                    .transition(.blurIn(reduceMotion: false))
                ArtView(art, size: min(size.height * 0.48, size.width * 0.5, 200), tilt: pointer)
                    .frame(maxHeight: .infinity)
                if let note = live.note {
                    Text(note)
                        .font(.system(size: 13.5, weight: .medium))
                        .foregroundStyle(.white.opacity(0.85))
                        .lineLimit(1)
                        .contentTransition(.numericText())
                }
                if let fraction = live.fraction {
                    Meter(value: fraction, color: .white, height: 5).frame(maxWidth: 260)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 18)
            .frame(width: size.width, height: size.height)
        } else {
            ZStack(alignment: .topLeading) {
                ArtView(art, size: size.height * 0.95, tilt: pointer)
                    .offset(x: size.width - size.height * 0.62, y: size.height * 0.08)
                VStack(alignment: .leading, spacing: 14) {
                    Text(live.title)
                        .font(.system(size: min(26, max(size.height * 0.075, 18)), weight: .bold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .frame(maxWidth: size.width - size.height * 0.5, alignment: .center)
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(live.items.prefix(5).enumerated()), id: \.element.id) { index, item in
                            LiveItemRow(item: item, current: !item.done && live.items.firstIndex { !$0.done } == index)
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }
                    }
                    .frame(maxWidth: min(size.width - size.height * 0.55, 420), alignment: .leading)
                    if let note = live.note {
                        Text(note).font(.system(size: 12.5, weight: .medium)).foregroundStyle(.white.opacity(0.75))
                    }
                }
                .padding(22)
            }
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .animation(Theme.Motion.smooth, value: live.items)
        }
    }
}

/// A line of the live list: done (a check), under way (a spinner) or waiting.
private struct LiveItemRow: View {
    let item: HomeLiveItem
    let current: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: item.done ? "checkmark.circle.fill" : current ? "circle.dotted" : "circle")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(item.done ? Color.white : .white.opacity(current ? 0.9 : 0.4))
                .symbolEffect(.rotate, options: .repeating, isActive: current)
                .contentTransition(.symbolEffect(.replace))
            Text(item.title)
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundStyle(.white.opacity(item.done || current ? 1 : 0.6))
                .lineLimit(1)
            Spacer(minLength: 8)
            if let detail = item.detail {
                Text(detail)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.white.opacity(0.7))
                    .lineLimit(1)
            }
        }
    }
}

// MARK: - How it's going

/// Under the grid: the funnel in its window, and the PRD's success metrics as tiles.
private struct HomeMetrics: View {
    @Bindable var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.blockSpacing) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("How it's going").font(Theme.pageTitle).foregroundStyle(Theme.text)
                    if let report = store.overview {
                        Text(OverviewText.since(report) + " · postings first seen in the window, and how far each got")
                            .font(.system(size: 13)).foregroundStyle(Theme.secondaryText)
                    }
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
        .task(id: store.overviewWindow) { await store.openOverview() }
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
            Meter(value: share, color: Color(hue: 0.83 - Double(index) * 0.045, saturation: 0.6, brightness: 1), height: 6, delay: Stagger.delay(index, step: 0.06))
            if let conversion = row.conversion {
                Text(conversion).font(.caption).foregroundStyle(Theme.secondaryText)
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
                Text(metric.label).font(Theme.tileLabel).foregroundStyle(.white.opacity(0.85))
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
                Text(metric.definition).font(.caption).foregroundStyle(Theme.tertiaryText)
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
                .shadow(color: Theme.good.opacity(0.7), radius: 4)
                .symbolEffect(.bounce, options: .nonRepeating, value: appeared)
                .onAppear { appeared = true }
        case .missed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warning).help("Below target")
                .symbolEffect(.wiggle, options: .nonRepeating, value: appeared)
                .onAppear { appeared = true }
        case .noData:
            Text("No data yet").font(.caption).foregroundStyle(Theme.secondaryText)
        case .watched:
            Text("Watched").font(.caption).foregroundStyle(Theme.secondaryText)
        }
    }
}
