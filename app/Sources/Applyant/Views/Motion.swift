// How things move: blocks coming in one after another, chips popping in, the shimmer and the
// sheen of work under way, numbers counting up, typing dots and the celebration's sparks.
// Everything falls back to a plain fade with Reduce Motion, and nothing keeps animating while
// the window is in the background. What moves all the time (the world's glow, floating art,
// halos) is Core Animation's, in Ambient.swift.
import ApplyantKit
import SwiftUI

/// Whether endless motion (a shimmer, a breathing symbol, the flowing line) may run: not with
/// Reduce Motion, and not while the window is behind others, where it would only cost battery.
struct EndlessMotion: DynamicProperty {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.controlActiveState) private var activeState

    var allowed: Bool { !reduceMotion && (activeState != .inactive || Self.always) }
    /// The ambient kind (the world drifting, art floating): only while the window is the key one.
    var ambient: Bool { !reduceMotion && (activeState == .key || Self.always) }

    /// A scripted run with `--ambient`: everything moves as in the window in front, for
    /// measuring what that costs without taking the screen from whoever is using it.
    nonisolated(unsafe) static var always = false
}

// MARK: - Coming in

extension View {
    /// Comes in from a little below, out of a blur, a beat after the block before it.
    func entrance(_ index: Int) -> some View { modifier(Entrance(delay: Stagger.delay(index))) }

    /// Pops in from small, a beat after the one before it (chips in a row).
    func popIn(_ index: Int) -> some View { modifier(PopIn(delay: 0.12 + Stagger.delay(index, step: 0.06))) }

    /// Work under way: a soft light passes over it.
    func shimmer(_ active: Bool = true) -> some View { modifier(Shimmer(active: active)) }

    /// Work under way on a whole card: a band of light sweeps across its glass.
    func sheen(_ active: Bool = true, radius: CGFloat = Theme.innerRadius + 2) -> some View {
        modifier(Sheen(active: active, radius: radius))
    }
}

private struct Entrance: ViewModifier {
    let delay: Double
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 14)
            .blur(radius: shown || reduceMotion ? 0 : 6)
            .onAppear {
                guard !shown else { return }
                withAnimation(reduceMotion ? Theme.Motion.fade : Theme.Motion.smooth.delay(delay)) { shown = true }
            }
    }
}

private struct PopIn: ViewModifier {
    let delay: Double
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .scaleEffect(shown || reduceMotion ? 1 : 0.6)
            .opacity(shown ? 1 : 0)
            .onAppear {
                guard !shown else { return }
                withAnimation(reduceMotion ? Theme.Motion.fade : Theme.Motion.bouncy.delay(delay)) { shown = true }
            }
    }
}

private struct Shimmer: ViewModifier {
    let active: Bool
    private let motion = EndlessMotion()

    func body(content: Content) -> some View {
        if active && motion.allowed {
            content
                .overlay {
                    ShimmerBand().mask(content).allowsHitTesting(false)
                }
        } else {
            content
        }
    }

    /// A pass every two seconds, drawn thirty times a second: smooth enough for a soft band, and
    /// a quarter of what a display-rate animation would cost.
    private struct ShimmerBand: View {
        var body: some View {
            TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.2) / 2.2
                GeometryReader { geo in
                    // Light over the white text: it glints as the band passes.
                    LinearGradient(colors: [.clear, .white.opacity(0.55), .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: geo.size.width * 0.45)
                        .offset(x: (-1 + 2.3 * t) * geo.size.width)
                }
            }
        }
    }
}

private struct Sheen: ViewModifier {
    let active: Bool
    let radius: CGFloat
    private let motion = EndlessMotion()

    func body(content: Content) -> some View {
        content.overlay {
            if active && motion.allowed {
                // Core Animation sweeps the band (Ambient.swift): no redraw per frame.
                SheenBand(radius: radius)
                    .allowsHitTesting(false)
            }
        }
    }
}

/// A small dot that breathes: something is happening right now. Core Animation breathes it
/// (Ambient.swift), so a dot on screen for hours costs nothing.
struct LiveDot: View {
    var color: Color = Theme.accent
    var size: CGFloat = 5
    private let motion = EndlessMotion()

    var body: some View {
        BreathingDot(color: NSColor(color), breathing: motion.allowed)
            .frame(width: size * 2.2, height: size * 2.2)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

// MARK: - Numbers

/// A number that counts up to its value when it appears, and rolls to a new one ("1,229").
struct CountingNumber: View {
    let value: Int
    @State private var shown: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Counted(value: shown)
            .onAppear {
                if reduceMotion { shown = Double(value) } else { withAnimation(Theme.Motion.gauge.delay(0.1)) { shown = Double(value) } }
            }
            .onChange(of: value) { _, new in
                withAnimation(Theme.Motion.pick(Theme.Motion.gauge, reduceMotion: reduceMotion)) { shown = Double(new) }
            }
            .accessibilityLabel(value.formatted())
    }

    private struct Counted: View, @preconcurrency Animatable {
        var value: Double
        var animatableData: Double {
            get { value }
            set { value = newValue }
        }

        var body: some View { Text(Int(value.rounded()).formatted()) }
    }
}

// MARK: - The activity line

/// A line of the accent's blues flowing while Applyant works (a delivery's progress without a
/// count). Still, and orange, while paused.
struct FlowLine: View {
    let flowing: Bool
    private let motion = EndlessMotion()

    var body: some View {
        GeometryReader { geo in
            if flowing {
                // Started over whenever it may move again (the window came back to the front).
                Flow(width: max(geo.size.width, 1), moving: motion.allowed).id(motion.allowed)
            } else {
                Theme.warning.opacity(0.6)
            }
        }
        .frame(height: 2)
        .clipped()
        .accessibilityHidden(true)
    }

    private struct Flow: View {
        let width: CGFloat
        let moving: Bool
        @State private var offset: CGFloat = 0

        var body: some View {
            // Two periods side by side, slid one period along and started over: no seam.
            let period: [Color] = [Theme.accentFill, Theme.accent, Theme.pink, Theme.accentFill]
            LinearGradient(colors: period + period.dropFirst(), startPoint: .leading, endPoint: .trailing)
                .frame(width: width * 2)
                .offset(x: -width * offset)
                .onAppear {
                    guard moving else { return }
                    withAnimation(.linear(duration: 4).repeatForever(autoreverses: false)) { offset = 1 }
                }
        }
    }
}

// MARK: - Typing, and the sparks

/// Three dots, rising one after another: someone is writing.
struct TypingDots: View {
    private let motion = EndlessMotion()

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3) { i in
                Circle()
                    .fill(Theme.secondaryText)
                    .frame(width: 6, height: 6)
                    .phaseAnimator(motion.allowed ? [0.0, 1.0, 0.0] : [0.0]) { dot, lift in
                        dot.offset(y: -3 * lift).opacity(0.45 + 0.55 * lift)
                    } animation: { _ in .easeInOut(duration: 0.35).delay(Double(i) * 0.12) }
            }
        }
        .accessibilityLabel("Writing")
    }
}

/// Sparks flying out from the middle, once, when it appears (a job well done).
struct Sparks: View {
    var size: CGFloat = 30
    var count = 10
    @State private var trigger = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct Spark {
        var distance: CGFloat = 0
        var opacity: Double = 0
        var scale: CGFloat = 1
    }

    var body: some View {
        ZStack {
            if !reduceMotion {
                KeyframeAnimator(initialValue: Spark(), trigger: trigger) { spark in
                    ZStack {
                        ForEach(0..<count, id: \.self) { i in
                            let angle = Double(i) / Double(count) * 2 * .pi + (i.isMultiple(of: 2) ? 0 : 0.2)
                            let reach = i.isMultiple(of: 3) ? 1.0 : 0.82
                            Circle()
                                .fill(Theme.sparkColors[i % Theme.sparkColors.count])
                                .frame(width: size * (i.isMultiple(of: 2) ? 0.17 : 0.12), height: size * (i.isMultiple(of: 2) ? 0.17 : 0.12))
                                .scaleEffect(spark.scale)
                                .offset(x: cos(angle) * spark.distance * reach, y: sin(angle) * spark.distance * reach)
                                .opacity(spark.opacity)
                        }
                    }
                } keyframes: { _ in
                    KeyframeTrack(\.distance) {
                        LinearKeyframe(size * 0.4, duration: 0.01)
                        SpringKeyframe(size * 1.15, duration: 0.7, spring: .smooth)
                    }
                    KeyframeTrack(\.opacity) {
                        LinearKeyframe(1, duration: 0.05)
                        LinearKeyframe(1, duration: 0.3)
                        LinearKeyframe(0, duration: 0.45)
                    }
                    KeyframeTrack(\.scale) {
                        LinearKeyframe(1.2, duration: 0.2)
                        LinearKeyframe(0.4, duration: 0.6)
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .onAppear { trigger += 1 }
        .allowsHitTesting(false)
    }
}

/// A symbol on the accent with sparks flying out of it (the toast's).
struct SparkBurst: View {
    let systemImage: String
    var size: CGFloat = 30
    @State private var trigger = 0

    var body: some View {
        ZStack {
            Sparks(size: size)
            Circle()
                .fill(Theme.accentFill)
                .frame(width: size, height: size)
                .shadow(color: Theme.accentFill.opacity(0.4), radius: 5, y: 2)
            Image(systemName: systemImage)
                .font(.system(size: size * 0.45, weight: .bold))
                .foregroundStyle(.white)
                .symbolEffect(.bounce.up.byLayer, value: trigger)
        }
        .frame(width: size, height: size)
        .onAppear { trigger += 1 }
    }
}

// MARK: - Transitions

@MainActor
extension AnyTransition {
    /// A page replacing another (a tab): out of a blur. A fade with Reduce Motion.
    static func blurIn(reduceMotion: Bool) -> AnyTransition {
        reduceMotion ? .opacity : AnyTransition(.blurReplace)
    }

    /// A newly picked job: up from a little below, out of a blur; the one before just fades.
    static func page(reduceMotion: Bool) -> AnyTransition {
        reduceMotion ? .opacity : .asymmetric(insertion: AnyTransition(.blurReplace).combined(with: .offset(y: 12)), removal: .opacity)
    }

    /// What a control opens, appearing under it (the metrics panel, an inline disclosure): down
    /// 10 points as it fades in, and it only fades out. A fade with Reduce Motion.
    static func reveal(reduceMotion: Bool) -> AnyTransition {
        reduceMotion ? .opacity : .asymmetric(insertion: .opacity.combined(with: .offset(y: -10)), removal: .opacity)
    }

    /// A row leaving its list (approved, skipped): it slides away to the side as it fades.
    static func rowOut(reduceMotion: Bool) -> AnyTransition {
        reduceMotion ? .opacity : .asymmetric(
            insertion: .opacity.combined(with: .scale(scale: 0.96, anchor: .top)),
            removal: .move(edge: .leading).combined(with: .opacity)
        )
    }
}

extension Theme.Motion {
    /// Something opening or closing in place (a DisclosureLine, the metrics panel).
    static let disclose = snappy
}
