// Search: the strategies that find postings on their own and the sources they read, each with
// what it found, verified and what you marked interested. Every strategy can be paused or run
// now, and every source (or a whole kind) switched off: a source that's off is never queried.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct SearchList: View {
    let store: AppStore

    var body: some View {
        let strategies = store.strategyRows
        let groups = SearchText.sourceGroups(store.search)
        List(selection: Binding(
            get: { store.navigation.search },
            set: { store.navigation.search = $0 }
        )) {
            SwiftUI.Section("Strategies") {
                if strategies.isEmpty {
                    Text("No strategies yet. Add one with `applyant search strategies add`.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                ForEach(strategies) { row in
                    SearchRowView(row: row).tag(row.selection)
                }
            }
            ForEach(groups, id: \.kind.kind) { group in
                SwiftUI.Section {
                    ForEach(group.rows) { row in
                        SearchRowView(row: row).tag(row.selection)
                    }
                } header: {
                    HStack {
                        Text(group.kind.label)
                        Spacer()
                        Toggle("", isOn: Binding(
                            get: { group.kind.enabled },
                            set: { on in Task { await store.setSource(group.kind.kind, enabled: on) } }
                        ))
                        .toggleStyle(.switch)
                        .controlSize(.mini)
                        .labelsHidden()
                        .help(group.kind.enabled ? "Switch every \(group.kind.label) source off" : "Switch \(group.kind.label) back on")
                    }
                }
            }
        }
        .navigationTitle("Search")
        .task { await store.openSearch() }
    }
}

struct SearchRowView: View {
    let row: SearchRow

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(row.title).font(.headline).lineLimit(2)
                .foregroundStyle(row.on ? .primary : .secondary)
            Text(row.subtitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            if !row.chips.isEmpty {
                HStack(spacing: 4) { ForEach(row.chips, id: \.text) { ChipView(chip: $0) } }
            }
        }
        .padding(.vertical, 3)
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
                ContentUnavailableView("Strategy gone", systemImage: "magnifyingglass")
            }
        case let .source(key)?:
            if let s = store.source(key) {
                SourceDetail(store: store, source: s)
            } else {
                ContentUnavailableView("Source gone", systemImage: "magnifyingglass")
            }
        case nil:
            ContentUnavailableView(
                "Search",
                systemImage: ApplyantKit.Section.search.symbol,
                description: Text("Strategies find postings on their own, on their schedule. Pick one to see what it searches and how it's doing, or a source to switch it off.")
            )
        }
    }
}

struct StrategyDetail: View {
    let store: AppStore
    let strategy: SearchStrategy

    var body: some View {
        let s = strategy
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(s.name).font(.title2.weight(.semibold))
                        if s.origin == "agent" { ChipView(chip: Chip(text: "Agent-generated", tone: .accent)) }
                    }
                    Text(SearchText.stats(s.stats)).foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    Button(s.state == "paused" ? "Resume" : "Pause") {
                        Task { await store.setStrategy(s.id, paused: s.state != "paused") }
                    }
                    Button("Run now") { Task { await store.runStrategy(s.id) } }
                        .disabled(s.running || s.sourceKeys.isEmpty)
                        .help(s.running ? "A run is waiting or running" : "Search now, outside the schedule")
                    if s.running {
                        ProgressView().controlSize(.small)
                        Text("Running…").foregroundStyle(.secondary)
                    }
                }
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 6) {
                    GridRow {
                        Text("Looks for").foregroundStyle(.secondary)
                        Text(s.queries.isEmpty ? "every listing" : s.queries.map { "“\($0)”" }.joined(separator: ", "))
                    }
                    GridRow {
                        Text("Where").foregroundStyle(.secondary)
                        Text(s.locations.isEmpty ? "anywhere" : s.locations.joined(separator: ", "))
                    }
                    GridRow {
                        Text("Schedule").foregroundStyle(.secondary)
                        Text(schedule(s))
                    }
                    GridRow {
                        Text("Reads").foregroundStyle(.secondary)
                        Text(s.sourceKeys.isEmpty
                            ? "nothing: every source it selects (\(s.sources.joined(separator: ", "))) is off"
                            : s.sourceKeys.compactMap { store.source($0)?.label }.joined(separator: ", "))
                    }
                }
                let runs = store.runs(of: s.id)
                if !runs.isEmpty {
                    Text("Recent runs").font(.headline)
                    ForEach(runs.prefix(5), id: \.id) { run in
                        RunSummary(store: store, run: run)
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: 820, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func schedule(_ s: SearchStrategy) -> String {
        var parts = ["every \(SearchText.every(s.everyMinutes))"]
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
                .buttonStyle(.link)
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
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct SourceDetail: View {
    let store: AppStore
    let source: SearchSource

    var body: some View {
        let s = source
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(s.label).font(.title2.weight(.semibold))
                    Text(s.key).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Toggle(isOn: Binding(
                    get: { s.enabled },
                    set: { on in Task { await store.setSource(s.key, enabled: on) } }
                )) {
                    Text(s.enabled ? "On: strategies that select it read it" : "Off: never queried")
                }
                .toggleStyle(.switch)
                if !s.kindEnabled {
                    Label("All \(SearchText.kindTitles[s.kind] ?? s.kind) sources are off, so this one isn't read either.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 6) {
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
            }
            .padding(20)
            .frame(maxWidth: 820, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
