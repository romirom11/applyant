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
                Button { creating = true } label: { Label("New search", systemImage: "plus") }
                Button { Task { await store.planSearch() } } label: {
                    Label(store.planning ? "Planning…" : "Plan searches", systemImage: "sparkle.magnifyingglass")
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
                    Label(SearchText.planSummary(plan), systemImage: "sparkle.magnifyingglass")
                        .font(.caption).foregroundStyle(Theme.secondaryText).lineLimit(3)
                        .padding(.horizontal, 6).padding(.top, 6)
                }
                CardListHeader(title: "Searches", count: strategies.count, tint: world.main)
                if strategies.isEmpty {
                    Text("No searches yet. Press Plan searches to have them proposed from your profile, or New search to write one yourself.")
                        .font(.callout).foregroundStyle(Theme.secondaryText).padding(.horizontal, 6)
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
                        Toggle("", isOn: Binding(
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
                                    Toggle(source.enabled ? "Turn \(source.label) off" : "Turn \(source.label) on", isOn: Binding(
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
            Text(row.title).font(.system(size: 13.5, weight: .bold)).lineLimit(2)
                .foregroundStyle(row.on ? Theme.text : Theme.secondaryText)
            Text(row.subtitle).font(.system(size: 12)).foregroundStyle(Theme.secondaryText).lineLimit(1)
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
            EmptyState(
                title: "Search",
                systemImage: ApplyantKit.Section.search.symbol,
                detail: "A search looks for job titles in the sources below, on its schedule, and puts what it finds in New. Pick a search to see what it looks for and how it's doing, or a source to switch it off.",
                art: .search
            )
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
                    ArtView(s.running ? .searching : .search, size: 64)
                } trailing: {
                    if s.origin == "agent" { ChipView(chip: Chip(text: "Agent-generated", tone: .accent)) }
                }
                FlowRow(spacing: 8) {
                    Button {
                        Task { await store.setStrategy(s.id, paused: s.state != "paused") }
                    } label: {
                        Label(s.state == "paused" ? "Resume" : "Pause", systemImage: s.state == "paused" ? "play.fill" : "pause.fill")
                    }
                    Button { Task { await store.runStrategy(s.id) } } label: { Label("Run now", systemImage: "bolt.fill") }
                        .disabled(s.running || s.sourceKeys.isEmpty)
                        .help(s.running ? "A run is waiting or running" : "Search now, outside the schedule")
                    Button { editing = true } label: { Label("Edit…", systemImage: "pencil") }
                    Button(role: .destructive) { confirmingDelete = true } label: { Label("Delete…", systemImage: "trash") }
                    if s.running {
                        HStack(spacing: 6) {
                            LiveDot(color: Theme.world(.search).main, size: 6)
                            Text("Running…").foregroundStyle(Theme.secondaryText)
                        }
                        .shimmer()
                    }
                }
                .buttonStyle(.secondary)
                .entrance(1)
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        Text("Looks for").foregroundStyle(Theme.secondaryText)
                        Text(s.queries.isEmpty ? "every listing" : s.queries.map { "“\($0)”" }.joined(separator: ", "))
                    }
                    GridRow {
                        Text("Where").foregroundStyle(.secondary)
                        Text(s.locations.isEmpty ? "anywhere" : s.locations.joined(separator: ", "))
                    }
                    if s.hasNote {
                        GridRow {
                            Text("Why").foregroundStyle(.secondary)
                            Text(s.note)
                        }
                    }
                    GridRow {
                        Text("Schedule").foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(schedule(s))
                            if s.hasCadenceNote {
                                Text(s.cadenceNote.prefix(1).uppercased() + s.cadenceNote.dropFirst())
                                    .font(.caption).foregroundStyle(.orange)
                            }
                        }
                    }
                    GridRow {
                        Text("Reads").foregroundStyle(.secondary)
                        Text(s.sourceKeys.isEmpty
                            ? "nothing: every source it selects (\(s.sources.joined(separator: ", "))) is off"
                            : s.sourceKeys.compactMap { store.source($0)?.label }.joined(separator: ", "))
                    }
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
            .padding(Theme.pagePadding)
            .frame(maxWidth: Theme.readableWidth, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .sheet(isPresented: $editing) {
            StrategyEditorSheet(store: store, strategy: s) { editing = false }.worldSheet()
        }
        .confirmationDialog("Delete \(s.name)?", isPresented: $confirmingDelete) {
            Button("Delete the search", role: .destructive) { Task { await store.deleteStrategy(s.id) } }
        } message: {
            Text("It stops searching. The postings it found stay.")
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
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(run.startedAt.date.formatted(date: .abbreviated, time: .shortened)).font(.callout.weight(.medium))
                Text(SearchText.trigger(run.trigger)).font(.callout).foregroundStyle(.secondary)
                ForEach(SearchText.runChips(run), id: \.text) { ChipView(chip: $0) }
                Spacer()
                Button("Events") {
                    store.navigation.section = .agentRuns
                    store.navigation.run = run.id
                }
                .buttonStyle(.secondary)
                .controlSize(.small)
            }
            if run.hasNote { Text(run.note).font(.caption).foregroundStyle(.secondary) }
            ForEach(run.sources, id: \.sourceKey) { src in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(src.label).font(.caption.weight(.medium)).frame(width: 170, alignment: .leading).lineLimit(1)
                    Text(SearchText.runSource(src)).font(.caption)
                        .foregroundStyle(src.hasError ? Color.orange : .secondary)
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
                PageHeader(title: s.label, subtitle: s.key) {
                    IconTile(systemImage: "dot.radiowaves.left.and.right", size: 52, colors: s.enabled && s.kindEnabled ? [Theme.world(.new).main, Theme.world(.applied).main] : [.gray, Color(white: 0.35)])
                } trailing: {
                    if s.origin == "agent" { ChipView(chip: Chip(text: "Found by the agent", tone: .accent)) }
                }
                if s.hasNote { Text(s.note).font(.callout) }
                Toggle(isOn: Binding(
                    get: { s.enabled },
                    set: { on in Task { await store.setSource(s.key, enabled: on) } }
                )) {
                    Text(s.enabled ? "On: searches that include it read it" : "Off: never read")
                }
                .toggleStyle(.switch)
                .entrance(1)
                if !s.kindEnabled {
                    Label("All \(SearchText.kindTitles[s.kind] ?? s.kind) sources are off, so this one isn't read either.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        Text("Results").foregroundStyle(.secondary)
                        Text(SearchText.stats(s.stats))
                    }
                    GridRow {
                        Text("Its list").foregroundStyle(.secondary)
                        Text(s.completeList
                            ? "complete: a posting it stops listing is closed"
                            : "the latest jobs only: a posting it stops listing is checked again, never closed")
                    }
                    if s.hasResolved {
                        GridRow {
                            Text("Read as").foregroundStyle(.secondary)
                            Text(s.resolved)
                        }
                    }
                    GridRow {
                        Text("Last read").foregroundStyle(.secondary)
                        Text(s.hasLastRunAt
                            ? s.lastRunAt.date.formatted(.relative(presentation: .named)) + (s.hasLastNote ? " · \(s.lastNote)" : "")
                            : "not yet")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.cardPadding)
                .cardSurface()
                .entrance(2)
                if let detail = store.sourceDetails[s.key], detail.hasRecipe {
                    RecipeView(store: store, source: detail).entrance(3)
                }
            }
            .padding(Theme.pagePadding)
            .frame(maxWidth: Theme.readableWidth, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: source.key) { await store.openSource(source.key) }
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
                Text("How this page is read").font(.headline)
                ChipView(chip: SearchText.recipeChip(r))
                Spacer()
                Button("Rebuild") { Task { await store.rebuildRecipe(source.key) } }
                    .buttonStyle(.secondary)
                    .disabled(r.status == "building")
                    .help("This page has no feed, so Applyant worked out where its job list is. Rebuild makes it work that out again, for when the page changed")
            }
            if r.hasNote { Text(r.note).font(.callout).foregroundStyle(.secondary) }
            if r.hasBuiltAt {
                Text("Built \(r.builtAt.date.formatted(.relative(presentation: .named))) · \(r.builds) build(s)"
                    + (r.hasLastCount ? " · last read \(r.lastCount) jobs" : ""))
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(r.description_p, id: \.self) { line in
                Text(line).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if !r.listings.isEmpty {
                Text("Read when it was built (\(r.listings.count), first page)").font(.subheadline.weight(.medium))
                ForEach(r.listings, id: \.url) { l in
                    VStack(alignment: .leading, spacing: 1) {
                        if let url = URL(string: l.url) {
                            Link(l.title, destination: url)
                        } else {
                            Text(l.title)
                        }
                        let meta = [l.hasLocation ? l.location : nil, l.hasTeam ? l.team : nil].compactMap { $0 }
                        if !meta.isEmpty { Text(meta.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
        }
        .padding(Theme.cardPadding)
        .cardSurface()
    }
}
