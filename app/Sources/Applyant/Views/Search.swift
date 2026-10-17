// Search: the strategies that find postings on their own and the sources they read, each with
// what it found, verified and what you marked interested. Every strategy can be paused or run
// now, and every source (or a whole kind) switched off: a source that's off is never queried.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct SearchList: View {
    let store: AppStore
    @State private var creating = false

    var body: some View {
        let strategies = store.strategyRows
        let groups = SearchText.sourceGroups(store.search)
        let world = Theme.world(.search)
        let on = store.search.sources.filter { $0.enabled && $0.kindEnabled }.count
        VStack(alignment: .leading, spacing: 0) {
            ModuleHeader(section: .search, subtitle: "\(strategies.count) search\(strategies.count == 1 ? "" : "es") · \(on) of \(store.search.sources.count) sources on")
                .columnHeader()
            HStack(spacing: 6) {
                Button { creating = true } label: { Label("New Search", systemImage: "plus") }
                Button { Task { await store.planSearch() } } label: {
                    Label(store.planning ? "Planning…" : "Plan Searches", systemImage: "sparkle.magnifyingglass")
                }
                .disabled(store.planning)
                .help(store.planning
                    ? "The planner is running"
                    : "Applyant proposes searches from your profile and looks for new job boards on the web (2–4 minutes)")
                if store.planning { ProgressView().controlSize(.mini) }
            }
            .buttonStyle(.secondary)
            .controlSize(.small)
            .padding(.horizontal, 16)
            .padding(.bottom, 4)
            CardList(
                selection: Binding(get: { store.navigation.search }, set: { store.navigation.search = $0 }),
                order: strategies.map(\.selection) + groups.flatMap { $0.rows.map(\.selection) },
                tint: world.main
            ) {
                if let plan = store.search.plans.first {
                    PlanLine(plan: plan).padding(.horizontal, 6).padding(.top, 6)
                }
                HStack(alignment: .lastTextBaseline) {
                    CardListHeader(title: "Searches", count: strategies.count, tint: world.main)
                    Spacer(minLength: 8)
                    // Who made them, said once instead of on every row.
                    if let origin = SearchText.origin(store.search) {
                        MetaLine(origin).padding(.trailing, 6)
                    }
                }
                if strategies.isEmpty {
                    Text("No searches yet. Press Plan Searches to have them proposed from your profile, or New Search to write one yourself.")
                        .textRole(.body, color: Theme.secondaryText).padding(.horizontal, 6)
                }
                ForEach(strategies) { row in
                    SelectableCard(id: row.selection) { SearchRowView(row: row) }
                }
                CardListHeader(title: "Sources", tint: world.main)
                AddBoardOrPage(store: store).padding(.horizontal, 4)
                ForEach(groups, id: \.kind.kind) { group in
                    HStack {
                        CardListHeader(title: group.kind.label, count: group.rows.count)
                        Spacer()
                        Toggle("All \(group.kind.label) sources", isOn: Binding(
                            get: { group.kind.enabled },
                            set: { on in Task { await store.setSource(group.kind.kind, enabled: on) } }
                        ))
                        .toggleStyle(.switch)
                        .controlSize(.mini)
                        .labelsHidden()
                        .padding(.top, 10)
                        .padding(.trailing, 6)
                        .help(group.kind.enabled ? "Switch every \(group.kind.label) source off" : "Switch \(group.kind.label) back on")
                    }
                    ForEach(group.rows) { row in
                        SelectableCard(id: row.selection, padding: 10) {
                            HStack {
                                SearchRowView(row: row)
                                Spacer()
                                if case let .source(key) = row.selection, let source = store.source(key) {
                                    Toggle(source.label, isOn: Binding(
                                        get: { source.enabled },
                                        set: { on in Task { await store.setSource(key, enabled: on) } }
                                    ))
                                    .toggleStyle(.switch)
                                    .controlSize(.mini)
                                    .labelsHidden()
                                    .help(source.enabled ? "Turn \(source.label) off" : "Turn \(source.label) on")
                                }
                            }
                        }
                    }
                    if group.kind.kind == "telegram" { FollowChannel(store: store).padding(.horizontal, 4) }
                }
            }
        }
        .navigationTitle("Search")
        .task { await store.openSearch() }
        .sheet(isPresented: $creating) {
            StrategyEditorSheet(store: store, strategy: nil) { creating = false }.worldSheet()
        }
    }
}

/// The planner's last run in a line, what it said behind Details….
private struct PlanLine: View {
    let plan: SearchPlan
    @State private var showsNote = false

    var body: some View {
        HStack(spacing: 8) {
            MetaLine(SearchText.planLine(plan), systemImage: "sparkle.magnifyingglass", tone: plan.status == "failed" ? .warning : nil)
            if plan.hasNote, !plan.note.isEmpty {
                Button("Details…") { showsNote.toggle() }
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                    .popover(isPresented: $showsNote, arrowEdge: .bottom) {
                        Prose(plan.note, size: .compact)
                            .padding(Theme.cardPadding)
                            .frame(width: 380, alignment: .leading)
                    }
            }
        }
    }
}

/// Telegram channels (phase 15): follow one by its @name or t.me link; its public preview is read.
struct FollowChannel: View {
    let store: AppStore
    @State private var channel = ""

    var body: some View {
        HStack {
            TextField("Follow a channel: @name or t.me/name", text: $channel)
                .textFieldStyle(.roundedBorder)
                .controlSize(.small)
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

struct SearchRowView: View {
    let row: SearchRow

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(row.title).textRole(.rowTitle, color: row.on ? Theme.text : Theme.secondaryText).lineLimit(2)
            Text(row.subtitle).textRole(.meta).lineLimit(1)
            if !row.chips.isEmpty {
                HStack(spacing: 4) { ForEach(row.chips, id: \.text) { ChipView(chip: $0) } }
                    .padding(.top, 2)
            }
        }
    }
}

struct SearchDetail: View {
    let store: AppStore

    var body: some View {
        switch store.navigation.search {
        case let .strategy(id)?:
            if let s = store.strategy(id) {
                StrategyDetail(store: store, strategy: s)
            } else {
                EmptyState(title: "This search was deleted", systemImage: "magnifyingglass", art: .search)
            }
        case let .source(key)?:
            if let s = store.source(key) {
                SourceDetail(store: store, source: s)
            } else {
                EmptyState(title: "Source gone", systemImage: "magnifyingglass", art: .search)
            }
        case nil:
            SearchOverview(store: store)
        }
    }
}

/// Nothing picked: how the searching stands, what a search does, and the two ways to add one.
private struct SearchOverview: View {
    let store: AppStore
    @State private var creating = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                PageHeader(title: "Search", subtitle: "Searches run on their schedule and put what they find in New.") {
                    ArtView(.search, size: 56)
                }
                StatStrip(SearchText.summary(store.search, runs: store.searchRuns).map { StatStrip.Item(label: $0.label, value: $0.value) })
                    .entrance(1)
                Prose("A search looks for job titles in the sources it reads. Pick one on the left to see what it looks for and how it's doing, or a source to switch it off.")
                    .entrance(2)
                HStack(spacing: 8) {
                    Button { creating = true } label: { Label("New Search", systemImage: "plus") }
                        .buttonStyle(.secondary)
                    Button { Task { await store.planSearch() } } label: {
                        Label(store.planning ? "Planning…" : "Plan Searches", systemImage: "sparkle.magnifyingglass")
                    }
                    .buttonStyle(.secondary)
                    .disabled(store.planning)
                }
                .entrance(3)
            }
            .pageColumn()
        }
        .sheet(isPresented: $creating) {
            StrategyEditorSheet(store: store, strategy: nil) { creating = false }.worldSheet()
        }
    }
}

struct StrategyDetail: View {
    let store: AppStore
    let strategy: SearchStrategy
    @State private var editing = false
    @State private var confirmingDelete = false

    var body: some View {
        let s = strategy
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                PageHeader(title: s.name, subtitle: SearchText.stats(s.stats)) {
                    ArtView(s.running ? .searching : .search, size: 56)
                } trailing: {
                    if s.origin == "agent" { ChipView(chip: Chip(text: "Planned by Applyant", tone: .accent)) }
                }
                FlowRow(spacing: 8) {
                    Button {
                        Task { await store.setStrategy(s.id, paused: s.state != "paused") }
                    } label: {
                        Label(s.state == "paused" ? "Resume" : "Pause", systemImage: s.state == "paused" ? "play.fill" : "pause.fill")
                    }
                    Button { Task { await store.runStrategy(s.id) } } label: { Label("Run Now", systemImage: "bolt.fill") }
                        .disabled(s.running || s.sourceKeys.isEmpty)
                        .help(s.running ? "A run is waiting or running" : "Search now, outside the schedule")
                    Button { editing = true } label: { Label("Edit…", systemImage: "pencil") }
                    Button(role: .destructive) { confirmingDelete = true } label: { Label("Delete…", systemImage: "trash") }
                    if s.running {
                        HStack(spacing: 6) {
                            LiveDot(color: Theme.world(.search).main, size: 6)
                            Text("Running…").textRole(.body, color: Theme.secondaryText)
                        }
                        .shimmer()
                    }
                }
                .buttonStyle(.secondary)
                .entrance(1)
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: Theme.Space.l, verticalSpacing: Theme.Space.s) {
                    fact("Looks for", s.queries.isEmpty ? "every listing" : s.queries.map { "“\($0)”" }.joined(separator: ", "))
                    fact("Where", s.locations.isEmpty ? "anywhere" : s.locations.joined(separator: ", "))
                    if s.hasNote { fact("Why", s.note) }
                    GridRow {
                        Text("Schedule").textRole(.body, color: Theme.secondaryText)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(schedule(s)).textRole(.body)
                            if s.hasCadenceNote {
                                MetaLine(s.cadenceNote.prefix(1).uppercased() + s.cadenceNote.dropFirst(), systemImage: "exclamationmark.triangle.fill", tone: .warning)
                            }
                        }
                    }
                    fact("Reads", s.sourceKeys.isEmpty
                        ? "nothing: every source it selects (\(s.sources.joined(separator: ", "))) is off"
                        : s.sourceKeys.compactMap { store.source($0)?.label }.joined(separator: ", "))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.cardPadding)
                .cardSurface()
                .entrance(2)
                let runs = store.runs(of: s.id)
                if !runs.isEmpty {
                    CardTitle(title: "Recent runs", systemImage: "clock.arrow.circlepath").padding(.top, 4).entrance(3)
                    ForEach(Array(runs.prefix(5).enumerated()), id: \.element.id) { index, run in
                        RunSummary(store: store, run: run).entrance(4 + index)
                    }
                }
            }
            .pageColumn()
        }
        .sheet(isPresented: $editing) {
            StrategyEditorSheet(store: store, strategy: s) { editing = false }.worldSheet()
        }
        .confirmationDialog("Delete \(s.name)?", isPresented: $confirmingDelete) {
            Button("Delete Search", role: .destructive) { Task { await store.deleteStrategy(s.id) } }
        } message: {
            Text("It stops searching. The postings it found stay.")
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).textRole(.body, color: Theme.secondaryText)
            Text(value).textRole(.body).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func schedule(_ s: SearchStrategy) -> String {
        var parts = ["every \(SearchText.every(SearchText.effectiveEvery(s)))"]
        if s.hasLastRunAt { parts.append("last run " + s.lastRunAt.date.formatted(.relative(presentation: .named))) }
        parts.append(s.state == "paused" ? "paused" : "next " + s.nextRunAt.date.formatted(date: .omitted, time: .shortened))
        return parts.joined(separator: " · ")
    }
}

struct RunSummary: View {
    let store: AppStore
    let run: SearchRun

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            HStack(spacing: 6) {
                Text(run.startedAt.date.formatted(date: .abbreviated, time: .shortened)).textRole(.itemTitle)
                Text(SearchText.trigger(run.trigger)).textRole(.meta)
                ForEach(SearchText.runChips(run), id: \.text) { ChipView(chip: $0) }
                Spacer()
                Button("Events") {
                    store.navigation.section = .agentRuns
                    store.navigation.run = run.id
                }
                .buttonStyle(.secondary)
                .controlSize(.small)
            }
            if run.hasNote { Text(run.note).textRole(.meta).lineLimit(2).help(run.note) }
            ForEach(run.sources, id: \.sourceKey) { src in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(src.label).textRole(.meta, color: Theme.text).frame(width: 170, alignment: .leading).lineLimit(1)
                    if src.hasError {
                        MetaLine(SearchText.runSource(src), systemImage: "exclamationmark.triangle.fill", tone: .warning)
                    } else {
                        Text(SearchText.runSource(src)).textRole(.meta).lineLimit(1)
                    }
                }
            }
        }
        .padding(12)
        .cardSurface(radius: Theme.innerRadius + 3)
    }
}

struct SourceDetail: View {
    let store: AppStore
    let source: SearchSource

    var body: some View {
        let s = source
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                PageHeader(title: s.label, subtitle: SearchText.kindTitles[s.kind] ?? s.kind) {
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
                    Callout(.warning, title: "All \(SearchText.kindTitles[s.kind] ?? s.kind) sources are off", detail: "So this one isn't read either.")
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
