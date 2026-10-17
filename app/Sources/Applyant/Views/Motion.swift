// How things move: blocks coming in one after another, chips popping in, the shimmer of work
// under way, the activity line, the job header's slowly drifting glow, typing dots and the
// celebration's sparks. Everything falls back to a plain fade with Reduce Motion, and nothing
// keeps animating while the window is in the background.
import ApplyantKit
import SwiftUI

/// Whether endless motion (a shimmer, a breathing symbol, the flowing line) may run: not with
/// Reduce Motion, and not while the window is behind others, where it would only cost battery.
struct EndlessMotion: DynamicProperty {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.controlActiveState) private var activeState

    var allowed: Bool { !reduceMotion && activeState != .inactive }
}

// MARK: - Coming in

extension View {
    /// Comes in from a little below, out of a blur, a beat after the block before it.
    func entrance(_ index: Int) -> some View { modifier(Entrance(delay: Stagger.delay(index))) }

    /// Pops in from small, a beat after the one before it (chips in a row).
    func popIn(_ index: Int) -> some View { modifier(PopIn(delay: 0.12 + Stagger.delay(index, step: 0.06))) }

    /// Work under way: a soft light passes over it.
    func shimmer(_ active: Bool = true) -> some View { modifier(Shimmer(active: active)) }
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

    /// Its own view, so the pass starts over from the left whenever the shimmer comes back (the
    /// window in front again).
    private struct ShimmerBand: View {
        @State private var phase: CGFloat = -1

        var body: some View {
            GeometryReader { geo in
                // A band of the page's own colour: it lightens dark text and dims light text.
                LinearGradient(colors: [.clear, Theme.page.opacity(0.75), .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: geo.size.width * 0.45)
                    .offset(x: phase * geo.size.width)
            }
            .onAppear {
                withAnimation(.linear(duration: 1.8).delay(0.2).repeatForever(autoreverses: false)) { phase = 1.3 }
            }
        }
    }
}

/// A small dot that breathes: something is happening right now.
struct LiveDot: View {
    var color: Color = Theme.accent
    private let motion = EndlessMotion()

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 5, height: 5)
            .phaseAnimator(motion.allowed ? [1.0, 0.35] : [1.0]) { dot, value in
                dot.opacity(value).scaleEffect(0.8 + 0.2 * value)
            } animation: { _ in .easeInOut(duration: 0.8) }
            .accessibilityHidden(true)
    }
}

// MARK: - The activity line

/// The bottom bar's top edge while Applyant works: the brand colours flowing along it. Still,
/// and orange, while paused.
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
            let period: [Color] = [Theme.accent, Theme.violet, Theme.pink, Theme.accent]
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

// MARK: - The job header's glow

/// A mesh of the score's colour, the company's and the accent, drifting slowly behind the job's
/// header and fading into the page. It stops while the window isn't in front, and stays still
/// with Reduce Motion.
struct HeroGlow: View {
    let score: Color
    let company: Color
    private let motion = EndlessMotion()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        // A slow drift: twenty frames a second are plenty, and cheap. Paused, it stays where it was.
        TimelineView(.animation(minimumInterval: 1 / 20, paused: !motion.allowed)) { context in
            let t = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate
            MeshGradient(
                width: 3, height: 3,
                points: Self.points(t),
                colors: [
                    company, Theme.accent, score,
                    score.opacity(0.8), company.opacity(0.7), Theme.violet.opacity(0.8),
                    Theme.page, Theme.page, Theme.page,
                ],
                smoothsColors: true
            )
        }
        .opacity(scheme == .dark ? 0.42 : 0.3)
        .mask(LinearGradient(colors: [.black, .black.opacity(0.7), .clear], startPoint: .top, endPoint: .bottom))
        .accessibilityHidden(true)
    }

    /// The inner points wander on slow, unrelated circles; the corners stay put.
    static func points(_ t: Double) -> [SIMD2<Float>] {
        func wave(_ speed: Double, _ phase: Double, _ amount: Double) -> Float { Float(sin(t * speed + phase) * amount) }
        return [
            [0, 0], [0.5 + wave(0.21, 0, 0.18), 0], [1, 0],
            [0, 0.45 + wave(0.17, 1, 0.12)], [0.5 + wave(0.13, 2, 0.2), 0.5 + wave(0.19, 3, 0.15)], [1, 0.5 + wave(0.15, 4, 0.12)],
            [0, 1], [0.5 + wave(0.11, 5, 0.2), 1], [1, 1],
        ]
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
                    .fill(.secondary)
                    .frame(width: 6, height: 6)
                    .phaseAnimator(motion.allowed ? [0.0, 1.0, 0.0] : [0.0]) { dot, lift in
                        dot.offset(y: -3 * lift).opacity(0.45 + 0.55 * lift)
                    } animation: { _ in .easeInOut(duration: 0.35).delay(Double(i) * 0.12) }
            }
        }
        .accessibilityLabel("Writing")
    }
}

/// A symbol on the brand gradient with sparks flying out of it, for a job well done.
struct SparkBurst: View {
    let systemImage: String
    var size: CGFloat = 30
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
                        ForEach(0..<10, id: \.self) { i in
                            let angle = Double(i) / 10 * 2 * .pi
                            Circle()
                                .fill(Theme.sparkColors[i % Theme.sparkColors.count])
                                .frame(width: i.isMultiple(of: 2) ? 5 : 4, height: i.isMultiple(of: 2) ? 5 : 4)
                                .scaleEffect(spark.scale)
                                .offset(x: cos(angle) * spark.distance, y: sin(angle) * spark.distance)
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
            Circle()
                .fill(Theme.brandFill)
                .frame(width: size, height: size)
                .shadow(color: Theme.accent.opacity(0.4), radius: 6, y: 2)
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
}
