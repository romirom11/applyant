// Agent runs: every search run, newest first, with what each source gave and the run's own
// events (the verification, scoring and form reading of the postings it found carry its id);
// and every model run (role, provider/model, tokens, duration, outcome, what it was for).
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct RunsList: View {
    let store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ModuleHeader(
                section: .agentRuns,
                subtitle: store.navigation.modelRuns ? "\(store.agentRuns.count) recent model runs" : "\(store.searchRuns.count) recent search runs"
            )
            .columnHeader()
            PillPicker(items: [false, true], title: { $0 ? "Model runs" : "Search runs" }, selection: Binding(
                get: { store.navigation.modelRuns },
                set: { store.navigation.modelRuns = $0 }
            ), tint: Theme.world(.agentRuns).main)
            .padding(.horizontal, 16)
            .padding(.bottom, 6)
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
            EmptyState(
                title: "No runs yet",
                systemImage: ApplyantKit.Section.agentRuns.symbol,
                detail: "Every run of a search shows here, with what it found. Add a search in Search to get the first one.",
                art: .agentRuns
            )
        } else {
            CardList(
                selection: Binding(get: { store.navigation.run }, set: { store.navigation.run = $0 }),
                order: store.searchRuns.map(\.id),
                tint: Theme.world(.agentRuns).main
            ) {
                // One header per batch: the schedule starts every search in the same minute.
                ForEach(SearchText.runBatches(store.searchRuns)) { batch in
                    CardListHeader(title: batch.title, count: batch.runs.count)
                    ForEach(batch.runs, id: \.id) { run in
                        SelectableCard(id: run.id, padding: 11) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(run.strategyName).textRole(.rowTitle).lineLimit(1)
                                Text("run \(run.id)").textRole(.meta).lineLimit(1)
                                Spacer(minLength: 4)
                                ForEach(SearchText.runRowChips(run), id: \.text) { ChipView(chip: $0) }
                            }
                        }
                        .sheen(run.status == "queued", radius: Theme.rowRadius)
                    }
                }
            }
            // The newest run is open from the start: the detail is never a blank.
            .task(id: store.searchRuns.first?.id) {
                if store.navigation.run == nil, let newest = store.searchRuns.first { store.navigation.run = newest.id }
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
            EmptyState(
                title: "No model runs yet",
                systemImage: "cpu",
                detail: "Every call to Claude, Codex or the on-device model shows here: verifying, scoring, writing, research.",
                art: .agentRuns
            )
        } else {
            // Read-only cards: nothing to pick.
            CardList(selection: .constant(Int64?.none), order: [], tint: Theme.world(.agentRuns).main) {
                ForEach(store.agentRuns, id: \.id) { run in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(AgentRunText.role(run)).textRole(.rowTitle).lineLimit(1)
                            Spacer()
                            ChipView(chip: AgentRunText.outcome(run))
                        }
                        Text(AgentRunText.line(run)).textRole(.meta).monospacedDigit().lineLimit(2)
                        if let entity = AgentRunText.entity(run) {
                            Text(entity).textRole(.body).lineLimit(1)
                        }
                        if let problem = AgentRunText.problem(run) {
                            HStack(alignment: .firstTextBaseline, spacing: 5) {
                                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warning).font(.system(size: 11))
                                Text(problem).textRole(.meta, color: Theme.text).lineLimit(3).textSelection(.enabled)
                            }
                        }
                        Text(Ago.text(run.startedAt.date) + " · " + run.startedAt.date.formatted(date: .abbreviated, time: .shortened))
                            .textRole(.meta)
                    }
                    .padding(11)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.insetFill, in: RoundedRectangle(cornerRadius: Theme.rowRadius, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Theme.rowRadius, style: .continuous).strokeBorder(Theme.hairline, lineWidth: 1))
                }
            }
        }
    }
}

struct RunDetail: View {
    let store: AppStore

    var body: some View {
        if store.navigation.modelRuns {
            EmptyState(
                title: "Model runs",
                systemImage: "cpu",
                detail: "\(store.agentRuns.count) recent runs on the left: what each model call was for, how long it took and whether it worked.",
                art: .agentRuns
            )
        } else if let id = store.navigation.run, let run = store.searchRuns.first(where: { $0.id == id }) {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                    PageHeader(
                        title: SearchText.runTitle(run),
                        subtitle: run.startedAt.date.formatted(date: .abbreviated, time: .shortened) + " · " + SearchText.trigger(run.trigger)
                    ) {
                        ArtView(.agentRuns, size: 56)
                    }
                    RunSummary(store: store, run: run).entrance(1)
                    CardTitle(title: "Events", systemImage: "list.bullet.rectangle").padding(.top, 4)
                    if let events = store.runEvents[id] {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(events, id: \.id) { e in
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text(e.at.date.formatted(date: .omitted, time: .standard))
                                        .textRole(.meta).monospacedDigit()
                                    Text(SearchText.eventLine(e)).textRole(.meta, color: Theme.text).textSelection(.enabled)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Theme.cardPadding)
                        .cardSurface()
                        .entrance(2)
                    } else {
                        ProgressView()
                    }
                }
                .pageColumn()
            }
            .task(id: id) { await store.openRun(id) }
        } else {
            EmptyState(
                title: "Pick a run",
                systemImage: ApplyantKit.Section.agentRuns.symbol,
                detail: "Each run on the left says what its sources listed and what was new. Pick one to see its events.",
                art: .agentRuns
            )
        }
    }
}
