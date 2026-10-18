// Sources: every place Applyant reads jobs from, each with its switch. The ATS index first
// (every company board Applyant knows on Greenhouse, Ashby, Lever and the other ATSs, read on
// its own schedule and searched by every strategy), then the searches across companies, the
// companies you watch, career pages and feeds, job boards, Telegram, LinkedIn and Xing. A
// source that's off (or whose kind is) is never queried; the index's ATSs and single companies
// switch the same way.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct SourcesList: View {
    let store: AppStore

    var body: some View {
        let groups = SourcesText.groups(store.search)
        let atsRows = (store.atsIndex?.ats ?? []).map(SourcesText.atsRow)
        let world = Theme.world(.sources)
        let order: [SourcesSelection] = [.index] + atsRows.map { .ats($0.ats) }
            + groups.flatMap { $0.rows.compactMap(Self.selection) }
        VStack(alignment: .leading, spacing: 0) {
            ModuleHeader(section: .sources, subtitle: subtitle).columnHeader()
            CardList(
                selection: Binding(get: { store.navigation.sources }, set: { store.navigation.sources = $0 }),
                order: order,
                tint: world.main
            ) {
                indexGroup(atsRows, tint: world.main)
                ForEach(groups) { group in
                    SourceGroupView(store: store, group: group, tint: world.main)
                }
            }
        }
        .navigationTitle("Sources")
        .task { await store.openSources() }
    }

    /// "23 of 31 sources on · 4,210 companies in the index".
    private var subtitle: String {
        var line = SourcesText.onLine(store.search)
        if let index = store.atsIndex, index.companies > 0 {
            line += " · \(SourcesText.number(index.companies)) compan\(index.companies == 1 ? "y" : "ies") in the index"
        }
        return line
    }

    static func selection(_ row: SearchRow) -> SourcesSelection? {
        if case let .source(key) = row.selection { return .source(key) }
        return nil
    }

    /// Every company on ATS: the master switch, the whole index, and each ATS with its switch.
    @ViewBuilder
    private func indexGroup(_ rows: [IndexAtsRow], tint: Color) -> some View {
        let index = store.atsIndex
        let on = SourcesText.indexOn(index, list: store.search)
        HStack {
            CardListHeader(title: SourceGroupID.index.title, tint: tint)
            Spacer()
            if index != nil || store.source(SourcesText.indexKey) != nil {
                SourceSwitch(
                    label: "Every company on ATS",
                    isOn: on,
                    help: on ? "Searches stop looking through the index" : "Every search looks through the index again"
                ) { value in Task { await store.setSource(SourcesText.indexKey, enabled: value) } }
                .padding(.top, 10)
                .padding(.trailing, 6)
            }
        }
        SelectableCard(id: SourcesSelection.index, padding: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text("All companies").textRole(.rowTitle, color: on ? Theme.text : Theme.secondaryText)
                Text(index.map(SourcesText.indexLine) ?? (store.atsIndexProblem == nil ? "Loading…" : "Not available yet"))
                    .textRole(.meta).lineLimit(1)
                if SourcesText.discovering(index) {
                    ChipView(chip: Chip(text: "Finding companies…", tone: .accent, live: true)).padding(.top, 2)
                }
            }
        }
        ForEach(rows) { row in
            SelectableCard(id: SourcesSelection.ats(row.ats), padding: 10) {
                HStack {
                    RowText(title: row.title, subtitle: row.subtitle, chips: row.chips, on: row.on && on)
                        .help(row.lastReadAt.map { "Last read " + $0.formatted(.relative(presentation: .named)) } ?? "Not read yet")
                    Spacer()
                    SourceSwitch(
                        label: row.title,
                        isOn: row.on,
                        help: row.on ? "Switch \(row.title) off: its boards are neither read nor searched" : "Switch \(row.title) back on"
                    ) { value in Task { await store.setSource(row.ats, enabled: value) } }
                }
            }
        }
    }
}

/// One group of the list after the index: its kind's switch in its header (or, with more than
/// one kind, over each kind's rows), the sources with theirs, and what adds one.
private struct SourceGroupView: View {
    let store: AppStore
    let group: SourceGroup
    let tint: Color

    var body: some View {
        let single = group.blocks.count == 1 ? group.blocks.first?.kind : nil
        HStack {
            CardListHeader(title: group.title, count: group.rows.isEmpty ? nil : group.rows.count, tint: tint)
            Spacer()
            if let kind = single { kindSwitch(kind).padding(.top, 10).padding(.trailing, 6) }
        }
        if group.id == .watched {
            AddBoardOrPage(store: store).padding(.horizontal, 4)
            if group.rows.isEmpty {
                Text("A company's careers page or its board on an ATS, by URL: Applyant reads it on every search.")
                    .textRole(.meta).padding(.horizontal, 6)
            }
        }
        ForEach(Array(group.blocks.enumerated()), id: \.offset) { _, block in
            if single == nil, let kind = block.kind {
                HStack {
                    CardListHeader(title: block.title, count: block.rows.count)
                    Spacer()
                    kindSwitch(kind).padding(.top, 10).padding(.trailing, 6)
                }
            }
            ForEach(block.rows) { row in
                if case let .source(key) = row.selection {
                    SelectableCard(id: SourcesSelection.source(key), padding: 10) {
                        HStack {
                            SearchRowView(row: row)
                            Spacer()
                            if let source = store.source(key) {
                                SourceSwitch(
                                    label: source.label,
                                    isOn: source.enabled,
                                    help: source.enabled ? "Turn \(source.label) off" : "Turn \(source.label) on"
                                ) { value in Task { await store.setSource(key, enabled: value) } }
                            }
                        }
                    }
                }
            }
        }
        if group.id == .telegram { FollowChannel(store: store).padding(.horizontal, 4) }
    }

    private func kindSwitch(_ kind: Applyant_V1_SearchSourceKind) -> some View {
        let title = SourcesText.kindTitle(kind.kind, label: kind.label)
        let off = kind.kind == "board"
            ? "Switch every job board off (the searches across companies are boards too; the index has its own switch)"
            : SourcesText.isAts(kind.kind)
                ? "Switch every \(title) source off, its companies in the index too"
                : "Switch every \(title) source off"
        return SourceSwitch(label: "All \(title) sources", isOn: kind.enabled, help: kind.enabled ? off : "Switch \(title) back on") { value in
            Task { await store.setSource(kind.kind, enabled: value) }
        }
    }
}

/// A row's switch: small, its label for VoiceOver only.
struct SourceSwitch: View {
    let label: String
    let isOn: Bool
    let help: String
    let set: @Sendable (Bool) -> Void

    var body: some View {
        Toggle(label, isOn: Binding(get: { isOn }, set: set))
            .toggleStyle(.switch)
            .controlSize(.mini)
            .labelsHidden()
            .help(help)
    }
}

/// A row's words: its title, one line under it, and its chips.
private struct RowText: View {
    let title: String
    let subtitle: String
    let chips: [Chip]
    let on: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).textRole(.rowTitle, color: on ? Theme.text : Theme.secondaryText).lineLimit(1)
            Text(subtitle).textRole(.meta).lineLimit(1)
            if !chips.isEmpty {
                HStack(spacing: 4) { ForEach(chips, id: \.text) { ChipView(chip: $0) } }
                    .padding(.top, 2)
            }
        }
    }
}

// MARK: - The detail

struct SourcesDetail: View {
    let store: AppStore

    var body: some View {
        switch store.navigation.sources {
        case let .source(key)?:
            if let s = store.source(key) {
                SourceDetail(store: store, source: s)
            } else {
                EmptyState(title: "Source gone", systemImage: ApplyantKit.Section.sources.symbol, art: .searching)
            }
        case let .ats(ats)?:
            AtsIndexPage(store: store, ats: ats).id(ats)
        case .index?, nil:
            AtsIndexPage(store: store, ats: nil)
        }
    }
}

/// The index (`ats` nil) or one ATS in it: its switch, its totals and its companies; the whole
/// index also has each ATS and the discovery runs.
private struct AtsIndexPage: View {
    let store: AppStore
    let ats: String?

    var body: some View {
        if let index = store.atsIndex {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                    if let ats {
                        if let a = index.ats.first(where: { $0.ats == ats }) {
                            atsPage(a, index: index)
                        } else {
                            Callout(.info, title: "\(SourcesText.kindTitle(ats)) isn't in the index", detail: "Its companies aren't read or searched through the index.")
                        }
                    } else {
                        indexPage(index)
                    }
                    IndexCompaniesBrowser(store: store, ats: ats, atsChoices: index.ats.map(\.ats)).entrance(4)
                }
                .pageColumn()
            }
        } else if let problem = store.atsIndexProblem {
            EmptyState(
                title: "The ATS index isn't here yet",
                systemImage: ApplyantKit.Section.sources.symbol,
                detail: SourcesText.indexUnavailable(problem),
                art: .searching
            )
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private func indexPage(_ index: AtsIndex) -> some View {
        let on = index.enabled
        PageHeader(title: SourceGroupID.index.title, subtitle: SourcesText.indexLine(index)) {
            ArtView(.searching, size: 56)
        }
        Prose("Greenhouse, Ashby, Lever and the other ATSs have no search across companies, so Applyant keeps an index of every company board it has found, each read on its own schedule. Every search looks through it, so it sees every company, not only the ones you watch.", size: .compact)
            .entrance(1)
        Toggle(isOn: Binding(
            get: { on },
            set: { value in Task { await store.setSource(SourcesText.indexKey, enabled: value) } }
        )) {
            Text(on ? "On: every search looks through these companies" : "Off: searches don't look through the index").textRole(.body)
        }
        .toggleStyle(.switch)
        .entrance(1)
        StatStrip(SourcesText.indexTotals(index).map { StatStrip.Item(label: $0.label, value: $0.value) }).entrance(2)
        if !index.ats.isEmpty {
            Card(title: "By ATS", systemImage: "square.stack.3d.up") {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(index.ats.enumerated()), id: \.element.ats) { i, a in
                        if i > 0 { Rectangle().fill(Theme.hairline).frame(height: 1) }
                        AtsLine(store: store, ats: a, indexOn: on)
                    }
                }
            }
            .entrance(3)
        }
        DiscoveryCard(store: store, index: index).entrance(3)
    }

    @ViewBuilder
    private func atsPage(_ a: AtsIndexAts, index: AtsIndex) -> some View {
        let row = SourcesText.atsRow(a)
        let watched = store.search.sources.filter { $0.kind == a.ats }.count
        PageHeader(title: row.title, subtitle: "In the index" + (row.lastReadAt.map { " · last read " + $0.formatted(.relative(presentation: .named)) } ?? "")) {
            IconTile(systemImage: "building.2", size: 56, colors: a.enabled && index.enabled ? [Theme.world(.new).main, Theme.world(.applied).main] : [Theme.glyph, Theme.raised])
        }
        Toggle(isOn: Binding(
            get: { a.enabled },
            set: { value in Task { await store.setSource(a.ats, enabled: value) } }
        )) {
            Text(a.enabled ? "On: its companies are read and searched" : "Off: its companies are neither read nor searched").textRole(.body)
        }
        .toggleStyle(.switch)
        .entrance(1)
        if !index.enabled {
            Callout(.info, title: "The whole index is off", detail: "Searches don't look through any ATS's companies until it's on again.") {
                Button("Turn On") { Task { await store.setSource(SourcesText.indexKey, enabled: true) } }
            }
        }
        StatStrip(SourcesText.atsTotals(a).map { StatStrip.Item(label: $0.label, value: $0.value) }, maxColumns: 6).entrance(2)
        if watched > 0 {
            MetaLine("You also watch \(watched) of its boards (Watched companies); its switch covers them too.", systemImage: "eye")
        }
    }
}

/// One ATS on the index's page: what it holds, when it was last read, and its switch; a click
/// opens it.
private struct AtsLine: View {
    let store: AppStore
    let ats: AtsIndexAts
    let indexOn: Bool

    var body: some View {
        let row = SourcesText.atsRow(ats)
        HStack(spacing: 10) {
            Button { store.navigation.sources = .ats(ats.ats) } label: {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title).textRole(.itemTitle, color: row.on && indexOn ? Theme.text : Theme.secondaryText)
                        MetaLine(row.subtitle + " · " + (row.lastReadAt.map { "read " + $0.formatted(.relative(presentation: .named)) } ?? "not read yet"))
                    }
                    Spacer(minLength: 8)
                    ForEach(row.chips, id: \.text) { ChipView(chip: $0) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Its companies")
            SourceSwitch(label: row.title, isOn: row.on, help: row.on ? "Switch \(row.title) off: its boards are neither read nor searched" : "Switch \(row.title) back on") { value in
                Task { await store.setSource(ats.ats, enabled: value) }
            }
        }
        .padding(.vertical, 8)
    }
}

/// Where the index finds its companies: the latest discovery run, and Find More Companies.
private struct DiscoveryCard: View {
    let store: AppStore
    let index: AtsIndex

    var body: some View {
        let latest = index.discoveries.first
        let running = SourcesText.discovering(index)
        Card(title: "Finding companies", systemImage: "sparkle.magnifyingglass") {
            HStack(spacing: 8) {
                if running { ProgressView().controlSize(.mini) }
                Button(running ? "Looking…" : "Find More Companies") { Task { await store.discoverIndexCompanies() } }
                    .buttonStyle(.secondary)
                    .controlSize(.small)
                    .disabled(running)
                    .help(running
                        ? "A discovery is waiting or running"
                        : "Looks for more company boards now: in Common Crawl's index of the web, behind postings and in the job searches (it also runs weekly)")
            }
        } content: {
            if let d = latest {
                VStack(alignment: .leading, spacing: 6) {
                    MetaLine(
                        SourcesText.discoveryLine(d) + " · " + (d.hasFinishedAt ? d.finishedAt : d.startedAt).date.formatted(.relative(presentation: .named)),
                        systemImage: d.status == "failed" ? "exclamationmark.triangle.fill" : "sparkle.magnifyingglass",
                        tone: d.status == "failed" ? .warning : nil
                    )
                    if d.hasNote, !d.note.isEmpty { Prose(d.note, size: .compact) }
                }
            } else {
                Text("No discovery has run yet. It runs weekly, or now with Find More Companies.").textRole(.body, color: Theme.secondaryText)
            }
        }
    }
}

/// The index's companies a page at a time: found by name, one ATS or all, only the ones your
/// searches match if you like; each with its status, counts, board and switch.
private struct IndexCompaniesBrowser: View {
    let store: AppStore
    /// The ATS page's own ATS (no ATS picker then).
    let ats: String?
    let atsChoices: [String]
    @State private var filter: IndexCompanyFilter

    init(store: AppStore, ats: String?, atsChoices: [String]) {
        self.store = store
        self.ats = ats
        self.atsChoices = atsChoices
        _filter = State(initialValue: IndexCompanyFilter(ats: ats))
    }

    var body: some View {
        // The page on screen while the next loads, if it's from the same ATS scope.
        let page = store.indexCompanies.flatMap { $0.filter.ats == filter.ats ? $0 : nil }
        Card(title: "Companies", systemImage: "building.2") {
            if let page { Text(page.line).textRole(.meta) }
        } content: {
            HStack(spacing: 8) {
                TextField("Find a company", text: Binding(get: { filter.query }, set: { filter.query = $0; filter.offset = 0 }))
                    .textFieldStyle(.glass)
                if ats == nil {
                    Picker("ATS", selection: Binding(get: { filter.ats }, set: { filter.ats = $0; filter.offset = 0 })) {
                        Text("Every ATS").tag(String?.none)
                        ForEach(atsChoices, id: \.self) { Text(SourcesText.kindTitle($0)).tag(Optional($0)) }
                    }
                    .labelsHidden()
                    .fixedSize()
                }
                PillPicker(
                    items: [false, true],
                    title: { $0 ? "Matching" : "All" },
                    selection: Binding(get: { filter.matchingOnly }, set: { filter.matchingOnly = $0; filter.offset = 0 }),
                    accessibilityLabel: "Which companies"
                )
                .help("Matching: only companies with open jobs your searches match")
            }
            if let problem = store.indexCompaniesProblem {
                MetaLine("Couldn't load the companies: \(problem)", systemImage: "exclamationmark.triangle.fill", tone: .warning)
            }
            if let page {
                if page.companies.isEmpty {
                    Text(filter.query.isEmpty && !filter.matchingOnly
                        ? "No companies here yet. Find More Companies looks for them."
                        : "No company matches.")
                        .textRole(.body, color: Theme.secondaryText)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(page.companies.enumerated()), id: \.element.id) { i, c in
                            if i > 0 { Rectangle().fill(Theme.hairline).frame(height: 1) }
                            IndexCompanyLine(store: store, company: c, showsAts: ats == nil)
                        }
                    }
                }
                if page.previous != nil || page.next != nil {
                    HStack(spacing: 8) {
                        Button { if let f = page.previous { filter = f } } label: { Label("Previous", systemImage: "chevron.left") }
                            .disabled(page.previous == nil)
                        Text(page.line).textRole(.meta)
                        Button { if let f = page.next { filter = f } } label: { Label("Next", systemImage: "chevron.right") }
                            .disabled(page.next == nil)
                    }
                    .buttonStyle(.secondary)
                    .controlSize(.small)
                    .frame(maxWidth: .infinity)
                }
            } else if store.indexCompaniesProblem == nil {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity)
            }
        }
        .task(id: filter) {
            // Typing waits for a pause; a page or a filter picked loads at once.
            if let shown = store.indexCompanies?.filter, shown.query != filter.query {
                try? await Task.sleep(for: .milliseconds(300))
                if Task.isCancelled { return }
            }
            await store.loadIndexCompanies(filter)
        }
    }
}

/// A company of the index: its name, status and counts, when it was read, its board, and its
/// switch.
private struct IndexCompanyLine: View {
    let store: AppStore
    let company: IndexCompany
    let showsAts: Bool

    var body: some View {
        let c = company
        let title = SourcesText.companyTitle(c)
        let read = c.hasLastReadAt ? "read " + c.lastReadAt.date.formatted(.relative(presentation: .named)) : nil
        let meta = ([SourcesText.companyLine(c, showsAts: showsAts), read, SourcesText.foundVia(c.foundVia)] as [String?])
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        HStack(spacing: 10) {
            CompanyAvatar(name: title, size: 28).opacity(c.enabled ? 1 : 0.5)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(title).textRole(.itemTitle, color: c.enabled ? Theme.text : Theme.secondaryText).lineLimit(1)
                    ForEach(SourcesText.companyChips(c), id: \.text) { ChipView(chip: $0) }
                }
                MetaLine(meta, details: c.hasLastNote && !c.lastNote.isEmpty ? c.lastNote : nil)
            }
            Spacer(minLength: 8)
            if !c.boardURL.isEmpty, let url = URL(string: c.boardURL) {
                Link("Board ↗", destination: url)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.accent)
                    .help(c.boardURL)
            }
            SourceSwitch(
                label: title,
                isOn: c.enabled,
                help: c.enabled ? "Leave \(title) out: it isn't read or searched" : "Take \(title) back into the index"
            ) { value in Task { await store.setIndexCompany(c.id, enabled: value) } }
        }
        .padding(.vertical, 7)
    }
}

// MARK: - A source

/// One source: its note, its switch, what it found, how its last read went, and a career
/// page's listing recipe.
struct SourceDetail: View {
    let store: AppStore
    let source: SearchSource

    var body: some View {
        let s = source
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                PageHeader(title: s.label, subtitle: SourcesText.kindTitle(s.kind)) {
                    IconTile(systemImage: "dot.radiowaves.left.and.right", size: 56, colors: s.enabled && s.kindEnabled ? [Theme.world(.new).main, Theme.world(.applied).main] : [Theme.glyph, Theme.raised])
                        .help(s.key)
                } trailing: {
                    if s.origin == "agent" { ChipView(chip: Chip(text: "Found by the agent", tone: .accent)) }
                }
                if s.hasNote { Prose(s.note, size: .compact) }
                Toggle(isOn: Binding(
                    get: { s.enabled },
                    set: { on in Task { await store.setSource(s.key, enabled: on) } }
                )) {
                    Text(s.enabled ? "On: searches that include it read it" : "Off: never read").textRole(.body)
                }
                .toggleStyle(.switch)
                .entrance(1)
                if !s.kindEnabled {
                    Callout(.warning, title: "All \(SourcesText.kindTitle(s.kind)) sources are off", detail: "So this one isn't read either.")
                }
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: Theme.Space.l, verticalSpacing: Theme.Space.s) {
                    fact("Results", SearchText.stats(s.stats))
                    fact("Its list", s.completeList
                        ? "complete: a posting it stops listing is closed"
                        : "the latest jobs only: a posting it stops listing is checked again, never closed")
                    if s.hasResolved { fact("Read as", s.resolved) }
                    fact("Last read", s.hasLastRunAt
                        ? s.lastRunAt.date.formatted(.relative(presentation: .named)) + (s.hasLastNote ? " · \(s.lastNote)" : "")
                        : "not yet")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.cardPadding)
                .cardSurface()
                .entrance(2)
                if let detail = store.sourceDetails[s.key], detail.hasRecipe {
                    RecipeView(store: store, source: detail).entrance(3)
                }
            }
            .pageColumn()
        }
        .task(id: source.key) { await store.openSource(source.key) }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).textRole(.body, color: Theme.secondaryText)
            Text(value).textRole(.body).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A career page's listing recipe: how it reads the page, and the jobs it read when it was built,
/// to check against the page itself.
struct RecipeView: View {
    let store: AppStore
    let source: SearchSource

    var body: some View {
        let r = source.recipe
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("How this page is read").textRole(.heading)
                ChipView(chip: SearchText.recipeChip(r))
                Spacer()
                Button("Rebuild") { Task { await store.rebuildRecipe(source.key) } }
                    .buttonStyle(.secondary)
                    .disabled(r.status == "building")
                    .help("This page has no feed, so Applyant worked out where its job list is. Rebuild makes it work that out again, for when the page changed")
            }
            if r.hasNote { Prose(r.note, size: .compact) }
            if r.hasBuiltAt {
                MetaLine("Built \(r.builtAt.date.formatted(.relative(presentation: .named))) · \(r.builds) build\(r.builds == 1 ? "" : "s")"
                    + (r.hasLastCount ? " · last read \(r.lastCount) jobs" : ""))
            }
            ForEach(r.description_p, id: \.self) { line in
                Text(line).font(.system(size: 11).monospaced()).foregroundStyle(Theme.secondaryText).textSelection(.enabled)
            }
            if !r.listings.isEmpty {
                Text("Read when it was built (\(r.listings.count), first page)").textRole(.itemTitle)
                ForEach(r.listings, id: \.url) { l in
                    VStack(alignment: .leading, spacing: 1) {
                        if let url = URL(string: l.url) {
                            Link(l.title, destination: url)
                        } else {
                            Text(l.title)
                        }
                        let meta = [l.hasLocation ? l.location : nil, l.hasTeam ? l.team : nil].compactMap { $0 }
                        if !meta.isEmpty { Text(meta.joined(separator: " · ")).textRole(.meta) }
                    }
                }
            }
        }
        .padding(Theme.cardPadding)
        .cardSurface()
    }
}

/// Telegram channels (phase 15): follow one by its @name or t.me link; its public preview is read.
struct FollowChannel: View {
    let store: AppStore
    @State private var channel = ""

    var body: some View {
        HStack {
            TextField("Follow a channel: @name or t.me/name", text: $channel)
                .textFieldStyle(.glass)
                .onSubmit(follow)
            Button("Follow", action: follow)
                .controlSize(.small)
                .disabled(TelegramText.channelLocator(channel) == nil)
        }
    }

    private func follow() {
        let value = channel
        Task { if await store.followChannel(value) { channel = "" } }
    }
}
