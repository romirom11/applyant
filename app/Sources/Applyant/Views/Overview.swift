// The Overview: the funnel (found → … → offer) in the list column, each step with its share of
// the one before (a step opens its list), and the PRD's success metrics as cards in the detail: the target, whether it
// holds, and what the number measures. The window (7 days · 30 days · all) is picked above the
// funnel; the store loads it again as postings and applications move.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct OverviewFunnel: View {
    @Bindable var store: AppStore

    var body: some View {
        VStack(spacing: 0) {
            PillPicker(items: OverviewText.windows, title: OverviewText.title, selection: $store.overviewWindow)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            Divider().opacity(0.6)
            if let report = store.overview {
                let rows = OverviewText.funnel(report.funnel)
                let top = max(rows.first?.count ?? 0, 1)
                List {
                    SwiftUI.Section {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            let list = OverviewText.section(forStep: row.id)
                            FunnelRowView(row: row, share: Double(row.count) / Double(top), index: index)
                                .contentShape(Rectangle())
                                // A step opens the list its postings are in now.
                                .onTapGesture {
                                    guard let list else { return }
                                    store.navigation.section = list
                                    store.navigation.select(nil)
                                }
                                .help(list.map { "Open \($0.title)" } ?? "")
                        }
                    } header: {
                        Text(OverviewText.since(report))
                    } footer: {
                        Text("Postings first seen in the window, and how far each got.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else {
                ProgressView().frame(maxHeight: .infinity)
            }
        }
        .navigationTitle("Overview")
        .task(id: store.overviewWindow) { await store.openOverview() }
    }
}

struct FunnelRowView: View {
    let row: FunnelRow
    /// The step's count against the first step's, for the bar.
    let share: Double
    /// Its place in the funnel: the bars grow one after another, and darken down the funnel.
    var index = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.label).font(.headline)
                Spacer()
                Text("\(row.count)")
                    .font(Theme.number(20, weight: .semibold))
                    .contentTransition(.numericText(value: Double(row.count)))
                    .animation(Theme.Motion.snappy, value: row.count)
            }
            Meter(value: share, color: index.isMultiple(of: 2) ? Theme.accent : Theme.violet, height: 6, delay: Stagger.delay(index, step: 0.06))
            if let conversion = row.conversion {
                Text(conversion).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

struct OverviewMetrics: View {
    let store: AppStore

    var body: some View {
        if let report = store.overview {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                    PageHeader(
                        title: "How it's going",
                        subtitle: OverviewText.title(report.window == .unspecified ? store.overviewWindow : report.window)
                            + " · " + OverviewText.since(report),
                        systemImage: "chart.line.uptrend.xyaxis"
                    )
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 250), spacing: 14, alignment: .top)], spacing: 14) {
                        ForEach(Array(report.metrics.enumerated()), id: \.element.key) { index, metric in
                            MetricCard(metric: metric).entrance(index + 1)
                        }
                    }
                }
                .padding(Theme.pagePadding)
                .frame(maxWidth: 940, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            EmptyState(
                title: "Overview",
                systemImage: ApplyantKit.Section.overview.symbol,
                detail: "The funnel and how the success metrics are doing."
            )
        }
    }
}

struct MetricCard: View {
    let metric: OverviewMetric
    @State private var appeared = false

    var body: some View {
        let standing = OverviewText.standing(metric)
        Card(tint: standing == .met ? Theme.good : standing == .missed ? Theme.warning : nil) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(metric.label).font(.headline)
                    Spacer()
                    mark(standing)
                }
                Text(metric.display)
                    .font(Theme.number(26))
                    .contentTransition(.numericText())
                    .animation(Theme.Motion.snappy, value: metric.display)
                Text(OverviewText.target(metric)).font(.callout).foregroundStyle(.secondary)
                if !metric.definition.isEmpty {
                    Text(metric.definition).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder
    private func mark(_ standing: OverviewText.Standing) -> some View {
        switch standing {
        case .met:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).help("On target")
                .symbolEffect(.bounce, options: .nonRepeating, value: appeared)
                .onAppear { appeared = true }
        case .missed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).help("Below target")
                .symbolEffect(.wiggle, options: .nonRepeating, value: appeared)
                .onAppear { appeared = true }
        case .noData:
            Text("No data yet").font(.caption).foregroundStyle(.secondary)
        case .watched:
            Text("Watched").font(.caption).foregroundStyle(.secondary)
        }
    }
}
