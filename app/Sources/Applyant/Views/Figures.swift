// Numbers and metrics, drawn the one way: a figure over its label, the funnel as one mark at two
// sizes (the conversion written on its arrows), a strip of facts, a grid of equal-height cards,
// and the panel that hangs from the control that opened it.
import AppKit
import ApplyantKit
import SwiftUI

// MARK: - The figure's middle

extension VerticalAlignment {
    private enum FigureMid: AlignmentID {
        static func defaultValue(in d: ViewDimensions) -> CGFloat { d[VerticalAlignment.center] }
    }

    /// The middle of a figure's capitals (`firstTextBaseline − capHeight / 2`): chevrons and
    /// connectors centre on it, so they line up with the digits rather than the figure and its
    /// label together.
    static let figureMid = VerticalAlignment(FigureMid.self)
}

extension View {
    /// Puts `.figureMid` at the middle of this view's first line of figures.
    func figureMid(_ size: Theme.FigureSize) -> some View {
        alignmentGuide(.figureMid) { $0[.firstTextBaseline] - size.capHeight / 2 }
    }
}

// MARK: - A figure over its label

/// A figure (counting up as it appears) over a one-line 13 pt label: every Home tile's, every
/// funnel step's.
struct FigureStack: View {
    private let value: Int64
    private let label: String
    private let size: Theme.FigureSize
    private let counts: Bool

    init(value: Int64, label: String, size: Theme.FigureSize = .large, counts: Bool = true) {
        self.value = value
        self.label = label
        self.size = size
        self.counts = counts
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Group {
                if counts { CountingNumber(value: Int(value)) } else { Text(value.formatted()) }
            }
            .font(size.font)
            .foregroundStyle(Theme.text)
            .lineLimit(1)
            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(Theme.secondaryText)
                .lineLimit(1)
        }
        .fixedSize()
        .figureMid(size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(value.formatted()) \(label)")
    }
}

// MARK: - The funnel

/// found › applied › interviews › offers: equal columns, a chevron on the digits' middle before
/// every step after the first, the conversion written over it ("88%"), every number 8 points
/// after its chevron. The large size steps down to the small one where it doesn't fit; numbers
/// are never squeezed.
struct FunnelStrip: View {
    struct Step: Identifiable, Hashable {
        let id: String
        let count: Int64
        let label: String
        /// "88%": this step's share of the one before it.
        var conversion: String?

        init(id: String, count: Int64, label: String, conversion: String? = nil) {
            self.id = id
            self.count = count
            self.label = label
            self.conversion = conversion
        }
    }

    private let steps: [Step]
    private let size: Theme.FigureSize
    private let open: ((Step) -> Void)?

    init(_ steps: [Step], size: Theme.FigureSize = .large, open: ((Step) -> Void)? = nil) {
        self.steps = steps
        self.size = size
        self.open = open
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            strip(size)
            if size == .large { strip(.small) }
        }
    }

    private func strip(_ size: Theme.FigureSize) -> some View {
        HStack(alignment: .figureMid, spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                HStack(alignment: .figureMid, spacing: 8) {
                    if index > 0 { connector(step.conversion) }
                    figure(step, size)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// 28 points for a bare chevron, 44 with the conversion over it.
    private func connector(_ conversion: String?) -> some View {
        VStack(spacing: 1) {
            if let conversion {
                Text(conversion)
                    .font(.system(size: 11, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.secondaryText)
                    .lineLimit(1)
                    .fixedSize()
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.glyph)
                .alignmentGuide(.figureMid) { $0[VerticalAlignment.center] }
        }
        .frame(width: conversion == nil ? 28 : 44)
        .accessibilityHidden(true)
    }

    @ViewBuilder private func figure(_ step: Step, _ size: Theme.FigureSize) -> some View {
        let stack = FigureStack(value: step.count, label: step.label, size: size)
            .accessibilityValue(step.conversion.map { "\($0) of the step before" } ?? "")
        if let open {
            Button { open(step) } label: { stack }
                .buttonStyle(StepStyle())
                .help("Open \(step.label)")
                .figureMid(size)
        } else {
            stack
        }
    }

    /// A step that opens its list: a soft fill under the pointer, around the figure without
    /// moving it.
    private struct StepStyle: ButtonStyle {
        func makeBody(configuration: Configuration) -> some View { Styled(configuration: configuration) }

        private struct Styled: View {
            let configuration: Configuration
            @State private var hovering = false

            var body: some View {
                let shape = RoundedRectangle(cornerRadius: Theme.innerRadius, style: .continuous)
                configuration.label
                    .padding(6)
                    .background(shape.fill(configuration.isPressed ? Theme.glassFillHover : hovering ? Theme.glassFill : .clear))
                    .contentShape(shape)
                    .padding(-6)
                    .onHover { hovering = $0 }
                    .animation(Theme.Motion.fade, value: hovering)
            }
        }
    }
}

// MARK: - A strip of facts

/// Facts side by side in one glass (employment, seniority, language): equal columns of equal
/// height, a hairline between them, a spaced-capitals label over a one-line value. More items
/// than `maxColumns`, or under 120 points a column, and it wraps into rows.
struct StatStrip: View {
    struct Item: Identifiable, Hashable {
        let id: String
        let label: String
        let value: String
        var help: String?

        init(id: String? = nil, label: String, value: String, help: String? = nil) {
            self.id = id ?? label
            self.label = label
            self.value = value
            self.help = help
        }
    }

    private let items: [Item]
    private let maxColumns: Int
    @State private var width: CGFloat = .infinity

    init(_ items: [Item], maxColumns: Int = 5) {
        self.items = items
        self.maxColumns = max(maxColumns, 1)
    }

    private var columns: Int {
        let fit = width.isFinite ? max(Int(width / 120), 1) : maxColumns
        return max(min(items.count, maxColumns, fit), 1)
    }

    var body: some View {
        let columns = columns
        let rows = stride(from: 0, to: items.count, by: columns).map { Array(items[$0..<min($0 + columns, items.count)]) }
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                if index > 0 { Rectangle().fill(Theme.hairline).frame(height: 1) }
                HStack(spacing: 0) {
                    ForEach(Array(row.enumerated()), id: \.element.id) { column, item in
                        if column > 0 { Rectangle().fill(Theme.hairline).frame(width: 1) }
                        cell(item)
                    }
                    // A short last row keeps the columns' widths.
                    ForEach(0..<(columns - row.count), id: \.self) { _ in
                        Color.clear.frame(maxWidth: .infinity).padding(.leading, 1)
                    }
                }
                // Every cell in the row as tall as the tallest.
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .glass()
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    private func cell(_ item: Item) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.label.uppercased()).textRole(.eyebrow).lineLimit(1)
            Text(item.value).textRole(.heading).lineLimit(1)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .help(item.help ?? item.value)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(item.label)
        .accessibilityValue(item.value)
    }
}

// MARK: - Equal-height cards

/// Cards in rows of `columns`, every card in a row as tall as the tallest (the glass is drawn
/// after the stretch, so the edges line up); a short last row keeps the columns' widths.
struct EqualHeightGrid<Item: Identifiable, Cell: View>: View {
    private let items: [Item]
    private let columns: Int
    private let spacing: CGFloat
    private let surface: Bool
    private let cell: (Item) -> Cell

    init(_ items: [Item], columns: Int, spacing: CGFloat = Theme.blockSpacing, surface: Bool = true,
         @ViewBuilder cell: @escaping (Item) -> Cell) {
        self.items = items
        self.columns = max(columns, 1)
        self.spacing = spacing
        self.surface = surface
        self.cell = cell
    }

    var body: some View {
        Grid(alignment: .topLeading, horizontalSpacing: spacing, verticalSpacing: spacing) {
            ForEach(Array(stride(from: 0, to: items.count, by: columns)), id: \.self) { start in
                let row = items[start..<min(start + columns, items.count)]
                GridRow {
                    ForEach(row) { item in
                        stretched(item)
                    }
                    ForEach(0..<(columns - row.count), id: \.self) { _ in
                        Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                    }
                }
            }
        }
    }

    @ViewBuilder private func stretched(_ item: Item) -> some View {
        let content = cell(item).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        if surface {
            content.padding(Theme.cardPadding).glass()
        } else {
            content
        }
    }
}

// MARK: - The panel hanging from its control

/// A rounded rectangle with a small notch on its top edge, pointing up at what opened it: one
/// continuous outline (the notch is part of the edge, not a triangle laid on it). The notch
/// stands in the top `notchSize.height` of the frame.
struct NotchedRoundedRectangle: InsettableShape {
    var radius: CGFloat = Theme.panelRadius
    var notchX: CGFloat
    var notchSize = CGSize(width: 18, height: 9)
    private var inset: CGFloat = 0

    init(radius: CGFloat = Theme.panelRadius, notchX: CGFloat, notchSize: CGSize = CGSize(width: 18, height: 9)) {
        self.radius = radius
        self.notchX = notchX
        self.notchSize = notchSize
    }

    func path(in rect: CGRect) -> Path {
        let frame = rect.insetBy(dx: inset, dy: inset)
        var body = frame
        body.origin.y += notchSize.height
        body.size.height = max(body.height - notchSize.height, 0)
        let corner = max(radius - inset, 0)
        let rounded = Path(roundedRect: body, cornerRadius: corner, style: .continuous)
        guard body.width > 2 * corner + notchSize.width else { return rounded }
        // Kept clear of the corners.
        let x = min(max(rect.minX + notchX, body.minX + corner + notchSize.width / 2), body.maxX - corner - notchSize.width / 2)
        var notch = Path()
        notch.move(to: CGPoint(x: x - notchSize.width / 2, y: body.minY + 1))
        notch.addLine(to: CGPoint(x: x, y: frame.minY))
        notch.addLine(to: CGPoint(x: x + notchSize.width / 2, y: body.minY + 1))
        notch.closeSubpath()
        return rounded.union(notch)
    }

    func inset(by amount: CGFloat) -> NotchedRoundedRectangle {
        var shape = self
        shape.inset += amount
        return shape
    }
}

/// What a tile opens, directly under it (Home's metrics): glass with its top light, one lit
/// edge, and a notch pointing at the tile's chevron at `anchorX` (in the panel's own width).
struct AnchoredPanel<Content: View>: View {
    private let anchorX: CGFloat
    private let content: Content

    init(anchorX: CGFloat, @ViewBuilder content: () -> Content) {
        self.anchorX = anchorX
        self.content = content()
    }

    var body: some View {
        let shape = NotchedRoundedRectangle(notchX: anchorX)
        content
            .padding(Theme.cardPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, shape.notchSize.height)
            .background {
                shape.fill(Theme.glassFill)
                    .overlay {
                        shape.fill(LinearGradient(colors: [.white.opacity(0.035), .clear], startPoint: .top, endPoint: .init(x: 0.5, y: 0.35)))
                    }
            }
            .overlay { shape.strokeBorder(Theme.glassEdge, lineWidth: 1) }
            .themeForeground()
    }
}
