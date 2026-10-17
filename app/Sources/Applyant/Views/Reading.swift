// Text, set the one way: running prose at a reading measure, a lead sentence, one-line meta, the
// inline disclosure, the Callout that states a condition, the EvidenceRow (a claim with its
// evidence in a margin column), the form's LabeledRow, the scrim under a floating button and the
// composer. Built from Theme's text roles (Theme.swift); figures are in Figures.swift.
import ApplyantKit
import SwiftUI

// MARK: - Prose

/// Running text: paragraphs at the reading measure with air between them, selectable. With
/// `collapsedLines` a long text shows its first lines and Show More.
struct Prose: View {
    enum Size {
        case regular, compact

        var font: Font { self == .regular ? .system(size: 14) : .system(size: 13) }
        var lineSpacing: CGFloat { self == .regular ? 5 : 3 }
        var gap: CGFloat { self == .regular ? Theme.paragraphSpacing : 8 }
    }

    private let paragraphs: [AttributedString]
    private let size: Size
    private let collapsedLines: Int?
    @State private var expanded = false

    init(_ text: String, size: Size = .regular, collapsedLines: Int? = nil) {
        self.init(paragraphs: Prose.paragraphs(text), size: size, collapsedLines: collapsedLines)
    }

    init(paragraphs: [String], size: Size = .regular, collapsedLines: Int? = nil) {
        self.paragraphs = paragraphs
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map { AttributedString($0) }
        self.size = size
        self.collapsedLines = collapsedLines
    }

    /// Paragraphs pre-joined with "\n\n" (links and emphasis kept).
    init(_ text: AttributedString, size: Size = .regular) {
        paragraphs = Prose.paragraphs(text)
        self.size = size
        collapsedLines = nil
    }

    var body: some View {
        let folds = foldsAway
        VStack(alignment: .leading, spacing: size.gap) {
            if folds && !expanded, let first = paragraphs.first, let lines = collapsedLines {
                Text(first).lineLimit(lines)
            } else {
                ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, paragraph in
                    Text(paragraph)
                }
            }
            if folds {
                DisclosureLine(expanded ? "Show Less" : "Show More", isExpanded: $expanded)
                    .padding(.top, -size.gap / 2)
            }
        }
        .font(size.font)
        .foregroundStyle(Theme.text)
        .lineSpacing(size.lineSpacing)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
        .frame(maxWidth: Theme.measure, alignment: .leading)
    }

    /// More than one paragraph, or more than the collapsed lines hold (about 80 characters each).
    private var foldsAway: Bool {
        guard let lines = collapsedLines, let first = paragraphs.first else { return false }
        return paragraphs.count > 1 || first.characters.count > lines * 80
    }

    /// Paragraphs are split on blank lines.
    static func paragraphs(_ text: String) -> [String] {
        text.replacingOccurrences(of: "\r\n", with: "\n")
            .components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    static func paragraphs(_ text: AttributedString) -> [AttributedString] {
        let chars = text.characters
        var result: [AttributedString] = []
        var start = chars.startIndex
        var i = chars.startIndex
        while i < chars.endIndex {
            let next = chars.index(after: i)
            if chars[i] == "\n", next < chars.endIndex, chars[next] == "\n" {
                result.append(AttributedString(text[start..<i]))
                var end = next
                while end < chars.endIndex, chars[end] == "\n" { end = chars.index(after: end) }
                start = end
                i = end
            } else {
                i = next
            }
        }
        if start < chars.endIndex { result.append(AttributedString(text[start..<chars.endIndex])) }
        return result.filter { !String($0.characters).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }
}

// MARK: - Lead

/// A page's one-sentence take, beside a thin accent rule (no glow). A longer take keeps its
/// first sentence as the lead and folds the rest into two lines of prose under it.
struct Lead: View {
    private let lead: String
    private let rest: String?

    init(_ text: String) {
        (lead, rest) = Lead.split(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Text(lead)
                .textRole(.lead)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .padding(.leading, 15)
                .background(alignment: .leading) {
                    Capsule().fill(Theme.accentFill).frame(width: 3)
                }
            if let rest {
                Prose(rest, collapsedLines: 2).padding(.leading, 15)
            }
        }
        .frame(maxWidth: Theme.leadMeasure + 15, alignment: .leading)
    }

    /// Over 140 characters: the first sentence, and the rest.
    static func split(_ text: String) -> (String, String?) {
        guard text.count > 140,
              let end = text.range(of: #"[.!?]["”’)]?\s+(?=[A-ZА-ЯІЇЄҐ0-9])"#, options: .regularExpression)
        else { return (text, nil) }
        let first = text[..<end.upperBound].trimmingCharacters(in: .whitespaces)
        let rest = text[end.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        return rest.isEmpty ? (text, nil) : (first, rest)
    }
}

// MARK: - Meta

/// One line of meta: a reason, a date, a source. The whole text is under the pointer when it
/// doesn't fit; `tone` colours the symbol, never the words.
struct MetaLine: View {
    private let text: String
    private let systemImage: String?
    private let tone: Chip.Tone?

    init(_ text: String, systemImage: String? = nil, tone: Chip.Tone? = nil) {
        self.text = text
        self.systemImage = systemImage
        self.tone = tone
    }

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(tone.map(Theme.tint) ?? Theme.secondaryText)
                    .accessibilityHidden(true)
            }
            Text(text).lineLimit(1).truncationMode(.tail)
        }
        .textRole(.meta)
        .help(text)
    }
}

// MARK: - Disclosure

/// The one inline disclosure ("Show More ›", "4 facts ›"): accent words with a chevron that
/// turns down as it opens. At least 22 points tall to hit.
struct DisclosureLine: View {
    private let title: String
    @Binding private var isExpanded: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(_ title: String, isExpanded: Binding<Bool>) {
        self.title = title
        _isExpanded = isExpanded
    }

    var body: some View {
        Button {
            withAnimation(Theme.Motion.pick(Theme.Motion.disclose, reduceMotion: reduceMotion)) { isExpanded.toggle() }
        } label: {
            HStack(spacing: 4) {
                Text(title).lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Theme.accent)
            .padding(.vertical, 4)
            .frame(minHeight: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
    }
}

// MARK: - Callout

/// The one way to state a condition (a blocker's why, a red flag, a signed-out mailbox): a quiet
/// inset block with a 3 pt rule and a symbol in the kind's colour. The words stay plain text,
/// never amber; the fix sits on the right.
struct Callout<Actions: View>: View {
    enum Kind {
        case warning, good, info, bad

        var color: Color {
            switch self {
            case .warning: Theme.warning
            case .good: Theme.good
            case .info: Theme.accent
            case .bad: Theme.bad
            }
        }

        var symbol: String {
            switch self {
            case .warning: "exclamationmark.triangle.fill"
            case .good: "checkmark.circle.fill"
            case .info: "info.circle.fill"
            case .bad: "xmark.octagon.fill"
            }
        }
    }

    private let kind: Kind
    private let title: String
    private let detail: String?
    private let systemImage: String?
    private let actions: Actions

    init(_ kind: Kind, title: String, detail: String? = nil, systemImage: String? = nil, @ViewBuilder actions: () -> Actions) {
        self.kind = kind
        self.title = title
        self.detail = detail
        self.systemImage = systemImage
        self.actions = actions()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: systemImage ?? kind.symbol)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(kind.color)
                .frame(width: 18)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .textRole(.itemTitle)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(Prose.Size.compact.font)
                        .lineSpacing(Prose.Size.compact.lineSpacing)
                        .foregroundStyle(Theme.text)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .help(detail)
                }
            }
            .frame(maxWidth: Theme.measure, alignment: .leading)
            Spacer(minLength: Theme.Space.s)
            if Actions.self != EmptyView.self {
                HStack(spacing: Theme.Space.s) { actions }
                    .buttonStyle(.secondary)
                    .controlSize(.small)
                    .fixedSize()
            }
        }
        .padding(.vertical, 10)
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .insetSurface(radius: Theme.innerRadius)
        .overlay(alignment: .leading) {
            Capsule().fill(kind.color).frame(width: 3).padding(.vertical, 8).padding(.leading, 5)
        }
        .accessibilityElement(children: .contain)
    }
}

extension Callout where Actions == EmptyView {
    init(_ kind: Kind, title: String, detail: String? = nil, systemImage: String? = nil) {
        self.init(kind, title: title, detail: detail, systemImage: systemImage, actions: { EmptyView() })
    }
}

// MARK: - Evidence

/// The signature row: a machine-written claim at reading measure, with its evidence in a margin
/// column on the right ("4 facts ›", "Sep 2021"), so the evidence lands at one x on every line.
/// Opened, the evidence sits under the claim behind a hairline rule. Narrow, the margin drops
/// under the reason.
struct EvidenceRow<Mark: View, Detail: View>: View {
    private let claim: String
    private let eyebrow: String?
    private let reason: String?
    private let margin: String?
    private let isExpanded: Binding<Bool>?
    private let mark: Mark
    private let detail: Detail
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(_ claim: String, eyebrow: String? = nil, reason: String? = nil, margin: String? = nil,
         isExpanded: Binding<Bool>? = nil, @ViewBuilder mark: () -> Mark, @ViewBuilder detail: () -> Detail) {
        self.claim = claim
        self.eyebrow = eyebrow
        self.reason = reason
        self.margin = margin
        self.isExpanded = isExpanded
        self.mark = mark()
        self.detail = detail()
    }

    private var hasMark: Bool { Mark.self != EmptyView.self }
    /// Where the claim's words start: after the 18 pt mark and its gap.
    private var textInset: CGFloat { hasMark ? 28 : 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if margin != nil || isExpanded != nil {
                MarginLayout(fixed: .trailing(Theme.marginColumn), stackIndent: textInset) {
                    main
                    marginView
                }
            } else {
                main
            }
            if isExpanded?.wrappedValue == true, Detail.self != EmptyView.self {
                detail
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) { Rectangle().fill(Theme.hairline).frame(width: 2) }
                    .padding(.leading, textInset)
                    .padding(.top, 2)
                    .transition(.reveal(reduceMotion: reduceMotion))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var main: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            if hasMark { mark.frame(width: 18) }
            VStack(alignment: .leading, spacing: 2) {
                if let eyebrow, !eyebrow.isEmpty {
                    Text(eyebrow.uppercased()).textRole(.eyebrow).lineLimit(1)
                }
                Text(claim)
                    .textRole(.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    // The margin lines up with the claim, not the eyebrow over it.
                    .alignmentGuide(.rowBaseline) { $0[.firstTextBaseline] }
                if let reason, !reason.isEmpty {
                    Text(reason)
                        .textRole(.meta)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .help(reason)
                }
            }
            .frame(maxWidth: Theme.measure, alignment: .leading)
        }
    }

    @ViewBuilder private var marginView: some View {
        if let isExpanded {
            DisclosureLine(margin ?? "Evidence", isExpanded: isExpanded)
        } else if let margin {
            Text(margin).textRole(.meta).monospacedDigit().lineLimit(1).help(margin)
        }
    }
}

extension EvidenceRow where Detail == EmptyView {
    init(_ claim: String, eyebrow: String? = nil, reason: String? = nil, margin: String? = nil, @ViewBuilder mark: () -> Mark) {
        self.init(claim, eyebrow: eyebrow, reason: reason, margin: margin, isExpanded: nil, mark: mark, detail: { EmptyView() })
    }
}

extension EvidenceRow where Mark == EmptyView {
    init(_ claim: String, eyebrow: String? = nil, reason: String? = nil, margin: String? = nil,
         isExpanded: Binding<Bool>? = nil, @ViewBuilder detail: () -> Detail) {
        self.init(claim, eyebrow: eyebrow, reason: reason, margin: margin, isExpanded: isExpanded, mark: { EmptyView() }, detail: detail)
    }
}

extension EvidenceRow where Mark == EmptyView, Detail == EmptyView {
    init(_ claim: String, eyebrow: String? = nil, reason: String? = nil, margin: String? = nil) {
        self.init(claim, eyebrow: eyebrow, reason: reason, margin: margin, isExpanded: nil, mark: { EmptyView() }, detail: { EmptyView() })
    }
}

extension VerticalAlignment {
    private enum RowBaseline: AlignmentID {
        static func defaultValue(in d: ViewDimensions) -> CGFloat { d[.firstTextBaseline] }
    }

    /// The line a MarginLayout lines its two sides up on: the first baseline, unless a view
    /// names another (EvidenceRow's claim under its eyebrow).
    fileprivate static let rowBaseline = VerticalAlignment(RowBaseline.self)
}

/// Two views side by side, one of them in a fixed column (EvidenceRow's margin on the right,
/// LabeledRow's labels on the left), their first lines on one baseline. Under 460 points they
/// stack, the second under the first.
private struct MarginLayout: Layout {
    enum Fixed {
        case leading(CGFloat), trailing(CGFloat)
    }

    var fixed: Fixed
    var spacing: CGFloat = 12
    var stackSpacing: CGFloat = 4
    /// Where the second view starts when stacked (under the claim's words, past its mark).
    var stackIndent: CGFloat = 0
    static let wideWidth: CGFloat = 460

    private func wide(_ width: CGFloat?) -> Bool { (width ?? .infinity) >= Self.wideWidth }

    /// The two proposals when side by side.
    private func proposals(_ width: CGFloat?) -> (ProposedViewSize, ProposedViewSize) {
        switch fixed {
        case let .trailing(column):
            (ProposedViewSize(width: width.map { max($0 - column - spacing, 0) }, height: nil), ProposedViewSize(width: column, height: nil))
        case let .leading(column):
            (ProposedViewSize(width: column, height: nil), ProposedViewSize(width: width.map { max($0 - column - spacing, 0) }, height: nil))
        }
    }

    /// Tops that put both first baselines on one line.
    private func tops(_ first: ViewDimensions, _ second: ViewDimensions) -> (CGFloat, CGFloat) {
        let delta = first[.rowBaseline] - second[.rowBaseline]
        return delta >= 0 ? (0, delta) : (-delta, 0)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard subviews.count == 2 else { return subviews.first?.sizeThatFits(proposal) ?? .zero }
        if wide(proposal.width) {
            let (p1, p2) = proposals(proposal.width)
            let d1 = subviews[0].dimensions(in: p1), d2 = subviews[1].dimensions(in: p2)
            let (t1, t2) = tops(d1, d2)
            let width = proposal.width ?? {
                switch fixed {
                case let .trailing(column): d1.width + spacing + column
                case let .leading(column): column + spacing + d2.width
                }
            }()
            return CGSize(width: width, height: max(t1 + d1.height, t2 + d2.height))
        }
        let s1 = subviews[0].sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
        let s2 = subviews[1].sizeThatFits(ProposedViewSize(width: proposal.width.map { max($0 - stackIndent, 0) }, height: nil))
        return CGSize(width: proposal.width ?? max(s1.width, stackIndent + s2.width), height: s1.height + stackSpacing + s2.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 2 else {
            subviews.first?.place(at: bounds.origin, proposal: proposal)
            return
        }
        if wide(bounds.width) {
            let (p1, p2) = proposals(bounds.width)
            let d1 = subviews[0].dimensions(in: p1), d2 = subviews[1].dimensions(in: p2)
            let (t1, t2) = tops(d1, d2)
            subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.minY + t1), proposal: p1)
            switch fixed {
            case .trailing:
                // The margin's text ends at the card's edge.
                subviews[1].place(at: CGPoint(x: bounds.maxX - d2.width, y: bounds.minY + t2), proposal: p2)
            case let .leading(column):
                subviews[1].place(at: CGPoint(x: bounds.minX + column + spacing, y: bounds.minY + t2), proposal: p2)
            }
            return
        }
        let p1 = ProposedViewSize(width: bounds.width, height: nil)
        let p2 = ProposedViewSize(width: max(bounds.width - stackIndent, 0), height: nil)
        let h1 = subviews[0].sizeThatFits(p1).height
        subviews[0].place(at: bounds.origin, proposal: p1)
        subviews[1].place(at: CGPoint(x: bounds.minX + stackIndent, y: bounds.minY + h1 + stackSpacing), proposal: p2)
    }
}

// MARK: - Form rows

/// A form's row: its label (a note under it, a status dot before it) in a 200 pt column, the
/// control after it at its own size. Under 460 points the label stacks over the control.
/// Controls size to their content: a picker `.fixedSize()`, a text field `maxWidth: 320`.
struct LabeledRow<Control: View>: View {
    private let label: String
    private let note: String?
    private let status: Chip.Tone?
    private let control: Control

    init(_ label: String, note: String? = nil, status: Chip.Tone? = nil, @ViewBuilder control: () -> Control) {
        self.label = label
        self.note = note
        self.status = status
        self.control = control()
    }

    /// A label this long is a form's question: it is read in full above its control instead of
    /// being cut down to the label column.
    private var asksAQuestion: Bool { label.count > 56 }

    var body: some View {
        Group {
            if asksAQuestion {
                VStack(alignment: .leading, spacing: 8) {
                    words(lines: nil)
                    control.frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                MarginLayout(fixed: .leading(Theme.labelColumn), spacing: Theme.Space.l, stackSpacing: 6) {
                    words(lines: 3)
                    control
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }

    private func words(lines: Int?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            // The dot after the words, so every label starts at one x.
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(label).textRole(.itemTitle).lineLimit(lines).fixedSize(horizontal: false, vertical: true)
                if let status {
                    Circle().fill(Theme.tint(status)).frame(width: 6, height: 6).accessibilityHidden(true)
                }
            }
            .help(label)
            if let note, !note.isEmpty {
                Text(note).textRole(.meta).lineLimit(lines.map { $0 + 1 }).fixedSize(horizontal: false, vertical: true).help(note)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Scrim

/// A fade into the window's deepest navy at a scrolling page's edge, so text never runs under a
/// floating button. Opaque with Reduce Transparency.
struct EdgeScrim: View {
    private let edge: VerticalEdge
    private let height: CGFloat
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    init(edge: VerticalEdge, height: CGFloat = 120) {
        self.edge = edge
        self.height = height
    }

    var body: some View {
        Group {
            if reduceTransparency {
                Theme.deepest
            } else {
                LinearGradient(
                    colors: [Theme.deepest.opacity(0), Theme.deepest.opacity(0.85)],
                    startPoint: edge == .bottom ? .top : .bottom,
                    endPoint: edge == .bottom ? .bottom : .top
                )
            }
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Composer

/// Where a message or an answer is written (Questions, Chat): the field with its placeholder,
/// what goes with it on the left, Send on the right (⌘↩).
struct Composer<Accessory: View>: View {
    @Binding private var text: String
    private let placeholder: String
    private let sendTitle: String
    private let canSend: Bool
    private let sending: Bool
    private let accessory: Accessory
    private let send: () -> Void

    init(text: Binding<String>, placeholder: String, sendTitle: String = "Send", canSend: Bool, sending: Bool = false,
         @ViewBuilder accessory: () -> Accessory, send: @escaping () -> Void) {
        _text = text
        self.placeholder = placeholder
        self.sendTitle = sendTitle
        self.canSend = canSend
        self.sending = sending
        self.accessory = accessory()
        self.send = send
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            TextEditor(text: $text)
                .font(.system(size: 14))
                .lineSpacing(3)
                .frame(minHeight: 44, maxHeight: 160)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text(placeholder)
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.secondaryText)
                            .padding(.leading, 5)
                            .padding(.top, 1)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .composerField()
                .accessibilityLabel(placeholder)
            HStack(spacing: Theme.Space.s) {
                accessory
                Spacer(minLength: 0)
                if sending { ProgressView().controlSize(.small) }
                Button(action: send) { Label(sendTitle, systemImage: "arrow.up") }
                    .buttonStyle(.primary)
                    .keyboardShortcut(.return, modifiers: .command)
                    .help("\(sendTitle) (⌘↩)")
                    .disabled(!canSend || sending)
            }
        }
    }
}

extension Composer where Accessory == EmptyView {
    init(text: Binding<String>, placeholder: String, sendTitle: String = "Send", canSend: Bool, sending: Bool = false, send: @escaping () -> Void) {
        self.init(text: text, placeholder: placeholder, sendTitle: sendTitle, canSend: canSend, sending: sending, accessory: { EmptyView() }, send: send)
    }
}

// MARK: - The system, on one page

/// Every text role and the shared text and figure pieces on the navy world: check it with
/// Increase Contrast and Reduce Transparency on (System Settings → Accessibility → Display).
struct SystemGallery: View {
    @State private var factsOpen = true
    @State private var sourcesOpen = false
    @State private var draft = ""

    private struct Metric: Identifiable {
        let id: String
        let lines: [String]
    }

    private let description = """
    We're a small team building payments infrastructure for marketplaces. You'll own the services that move money between buyers, sellers and banks, from design to on-call.

    You'll work closely with product and the founders, write most of the backend in TypeScript and Go, and help us choose what to build next. We value clear writing and small, frequent releases.

    Remote within Europe, with a week together every quarter.
    """

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Space.xl) {
                section("Text roles") {
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        ForEach(Theme.TextRole.allCases, id: \.self) { role in
                            Text(role == .eyebrow ? "EYEBROW · GROUP HEADER" : "\(role): The quick brown fox, 1,229 found")
                                .textRole(role)
                        }
                    }
                }
                section("Lead and prose") {
                    VStack(alignment: .leading, spacing: Theme.Space.l) {
                        Lead("A strong match on backend ownership and payments; two requirements need evidence only you can give. The posting asks for Lambda and EC2 in production, which none of your facts shows yet.")
                        Prose(description, collapsedLines: 3)
                        Prose(description)
                        Prose(description, size: .compact)
                        MetaLine("Found 4 days ago on Greenhouse · posted Sep 2021 · a very long source line that is cut", systemImage: "clock", tone: .accent)
                    }
                }
                section("Callouts") {
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        Callout(.warning, title: "Gmail signed Applyant out", detail: "Replies aren't being read. Reconnect to keep Applied, Interviews and Offers up to date.") {
                            Button("Reconnect…") {}.buttonStyle(.primary)
                        }
                        Callout(.bad, title: "2 red flags", detail: "Glassdoor reviews mention late salaries in 2024; the company's last funding round was 2019.")
                        Callout(.good, title: "Every requirement has evidence")
                        Callout(.info, title: "Your CV changed since this application was prepared", detail: "Prepare it again to use the new version.") {
                            Button("Prepare Again") {}
                        }
                    }
                }
                section("Evidence rows: wide, then narrow") {
                    VStack(alignment: .leading, spacing: Theme.Space.l) {
                        evidence
                        evidence.frame(width: 420)
                    }
                    .padding(Theme.cardPadding)
                    .glass()
                }
                section("Labeled rows") {
                    VStack(alignment: .leading, spacing: Theme.rowSpacing) {
                        LabeledRow("Notice period", note: "Asked by 3 forms", status: .warning) {
                            TextField("e.g. 1 month", text: $draft).textFieldStyle(.roundedBorder).frame(maxWidth: 320)
                        }
                        LabeledRow("Work authorisation") {
                            Picker("", selection: .constant(0)) { Text("EU citizen").tag(0) }.labelsHidden().fixedSize()
                        }
                    }
                    .padding(Theme.cardPadding)
                    .glass()
                }
                section("Funnel: large, small, opening") {
                    VStack(alignment: .leading, spacing: Theme.Space.l) {
                        FunnelStrip(funnel)
                            .padding(Theme.cardPadding).glass()
                        FunnelStrip(funnel, size: .small, open: { _ in })
                            .padding(Theme.cardPadding).glass()
                        FunnelStrip(funnel).frame(width: 360)
                            .padding(Theme.cardPadding).glass()
                    }
                }
                section("Stat strip") {
                    VStack(alignment: .leading, spacing: Theme.Space.l) {
                        StatStrip([
                            .init(label: "Employment", value: "Full-time"),
                            .init(label: "Seniority", value: "Senior"),
                            .init(label: "Language", value: "English, German nice to have"),
                        ])
                        StatStrip([
                            .init(label: "Salary", value: "€90k–110k"), .init(label: "Remote", value: "Europe"),
                            .init(label: "Team", value: "12"), .init(label: "Founded", value: "2019"),
                            .init(label: "Stage", value: "Series A"), .init(label: "Visa", value: "No"),
                        ], maxColumns: 4)
                    }
                }
                section("Equal-height grid, in an anchored panel") {
                    AnchoredPanel(anchorX: 120) {
                        EqualHeightGrid(metrics, columns: 3) { metric in
                            VStack(alignment: .leading, spacing: 4) {
                                ForEach(Array(metric.lines.enumerated()), id: \.offset) { index, line in
                                    Text(line)
                                        .textRole(index == 0 ? .itemTitle : index == 1 ? .body : .meta)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                    }
                }
                section("Composer") {
                    Composer(text: $draft, placeholder: "Your answer, in your own words", canSend: !draft.isEmpty) {
                        Button("Later") {}.buttonStyle(.secondary)
                    } send: {}
                }
            }
            .pageColumn()
        }
        .background {
            ZStack {
                Theme.base
                RadialGradient(colors: [Theme.cobalt.opacity(0.7), .clear], center: .topTrailing, startRadius: 20, endRadius: 700)
            }
            .ignoresSafeArea()
        }
        .environment(\.colorScheme, .dark)
        .themeForeground()
    }

    private var evidence: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            EvidenceRow("Lambda and EC2 in production", reason: "No Lambda or EC2 use shown in your facts", margin: "2 facts", isExpanded: $factsOpen) {
                VerdictMark(verdict: "missing")
            } detail: {
                Prose(paragraphs: ["Ran the payments API on ECS (2021–2023).", "Built a Kubernetes cluster for batch jobs."], size: .compact)
            }
            EvidenceRow("Proactive stakeholder updates", eyebrow: "Communication", margin: "4 facts", isExpanded: $sourcesOpen) {
                VerdictMark(verdict: "partial")
            } detail: {
                Text("Weekly written updates to the founders").textRole(.body)
            }
            EvidenceRow("Raised a Series A from Northzone", reason: "Two sources agree", margin: "Sep 2021")
        }
    }

    private var funnel: [FunnelStrip.Step] {
        [
            .init(id: "found", count: 1229, label: "found"),
            .init(id: "applied", count: 4, label: "applied", conversion: "0.3%"),
            .init(id: "interviews", count: 0, label: "interviews", conversion: "0%"),
            .init(id: "offers", count: 0, label: "offers"),
        ]
    }

    private var metrics: [Metric] {
        [
            Metric(id: "a", lines: ["Live postings", "96%", "113 of 118", "Goal ≥ 95%"]),
            Metric(id: "b", lines: ["Relevance", "36%", "5 of 14, and a longer detail that wraps onto a second line", "Goal ≥ 50%"]),
            Metric(id: "c", lines: ["Review time", "1d 17h", "Goal ≤ 15 min"]),
            Metric(id: "d", lines: ["Invented claims", "0", "of 26 sentences · 8 corrected", "Watched"]),
            Metric(id: "e", lines: ["Answers kept", "88%"]),
        ]
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Eyebrow(text: title)
            content()
        }
    }
}

#Preview("System") {
    SystemGallery().frame(width: 900, height: 1200)
}
