// Agent runs: every search run, newest first, with what each source gave and the run's own
// events (the verification, scoring and form reading of the postings it found carry its id);
// and every model run (role, provider/model, tokens, duration, outcome, what it was for).
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct RunsList: View {
    let store: AppStore

    var body: some View {
        VStack(spacing: 0) {
            Picker("Runs", selection: Binding(
                get: { store.navigation.modelRuns },
                set: { store.navigation.modelRuns = $0 }
            )) {
                Text("Search runs").tag(false)
                Text("Model runs").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            if store.navigation.modelRuns {
                ModelRunsList(store: store)
            } else {
                searchRuns
            }
        }
        .navigationTitle("Agent runs")
        .task {
            await store.openSearch()
            await store.openAgentRuns()
        }
    }

    @ViewBuilder
    private var searchRuns: some View {
        if store.searchRuns.isEmpty {
            ContentUnavailableView(
                "No runs yet",
                systemImage: ApplyantKit.Section.agentRuns.symbol,
                description: Text("Every run of a search shows here, with what it found. Add a search in Search to get the first one.")
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
}

/// Model runs, newest first: role · provider/model · tokens in/out · duration · outcome (the
/// error when not ok) · the entity · when.
struct ModelRunsList: View {
    let store: AppStore

    var body: some View {
        if store.agentRuns.isEmpty {
            ContentUnavailableView(
                "No model runs yet",
                systemImage: "cpu",
                description: Text("Every call to Claude, Codex or the on-device model shows here: verifying, scoring, writing, research.")
            )
        } else {
            List(store.agentRuns, id: \.id) { run in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(AgentRunText.role(run)).font(.headline).lineLimit(1)
                        Spacer()
                        ChipView(chip: AgentRunText.outcome(run))
                    }
                    Text(AgentRunText.line(run)).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary).lineLimit(2)
                    if let entity = AgentRunText.entity(run) {
                        Text(entity).font(.subheadline).lineLimit(1)
                    }
                    if let problem = AgentRunText.problem(run) {
                        Text(problem).font(.caption).foregroundStyle(.orange).lineLimit(3).textSelection(.enabled)
                    }
                    Text(Ago.text(run.startedAt.date) + " · " + run.startedAt.date.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption).foregroundStyle(.secondary)
                }
                .padding(.vertical, 3)
            }
        }
    }
}

struct RunDetail: View {
    let store: AppStore

    var body: some View {
        if store.navigation.modelRuns {
            ContentUnavailableView(
                "Model runs",
                systemImage: "cpu",
                description: Text("\(store.agentRuns.count) recent runs on the left: what each model call was for, how long it took and whether it worked.")
            )
        } else if let id = store.navigation.run, let run = store.searchRuns.first(where: { $0.id == id }) {
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
