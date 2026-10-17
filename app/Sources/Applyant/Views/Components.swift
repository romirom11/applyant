// The pieces every screen is built from, in Theme's language: the card, chips, the score ring,
// a company's monogram, page headers, empty states, the pill picker and the two button styles.
import ApplyantKit
import SwiftUI

// MARK: - Cards

extension View {
    /// A card's surface: a lifted fill, a hairline edge and a soft shadow; `tint` washes it in a
    /// colour (a warning, a hand-off).
    func cardSurface(tint: Color? = nil, radius: CGFloat = Theme.cornerRadius) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return background {
            shape.fill(Theme.cardFill)
                .overlay { if let tint { shape.fill(tint.opacity(0.07)) } }
                .shadow(color: Theme.shadow, radius: 10, y: 3)
        }
        .overlay { shape.strokeBorder(tint.map { $0.opacity(0.3) } ?? Theme.hairline, lineWidth: 0.5) }
    }

    /// A quiet block inside a card or on the page: no edge, no shadow.
    func insetSurface(radius: CGFloat = Theme.innerRadius, tint: Color? = nil) -> some View {
        background(tint.map { $0.opacity(0.09) } ?? Theme.insetFill, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }

    /// Behind a detail page, under the toolbar too (else a band of the window's own colour
    /// shows there).
    func pageBackground() -> some View {
        background { Theme.page.ignoresSafeArea() }
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
        VStack(alignment: .leading, spacing: Theme.rowSpacing + 4) {
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
        .cardSurface(tint: tint)
    }
}

extension Card where Accessory == EmptyView {
    init(title: String? = nil, systemImage: String? = nil, tint: Color? = nil, @ViewBuilder content: () -> Content) {
        self.init(title: title, systemImage: systemImage, tint: tint, accessory: { EmptyView() }, content: content)
    }
}

struct CardTitle: View {
    let title: String
    var systemImage: String?
    var tint: Color?

    var body: some View {
        HStack(spacing: 7) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(tint ?? Theme.accent)
                    .frame(width: 18)
            }
            Text(title).font(Theme.cardTitle)
        }
    }
}

/// A card whose content folds away under its title; open to start with unless told otherwise.
struct FoldingCard<Content: View>: View {
    let title: String
    var systemImage: String?
    @State var expanded = true
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
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                content
                    .padding(.top, Theme.rowSpacing + 4)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.cardPadding)
        .cardSurface()
    }
}

/// Small capitals over a group of rows ("NEEDS YOU · 19").
struct Eyebrow: View {
    let text: String
    var count: Int?
    var tint: Color = .secondary

    var body: some View {
        HStack(spacing: 6) {
            Text(text.uppercased()).tracking(0.7)
            if let count {
                Text("\(count)")
                    .contentTransition(.numericText(value: Double(count)))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(tint.opacity(0.14), in: Capsule())
            }
        }
        .font(Theme.eyebrow)
        .foregroundStyle(tint)
        .animation(Theme.Motion.snappy, value: count)
    }
}

// MARK: - Chips, marks, avatars

struct ChipView: View {
    let chip: Chip

    var body: some View {
        let tint = Theme.tint(chip.tone)
        HStack(spacing: 4) {
            if chip.live { LiveDot(color: tint) }
            Text(chip.text)
                .contentTransition(.numericText())
                .lineLimit(1)
        }
        .font(.caption.weight(.medium))
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(tint.opacity(chip.tone == .neutral ? 0.1 : 0.14), in: Capsule())
        .overlay(Capsule().strokeBorder(tint.opacity(0.18), lineWidth: 0.5))
        .foregroundStyle(tint)
        .animation(Theme.Motion.snappy, value: chip.text)
    }
}

/// A score as a ring that fills to it: small in the lists, large in the job's header, where it
/// sweeps in and counts up as it appears. A changed score animates either way.
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
        let line = max(2.5, size * 0.1)
        ZStack {
            Circle().stroke(color.opacity(0.16), lineWidth: line)
            Circle()
                .trim(from: 0, to: shown)
                .stroke(
                    AngularGradient(colors: [color.opacity(0.55), color], center: .center, startAngle: .degrees(0), endAngle: .degrees(360 * max(shown, 0.01))),
                    style: StrokeStyle(lineWidth: line, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
                // A glow on the header's ring only: a list's thousand rings stay cheap.
                .shadow(color: color.opacity(size > 50 ? 0.45 : 0), radius: size > 50 ? 6 : 0)
            if score != nil {
                RingNumber(value: shown * 100)
                    .font(Theme.number(size * 0.36))
                    .foregroundStyle(color)
            } else {
                Text("–").font(Theme.number(size * 0.36)).foregroundStyle(.secondary)
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

/// A requirement's verdict as a mark: met, partly, missing, unknown.
struct VerdictMark: View {
    let verdict: String

    var body: some View {
        Image(systemName: Theme.verdictSymbol(verdict))
            .font(.callout)
            // A white mark on the verdict's colour; "partly" is a half-filled circle of it.
            .symbolRenderingMode(verdict == "strong" || verdict == "missing" ? .palette : .monochrome)
            .foregroundStyle(verdict == "strong" || verdict == "missing" ? Color.white : Theme.verdict(verdict), Theme.verdict(verdict))
            .frame(width: 18)
            .help(Score.verdictMark(verdict) == "?" ? "Not known" : verdict.capitalized)
    }
}

/// A company's monogram on its own colour.
struct CompanyAvatar: View {
    let name: String
    var size: CGFloat = 52

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
        shape
            .fill(LinearGradient(
                colors: [Theme.company(name, shift: -0.03), Theme.company(name, shift: 0.06)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            ))
            .overlay {
                Text(Monogram.initials(name))
                    .font(.system(size: size * (Monogram.initials(name).count > 1 ? 0.36 : 0.44), weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.18), radius: 1, y: 1)
            }
            .overlay { shape.strokeBorder(.white.opacity(0.22), lineWidth: 0.5) }
            .frame(width: size, height: size)
            .shadow(color: Theme.company(name).opacity(size > 40 ? 0.35 : 0.15), radius: size > 40 ? 10 : 3, y: size > 40 ? 4 : 1)
            .accessibilityHidden(true)
    }
}

/// An SF Symbol on the brand gradient, for page headers that have no company.
struct IconTile: View {
    let systemImage: String
    var size: CGFloat = 44
    var colors: [Color] = Theme.brandColors

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
        shape
            .fill(LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay {
                Image(systemName: systemImage)
                    .font(.system(size: size * 0.45, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .overlay { shape.strokeBorder(.white.opacity(0.22), lineWidth: 0.5) }
            .frame(width: size, height: size)
            .shadow(color: (colors.first ?? Theme.accent).opacity(0.3), radius: 8, y: 3)
            .accessibilityHidden(true)
    }
}

/// A detail page's title: its tile, the title and a line under it, and what's on the right.
struct PageHeader<Leading: View, Trailing: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder var leading: Leading
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            leading
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(Theme.pageTitle).textSelection(.enabled)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).foregroundStyle(.secondary).textSelection(.enabled)
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
        self.init(title: title, subtitle: subtitle, leading: { IconTile(systemImage: systemImage) }, trailing: { EmptyView() })
    }
}

// MARK: - Empty states

/// Nothing to show: a breathing symbol, what's missing and what to do about it.
struct EmptyState<Actions: View>: View {
    let title: String
    let systemImage: String
    var detail: String?
    @ViewBuilder var actions: Actions

    var body: some View {
        ContentUnavailableView {
            Label { Text(title) } icon: { LiveSymbol(systemImage: systemImage) }
        } description: {
            if let detail { Text(detail) }
        } actions: {
            actions
        }
    }
}

extension EmptyState where Actions == EmptyView {
    init(title: String, systemImage: String, detail: String? = nil) {
        self.init(title: title, systemImage: systemImage, detail: detail, actions: { EmptyView() })
    }
}

/// A large symbol on a soft glow that breathes now and then.
struct LiveSymbol: View {
    let systemImage: String
    private let motion = EndlessMotion()

    var body: some View {
        ZStack {
            Circle()
                .fill(Theme.brand)
                .frame(width: 78, height: 78)
                .opacity(0.16)
                .blur(radius: 14)
            Image(systemName: systemImage)
                .font(.system(size: 40, weight: .regular))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(Theme.brand)
                .symbolEffect(.breathe.pulse.byLayer, options: .repeat(.periodic(delay: 1.5)), isActive: motion.allowed)
        }
        .frame(width: 84, height: 84)
    }
}

// MARK: - The pill picker

/// A segmented control whose pill slides to the picked item: the job's tabs, New's filter, the
/// Overview's window.
struct PillPicker<Value: Hashable>: View {
    let items: [Value]
    let title: (Value) -> String
    @Binding var selection: Value
    /// ⌘1, ⌘2… pick the items (the job's tabs).
    var numberShortcuts = false
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
                        .font(.callout.weight(picked ? .semibold : .medium))
                        .foregroundStyle(picked ? Color.primary : Color.secondary)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 5)
                        .background {
                            if picked {
                                Capsule()
                                    .fill(Theme.cardFill)
                                    .shadow(color: .black.opacity(0.12), radius: 3, y: 1)
                                    .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 0.5))
                                    .matchedGeometryEffect(id: "pill", in: pill)
                            } else if hovered == item {
                                Capsule().fill(Color.primary.opacity(0.05))
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
        .background(Theme.insetFill, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 0.5))
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

/// The one thing to do next: on the brand gradient, lifting under the pointer.
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { Styled(configuration: configuration) }

    private struct Styled: View {
        let configuration: Configuration
        @Environment(\.isEnabled) private var enabled
        @Environment(\.controlSize) private var controlSize
        @State private var hovering = false

        var body: some View {
            let small = controlSize == .small || controlSize == .mini
            let shape = RoundedRectangle(cornerRadius: small ? 6 : 8, style: .continuous)
            configuration.label
                .font((small ? Font.callout : Font.body).weight(.semibold))
                .foregroundStyle(.white.opacity(enabled ? 1 : 0.75))
                .padding(.horizontal, small ? 9 : 14)
                .padding(.vertical, small ? 3 : 6)
                .background {
                    shape.fill(enabled ? AnyShapeStyle(Theme.brandFill) : AnyShapeStyle(Color.secondary.opacity(0.45)))
                        .overlay {
                            // A light edge along the top, like a lit surface.
                            shape.fill(LinearGradient(colors: [.white.opacity(hovering ? 0.22 : 0.14), .clear], startPoint: .top, endPoint: .center))
                        }
                }
                .overlay { shape.strokeBorder(.white.opacity(0.16), lineWidth: 0.5) }
                .shadow(color: Theme.accent.opacity(enabled ? (hovering ? 0.42 : 0.24) : 0), radius: hovering ? 9 : 5, y: 2)
                .scaleEffect(configuration.isPressed ? 0.96 : 1)
                .brightness(configuration.isPressed ? -0.05 : 0)
                .animation(Theme.Motion.snappy, value: configuration.isPressed)
                .animation(Theme.Motion.fade, value: hovering)
                .contentShape(shape)
                .onHover { hovering = $0 && enabled }
        }
    }
}

/// Everything beside it: a quiet fill that firms up under the pointer.
struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { Styled(configuration: configuration) }

    private struct Styled: View {
        let configuration: Configuration
        @Environment(\.isEnabled) private var enabled
        @Environment(\.controlSize) private var controlSize
        @State private var hovering = false

        var body: some View {
            let small = controlSize == .small || controlSize == .mini
            let shape = RoundedRectangle(cornerRadius: small ? 6 : 8, style: .continuous)
            configuration.label
                .font((small ? Font.callout : Font.body).weight(.medium))
                .foregroundStyle(enabled ? Color.primary : Color.secondary)
                .padding(.horizontal, small ? 8 : 12)
                .padding(.vertical, small ? 3 : 6)
                .background {
                    shape.fill(Color.primary.opacity(configuration.isPressed ? 0.13 : hovering ? 0.09 : 0.055))
                }
                .overlay { shape.strokeBorder(Theme.hairline, lineWidth: 0.5) }
                .scaleEffect(configuration.isPressed ? 0.96 : 1)
                .animation(Theme.Motion.snappy, value: configuration.isPressed)
                .animation(Theme.Motion.fade, value: hovering)
                .contentShape(shape)
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
                Capsule().fill(color.opacity(0.14))
                Capsule()
                    .fill(LinearGradient(colors: [color.opacity(0.7), color], startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(shown > 0 ? height : 0, geo.size.width * shown))
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

// MARK: - Messages

extension View {
    /// A message in a conversation: the candidate's on the brand gradient, Applyant's on a card.
    func bubble(mine: Bool) -> some View {
        modifier(Bubble(mine: mine))
    }
}

private struct Bubble: ViewModifier {
    let mine: Bool

    func body(content: Content) -> some View {
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: 16, bottomLeadingRadius: mine ? 16 : 5,
            bottomTrailingRadius: mine ? 5 : 16, topTrailingRadius: 16, style: .continuous
        )
        if mine {
            content
                .foregroundStyle(.white)
                .tint(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.brandFill, in: shape)
                .shadow(color: Theme.accent.opacity(0.25), radius: 8, y: 3)
        } else {
            content
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.cardFill, in: shape)
                .overlay(shape.strokeBorder(Theme.hairline, lineWidth: 0.5))
                .shadow(color: Theme.shadow, radius: 8, y: 2)
        }
    }
}

/// Where a message or an answer is written: a quiet field with a hairline edge.
extension View {
    func composerField() -> some View {
        scrollContentBackground(.hidden)
            .padding(8)
            .background(Theme.cardFill, in: RoundedRectangle(cornerRadius: Theme.innerRadius + 3, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.innerRadius + 3, style: .continuous).strokeBorder(Theme.hairline, lineWidth: 0.5))
            .shadow(color: Theme.shadow, radius: 6, y: 1)
    }
}
