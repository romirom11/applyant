// Agent runs: every search run, newest first, with what each source gave and the run's own
// events (the verification, scoring and form reading of the postings it found carry its id).
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct RunsList: View {
    let store: AppStore

    var body: some View {
        Group {
            if store.searchRuns.isEmpty {
                ContentUnavailableView(
                    "No runs yet",
                    systemImage: ApplyantKit.Section.agentRuns.symbol,
                    description: Text("A search strategy's runs show here. `applyant runs show` has every task's events.")
                )
            } else {
                List(store.searchRuns, id: \.id, selection: Binding(
                    get: { store.navigation.run },
                    set: { store.navigation.run = $0 }
                )) { run in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(SearchText.runTitle(run)).font(.headline).lineLimit(1)
                        Text(run.startedAt.date.formatted(date: .abbreviated, time: .shortened) + " · " + SearchText.trigger(run.trigger))
                            .font(.subheadline).foregroundStyle(.secondary)
                        HStack(spacing: 4) { ForEach(SearchText.runChips(run), id: \.text) { ChipView(chip: $0) } }
                    }
                    .padding(.vertical, 3)
                    .tag(run.id)
                }
            }
        }
        .navigationTitle("Agent runs")
        .task { await store.openSearch() }
    }
}

struct RunDetail: View {
    let store: AppStore

    var body: some View {
        if let id = store.navigation.run, let run = store.searchRuns.first(where: { $0.id == id }) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(SearchText.runTitle(run)).font(.title2.weight(.semibold))
                    RunSummary(store: store, run: run)
                    Text("Events").font(.headline)
                    if let events = store.runEvents[id] {
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(events, id: \.id) { e in
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text(e.at.date.formatted(date: .omitted, time: .standard))
                                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                    Text(SearchText.eventLine(e)).font(.caption).textSelection(.enabled)
                                }
                            }
                        }
                    } else {
                        ProgressView()
                    }
                }
                .padding(20)
                .frame(maxWidth: 900, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .task(id: id) { await store.openRun(id) }
        } else {
            ContentUnavailableView("Pick a run", systemImage: ApplyantKit.Section.agentRuns.symbol)
        }
    }
}
