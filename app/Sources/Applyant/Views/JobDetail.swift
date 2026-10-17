// One job, whichever list it was picked from: a hero tile with what it is and the one next step
// (lit like CleanMyMac's working tile, in the list's world and the company's colour), then tabs:
// the posting itself (what it asks for, how you match, its text), its application once there
// is one, and its company. When Approve and send is the step, it's the big round Send button at
// the foot of the page. The page's glass tiles come in one after another.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct JobDetail: View {
    let store: AppStore
    let postingId: Int64
    /// The application picked with it (an application list), else the posting's own.
    let applicationId: Int64?
    /// The tab picked last stays picked from job to job.
    @AppStorage("jobDetailTab") private var pickedTab: DetailTab = .job
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let posting = store.postingDetails[postingId] ?? store.postings[postingId]
        let appId = applicationId ?? posting.flatMap { $0.hasApplicationID ? $0.applicationID : nil }
        let app = appId.flatMap { store.applicationDetails[$0] ?? store.applications[$0] }
        let tabs = DetailTab.available(
            hasApplication: appId != nil,
            hasCompany: posting?.hasCompany == true || app?.hasCompany == true
        )
        let tab = DetailTab.shown(pickedTab, in: tabs)
        let primary = JobAction.primary(posting: posting, application: app)
        let sending = app.flatMap { store.deliveries[$0.id] } != nil
        let roundSend = app != nil && (sending || { if case .approve = primary { return true }; return false }())
        VStack(spacing: 0) {
            if posting != nil || app != nil {
                DetailHeader(
                    store: store, posting: posting, app: app, tab: tab, tabs: tabs,
                    showTab: { asked in
                        withAnimation(Theme.Motion.pick(Theme.Motion.snappy, reduceMotion: reduceMotion)) { pickedTab = asked }
                    }
                )
                // The header takes the height it needs first (else a narrow window cuts its title
                // and buttons short); the tab's page scrolls in what's left.
                .layoutPriority(1)
                // The picked tab's page replaces the last one out of a blur.
                ZStack {
                    switch tab {
                    case .job: JobTab(store: store, postingId: postingId)
                    case .application: if let appId { ApplicationTab(store: store, applicationId: appId).id(appId) }
                    case .company: CompanyTab(store: store, posting: store.postingDetails[postingId], app: app)
                    }
                }
                .id(tab)
                .transition(.blurIn(reduceMotion: reduceMotion))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // Room at the foot for the round Send button, so the last tile isn't under it.
                .contentMargins(.bottom, roundSend ? 130 : 0, for: .scrollContent)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .overlay(alignment: .bottom) {
            if roundSend, let app {
                SendButton(store: store, app: app, primary: primary, title: posting.flatMap { $0.hasCompany ? $0.company : nil } ?? ApproveText.company(app))
                    .padding(.bottom, 14)
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
            }
        }
        .animation(Theme.Motion.bouncy, value: roundSend)
        // Both load whatever the tab: the header and the Job tab need the full posting, the
        // header the application's blockers.
        .task(id: postingId) { await store.openPosting(postingId) }
        .task(id: appId) { if let appId { await store.openApplication(appId) } }
        .onChange(of: store.navigation.tab, initial: true) { _, asked in
            // A review asked for from elsewhere opens its tab once.
            guard let asked else { return }
            pickedTab = asked
            store.navigation.tab = nil
        }
    }
}

// MARK: - The header

/// What the job is, where it stands, and its next step (one primary action), with the rest
/// beside it, over the job's glow; the tabs at its foot.
struct DetailHeader: View {
    let store: AppStore
    let posting: Posting?
    let app: Application?
    let tab: DetailTab
    let tabs: [DetailTab]
    let showTab: (DetailTab) -> Void
    @Environment(Toasts.self) private var toasts
    @Environment(\.openURL) private var openURL
    @State private var skipping = false
    @State private var skipReason = ""
    @State private var confirmRegenerate = false
    /// Prepare is on its way to the daemon: a second ⌘↩ doesn't send it again.
    @State private var working = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// What Re-score said ("Re-scoring 1 posting"), for a few seconds.
    @State private var note: String?

    var body: some View {
        let world = Theme.world(store.navigation.section)
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 18) {
                    CompanyAvatar(name: company ?? title, size: 64)
                        .popIn(0)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(title)
                            .font(Theme.heroTitle)
                            .foregroundStyle(.white)
                            .lineLimit(3)
                            .textSelection(.enabled)
                        if !subtitle.isEmpty {
                            Text(subtitle)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(.white.opacity(0.75))
                                .textSelection(.enabled)
                        }
                        HStack(spacing: 6) {
                            ForEach(Array(chips.enumerated()), id: \.element.text) { index, chip in
                                ChipView(chip: chip).popIn(index + 1)
                            }
                            if let dates {
                                Text(dates).font(.system(size: 12, weight: .medium)).foregroundStyle(.white.opacity(0.6)).popIn(chips.count + 1)
                            }
                        }
                        .padding(.top, 2)
                    }
                    Spacer(minLength: 0)
                    ScoreRing(score: score, size: 84, sweepsIn: true)
                }
                if let hint = app.flatMap(SignInHint.of) { SignInBanner(store: store, hint: hint) }
                if let app, let delivery = store.deliveries[app.id] { DeliveryStrip(progress: delivery) }
                actions
                // Why Approve is off, the first reason; the Application tab lists them all.
                if case let .approve(false, help) = primary {
                    Button { showTab(.application) } label: {
                        Label(help.components(separatedBy: "\n").first ?? help, systemImage: "exclamationmark.circle.fill")
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.warning)
                    .font(.system(size: 13, weight: .semibold))
                    .help(help)
                }
            }
            .padding(22)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background { HeroBackground(world: world, company: company ?? title, score: score) }
            .clipShape(RoundedRectangle(cornerRadius: Theme.panelRadius, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: Theme.panelRadius, style: .continuous).strokeBorder(Theme.glassEdge, lineWidth: 1) }
            .shadow(color: world.main.opacity(0.25), radius: 24, y: 10)
            if tabs.count > 1 {
                PillPicker(items: tabs, title: \.title, selection: Binding(get: { tab }, set: { showTab($0) }), numberShortcuts: true, tint: world.main, large: true)
                    .help("⌘1, ⌘2, ⌘3 switch tabs")
                    .padding(.top, 14)
                    .padding(.leading, 4)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 2)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(isPresented: $skipping) {
            SkipPostingSheet(reason: $skipReason) { reason in
                guard let id = posting?.id ?? app?.postingID else { return }
                let what = title
                Task {
                    await store.advancing {
                        let skipped = await store.skip(posting: id, reason: reason)
                        if skipped {
                            toasts.show(.init(systemImage: "xmark.circle", title: "Skipped", detail: what) {
                                Task { await store.undoDecision(posting: id) }
                            })
                        }
                        return skipped
                    }
                }
            }
            .worldSheet()
        }
        .confirmationDialog("Write every answer and the CV again?", isPresented: $confirmRegenerate) {
            Button("Regenerate") {
                guard let id = app?.id else { return }
                Task { await store.regenerate(application: id) }
            }
        } message: {
            Text("Your edits are redrafted too; your per-application values stay.")
        }
        .task(id: note) {
            // A newer note cancels this wait; only an uninterrupted one clears it.
            guard note != nil, (try? await Task.sleep(for: .seconds(4))) != nil else { return }
            note = nil
        }
    }

    // MARK: What it is

    private var title: String {
        if let posting, posting.hasTitle { return posting.title }
        if let app, app.hasTitle { return app.title }
        return posting?.canonicalURL ?? app?.postingURL ?? ""
    }

    private var company: String? {
        posting.flatMap { $0.hasCompany ? $0.company : nil } ?? app.flatMap { $0.hasCompany ? $0.company : nil }
    }

    private var score: Int32? {
        if let posting, posting.hasScore { return posting.score }
        return app.flatMap { $0.hasScore ? $0.score : nil }
    }

    private var facts: [KeyFact] {
        guard let posting else { return [] }
        return KeyFacts.rows(posting, description: DescriptionCache.description(posting))
    }

    /// "Acme · Remote (europe) · $5000–7000".
    private var subtitle: String {
        let wanted = ["Workplace", "Location", "Salary"]
        let parts = [company] + wanted.map { label in facts.first { $0.label == label }?.value }
        return parts.compactMap { $0 }.joined(separator: " · ")
    }

    private var chips: [Chip] {
        var chips: [Chip] = []
        if let app {
            chips.append(StageText.chip(app, delivery: store.deliveries[app.id]))
        } else if let posting {
            if posting.stage == .skipped || posting.decision == "skipped" { chips.append(Chip(text: "Skipped", tone: .neutral)) }
            else if posting.decision == "interested" { chips.append(Chip(text: "Saved", tone: .accent)) }
            else if posting.stage == .closed { chips.append(Chip(text: "Closed", tone: .warning)) }
        }
        if let site = Source.site(posting?.canonicalURL ?? app?.postingURL ?? "") { chips.append(Chip(text: site, tone: .neutral)) }
        return chips
    }

    /// "Found 3 days ago · posted 17 Sep 2026".
    private var dates: String? {
        guard let posting else { return nil }
        var parts = ["Found " + posting.firstSeenAt.date.formatted(.relative(presentation: .named))]
        if let posted = facts.first(where: { $0.label == "Posted" }) { parts.append("posted " + posted.value) }
        return parts.joined(separator: " · ")
    }

    // MARK: What to do

    private var primary: JobAction { JobAction.primary(posting: posting, application: app) }

    /// Nobody decided on it and nothing was started: Save keeps it.
    private var undecided: Bool {
        guard let posting, app == nil else { return false }
        return posting.decision.isEmpty && posting.stage != .skipped
    }

    private var skipped: Bool { posting.map { $0.stage == .skipped || $0.decision == "skipped" } ?? false }

    /// Before approval: once it's on its way or sent, Set status is what's left.
    private var unsent: Bool { app.map { $0.stage != .approved && !StageRules.isSent($0.stage) } ?? true }

    private var actions: some View {
        FlowRow(spacing: 8) {
            primaryButton
            if let posting {
                if undecided {
                    Button { Task { await store.markInterested(posting: posting.id) } } label: {
                        Label("Save", systemImage: "bookmark")
                    }
                    .help("Keep it in Saved. Applyant starts its application too.")
                } else if posting.decision == "interested" {
                    Button { Task { await store.undoDecision(posting: posting.id) } } label: {
                        Label("Unsave", systemImage: "bookmark.slash")
                    }
                    .help("Takes it out of Saved; its application stays")
                }
                if skipped {
                    // Where it goes back to: New, or its application's list when it has one.
                    let back = app.map(Navigation.section(for:)) ?? .new
                    Button { Task { await store.undoDecision(posting: posting.id) } } label: {
                        Label("Back to \(back.title)", systemImage: "arrow.uturn.backward")
                    }
                    .help("Takes the skip back; the job is undecided again")
                } else if unsent {
                    Button { skipping = true } label: { Label("Skip…", systemImage: "xmark") }
                        .keyboardShortcut("k", modifiers: .command)
                        .help("Not for you: it moves to Skipped (⌘K)")
                }
            }
            if let app, app.stage == .readyForReview || app.stage == .needsCandidate {
                Button { confirmRegenerate = true } label: { Label("Regenerate…", systemImage: "arrow.triangle.2.circlepath") }
            }
            if let app {
                SetStatusMenu(store: store, app: app)
                    .menuStyle(.button)
                    .fixedSize()
            }
            if let posting, Score.canRescore(posting) {
                Button { Task { note = await store.rescore([posting.id]) } } label: { Label("Re-score", systemImage: "gauge.with.dots.needle.67percent") }
                    .help("Score it again against your current profile and preferences")
            }
            if let url = URL(string: posting?.canonicalURL ?? app?.postingURL ?? ""), url.scheme != nil {
                Button { openURL(url) } label: { Label("Open posting", systemImage: "arrow.up.right.square") }
                    .help(url.absoluteString)
            }
            if let note {
                Text(note).font(.callout).foregroundStyle(.secondary)
                    .transition(.opacity.combined(with: .move(edge: .leading)))
            }
        }
        .buttonStyle(.secondary)
        .animation(Theme.Motion.snappy, value: note)
    }

    @ViewBuilder
    private var primaryButton: some View {
        switch primary {
        case .prepare:
            Button {
                guard let id = posting?.id, !working else { return }
                working = true
                Task {
                    defer { working = false }
                    if let app = await store.prepare(posting: id) {
                        store.navigation.reviewing = app
                        showTab(.application)
                    }
                }
            } label: {
                Label("Prepare application", systemImage: "sparkles")
            }
            .buttonStyle(.primary)
            .controlSize(.large)
            .disabled(working)
            .keyboardShortcut(.return, modifiers: .command)
            .help("Applyant drafts the answers and the CV for this job (⌘↩)")
        case .approve:
            // THE action: the round Send button at the foot of the page.
            EmptyView()
        case .review:
            if tab != .application {
                Button { showTab(.application) } label: {
                    Label("Review application", systemImage: "doc.text.magnifyingglass")
                }
                .buttonStyle(.primary)
                .controlSize(.large)
                .keyboardShortcut(.return, modifiers: .command)
            }
        case .none:
            EmptyView()
        }
    }
}

/// The hero's colour: the list's world and the company's own glowing on a deep base, drifting
/// slowly, with a lit glass edge over it.
struct HeroBackground: View {
    let world: Theme.World
    let company: String
    let score: Int32?
    private let motion = EndlessMotion()

    var body: some View {
        let companyHue = Monogram.hue(company)
        ZStack {
            GlowField(
                base: NSColor(hue: world.tone.hue, saturation: 0.75, brightness: 0.26, alpha: 0.9),
                colors: [
                    world.glow,
                    NSColor(hue: companyHue, saturation: 0.65, brightness: 0.55, alpha: 1),
                    world.secondGlow,
                    NSColor(srgbRed: 0.45, green: 0.16, blue: 0.75, alpha: 1),
                ],
                moving: motion.ambient,
                intensity: 1
            )
            LinearGradient(colors: [.white.opacity(0.08), .clear, Theme.base.opacity(0.25)], startPoint: .top, endPoint: .bottom)
        }
    }
}

/// Approve and send, when it's THE thing to do: a big round glowing button at the foot of the
/// job (ClearVPN's power button), asking once before it sends. While the application goes out,
/// a ring fills around it to how far the form is (or circles, until that's known).
struct SendButton: View {
    let store: AppStore
    let app: Application
    let primary: JobAction
    /// Who it goes to: "Kalepa".
    let title: String
    @Environment(Toasts.self) private var toasts
    @State private var confirming = false
    /// Approve is on its way to the daemon: a second ⌘↩ doesn't send it again.
    @State private var working = false

    var body: some View {
        let delivery = store.deliveries[app.id]
        let (enabled, help): (Bool, String) = if case let .approve(on, why) = primary { (on, why) } else { (false, "") }
        VStack(spacing: 6) {
            RoundActionButton(
                title: delivery != nil ? "Sending" : "Send",
                systemImage: "paperplane.fill",
                size: 76,
                working: delivery != nil && delivery?.fraction == nil,
                progress: delivery?.fraction,
                enabled: delivery != nil || (enabled && !working)
            ) {
                guard delivery == nil else { return }
                confirming = true
            }
            .keyboardShortcut(.return, modifiers: .command)
            .help(delivery?.line ?? (enabled ? "Approve and send… (⌘↩)" : help))
            .accessibilityLabel(delivery != nil ? "Sending" : "Approve and send")
            if let delivery {
                Text(delivery.line)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.85))
                    .contentTransition(.numericText())
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(Theme.toastFill, in: Capsule())
            }
        }
        .confirmationDialog(ApproveText.title(app), isPresented: $confirming) {
            Button("Send it") {
                guard !working else { return }
                let id = app.id
                let to = title
                working = true
                Task {
                    defer { working = false }
                    await store.advancing {
                        let approved = await store.approve(application: id)
                        if approved {
                            toasts.show(.init(systemImage: "paperplane.fill", title: "Sent to \(to)", detail: "Applyant fills the form and sends it now", celebrates: true))
                        }
                        return approved
                    }
                }
            }
        } message: {
            Text(ApproveText.message(app))
        }
    }
}

/// A delivery under way: what it's doing, and how far the form's filling is.
struct DeliveryStrip: View {
    let progress: DeliveryProgress
    private let motion = EndlessMotion()

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "paperplane.fill")
                .foregroundStyle(.white)
                .symbolEffect(.pulse, options: .repeating, isActive: motion.allowed)
            VStack(alignment: .leading, spacing: 6) {
                Text(progress.line)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .contentTransition(.numericText())
                    .animation(Theme.Motion.snappy, value: progress.line)
                if let fraction = progress.fraction {
                    Meter(value: fraction, color: .white, height: 5)
                } else {
                    FlowLine(flowing: true).clipShape(Capsule()).frame(height: 3)
                }
            }
        }
        .padding(12)
        .insetSurface(radius: Theme.innerRadius + 2, tint: .white)
        .transition(.opacity.combined(with: .move(edge: .top)))
    }
}

/// The site wants the candidate signed in first: say so, and open its sign-in.
struct SignInBanner: View {
    let store: AppStore
    let hint: SignInHint
    private let motion = EndlessMotion()

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "person.badge.key.fill")
                .font(.title3)
                .foregroundStyle(Theme.warning)
                .symbolEffect(.wiggle, options: .repeat(.periodic(delay: 4)), isActive: motion.allowed)
            Text("\(hint.host) wants you signed in before this application can go through.")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.warning)
            Spacer()
            Button(hint.title) { Task { await store.signIn(hint.url) } }
                .buttonStyle(.primary)
                .help(
                    "Opens Applyant's browser at \(hint.url). Sign in there and close the window, then try again: "
                        + "Regenerate… reads the form once more, Try delivery again… sends it."
                )
        }
        .padding(12)
        .background(Color.black.opacity(0.2), in: RoundedRectangle(cornerRadius: Theme.innerRadius + 2, style: .continuous))
        .insetSurface(radius: Theme.innerRadius + 2, tint: Theme.warning)
    }
}

struct SkipPostingSheet: View {
    @Binding var reason: String
    let onSkip: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                ArtView(.skipped, size: 44)
                Text("Skip this job").font(.system(size: 20, weight: .bold))
            }
            Text("Say why in a few words. Applyant uses it to score similar postings a little lower next time (for example, “salary too low” makes salary count more).")
                .font(.callout).foregroundStyle(Theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            TextField("e.g. application link opens the homepage", text: $reason)
                .textFieldStyle(.roundedBorder)
                .frame(width: 380)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.buttonStyle(.secondary)
                Button("Skip") {
                    let value = reason
                    reason = ""
                    dismiss()
                    onSkip(value)
                }
                .buttonStyle(.primary)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(22)
        .frame(width: 430)
    }
}

// MARK: - The Job tab

/// The posting: its summary, key facts, how you match, and its text.
struct JobTab: View {
    let store: AppStore
    let postingId: Int64

    var body: some View {
        if let p = store.postingDetails[postingId] {
            let description = DescriptionCache.description(p)
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                    if p.hasSummary { SummaryLine(text: p.summary).entrance(0) }
                    KeyFactsGrid(facts: KeyFacts.rows(p, description: description)).entrance(1)
                    MatchCard(posting: p).entrance(2)
                    DescriptionCard(description: description, text: p.hasText ? p.text : "", url: p.canonicalURL).entrance(3)
                    PostingNotes(posting: p).entrance(4)
                }
                .padding(.horizontal, 20)
                .padding(.top, 10)
                .padding(.bottom, 20)
                .frame(maxWidth: Theme.readableWidth, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// The scorer's one-line take, large, set off by the brand's glowing bar.
struct SummaryLine: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Capsule().fill(Theme.brand).frame(width: 4)
                .shadow(color: Theme.magenta.opacity(0.7), radius: 5)
            Text(text)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(.white.opacity(0.94))
                .lineSpacing(4)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, 4)
    }
}

/// The posting's facts at a glance, as small bento tiles: a label over a big value.
struct KeyFactsGrid: View {
    let facts: [KeyFact]

    private static let symbols: [String: String] = [
        "Workplace": "laptopcomputer", "Location": "mappin.and.ellipse", "Employment": "briefcase.fill",
        "Seniority": "chart.bar.fill", "Salary": "banknote.fill", "Language": "character.bubble.fill", "Posted": "calendar",
    ]

    private static let hues: [String: Double] = [
        "Workplace": 0.55, "Location": 0.5, "Employment": 0.75, "Seniority": 0.85, "Salary": 0.38, "Language": 0.62, "Posted": 0.1,
    ]

    var body: some View {
        if !facts.isEmpty {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 175), spacing: 10, alignment: .top)], alignment: .leading, spacing: 10) {
                ForEach(Array(facts.enumerated()), id: \.element.label) { index, fact in
                    let tint = Color(hue: Self.hues[fact.label] ?? 0.75, saturation: 0.55, brightness: 1)
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(fact.label.uppercased()).font(Theme.eyebrow).tracking(1).foregroundStyle(Theme.secondaryText)
                            Spacer()
                            Image(systemName: Self.symbols[fact.label] ?? "info.circle")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(tint)
                                .shadow(color: tint.opacity(0.7), radius: 4)
                        }
                        Text(fact.value)
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(.white)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, minHeight: 70, alignment: .topLeading)
                    .glass(radius: 16)
                    .popIn(index)
                }
            }
        }
    }
}

/// How you match: the requirements by kind with the facts behind each verdict, the score's
/// parts and what might be a problem.
struct MatchCard: View {
    let posting: Posting

    var body: some View {
        let groups = MatchText.requirementGroups(posting)
        let parts = MatchText.breakdown(posting)
        let issues = MatchText.issues(posting)
        if !groups.isEmpty || !parts.isEmpty || !issues.isEmpty {
            Card(title: "How you match", systemImage: "checklist") {
                ForEach(Array(groups.enumerated()), id: \.element.id) { groupIndex, group in
                    VStack(alignment: .leading, spacing: Theme.rowSpacing + 4) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(group.title).font(.system(size: 13.5, weight: .bold)).foregroundStyle(.white)
                            if let note = group.note { Text(note).font(.system(size: 12)).foregroundStyle(Theme.secondaryText) }
                        }
                        VerdictBar(verdicts: group.requirements.map(\.verdict))
                            .padding(.bottom, 2)
                        ForEach(Array(group.requirements.enumerated()), id: \.offset) { index, r in
                            RequirementRow(requirement: r).entrance(groupIndex * 3 + index + 1)
                        }
                    }
                    .padding(.bottom, 8)
                }
                if !issues.isEmpty { IssuesList(issues: issues) }
                if !parts.isEmpty { ScoreBreakdown(posting: posting, parts: parts) }
            }
        }
    }
}

/// The group's verdicts as one segmented bar that glows: met, partly, missing, unknown.
private struct VerdictBar: View {
    let verdicts: [String]
    @State private var grown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let order = ["strong", "partial", "missing", "unknown"]

    var body: some View {
        let counts = Self.order.map { kind in
            verdicts.filter { kind == "unknown" ? !["strong", "partial", "missing"].contains($0) : $0 == kind }.count
        }
        let total = max(verdicts.count, 1)
        GeometryReader { geo in
            let shown = counts.enumerated().filter { $0.element > 0 }
            let gaps = CGFloat(max(shown.count - 1, 0)) * 3
            HStack(spacing: 3) {
                ForEach(shown, id: \.offset) { i, n in
                    let color = Theme.verdict(Self.order[i])
                    Capsule()
                        .fill(LinearGradient(colors: [color.opacity(0.75), color], startPoint: .leading, endPoint: .trailing))
                        .opacity(Self.order[i] == "unknown" ? 0.45 : 1)
                        .shadow(color: color.opacity(Self.order[i] == "unknown" ? 0 : 0.6), radius: 4)
                        .frame(width: max(0, (geo.size.width - gaps) * CGFloat(n) / CGFloat(total)))
                }
            }
            .scaleEffect(x: grown || reduceMotion ? 1 : 0, anchor: .leading)
        }
        .frame(height: 6)
        .onAppear { withAnimation(Theme.Motion.gauge.delay(0.25)) { grown = true } }
        .accessibilityHidden(true)
    }
}

struct RequirementRow: View {
    let requirement: RequirementMatch

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VerdictMark(verdict: requirement.verdict)
            VStack(alignment: .leading, spacing: 3) {
                Text(requirement.text)
                    .font(.system(size: 13.5, weight: .medium))
                    .foregroundStyle(.white.opacity(0.94))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                let evidence = MatchText.evidence(requirement)
                if !evidence.isEmpty {
                    Text(evidence.prefix(2).joined(separator: " · ")).font(.system(size: 12)).foregroundStyle(Theme.secondaryText).lineLimit(2)
                        .help(evidence.joined(separator: "\n"))
                }
                if requirement.hasNote { Text(requirement.note).font(.system(size: 12)).foregroundStyle(Theme.tertiaryText) }
            }
        }
    }
}

struct IssuesList: View {
    let issues: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Potential issues").font(.system(size: 13.5, weight: .bold)).foregroundStyle(.white)
            ForEach(issues, id: \.self) { issue in
                Label(issue, systemImage: "exclamationmark.triangle.fill")
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(Theme.warning)
                    .font(.system(size: 13, weight: .medium))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .insetSurface(tint: Theme.warning)
        .padding(.bottom, 4)
    }
}

/// The score's parts in one compact table, each with its bar.
struct ScoreBreakdown: View {
    let posting: Posting
    let parts: [Applyant_V1_ScoreComponent]
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(Theme.Motion.pick(Theme.Motion.snappy, reduceMotion: reduceMotion)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Theme.secondaryText)
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Text("Score \(posting.hasScore ? "\(posting.score)" : "–") of 100").font(.system(size: 13.5, weight: .bold)).foregroundStyle(.white)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 8) {
                    ForEach(Array(parts.enumerated()), id: \.element.key) { index, c in
                        let points = Score.points(c)
                        GridRow {
                            Text(Score.componentTitles[c.key] ?? c.key).font(.callout).foregroundStyle(.white.opacity(0.9))
                            Meter(value: c.value, color: c.uncertain ? Theme.secondaryText : Theme.score(Int32((c.value * 100).rounded())), height: 5, delay: Stagger.delay(index, step: 0.03))
                                .frame(width: 100)
                                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                            Text(c.uncertain ? "?" : "\(points.earned)/\(points.of)").font(.callout).monospacedDigit().foregroundStyle(.white)
                            Text(c.hasNote ? c.note : "").font(.callout).foregroundStyle(Theme.secondaryText).lineLimit(2)
                        }
                    }
                }
                .padding(.leading, 16)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}

/// The posting's text, read as headings, paragraphs and lists on darker glass, at a size and
/// line length made for reading; the capture itself on request.
struct DescriptionCard: View {
    let description: PostingDescription
    let text: String
    let url: String
    @State private var showCapture = false

    var body: some View {
        FoldingCard(title: "Description", systemImage: "doc.text", surface: Theme.readingFill) {
            VStack(alignment: .leading, spacing: 0) {
                if description.blocks.isEmpty {
                    Text(text.isEmpty ? "The posting's text wasn't captured. Open posting ↗ shows it on its site." : "Nothing readable was left after taking the page's own parts out: “Show the captured text” has all of it.")
                        .foregroundStyle(Theme.secondaryText)
                } else {
                    DescriptionBlocks(blocks: description.blocks)
                }
                if !text.isEmpty {
                    Toggle("Show the captured text", isOn: $showCapture).toggleStyle(.checkbox).font(Theme.caption).padding(.top, 14)
                        .foregroundStyle(Theme.secondaryText)
                    if showCapture {
                        Text(text)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.8))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                            .insetSurface()
                    }
                }
            }
            .frame(maxWidth: Theme.proseWidth, alignment: .leading)
        }
    }
}

struct DescriptionBlocks: View {
    let blocks: [PostingDescription.Block]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case let .heading(text):
                    Text(PostingDescription.inline(text))
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.top, 8)
                case let .paragraph(text):
                    Text(PostingDescription.inline(text))
                        .font(Theme.prose)
                        .foregroundStyle(.white.opacity(0.88))
                        .lineSpacing(5)
                        .fixedSize(horizontal: false, vertical: true)
                case let .list(items, start):
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                if let start {
                                    Text("\(start + i).").font(Theme.prose.weight(.semibold)).foregroundStyle(Theme.accent).monospacedDigit()
                                } else {
                                    Circle().fill(Theme.brand).frame(width: 6, height: 6)
                                        .shadow(color: Theme.magenta.opacity(0.7), radius: 3)
                                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4.5 }
                                }
                                Text(PostingDescription.inline(item))
                                    .font(Theme.prose)
                                    .foregroundStyle(.white.opacity(0.88))
                                    .lineSpacing(5)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }
        }
        .tint(Theme.accent)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// How the posting was checked and read, and the candidate's own note on it.
struct PostingNotes: View {
    let posting: Posting

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if posting.hasVerifyNote { Text("Verification: \(posting.verifyNote)") }
            if let verified = PostingText.formVerified(posting) { Text(verified) }
            if posting.hasFormNote { Text("Form: \(posting.formNote)") }
            if posting.hasDecisionReason { Text("Your note: \(posting.decisionReason)") }
        }
        .font(Theme.caption)
        .foregroundStyle(Theme.tertiaryText)
        .textSelection(.enabled)
        .padding(.horizontal, 4)
    }
}

/// Reading a posting's text is done once per text, not on every redraw.
@MainActor
enum DescriptionCache {
    private static var cache: [Int64: (size: Int, description: PostingDescription)] = [:]

    static func description(_ p: Posting) -> PostingDescription {
        let text = p.hasText ? p.text : ""
        if let hit = cache[p.id], hit.size == text.utf8.count { return hit.description }
        let parsed = PostingDescription.parse(text, title: p.hasTitle ? p.title : nil, company: p.hasCompany ? p.company : nil)
        cache[p.id] = (text.utf8.count, parsed)
        return parsed
    }
}

// MARK: - The Company tab

struct CompanyTab: View {
    let store: AppStore
    let posting: Posting?
    let app: Application?

    var body: some View {
        let research = posting.flatMap { $0.hasCompanyResearch ? $0.companyResearch : nil }
            ?? app.flatMap { $0.hasCompanyResearch ? $0.companyResearch : nil }
        let full = research.flatMap { store.companyDetails[$0.id] }
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                CompanyCard(store: store, company: full ?? research, postingId: posting?.id ?? app?.postingID).entrance(0)
                if let full {
                    ForEach(Array(full.sections.enumerated()), id: \.element.key) { index, section in
                        CompanyFindings(section: section).entrance(index + 1)
                    }
                }
            }
            .padding(Theme.pagePadding)
            .frame(maxWidth: Theme.readableWidth, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: research?.id) {
            if let research, research.id != 0, research.hasSummary { await store.openCompany(research.id) }
        }
    }
}
