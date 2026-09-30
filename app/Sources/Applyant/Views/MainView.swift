// The main window, Mail-style: sections → the section's list → the selected item.
import ApplyantKit
import SwiftUI

struct MainView: View {
    @Bindable var store: AppStore

    var body: some View {
        NavigationSplitView {
            Sidebar(store: store)
                .navigationSplitViewColumnWidth(min: 190, ideal: 210)
        } content: {
            Group {
                switch store.navigation.section {
                case .interview: InterviewList(store: store)
                case .search: SearchList(store: store)
                case .agentRuns: RunsList(store: store)
                case .companies: CompaniesList(store: store)
                case .whichApplication: WhichApplicationList(store: store)
                case .settings: SettingsView(store: store)
                case .profile: ProfileEditor(store: store).navigationTitle("Profile")
                case .projects: ProjectsList(store: store)
                default: PostingList(store: store)
                }
            }
            .navigationSplitViewColumnWidth(min: 280, ideal: 330)
        } detail: {
            Detail(store: store)
        }
        .toolbar {
            ToolbarItem(placement: .status) { ConnectionBadge(connection: store.connection) }
        }
        .sheet(isPresented: $store.showOnboarding) {
            OnboardingView(store: store)
                .frame(minWidth: 900, idealWidth: 980, minHeight: 640, idealHeight: 720)
        }
        .alert(
            "Applyant",
            isPresented: Binding(get: { store.lastError != nil }, set: { if !$0 { store.lastError = nil } }),
            actions: { Button("OK") { store.lastError = nil } },
            message: { Text(store.lastError ?? "") }
        )
    }
}

struct Detail: View {
    let store: AppStore

    var body: some View {
        if store.navigation.section == .profile {
            ProfileSourcesPane(store: store)
        } else if store.navigation.section == .projects {
            ProjectDetail(store: store)
        } else if store.navigation.section == .search {
            SearchDetail(store: store)
        } else if store.navigation.section == .agentRuns {
            RunDetail(store: store)
        } else if store.navigation.section == .companies {
            CompanyDetail(store: store)
        } else if store.navigation.section == .whichApplication {
            WhichApplicationDetail(store: store)
        } else if store.navigation.section == .interview {
            if let target = store.navigation.interview {
                InterviewThreadView(store: store, target: target)
                    .id(target)
            } else {
                ContentUnavailableView(
                    "The interview",
                    systemImage: ApplyantKit.Section.interview.symbol,
                    description: Text("Pick a question or a project on the left. Your answers become facts that applications can use.")
                )
            }
        } else if let app = store.navigation.reviewing {
            ReviewApplication(store: store, applicationId: app)
                .id(app)
        } else if let posting = store.navigation.postingId {
            PostingDetail(store: store, postingId: posting)
                .id(posting)
        } else {
            ContentUnavailableView("Nothing selected", systemImage: "tray", description: Text("Pick a posting on the left."))
        }
    }
}

struct ConnectionBadge: View {
    let connection: AppStore.Connection

    var body: some View {
        switch connection {
        case .connected:
            EmptyView()
        case .connecting:
            Label("Connecting…", systemImage: "circle.dotted").foregroundStyle(.secondary)
        case let .disconnected(reason):
            Label(reason, systemImage: "bolt.horizontal.circle").foregroundStyle(.orange)
        }
    }
}

struct Sidebar: View {
    @Bindable var store: AppStore

    var body: some View {
        List(selection: Binding(
            get: { store.navigation.section },
            set: { section in
                guard let section, section != store.navigation.section else { return }
                store.navigation.section = section
                store.navigation.postingId = nil
                store.navigation.reviewing = nil
            }
        )) {
            ForEach(Section.Group.allCases, id: \.self) { group in
                let sections = Section.allCases.filter { $0.group == group }
                if group == .top {
                    ForEach(sections) { row($0) }
                } else {
                    SwiftUI.Section(group.rawValue) {
                        ForEach(sections) { row($0) }
                    }
                }
            }
        }
        .listStyle(.sidebar)
    }

    private func row(_ section: ApplyantKit.Section) -> some View {
        let count = store.count(section)
        return Label(section.title, systemImage: section.symbol)
            .badge(count > 0 && section != .skipped ? count : 0)
            .foregroundStyle(section.isBuilt ? .primary : .secondary)
            .tag(section)
    }
}

struct PostingList: View {
    let store: AppStore

    var body: some View {
        let section = store.navigation.section
        let items = store.items(section)
        Group {
            if !section.isBuilt {
                ContentUnavailableView(
                    section.title,
                    systemImage: section.symbol,
                    description: Text("Comes with \(section.comesWith ?? "a later phase").")
                )
            } else if items.isEmpty {
                ContentUnavailableView(emptyTitle(section), systemImage: section.symbol)
            } else {
                List(items, selection: Binding(
                    get: { store.navigation.postingId.flatMap { id in items.first { $0.postingId == id }?.id } },
                    set: { select($0, in: items, section: section) }
                )) { item in
                    PostingRow(item: item).tag(item.id)
                }
            }
        }
        .navigationTitle(section.title)
    }

    private func select(_ id: String?, in items: [ListItem], section: ApplyantKit.Section) {
        guard let item = items.first(where: { $0.id == id }) else { return }
        store.navigation.postingId = item.postingId
        // Application sections open the review; posting sections open the posting.
        let reviewSections: Set<ApplyantKit.Section> = [.readyToReview, .preparing, .applied, .interviews, .offers]
        store.navigation.reviewing = reviewSections.contains(section) ? item.applicationId : nil
    }

    private func emptyTitle(_ section: ApplyantKit.Section) -> String {
        switch section {
        case .inbox: "No scored postings yet"
        case .readyToReview: "Nothing to review"
        case .preparing: "Nothing being prepared"
        case .applied: "No applications sent yet"
        case .interviews: "No interviews yet"
        case .offers: "No offers yet"
        default: "Empty"
        }
    }
}

struct PostingRow: View {
    let item: ListItem

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ScoreBadge(score: item.score)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title).font(.headline).lineLimit(2)
                if !item.subtitle.isEmpty {
                    Text(item.subtitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                if !item.chips.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(item.chips, id: \.text) { ChipView(chip: $0) }
                    }
                }
            }
        }
        .padding(.vertical, 3)
    }
}

struct ScoreBadge: View {
    let score: Int32?

    var body: some View {
        Text(score.map { "\($0)" } ?? "–")
            .font(.system(.title3, design: .rounded).weight(.semibold))
            .monospacedDigit()
            .frame(width: 38)
            .foregroundStyle(color)
    }

    private var color: Color {
        guard let score else { return .secondary }
        return score >= 80 ? .green : score >= 60 ? .primary : .secondary
    }
}

struct ChipView: View {
    let chip: Chip

    var body: some View {
        Text(chip.text)
            .font(.caption)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(tint.opacity(0.15), in: Capsule())
            .foregroundStyle(tint == .secondary ? Color.secondary : tint)
    }

    private var tint: Color {
        switch chip.tone {
        case .accent: .accentColor
        case .warning: .orange
        case .good: .green
        case .neutral: .secondary
        }
    }
}
