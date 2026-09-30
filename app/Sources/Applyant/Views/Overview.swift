// The Overview: the funnel (found → … → offer) in the list column, each step with its share of
// the one before, and the PRD's success metrics as cards in the detail: the target, whether it
// holds, and what the number measures. The window (7 days · 30 days · all) is picked above the
// funnel; the store loads it again as postings and applications move.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct OverviewFunnel: View {
    @Bindable var store: AppStore

    var body: some View {
        VStack(spacing: 0) {
            Picker("Window", selection: $store.overviewWindow) {
                ForEach(OverviewText.windows, id: \.self) { Text(OverviewText.title($0)).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            Divider()
            if let report = store.overview {
                let rows = OverviewText.funnel(report.funnel)
                let top = max(rows.first?.count ?? 0, 1)
                List {
                    SwiftUI.Section {
                        ForEach(rows) { row in
                            FunnelRowView(row: row, share: Double(row.count) / Double(top))
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

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.label).font(.headline)
                Spacer()
                Text("\(row.count)")
                    .font(.system(.title3, design: .rounded).weight(.semibold))
                    .monospacedDigit()
            }
            GeometryReader { geo in
                Capsule()
                    .fill(Color.accentColor.opacity(0.6))
                    .frame(width: max(row.count > 0 ? 4 : 0, geo.size.width * min(share, 1)))
            }
            .frame(height: 5)
            if let conversion = row.conversion {
                Text(conversion).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 3)
    }
}

struct OverviewMetrics: View {
    let store: AppStore

    var body: some View {
        if let report = store.overview {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("How it's going").font(.title2.weight(.semibold))
                        Text(OverviewText.title(report.window == .unspecified ? store.overviewWindow : report.window)
                            + " · " + OverviewText.since(report))
                            .foregroundStyle(.secondary)
                    }
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 250), spacing: 12, alignment: .top)], spacing: 12) {
                        ForEach(report.metrics, id: \.key) { MetricCard(metric: $0) }
                    }
                }
                .padding(20)
                .frame(maxWidth: 900, alignment: .leading)
            }
        } else {
            ContentUnavailableView(
                "Overview",
                systemImage: ApplyantKit.Section.overview.symbol,
                description: Text("The funnel and how the success metrics are doing.")
            )
        }
    }
}

struct MetricCard: View {
    let metric: OverviewMetric

    var body: some View {
        let standing = OverviewText.standing(metric)
        GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(metric.label).font(.headline)
                    Spacer()
                    mark(standing)
                }
                Text(metric.display)
                    .font(.system(.title3, design: .rounded).weight(.semibold))
                    .monospacedDigit()
                Text(OverviewText.target(metric)).font(.callout).foregroundStyle(.secondary)
                if !metric.definition.isEmpty {
                    Text(metric.definition).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
    }

    @ViewBuilder
    private func mark(_ standing: OverviewText.Standing) -> some View {
        switch standing {
        case .met:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).help("On target")
        case .missed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).help("Below target")
        case .noData:
            Text("No data yet").font(.caption).foregroundStyle(.secondary)
        case .watched:
            Text("Watched").font(.caption).foregroundStyle(.secondary)
        }
    }
}
