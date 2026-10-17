// The pieces every screen is built from, in Theme's language: glass tiles, chips, the score
// ring, a company's glossy monogram, a section's module header, page headers, empty states with
// their 3D art, the pill picker, the buttons (a glowing pill, a glass pill, the big round one)
// and the list of glass cards the list columns are made of.
import ApplyantKit
import SwiftUI

// MARK: - Glass

extension View {
    /// A glass tile over the world: a translucent fill, an edge lit along the top, and a soft
    /// sheen down from it. `tint` washes it in a colour (a warning, a hand-off, the selection).
    func glass(radius: CGFloat = Theme.cornerRadius, tint: Color? = nil, fill: Color = Theme.glassFill) -> some View {
        modifier(Glass(radius: radius, tint: tint, fill: fill))
    }

    /// The same as `glass`: the tiles of a page.
    func cardSurface(tint: Color? = nil, radius: CGFloat = Theme.cornerRadius) -> some View {
        glass(radius: radius, tint: tint)
    }

    /// A quiet block inside a tile or on the page: no edge.
    func insetSurface(radius: CGFloat = Theme.innerRadius, tint: Color? = nil) -> some View {
        background(tint.map { $0.opacity(0.14) } ?? Theme.insetFill, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }

    /// Long text's panel: darker glass, so the words read easily on any world.
    func readingSurface(radius: CGFloat = Theme.cornerRadius) -> some View {
        glass(radius: radius, fill: Theme.readingFill)
    }

    /// The world is behind every page: nothing to paint (kept so pages say where they start).
    func pageBackground() -> some View { self }
}

private struct Glass: ViewModifier {
    let radius: CGFloat
    let tint: Color?
    let fill: Color

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background {
                shape.fill(fill)
                    .overlay { if let tint { shape.fill(tint.opacity(0.13)) } }
                    .overlay {
                        // Light falling on the glass from above.
                        shape.fill(LinearGradient(colors: [.white.opacity(0.06), .clear], startPoint: .top, endPoint: .init(x: 0.5, y: 0.35)))
                    }
            }
            .overlay { shape.strokeBorder(tint.map { AnyShapeStyle($0.opacity(0.45)) } ?? AnyShapeStyle(Theme.glassEdge), lineWidth: 1) }
    }
}

/// A block of a page with a title ("How you match", "Description") and, optionally, something
/// on the title's right.
struct Card<Content: View, Accessory: View>: View {
    var title: String?
    var systemImage: String?
    var tint: Color?
    @ViewBuilder var accessory: Accessory
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.rowSpacing + 6) {
            if title != nil || Accessory.self != EmptyView.self {
                HStack(alignment: .firstTextBaseline) {
                    if let title { CardTitle(title: title, systemImage: systemImage, tint: tint) }
                    Spacer()
                    accessory
                }
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.cardPadding)
        .glass(tint: tint)
    }
}

extension Card where Accessory == EmptyView {
    init(title: String? = nil, systemImage: String? = nil, tint: Color? = nil, @ViewBuilder content: () -> Content) {
        self.init(title: title, systemImage: systemImage, tint: tint, accessory: { EmptyView() }, content: content)
    }
}

/// A tile's label: small, white, with its symbol in a lit colour.
struct CardTitle: View {
    let title: String
    var systemImage: String?
    var tint: Color?

    var body: some View {
        HStack(spacing: 8) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(tint ?? Theme.accent)
                    .frame(width: 18)
            }
            Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
        }
    }
}

/// A card whose content folds away under its title; open to start with unless told otherwise.
struct FoldingCard<Content: View>: View {
    let title: String
    var systemImage: String?
    @State var expanded = true
    var surface: Color = Theme.glassFill
    @ViewBuilder var content: Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(Theme.Motion.pick(Theme.Motion.snappy, reduceMotion: reduceMotion)) { expanded.toggle() }
            } label: {
                HStack {
                    CardTitle(title: title, systemImage: systemImage)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Theme.secondaryText)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                content
                    .padding(.top, Theme.rowSpacing + 8)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.cardPadding + 2)
        .glass(fill: surface)
    }
}

/// Small capitals over a group of rows ("NEEDS YOU · 19"), its count glowing.
struct Eyebrow: View {
    let text: String
    var count: Int?
    var tint: Color = Theme.secondaryText

    var body: some View {
        HStack(spacing: 7) {
            Text(text.uppercased()).tracking(1.1).foregroundStyle(tint)
            if let count {
                Text("\(count)")
                    .font(Theme.number(10.5))
                    .contentTransition(.numericText(value: Double(count)))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6).padding(.vertical, 1.5)
                    .background(tint.opacity(0.32), in: Capsule())
                    .overlay(Capsule().strokeBorder(tint.opacity(0.55), lineWidth: 0.75))
                    .shadow(color: tint.opacity(0.6), radius: 5)
            }
        }
        .font(Theme.eyebrow)
        .animation(Theme.Motion.snappy, value: count)
    }
}

// MARK: - Chips, marks, avatars

/// A glass capsule with a word or two ("Needs you", "Greenhouse") in its tone.
struct ChipView: View {
    let chip: Chip

    var body: some View {
        let tint = Theme.tint(chip.tone)
        let neutral = chip.tone == .neutral
        HStack(spacing: 5) {
            if chip.live { LiveDot(color: tint, size: 4.5) }
            Text(chip.text)
                .contentTransition(.numericText())
                .lineLimit(1)
        }
        .font(.system(size: 11, weight: .semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(neutral ? Color.white.opacity(0.08) : tint.opacity(0.16), in: Capsule())
        .overlay(Capsule().strokeBorder(neutral ? Color.white.opacity(0.12) : tint.opacity(0.35), lineWidth: 0.75))
        .foregroundStyle(neutral ? Color.white.opacity(0.75) : tint)
        .animation(Theme.Motion.snappy, value: chip.text)
    }
}

/// A score as a ring that fills to it: small in the lists, large in the job's hero, where it
/// sweeps in and counts up as it appears. A changed score animates either way. The ring glows:
/// a wide faint stroke under it in the lists (cheap), a real glow in the hero.
struct ScoreRing: View {
    let score: Int32?
    var size: CGFloat = 36
    var sweepsIn = false
    @State private var shown: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(score: Int32?, size: CGFloat = 36, sweepsIn: Bool = false) {
        self.score = score
        self.size = size
        self.sweepsIn = sweepsIn
        _shown = State(initialValue: sweepsIn ? 0 : ScoreScale.fill(score))
    }

    var body: some View {
        let color = Theme.score(score)
        let line = max(3, size * 0.095)
        let big = size > 50
        ZStack {
            Circle().stroke(Color.white.opacity(0.1), lineWidth: line)
            Circle()
                .trim(from: 0, to: shown)
                .stroke(color.opacity(big ? 0 : 0.22), style: StrokeStyle(lineWidth: line * 2.6, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Circle()
                .trim(from: 0, to: shown)
                .stroke(
                    AngularGradient(colors: [color.opacity(0.45), color, .white.opacity(0.9)], center: .center, startAngle: .degrees(0), endAngle: .degrees(360 * max(shown, 0.01))),
                    style: StrokeStyle(lineWidth: line, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
                // A real glow on the hero's ring only: a list's thousand rings stay cheap.
                .shadow(color: color.opacity(big ? 0.75 : 0), radius: big ? 10 : 0)
            if score != nil {
                RingNumber(value: shown * 100)
                    .font(Theme.number(size * 0.36))
                    .foregroundStyle(.white)
            } else {
                Text("–").font(Theme.number(size * 0.36)).foregroundStyle(Theme.secondaryText)
            }
        }
        .frame(width: size, height: size)
        .onAppear {
            guard sweepsIn else { return }
            let target = ScoreScale.fill(score)
            if reduceMotion { shown = target } else { withAnimation(Theme.Motion.gauge.delay(0.15)) { shown = target } }
        }
        .onChange(of: score) { _, new in
            withAnimation(Theme.Motion.pick(Theme.Motion.gauge, reduceMotion: reduceMotion)) { shown = ScoreScale.fill(new) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(score.map { "Score \($0)" } ?? "Not scored")
    }
}

/// The ring's number, counted along with the fill.
private struct RingNumber: View, @preconcurrency Animatable {
    var value: Double
    var animatableData: Double {
        get { value }
        set { value = newValue }
    }

    var body: some View { Text("\(Int(value.rounded()))") }
}

/// A requirement's verdict as a mark that glows: met, partly, missing, unknown.
struct VerdictMark: View {
    let verdict: String

    var body: some View {
        let color = Theme.verdict(verdict)
        Image(systemName: Theme.verdictSymbol(verdict))
            .font(.system(size: 14, weight: .semibold))
            // A white mark on the verdict's colour; "partly" is a half-filled circle of it.
            .symbolRenderingMode(verdict == "strong" || verdict == "missing" ? .palette : .monochrome)
            .foregroundStyle(verdict == "strong" || verdict == "missing" ? Color.white : color, color)
            .shadow(color: color.opacity(verdict == "unknown" ? 0 : 0.7), radius: 5)
            .frame(width: 18)
            .help(Score.verdictMark(verdict) == "?" ? "Not known" : verdict.capitalized)
    }
}

/// A company's monogram as a glossy 3D tile of its own colour: lit from the top, a rim of
/// light along its edge and a soft shadow under it.
struct CompanyAvatar: View {
    let name: String
    var size: CGFloat = 52

    var body: some View {
        GlossyTile(colors: [Theme.company(name, shift: -0.04), Theme.company(name, shift: 0.07)], size: size) {
            Text(Monogram.initials(name))
                .font(.system(size: size * (Monogram.initials(name).count > 1 ? 0.36 : 0.44), weight: .heavy, design: .rounded))
                .foregroundStyle(LinearGradient(colors: [.white, .white.opacity(0.82)], startPoint: .top, endPoint: .bottom))
                .shadow(color: .black.opacity(0.25), radius: 1.5, y: 1)
        }
        .accessibilityHidden(true)
    }
}

/// An SF Symbol on a glossy tile of the brand's (or the given) colours.
struct IconTile: View {
    let systemImage: String
    var size: CGFloat = 44
    var colors: [Color] = Theme.brandColors

    var body: some View {
        GlossyTile(colors: colors, size: size) {
            Image(systemName: systemImage)
                .font(.system(size: size * 0.44, weight: .semibold))
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.2), radius: 1.5, y: 1)
        }
        .accessibilityHidden(true)
    }
}

/// A rounded square of glossy glass: the gradient, a highlight across its top, a darker
/// bottom edge, a rim of light, and a glow of its colour under it.
struct GlossyTile<Content: View>: View {
    let colors: [Color]
    let size: CGFloat
    @ViewBuilder var content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
        shape
            .fill(LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay {
                // The bevel: lighter top, deeper bottom.
                shape.fill(LinearGradient(colors: [.white.opacity(0.32), .clear, .black.opacity(0.22)], startPoint: .top, endPoint: .bottom))
            }
            .overlay(alignment: .top) {
                Ellipse()
                    .fill(LinearGradient(colors: [.white.opacity(0.45), .white.opacity(0)], startPoint: .top, endPoint: .bottom))
                    .frame(width: size * 0.78, height: size * 0.36)
                    .offset(y: size * 0.04)
            }
            .overlay { content }
            .overlay { shape.strokeBorder(LinearGradient(colors: [.white.opacity(0.65), .white.opacity(0.08)], startPoint: .top, endPoint: .bottom), lineWidth: max(1, size * 0.02)) }
            .clipShape(shape)
            .frame(width: size, height: size)
            .shadow(color: (colors.last ?? Theme.accent).opacity(size > 40 ? 0.55 : 0.3), radius: size > 40 ? 14 : 4, y: size > 40 ? 6 : 2)
    }
}

/// A section's own title over its list or page, like a CleanMyMac module: its 3D art, the
/// big title, a line under it, and what's on the right.
struct ModuleHeader<Accessory: View>: View {
    let section: ApplyantKit.Section
    var title: String?
    var subtitle: String?
    var artSize: CGFloat = 54
    @ViewBuilder var accessory: Accessory

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            ArtView(Art(section), size: artSize, floats: true, tilts: true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title ?? section.railTitle)
                    .font(Theme.moduleTitle)
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(Theme.secondaryText)
                        .lineLimit(2)
                        .contentTransition(.numericText())
                }
            }
            Spacer(minLength: 0)
            accessory
        }
    }
}

extension View {
    /// A list column's header sits this far in from the panel's edges.
    func columnHeader() -> some View {
        padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 10)
    }
}

extension ModuleHeader where Accessory == EmptyView {
    init(section: ApplyantKit.Section, title: String? = nil, subtitle: String? = nil, artSize: CGFloat = 54) {
        self.init(section: section, title: title, subtitle: subtitle, artSize: artSize, accessory: { EmptyView() })
    }
}

/// A detail page's title: its tile, the title and a line under it, and what's on the right.
struct PageHeader<Leading: View, Trailing: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder var leading: Leading
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            leading
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(Theme.pageTitle).foregroundStyle(Theme.text).textSelection(.enabled)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.system(size: 13.5)).foregroundStyle(Theme.secondaryText).textSelection(.enabled)
                }
            }
            Spacer(minLength: 0)
            trailing
        }
        .entrance(0)
    }
}

extension PageHeader where Trailing == EmptyView {
    init(title: String, subtitle: String? = nil, @ViewBuilder leading: () -> Leading) {
        self.init(title: title, subtitle: subtitle, leading: leading, trailing: { EmptyView() })
    }
}

extension PageHeader where Leading == IconTile, Trailing == EmptyView {
    init(title: String, subtitle: String? = nil, systemImage: String) {
        self.init(title: title, subtitle: subtitle, leading: { IconTile(systemImage: systemImage, size: 48) }, trailing: { EmptyView() })
    }
}

// MARK: - Empty states

/// Nothing to show: the big 3D art floating, a bold title, what's missing and what to do.
struct EmptyState<Actions: View>: View {
    let title: String
    let systemImage: String
    var detail: String?
    var art: Art?
    var artSize: CGFloat = 150
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: 14) {
            if let art {
                ArtView(art, size: artSize)
                    .padding(.bottom, 4)
            } else {
                LiveSymbol(systemImage: systemImage)
            }
            Text(title)
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(Theme.text)
                .multilineTextAlignment(.center)
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(.system(size: 13.5))
                    .foregroundStyle(Theme.secondaryText)
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
                    .frame(maxWidth: 380)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) { actions }
                .padding(.top, 4)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .entrance(0)
    }
}

extension EmptyState where Actions == EmptyView {
    init(title: String, systemImage: String, detail: String? = nil, art: Art? = nil, artSize: CGFloat = 150) {
        self.init(title: title, systemImage: systemImage, detail: detail, art: art, artSize: artSize, actions: { EmptyView() })
    }
}

/// A large symbol on a glossy tile, glowing, that breathes now and then.
struct LiveSymbol: View {
    let systemImage: String
    private let motion = EndlessMotion()

    var body: some View {
        ZStack {
            Circle()
                .fill(RadialGradient(colors: [Theme.violet.opacity(0.5), .clear], center: .center, startRadius: 4, endRadius: 60))
                .frame(width: 120, height: 120)
            GlossyTile(colors: [Theme.violet, Theme.magenta], size: 76) {
                Image(systemName: systemImage)
                    .font(.system(size: 32, weight: .semibold))
                    .foregroundStyle(.white)
                    .symbolEffect(.breathe.pulse.byLayer, options: .repeat(.periodic(delay: 1.5)), isActive: motion.allowed)
            }
        }
        .frame(width: 120, height: 110)
    }
}

// MARK: - The pill picker

/// A glass segmented control whose glowing pill slides to the picked item: the job's tabs,
/// New's filter, the Overview's window.
struct PillPicker<Value: Hashable>: View {
    let items: [Value]
    let title: (Value) -> String
    @Binding var selection: Value
    /// ⌘1, ⌘2… pick the items (the job's tabs).
    var numberShortcuts = false
    var tint: Color = Theme.magenta
    var large = false
    @Namespace private var pill
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovered: Value?

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(items.enumerated()), id: \.element) { index, item in
                let picked = item == selection
                Button {
                    withAnimation(Theme.Motion.pick(Theme.Motion.snappy, reduceMotion: reduceMotion)) { selection = item }
                } label: {
                    Text(title(item))
                        .font(.system(size: large ? 13.5 : 12.5, weight: picked ? .bold : .medium))
                        .foregroundStyle(picked ? Color.white : Theme.secondaryText)
                        .padding(.horizontal, large ? 18 : 14)
                        .padding(.vertical, large ? 7 : 5)
                        .background {
                            if picked {
                                Capsule()
                                    .fill(LinearGradient(colors: [tint.opacity(0.85), Theme.violet.opacity(0.75)], startPoint: .topLeading, endPoint: .bottomTrailing))
                                    .overlay(Capsule().strokeBorder(.white.opacity(0.35), lineWidth: 0.75))
                                    .shadow(color: tint.opacity(0.55), radius: 8)
                                    .matchedGeometryEffect(id: "pill", in: pill)
                            } else if hovered == item {
                                Capsule().fill(Color.white.opacity(0.07))
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .onHover { hovered = $0 ? item : (hovered == item ? nil : hovered) }
                .modifier(NumberShortcut(index: numberShortcuts ? index : nil))
                .accessibilityAddTraits(picked ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Color.black.opacity(0.18), in: Capsule())
        .background(Theme.glassFill, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.glassEdge, lineWidth: 0.75))
        .fixedSize()
    }
}

private struct NumberShortcut: ViewModifier {
    let index: Int?

    func body(content: Content) -> some View {
        if let index, index < 9 {
            content.keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
        } else {
            content
        }
    }
}

// MARK: - Buttons

/// The one thing to do next: a glowing pill on the brand gradient, lifting under the pointer.
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { Styled(configuration: configuration) }

    private struct Styled: View {
        let configuration: Configuration
        @Environment(\.isEnabled) private var enabled
        @Environment(\.controlSize) private var controlSize
        @State private var hovering = false

        var body: some View {
            let small = controlSize == .small || controlSize == .mini
            let large = controlSize == .large
            configuration.label
                .font(.system(size: small ? 12 : large ? 15 : 13.5, weight: .bold))
                .foregroundStyle(.white.opacity(enabled ? 1 : 0.6))
                .padding(.horizontal, small ? 11 : large ? 22 : 16)
                .padding(.vertical, small ? 4 : large ? 10 : 7)
                .background {
                    Capsule().fill(enabled ? AnyShapeStyle(Theme.brandFill) : AnyShapeStyle(Color.white.opacity(0.12)))
                        .overlay {
                            // A light edge along the top, like a lit surface.
                            Capsule().fill(LinearGradient(colors: [.white.opacity(hovering ? 0.32 : 0.22), .clear], startPoint: .top, endPoint: .center))
                        }
                }
                .overlay { Capsule().strokeBorder(.white.opacity(enabled ? 0.35 : 0.12), lineWidth: 0.75) }
                .shadow(color: Theme.magenta.opacity(enabled ? (hovering ? 0.7 : 0.45) : 0), radius: hovering ? 14 : 9, y: 2)
                .scaleEffect(configuration.isPressed ? 0.96 : hovering ? 1.02 : 1)
                .brightness(configuration.isPressed ? -0.05 : 0)
                .animation(Theme.Motion.snappy, value: configuration.isPressed)
                .animation(Theme.Motion.snappy, value: hovering)
                .contentShape(Capsule())
                .onHover { hovering = $0 && enabled }
        }
    }
}

/// Everything beside it: a glass pill that brightens under the pointer.
struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { Styled(configuration: configuration) }

    private struct Styled: View {
        let configuration: Configuration
        @Environment(\.isEnabled) private var enabled
        @Environment(\.controlSize) private var controlSize
        @State private var hovering = false

        var body: some View {
            let small = controlSize == .small || controlSize == .mini
            configuration.label
                .font(.system(size: small ? 12 : 13, weight: .semibold))
                .foregroundStyle(enabled ? (configuration.role == .destructive ? Theme.bad : Color.white.opacity(0.92)) : Theme.tertiaryText)
                .padding(.horizontal, small ? 10 : 14)
                .padding(.vertical, small ? 4 : 7)
                .background {
                    Capsule().fill(Color.white.opacity(configuration.isPressed ? 0.18 : hovering ? 0.14 : 0.08))
                }
                .overlay { Capsule().strokeBorder(Theme.glassEdge, lineWidth: 0.75) }
                .scaleEffect(configuration.isPressed ? 0.96 : 1)
                .animation(Theme.Motion.snappy, value: configuration.isPressed)
                .animation(Theme.Motion.fade, value: hovering)
                .contentShape(Capsule())
                .onHover { hovering = $0 && enabled }
        }
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle {
    static var primary: PrimaryButtonStyle { PrimaryButtonStyle() }
}

extension ButtonStyle where Self == SecondaryButtonStyle {
    static var secondary: SecondaryButtonStyle { SecondaryButtonStyle() }
}

/// The big round button (CleanMyMac's Scan, ClearVPN's power button): a glowing disc with a
/// light rim and a soft halo that breathes; while work runs a bright arc circles it, or a ring
/// fills to how far it is.
struct RoundActionButton: View {
    let title: String
    var systemImage: String?
    var size: CGFloat = 92
    var colors: [Color] = [Theme.magenta, Theme.violet]
    /// Work under way: the arc circles it.
    var working = false
    /// How far it is, when that's known: a ring fills to it instead.
    var progress: Double?
    var enabled = true
    let action: () -> Void
    @State private var hovering = false
    private let motion = EndlessMotion()

    var body: some View {
        Button(action: action) {
            ZStack {
                if enabled {
                    Halo(color: NSColor(colors.first ?? Theme.magenta), breathing: motion.ambient)
                        .frame(width: size * 1.9, height: size * 1.9)
                }
                // The rim: a ring of light around the disc.
                Circle()
                    .fill(Color.white.opacity(enabled ? 0.22 : 0.08))
                    .frame(width: size + 12, height: size + 12)
                    .overlay(Circle().strokeBorder(.white.opacity(enabled ? 0.55 : 0.15), lineWidth: 1))
                Circle()
                    .fill(enabled
                        ? AnyShapeStyle(RadialGradient(colors: [colors.first ?? Theme.magenta, colors.last ?? Theme.violet], center: .init(x: 0.35, y: 0.25), startRadius: 2, endRadius: size * 0.75))
                        : AnyShapeStyle(Color.white.opacity(0.1)))
                    .overlay {
                        Circle().fill(LinearGradient(colors: [.white.opacity(0.35), .clear], startPoint: .top, endPoint: .center))
                            .padding(size * 0.06)
                            .blendMode(.plusLighter)
                    }
                    .frame(width: size, height: size)
                    .shadow(color: (colors.first ?? Theme.magenta).opacity(enabled ? 0.6 : 0), radius: 16, y: 4)
                if let progress {
                    Circle()
                        .trim(from: 0, to: progress)
                        .stroke(.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .frame(width: size + 12, height: size + 12)
                        .shadow(color: .white.opacity(0.8), radius: 4)
                        .animation(Theme.Motion.smooth, value: progress)
                } else if working {
                    SpinningRing(colors: [NSColor.white.withAlphaComponent(0.9), .white], lineWidth: 3, spinning: motion.ambient)
                        .frame(width: size + 12, height: size + 12)
                }
                VStack(spacing: 3) {
                    if let systemImage {
                        Image(systemName: systemImage).font(.system(size: size * 0.2, weight: .bold))
                    }
                    Text(title).font(.system(size: size * 0.17, weight: .bold))
                }
                .foregroundStyle(.white.opacity(enabled ? 1 : 0.5))
                .shadow(color: .black.opacity(0.2), radius: 2, y: 1)
            }
            .frame(width: size + 14, height: size + 14)
            .contentShape(Circle())
            .scaleEffect(hovering && enabled ? 1.05 : 1)
            .animation(Theme.Motion.bouncy, value: hovering)
        }
        .buttonStyle(RoundPress())
        .disabled(!enabled)
        .onHover { hovering = $0 }
    }

    private struct RoundPress: ButtonStyle {
        func makeBody(configuration: Configuration) -> some View {
            configuration.label
                .scaleEffect(configuration.isPressed ? 0.93 : 1)
                .animation(Theme.Motion.snappy, value: configuration.isPressed)
        }
    }
}

// MARK: - Meters

/// A bar that fills to `value` (0…1), growing in from empty when it appears.
struct Meter: View {
    let value: Double
    var color: Color = Theme.accent
    var height: CGFloat = 6
    var delay: Double = 0
    @State private var shown = 0.0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.09))
                Capsule()
                    .fill(LinearGradient(colors: [color.opacity(0.65), color], startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(shown > 0 ? height : 0, geo.size.width * shown))
                    .shadow(color: color.opacity(0.55), radius: 4)
            }
        }
        .frame(height: height)
        .onAppear {
            let target = min(max(value, 0), 1)
            if reduceMotion { shown = target } else { withAnimation(Theme.Motion.gauge.delay(delay)) { shown = target } }
        }
        .onChange(of: value) { _, new in
            withAnimation(Theme.Motion.pick(Theme.Motion.smooth, reduceMotion: reduceMotion)) { shown = min(max(new, 0), 1) }
        }
        .accessibilityElement()
        .accessibilityValue("\(Int((value * 100).rounded())) percent")
    }
}

// MARK: - Layout

/// A row that wraps onto the next line when it runs out of width (a header's buttons).
struct FlowRow: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        // Asked for its smallest size: as narrow as its widest button (else the detail column
        // can't be narrower than every button in one line, and the window grows to fit), and
        // one line tall (every button stacked would make the window that tall). A real width
        // gets the real height.
        if proposal.width == 0 {
            let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
            return CGSize(width: sizes.map(\.width).max() ?? 0, height: sizes.map(\.height).max() ?? 0)
        }
        // No width (its ideal size): one line.
        let lines = lines(subviews, width: proposal.width ?? .infinity)
        let width = lines.map(\.width).max() ?? 0
        let height = lines.map(\.height).reduce(0, +) + CGFloat(max(lines.count - 1, 0)) * lineSpacing
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in lines(subviews, width: bounds.width) {
            var x = bounds.minX
            for (index, size) in zip(line.indices, line.sizes) {
                // Centred in its line: a menu and a button of different heights line up.
                subviews[index].place(at: CGPoint(x: x, y: y + (line.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += line.height + lineSpacing
        }
    }

    private struct Line {
        var indices: [Int] = []
        var sizes: [CGSize] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func lines(_ subviews: Subviews, width: CGFloat) -> [Line] {
        var lines: [Line] = []
        var line = Line()
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            if size.width == 0 && size.height == 0 { continue }
            let next = line.indices.isEmpty ? size.width : line.width + spacing + size.width
            if !line.indices.isEmpty && next > width {
                lines.append(line)
                line = Line()
            }
            line.width = line.indices.isEmpty ? size.width : line.width + spacing + size.width
            line.height = max(line.height, size.height)
            line.indices.append(index)
            line.sizes.append(size)
        }
        if !line.indices.isEmpty { lines.append(line) }
        return lines
    }
}

// MARK: - The list of glass cards

/// What a CardList tells its cards: which one is picked, how to pick one, and its world's colour.
struct CardListContext {
    var selected: AnyHashable?
    var select: (AnyHashable) -> Void = { _ in }
    var tint: Color = Theme.magenta
}

private struct CardListContextKey: EnvironmentKey {
    static var defaultValue: CardListContext { CardListContext() }
}

extension EnvironmentValues {
    var cardList: CardListContext {
        get { self[CardListContextKey.self] }
        set { self[CardListContextKey.self] = newValue }
    }
}

/// A list column's rows as glass cards in a lazy stack (only the rows on screen exist, so a
/// thousand scroll smoothly): ↑ and ↓ move the selection, which scrolls into view, and so does
/// a selection made elsewhere (the next job after Approve).
struct CardList<ID: Hashable, Content: View>: View {
    @Binding var selection: ID?
    /// Every row's id, top to bottom, for the arrow keys.
    let order: [ID]
    var tint: Color = Theme.magenta
    var spacing: CGFloat = 6
    @ViewBuilder var content: Content
    @FocusState private var focused: Bool
    /// The last pick made in the list itself (a click, an arrow): already in view.
    @State private var picked: ID?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: spacing) {
                    content
                }
                .padding(.horizontal, 10)
                .padding(.top, 4)
                .padding(.bottom, 14)
            }
            .focusable(ProcessInfo.processInfo.environment["BISECT_NOFOCUS"] == nil)
            .focused($focused)
            .focusEffectDisabled()
            .onKeyPress(.downArrow) { move(1, proxy) }
            .onKeyPress(.upArrow) { move(-1, proxy) }
            .environment(\.cardList, CardListContext(
                selected: selection.map(AnyHashable.init),
                select: { id in
                    focused = true
                    if let id = id.base as? ID {
                        picked = id
                        selection = id
                    }
                },
                tint: tint
            ))
            .onChange(of: selection) { _, new in
                guard let new, new != picked else { return }
                withAnimation(Theme.Motion.smooth) { proxy.scrollTo(new) }
            }
        }
    }

    private func move(_ step: Int, _ proxy: ScrollViewProxy) -> KeyPress.Result {
        guard !order.isEmpty else { return .ignored }
        let index = selection.flatMap { order.firstIndex(of: $0) }.map { $0 + step } ?? (step > 0 ? 0 : order.count - 1)
        let next = order[min(max(index, 0), order.count - 1)]
        picked = next
        selection = next
        proxy.scrollTo(next)
        return .handled
    }
}

/// A row of a CardList: a soft glass card that brightens under the pointer and, picked, glows
/// with the world's colour along its edge.
struct SelectableCard<ID: Hashable, Label: View>: View {
    let id: ID
    var padding: CGFloat = 12
    @ViewBuilder var label: Label
    @Environment(\.cardList) private var list
    @State private var hovering = false

    var body: some View {
        let picked = list.selected == AnyHashable(id)
        let shape = RoundedRectangle(cornerRadius: 15, style: .continuous)
        label
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                shape.fill(picked ? AnyShapeStyle(LinearGradient(colors: [list.tint.opacity(0.32), list.tint.opacity(0.12)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    : AnyShapeStyle(Color.white.opacity(hovering ? 0.095 : 0.05)))
            }
            .overlay {
                if picked {
                    shape.strokeBorder(LinearGradient(colors: [.white.opacity(0.75), list.tint, list.tint.opacity(0.5)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1.5)
                } else {
                    shape.strokeBorder(Color.white.opacity(hovering ? 0.16 : 0.07), lineWidth: 1)
                }
            }
            // Only the picked card glows: one shadow, not one per row.
            .shadow(color: list.tint.opacity(picked ? 0.45 : 0), radius: picked ? 12 : 0)
            .scaleEffect(hovering && !picked ? 1.008 : 1)
            .contentShape(shape)
            .onTapGesture { list.select(AnyHashable(id)) }
            .onHover { hovering = $0 }
            .animation(Theme.Motion.snappy, value: picked)
            .animation(Theme.Motion.fade, value: hovering)
            .id(id)
            .accessibilityAddTraits(picked ? [.isSelected, .isButton] : .isButton)
    }
}

/// A group's header in a CardList ("NEEDS YOU 19").
struct CardListHeader: View {
    let title: String
    var count: Int?
    var tint: Color = Theme.secondaryText

    var body: some View {
        Eyebrow(text: title, count: count, tint: tint)
            .padding(.horizontal, 6)
            .padding(.top, 12)
            .padding(.bottom, 2)
    }
}

// MARK: - Messages

extension View {
    /// A message in a conversation: the candidate's on the brand gradient, Applyant's on glass.
    func bubble(mine: Bool) -> some View {
        modifier(Bubble(mine: mine))
    }
}

private struct Bubble: ViewModifier {
    let mine: Bool

    func body(content: Content) -> some View {
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: 18, bottomLeadingRadius: mine ? 18 : 6,
            bottomTrailingRadius: mine ? 6 : 18, topTrailingRadius: 18, style: .continuous
        )
        if mine {
            content
                .foregroundStyle(.white)
                .tint(.white)
                .padding(.horizontal, 15)
                .padding(.vertical, 11)
                .background(Theme.brandFill, in: shape)
                .overlay(shape.strokeBorder(.white.opacity(0.25), lineWidth: 0.75))
                .shadow(color: Theme.magenta.opacity(0.35), radius: 10, y: 3)
        } else {
            content
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 15)
                .padding(.vertical, 11)
                .background(Theme.glassFill, in: shape)
                .overlay(shape.strokeBorder(Theme.glassEdge, lineWidth: 1))
        }
    }
}

/// Where a message or an answer is written: dark glass with a lit edge.
extension View {
    func composerField() -> some View {
        scrollContentBackground(.hidden)
            .padding(10)
            .background(Theme.readingFill, in: RoundedRectangle(cornerRadius: Theme.innerRadius + 4, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.innerRadius + 4, style: .continuous).strokeBorder(Theme.glassEdge, lineWidth: 1))
    }
}

// MARK: - Sheets

extension View {
    /// A sheet in the window's world: dark, on the deep base with a violet glow.
    func worldSheet() -> some View {
        environment(\.colorScheme, .dark)
            .presentationBackground {
                ZStack {
                    GlowField(base: NSColor(Theme.base), colors: [NSColor(srgbRed: 0.38, green: 0.14, blue: 0.70, alpha: 1), NSColor(srgbRed: 0.55, green: 0.12, blue: 0.62, alpha: 1)], moving: false, intensity: 0.8)
                    Grain()
                }
            }
    }
}
