// One job, whichever list it was picked from: a hero tile with what it is and its one next
// step (lit like CleanMyMac's working tile, in the list's world and the company's colour), then
// tabs: the posting itself (what it asks for, how you match, its text), its application once
// there is one, and its company. When Approve and Send… is the step, it's the big round Send
// button at the foot of the page. The header's buttons, the Job menu and their shortcuts all
// run the same JobCommands.
import AppKit
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
    @Environment(Toasts.self) private var toasts
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var skipping = false
    @State private var skipReason = ""
    @State private var confirmRegenerate = false
    @State private var confirmSend = false
    /// Prepare or Approve is on its way to the daemon: a second ⌘↩ doesn't send it again.
    @State private var working = false
    /// What Re-score said ("Re-scoring 1 posting"), for a few seconds.
    @State private var note: String?

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
        let commands = commands(posting: posting, app: app, primary: primary, tab: tab)
        let sending = app.flatMap { store.deliveries[$0.id] } != nil
        // The round Send is there only when it can send (or is sending): a blocked one would
        // be a dead control over the page; the hero's Finish Application says what's left.
        let roundSend = app != nil && (sending || { if case .approve(true, _) = primary { return true }; return false }())
        VStack(spacing: 0) {
            if posting != nil || app != nil {
                DetailHeader(
                    store: store, posting: posting, app: app, tab: tab, tabs: tabs,
                    primary: primary, commands: commands, note: note, showTab: showTab
                )
                // The header takes the height it needs first (else a narrow window cuts its title
                // and buttons short); the tab's page scrolls in what's left.
                .layoutPriority(1)
                // The picked tab's page replaces the last one out of a quick blur.
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
            // The page fades out under the button, so it never sits on a line of text.
            if roundSend { EdgeScrim(edge: .bottom, height: 120).transition(.opacity) }
        }
        .overlay(alignment: .bottom) {
            if roundSend, let app {
                SendButton(store: store, app: app, approve: commands.approve)
                    .padding(.bottom, 14)
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
            }
        }
        .animation(Theme.Motion.bouncy, value: roundSend)
        // The Job menu: off while a sheet or a question is open over the job.
        .focusedSceneValue(\.jobCommands, skipping || confirmRegenerate || confirmSend ? JobCommands() : commands)
        .sheet(isPresented: $skipping) {
            SkipPostingSheet(reason: $skipReason) { reason in
                guard let id = posting?.id ?? app?.postingID else { return }
                skip(posting: id, reason: reason, title: Self.title(posting: posting, app: app))
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
        .confirmationDialog(app.map(ApproveText.title) ?? "", isPresented: $confirmSend, presenting: app) { app in
            Button("Send") { send(app, to: posting.flatMap { $0.hasCompany ? $0.company : nil } ?? ApproveText.company(app)) }
        } message: { app in
            Text(ApproveText.message(app))
        }
        .task(id: note) {
            // A newer note cancels this wait; only an uninterrupted one clears it.
            guard note != nil, (try? await Task.sleep(for: .seconds(4))) != nil else { return }
            note = nil
        }
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

    /// The job's title, else its application's, else its link.
    static func title(posting: Posting?, app: Application?) -> String {
        if let posting, posting.hasTitle { return posting.title }
        if let app, app.hasTitle { return app.title }
        return posting?.canonicalURL ?? app?.postingURL ?? ""
    }

    private func showTab(_ asked: DetailTab) {
        withAnimation(Theme.Motion.fade) { pickedTab = asked }
    }

    // MARK: What it can do

    /// The job's commands for where it stands: nil where one doesn't apply.
    private func commands(posting: Posting?, app: Application?, primary: JobAction, tab: DetailTab) -> JobCommands {
        var c = JobCommands()
        let sending = app.flatMap { store.deliveries[$0.id] } != nil
        switch primary {
        case .prepare:
            if let id = posting?.id, !working { c.prepare = { prepare(posting: id) } }
        case let .approve(enabled, _):
            if enabled, app != nil, !sending, !working { c.approve = { confirmSend = true } }
        case .review:
            if tab != .application { c.review = { showTab(.application) } }
        case .none:
            break
        }
        if let posting {
            let skipped = posting.stage == .skipped || posting.decision == "skipped"
            if app == nil, posting.decision.isEmpty, !skipped {
                c.save = { Task { await store.markInterested(posting: posting.id) } }
            } else if posting.decision == "interested" {
                c.saved = true
                c.save = { Task { await store.undoDecision(posting: posting.id) } }
            }
            if skipped {
                // Where it goes back to: New, or its application's list when it has one.
                c.unskipTitle = "Back to \((app.map(Navigation.section(for:)) ?? .new).title)"
                c.unskip = { Task { await store.undoDecision(posting: posting.id) } }
            } else if app.map({ $0.stage != .approved && !StageRules.isSent($0.stage) }) ?? true {
                // Before approval: once it's on its way or sent, Set Status is what's left.
                c.skip = { skipping = true }
            }
            if Score.canRescore(posting) { c.rescore = { Task { note = await store.rescore([posting.id]) } } }
        }
        if let app, app.stage == .readyForReview || app.stage == .needsCandidate {
            c.regenerate = { confirmRegenerate = true }
        }
        if let url = URL(string: posting?.canonicalURL ?? app?.postingURL ?? ""), url.scheme != nil {
            c.openPosting = { openURL(url) }
        }
        return c
    }

    private func prepare(posting id: Int64) {
        guard !working else { return }
        working = true
        Task {
            defer { working = false }
            if let app = await store.prepare(posting: id) {
                store.navigation.reviewing = app
                showTab(.application)
            }
        }
    }

    private func send(_ app: Application, to company: String) {
        guard !working else { return }
        let id = app.id
        working = true
        Task {
            defer { working = false }
            await store.advancing {
                let approved = await store.approve(application: id)
                if approved {
                    toasts.show(.init(systemImage: "paperplane.fill", title: "Sent to \(company)", detail: "Applyant fills the form and sends it now", celebrates: true))
                }
                return approved
            }
        }
    }

    private func skip(posting id: Int64, reason: String, title: String) {
        Task {
            await store.advancing {
                let skipped = await store.skip(posting: id, reason: reason)
                if skipped {
                    toasts.show(.init(systemImage: "xmark.circle", title: "Skipped", detail: title) {
                        Task { await store.undoDecision(posting: id) }
                    })
                }
                return skipped
            }
        }
    }
}

// MARK: - The header

/// What the job is, where it stands, and its next step: one prominent action, Save and Skip…
/// beside it, the rest in More; what's left before it can be sent under them; the tabs at its foot.
struct DetailHeader: View {
    let store: AppStore
    let posting: Posting?
    let app: Application?
    let tab: DetailTab
    let tabs: [DetailTab]
    let primary: JobAction
    let commands: JobCommands
    /// What Re-score said, for a few seconds.
    let note: String?
    let showTab: (DetailTab) -> Void

    /// The avatar and the gap after it: the actions line up with the title.
    private static let titleColumn: CGFloat = 64 + 18

    var body: some View {
        let world = Theme.world(store.navigation.section)
        let todo = app.map(ReviewRules.todo) ?? []
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 18) {
                    CompanyAvatar(name: company ?? title, size: 64)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(title)
                            .textRole(.display)
                            .lineLimit(3)
                            .textSelection(.enabled)
                        if !subtitle.isEmpty {
                            Text(subtitle)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(Theme.secondaryText)
                                .lineLimit(2)
                                .textSelection(.enabled)
                        }
                        FlowRow(spacing: 6) {
                            ForEach(chips, id: \.text) { ChipView(chip: $0, help: $0.help) }
                            if let flags = redFlagsChip {
                                Button { showTab(.company) } label: { ChipView(chip: flags) }
                                    .buttonStyle(.plain)
                                    .help((flags.help ?? "") + "\n\nThe Company tab has them with their sources.")
                            }
                            if let dates {
                                Text(dates)
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(Theme.secondaryText)
                                    .lineLimit(1)
                                    .padding(.leading, 2)
                            }
                        }
                        .padding(.top, 2)
                    }
                    Spacer(minLength: 0)
                    ScoreRing(score: score, size: 84)
                }
                if let hint = app.flatMap(SignInHint.of) { SignInBanner(store: store, hint: hint) }
                if let app, let delivery = store.deliveries[app.id] { DeliveryStrip(progress: delivery) }
                VStack(alignment: .leading, spacing: 10) {
                    actions
                    // What's left before it can be sent, each a way into the Application tab.
                    if !todo.isEmpty {
                        FlowRow(spacing: 6) {
                            ForEach(todo) { item in
                                Button { showTab(.application) } label: {
                                    ChipView(chip: Chip(text: item.title + " ›", tone: .warning))
                                }
                                .buttonStyle(.plain)
                                .help("Open the Application tab: it's under Before You Can Send")
                            }
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("Before you can send")
                    }
                }
                .padding(.leading, Self.titleColumn)
            }
            .padding(22)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background { HeroBackground(world: world, company: company ?? title, score: score) }
            .clipShape(RoundedRectangle(cornerRadius: Theme.panelRadius, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: Theme.panelRadius, style: .continuous).strokeBorder(Theme.glassEdge, lineWidth: 1) }
            .shadow(color: world.main.opacity(0.25), radius: 24, y: 10)
            if tabs.count > 1 {
                PillPicker(items: tabs, title: \.title, selection: Binding(get: { tab }, set: { showTab($0) }), numberShortcuts: true, tint: world.main, large: true, accessibilityLabel: "Job sections")
                    .help("⌘1, ⌘2, ⌘3 switch tabs")
                    .padding(.top, 14)
                    .padding(.leading, 4)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 2)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: What it is

    private var title: String { JobDetail.title(posting: posting, app: app) }

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

    /// Sent or on its way: Set Status and Open Posting are out on the row, not in More.
    private var sent: Bool { app.map { $0.stage == .approved || StageRules.isSent($0.stage) } ?? false }

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

    /// "2 red flags" when the company research found any: it opens the Company tab.
    private var redFlagsChip: Chip? {
        let research = posting.flatMap { $0.hasCompanyResearch ? $0.companyResearch : nil }
            ?? app.flatMap { $0.hasCompanyResearch ? $0.companyResearch : nil }
        guard let flags = research?.redFlags, !flags.isEmpty, tabs.contains(.company) else { return nil }
        return Chip(
            text: flags.count == 1 ? "1 red flag" : "\(flags.count) red flags",
            tone: .warning,
            help: flags.map(CompanyText.flagTitle).joined(separator: "\n")
        )
    }

    /// "Sent Oct 3 · 14 days ago · no reply yet" once it's sent; before that "Found 3 days ago
    /// · posted 17 Sep 2026".
    private var dates: String? {
        if let app, let line = SentText.line(app) { return line }
        guard let posting else { return nil }
        var parts = ["Found " + posting.firstSeenAt.date.formatted(.relative(presentation: .named))]
        if let posted = facts.first(where: { $0.label == "Posted" }) { parts.append("posted " + posted.value) }
        return parts.joined(separator: " · ")
    }

    // MARK: What to do

    private var actions: some View {
        FlowRow(spacing: 8) {
            primaryButton
            if let save = commands.save {
                Button(action: save) {
                    Label(commands.saved ? "Unsave" : "Save", systemImage: commands.saved ? "bookmark.slash" : "bookmark")
                }
                .help(commands.saved ? "Takes it out of Saved; its application stays (⌘D)" : "Keep it in Saved. Applyant starts its application too (⌘D)")
            }
            if let skip = commands.skip {
                Button(action: skip) { Label("Skip…", systemImage: "xmark") }
                    // ⌘⌫ is the Job menu's; ⌘K stays as it was.
                    .keyboardShortcut("k", modifiers: .command)
                    .help("Not for you: it moves to Skipped (⌘⌫)")
            }
            if sent, let app, !StageRules.targets(from: app.stage).isEmpty {
                Menu {
                    SetStatusItems(store: store, app: app)
                } label: {
                    Label("Set Status", systemImage: "flag")
                }
                .menuStyle(.button)
                .fixedSize()
                .help("Correct the status by hand: a reply Applyant missed, or one sent outside it")
            }
            if sent, let open = commands.openPosting {
                Button(action: open) { Label("Open Posting", systemImage: "arrow.up.right.square") }
                    .help("The posting on its site")
            }
            more
            if let note {
                Text(note).textRole(.meta)
                    .transition(.opacity.combined(with: .move(edge: .leading)))
            }
        }
        .buttonStyle(.secondary)
        .animation(Theme.Motion.snappy, value: note)
    }

    /// The one prominent action by where the job stands. Approve and Send… is the round Send
    /// button at the foot of the page instead; while something blocks it, Finish Application
    /// opens what's left.
    @ViewBuilder
    private var primaryButton: some View {
        switch primary {
        case .prepare:
            Button { commands.prepare?() } label: {
                Label("Prepare Application", systemImage: "sparkles")
            }
            .buttonStyle(.primary)
            .controlSize(.large)
            .disabled(commands.prepare == nil)
            .keyboardShortcut(.return, modifiers: .command)
            .help("Applyant drafts the answers and the CV for this job (⌘↩ or ⇧⌘P)")
        case .approve(true, _):
            EmptyView()
        case let .approve(false, why):
            Button { showTab(.application) } label: {
                Label("Finish Application", systemImage: "checklist")
            }
            .buttonStyle(.primary)
            .controlSize(.large)
            .keyboardShortcut(.return, modifiers: .command)
            .help("Before it can be sent: " + why.components(separatedBy: "\n").map(FieldText.plain).joined(separator: "; ") + " (⌘↩)")
        case .review:
            if let review = commands.review {
                Button(action: review) {
                    Label("Review Application", systemImage: "doc.text.magnifyingglass")
                }
                .buttonStyle(.primary)
                .controlSize(.large)
                .keyboardShortcut(.return, modifiers: .command)
            }
        case .none:
            if let unskip = commands.unskip {
                Button(action: unskip) { Label(commands.unskipTitle, systemImage: "arrow.uturn.backward") }
                    .buttonStyle(.primary)
                    .controlSize(.large)
                    .help("Takes the skip back; the job is undecided again")
            }
        }
    }

    /// Everything else the job can do, out of the way.
    @ViewBuilder
    private var more: some View {
        let statuses = !sent && (app.map { !StageRules.targets(from: $0.stage).isEmpty } ?? false)
        let open = sent ? nil : commands.openPosting
        if commands.regenerate != nil || commands.rescore != nil || open != nil || statuses {
            Menu {
                if let regenerate = commands.regenerate { Button("Regenerate…", action: regenerate) }
                if let rescore = commands.rescore { Button("Re-score", action: rescore) }
                if let app, statuses {
                    Menu("Set Status") { SetStatusItems(store: store, app: app) }
                }
                if let open {
                    Divider()
                    Button("Open Posting", action: open)
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .fixedSize()
            .accessibilityLabel("More")
            .help("More")
        }
    }
}

/// Set Status's items, for the job's More menu and a row's menu: the status corrected by hand
/// (a reply Applyant missed, or one sent outside it).
struct SetStatusItems: View {
    let store: AppStore
    let app: Application

    var body: some View {
        if ApproveText.canReturnToReview(app) {
            Button("Back to Review (Nothing Is Sent)") { Task { await store.returnToReview(application: app.id) } }
            Divider()
        }
        ForEach(StageRules.targets(from: app.stage), id: \.self) { stage in
            Button(StageText.statusItem(stage, from: app.stage)) {
                Task { await store.setStage(application: app.id, to: stage) }
            }
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
                    // The company's colour stays a muted hint, so no job turns the header pink.
                    NSColor(hue: companyHue, saturation: 0.35, brightness: 0.42, alpha: 1),
                    world.secondGlow,
                    NSColor(srgbRed: 0.118, green: 0.227, blue: 0.541, alpha: 1),
                ],
                moving: motion.ambient,
                intensity: 1
            )
            LinearGradient(colors: [.white.opacity(0.08), .clear, Theme.base.opacity(0.25)], startPoint: .top, endPoint: .bottom)
        }
    }
}

/// Approve and Send…, when it's THE thing to do: a big round glowing button at the foot of
/// the job (ClearVPN's power button), there only while the application can go (or is going);
/// JobDetail asks once before it sends. While the application goes out, a ring fills around it
/// to how far the form is (or circles, until that's known).
struct SendButton: View {
    let store: AppStore
    let app: Application
    /// The job's Approve and Send… (the Job menu's ⌘↩); nil while it's on its way.
    let approve: (() -> Void)?

    var body: some View {
        let delivery = store.deliveries[app.id]
        VStack(spacing: 6) {
            RoundActionButton(
                title: delivery != nil ? "Sending" : "Send",
                systemImage: "paperplane.fill",
                size: 76,
                working: delivery != nil && delivery?.fraction == nil,
                progress: delivery?.fraction,
                enabled: delivery != nil || approve != nil
            ) {
                guard delivery == nil else { return }
                approve?()
            }
            .help(delivery?.line ?? "Approve and Send… (⌘↩)")
            .accessibilityLabel(delivery != nil ? "Sending" : "Approve and Send…")
            if let delivery {
                Text(delivery.line)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.text)
                    .contentTransition(.numericText())
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(Theme.toastFill, in: Capsule())
            }
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

    var body: some View {
        Callout(
            .warning,
            title: "\(hint.host) wants you signed in first",
            detail: "This application can't go through until you are.",
            systemImage: "person.badge.key.fill"
        ) {
            Button(hint.title) { Task { await store.signIn(hint.url) } }
                .buttonStyle(.primary)
                .help(
                    "Opens Applyant's browser at \(hint.url). Sign in there and close the window, then try again: "
                        + "Regenerate… reads the form once more, Try Delivery Again… sends it."
                )
        }
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
                .textRole(.body, color: Theme.secondaryText)
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

/// The posting: its one-line take, the facts the hero doesn't say, how you match, and its text.
struct JobTab: View {
    let store: AppStore
    let postingId: Int64

    var body: some View {
        if let p = store.postingDetails[postingId] {
            let description = DescriptionCache.description(p)
            let facts = KeyFacts.stripRows(p, description: description)
            // Picked often: the page is simply there, no tiles coming in one after another.
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                    if p.hasSummary { Lead(p.summary) }
                    if !facts.isEmpty {
                        StatStrip(facts.map { StatStrip.Item(label: $0.label, value: $0.value, help: $0.full) })
                    }
                    MatchCard(posting: p, projects: projectNames)
                    DescriptionCard(description: description, text: p.hasText ? p.text : "", url: p.canonicalURL)
                    PostingNotes(posting: p)
                }
                .pageColumn()
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// The candidate's projects by slug, so a fact says which project it's from by name.
    private var projectNames: [String: String] {
        Dictionary((store.candidateProfile?.projects ?? []).map { ($0.slug, $0.name) }, uniquingKeysWith: { first, _ in first })
    }
}

/// How you match: the requirements by kind, the gaps first, each a claim with its facts in the
/// margin; what's met folds into one line. Then what might be a problem, and the score's parts.
struct MatchCard: View {
    let posting: Posting
    /// The candidate's projects by slug.
    var projects: [String: String] = [:]

    var body: some View {
        let groups = MatchText.requirementGroups(posting)
        let parts = MatchText.breakdown(posting)
        let issues = MatchText.issueList(posting)
        if !groups.isEmpty || !parts.isEmpty || !issues.isEmpty {
            Card(title: "How you match", systemImage: "checklist") {
                VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                    ForEach(groups) { group in
                        RequirementGroupView(group: group, projects: projects)
                    }
                    if !issues.isEmpty { IssuesList(issues: issues) }
                    if !parts.isEmpty { ScoreBreakdown(posting: posting, parts: parts) }
                }
            }
        }
    }
}

/// Must-haves or nice-to-haves: the bar of verdicts, what's missing or partly there in full,
/// and the met ones behind "7 met · 8+ years, ownership, system design".
private struct RequirementGroupView: View {
    let group: MatchText.RequirementGroup
    let projects: [String: String]
    @State private var showMet = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let gaps = group.requirements.filter { $0.verdict != "strong" }
        let met = group.requirements.filter { $0.verdict == "strong" }
        VStack(alignment: .leading, spacing: Theme.rowSpacing) {
            Text(group.title).textRole(.itemTitle)
            VerdictBar(verdicts: group.requirements.map(\.verdict))
                .help(group.note ?? "")
                .padding(.bottom, 2)
            ForEach(Array(gaps.enumerated()), id: \.offset) { _, r in
                RequirementRow(requirement: r, projects: projects)
            }
            if let summary = MatchText.metSummary(group) {
                DisclosureLine(summary, isExpanded: $showMet.animation(Theme.Motion.pick(Theme.Motion.disclose, reduceMotion: reduceMotion)))
                if showMet {
                    VStack(alignment: .leading, spacing: Theme.rowSpacing) {
                        ForEach(Array(met.enumerated()), id: \.offset) { _, r in
                            RequirementRow(requirement: r, projects: projects)
                        }
                    }
                    .transition(.opacity)
                }
            }
        }
    }
}

/// The group's verdicts as one segmented bar: met, partly, missing, unknown.
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
                        .fill(color)
                        .opacity(Self.order[i] == "unknown" ? 0.45 : 1)
                        .frame(width: max(0, (geo.size.width - gaps) * CGFloat(n) / CGFloat(total)))
                }
            }
            .scaleEffect(x: grown || reduceMotion ? 1 : 0, anchor: .leading)
        }
        .frame(height: 6)
        .onAppear { withAnimation(Theme.Motion.fade) { grown = true } }
        .accessibilityHidden(true)
    }
}

/// A requirement as a claim: its verdict, what it asks, why (in full when it isn't met), and
/// the facts behind it in the margin ("2 facts ›"), each under its project's name.
struct RequirementRow: View {
    let requirement: RequirementMatch
    var projects: [String: String] = [:]
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let evidence = MatchText.evidence(requirement, projects: projects)
        let note = requirement.hasNote && !requirement.note.isEmpty ? requirement.note : nil
        // A met one needs no why: it would only say the requirement again.
        let reason = requirement.verdict == "strong" ? nil : note
        Group {
            if evidence.isEmpty {
                EvidenceRow(requirement.text, reason: reason) { VerdictMark(verdict: requirement.verdict) }
            } else {
                EvidenceRow(
                    requirement.text,
                    reason: reason,
                    margin: MatchText.factsLabel(evidence.count),
                    isExpanded: $open.animation(Theme.Motion.pick(Theme.Motion.disclose, reduceMotion: reduceMotion))
                ) {
                    VerdictMark(verdict: requirement.verdict)
                } detail: {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(evidence.enumerated()), id: \.offset) { _, line in
                            Text(line)
                                .textRole(.meta)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
        .help(requirement.verdict == "strong" ? (note ?? "") : "")
    }
}

/// What might be a problem: a dealbreaker, or what the posting doesn't say clearly enough.
struct IssuesList: View {
    let issues: [MatchText.Issue]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.rowSpacing) {
            ForEach(Array(issues.enumerated()), id: \.offset) { _, issue in
                Callout(.warning, title: issue.title, detail: issue.detail, systemImage: "exclamationmark.triangle.fill")
            }
        }
    }
}

/// The score's parts in one compact table, each with its bar, behind one line.
struct ScoreBreakdown: View {
    let posting: Posting
    let parts: [Applyant_V1_ScoreComponent]
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            DisclosureLine(
                posting.hasScore ? "How the score of \(posting.score) adds up" : "How the score adds up",
                isExpanded: $open.animation(Theme.Motion.pick(Theme.Motion.disclose, reduceMotion: reduceMotion))
            )
            if open {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 8) {
                    ForEach(Array(parts.enumerated()), id: \.element.key) { index, c in
                        let points = Score.points(c)
                        GridRow {
                            Text(Score.componentTitles[c.key] ?? c.key).textRole(.body)
                            Meter(value: c.value, color: c.uncertain ? Theme.secondaryText : Theme.score(Int32((c.value * 100).rounded())), height: 5, delay: Stagger.delay(index, step: 0.03))
                                .frame(width: 100)
                                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                            Text(c.uncertain ? "?" : "\(points.earned)/\(points.of)").textRole(.body).monospacedDigit()
                            Text(c.hasNote ? c.note : "").textRole(.meta).lineLimit(2).help(c.hasNote ? c.note : "")
                        }
                    }
                }
                .padding(.leading, 16)
                .transition(.opacity)
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
                    Text(text.isEmpty ? "The posting's text wasn't captured. Open Posting (in More) shows it on its site." : "Nothing readable was left after taking the page's own parts out: “Show the captured text” has all of it.")
                        .textRole(.body, color: Theme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    DescriptionBlocks(blocks: description.blocks)
                }
                if !text.isEmpty {
                    Toggle("Show the captured text", isOn: $showCapture)
                        .toggleStyle(.checkbox)
                        .textRole(.meta)
                        .padding(.top, 16)
                    if showCapture {
                        Text(text)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Theme.secondaryText)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                            .insetSurface()
                    }
                }
            }
            .frame(maxWidth: Theme.measure, alignment: .leading)
        }
    }
}

struct DescriptionBlocks: View {
    let blocks: [PostingDescription.Block]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.paragraphSpacing) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case let .heading(text):
                    Text(PostingDescription.inline(text))
                        .textRole(.heading)
                        .padding(.top, 8)
                case let .paragraph(text):
                    Prose(PostingDescription.inline(text))
                case let .list(items, start):
                    VStack(alignment: .leading, spacing: Theme.rowSpacing) {
                        ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                if let start {
                                    Text("\(start + i).").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.accent).monospacedDigit()
                                } else {
                                    Circle().fill(Theme.accent).frame(width: 5, height: 5)
                                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4.5 }
                                }
                                Prose(PostingDescription.inline(item))
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
        VStack(alignment: .leading, spacing: 2) {
            if posting.hasVerifyNote { MetaLine("Verification: \(posting.verifyNote)") }
            if let verified = PostingText.formVerified(posting) { MetaLine(verified) }
            if posting.hasFormNote { MetaLine("Form: \(posting.formNote)") }
            if posting.hasDecisionReason { MetaLine("Your note: \(posting.decisionReason)") }
        }
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
                CompanyCard(store: store, company: full ?? research, postingId: posting?.id ?? app?.postingID)
                if let full {
                    ForEach(full.sections, id: \.key) { section in
                        CompanyFindings(section: section)
                    }
                }
            }
            .pageColumn()
        }
        .task(id: research?.id) {
            if let research, research.id != 0, research.hasSummary { await store.openCompany(research.id) }
        }
    }
}
