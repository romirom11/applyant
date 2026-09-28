// The agent interview: what waits for an answer, each project with what its facts don't show,
// and one conversation at a time. Answers become confirmed facts; an application question's
// answer prepares its application again.
import ApplyantKit
import SwiftUI

struct InterviewList: View {
    let store: AppStore

    var body: some View {
        let rows = store.interviewRows
        Group {
            if rows.waiting.isEmpty && rows.projects.isEmpty {
                ContentUnavailableView(
                    "No projects yet",
                    systemImage: ApplyantKit.Section.interview.symbol,
                    description: Text("Add a CV or a repository first (`applyant candidate source add`).")
                )
            } else {
                List(selection: Binding(
                    get: { store.navigation.interview },
                    set: { store.navigation.interview = $0 }
                )) {
                    if !rows.waiting.isEmpty {
                        SwiftUI.Section("Waiting for you") {
                            ForEach(rows.waiting) { InterviewRowView(row: $0).tag($0.target) }
                        }
                    }
                    if !rows.projects.isEmpty {
                        SwiftUI.Section("Projects") {
                            ForEach(rows.projects) { InterviewRowView(row: $0).tag($0.target) }
                        }
                    }
                }
            }
        }
        .navigationTitle("Interview")
    }
}

struct InterviewRowView: View {
    let row: InterviewRow

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(row.title).font(.headline).lineLimit(2)
            Text(row.subtitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            if !row.chips.isEmpty {
                HStack(spacing: 4) { ForEach(row.chips, id: \.text) { ChipView(chip: $0) } }
            }
        }
        .padding(.vertical, 3)
    }
}

struct InterviewThreadView: View {
    let store: AppStore
    let target: InterviewTarget
    @State private var answer = ""
    @FocusState private var answering: Bool

    var body: some View {
        Group {
            if let thread = store.interviewThreads[target] {
                VStack(spacing: 0) {
                    ScrollViewReader { proxy in
                        ScrollView {
                            VStack(alignment: .leading, spacing: 14) {
                                header(thread)
                                ForEach(thread.questions, id: \.id) { q in
                                    exchange(q).id(q.id)
                                }
                                footer(thread)
                            }
                            .padding(20)
                            .frame(maxWidth: 760, alignment: .leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .onChange(of: thread.questions.last?.id) { _, last in
                            if let last { withAnimation { proxy.scrollTo(last, anchor: .bottom) } }
                        }
                    }
                    if let open = InterviewText.openQuestion(thread) {
                        Divider()
                        composer(open)
                    }
                }
            } else {
                ProgressView()
            }
        }
        .task(id: target) { await store.openInterview(target) }
    }

    // MARK: Pieces

    @ViewBuilder
    private func header(_ thread: InterviewThread) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if thread.hasProject {
                let p = thread.project
                Text(p.project.name).font(.title2.weight(.semibold))
                Text(p.gaps.isEmpty
                    ? "Its facts cover your role, what you built, the team and the results."
                    : "Its facts don't show yet: " + p.gapLabels.joined(separator: "; ") + ".")
                    .foregroundStyle(.secondary)
            } else if let first = thread.questions.first {
                Text(first.hasApplication ? first.application : "An application").font(.title2.weight(.semibold))
                Text("The application asks this, and nothing Applyant knows answers it yet. Your answer is saved as facts and used for this application and later ones.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func exchange(_ q: InterviewQuestion) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "bubble.left.fill").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(q.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    if q.hasContext {
                        Text(q.origin == "application" ? "Missing: \(q.context)" : q.context)
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(10)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))

            if q.hasAnswer {
                HStack {
                    Spacer(minLength: 60)
                    Text(q.answer)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(10)
                        .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
                }
            }
            switch q.status {
            case "processing":
                Label("Reading your answer…", systemImage: "hourglass").font(.callout).foregroundStyle(.secondary)
            case "dismissed":
                Label("Left for later", systemImage: "clock").font(.callout).foregroundStyle(.secondary)
            case "open" where q.hasNote:
                Label(q.note, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange)
            default:
                EmptyView()
            }
            if !q.facts.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Saved as facts").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(q.facts, id: \.id) { f in
                        Label {
                            Text(f.text + (f.hasProjectSlug ? "  · \(f.projectSlug)" : "")).font(.callout)
                        } icon: {
                            Image(systemName: "checkmark.seal.fill").foregroundStyle(.green)
                        }
                    }
                }
                .padding(.leading, 26)
            } else if q.status == "answered" {
                Text(q.hasNote ? q.note : "Nothing saved from this answer")
                    .font(.caption).foregroundStyle(.secondary).padding(.leading, 26)
            }
        }
    }

    @ViewBuilder
    private func footer(_ thread: InterviewThread) -> some View {
        if thread.pending && InterviewText.openQuestion(thread) == nil {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(thread.questions.contains { $0.status == "processing" } ? "Reading your answer…" : "Writing a question…")
                    .foregroundStyle(.secondary)
            }
        } else if InterviewText.canAskMore(thread) {
            let p = thread.project
            HStack {
                if !thread.questions.isEmpty {
                    Text(p.gaps.isEmpty ? "That's all for now." : "Nothing more asked for now.").foregroundStyle(.secondary)
                }
                Spacer()
                Button(p.asked == 0 ? "Start the interview" : "Ask me more") {
                    Task { await store.startInterview(project: p.project.id) }
                }
                .buttonStyle(.borderedProminent)
            }
        } else if !thread.hasProject, let q = thread.questions.last, q.hasApplicationID, q.status != "open", q.status != "processing" {
            HStack {
                Text(q.status == "dismissed"
                    ? "Left for you to answer in review."
                    : "Your answer went to the application; it's prepared again with it.")
                    .foregroundStyle(.secondary)
                Spacer()
                if let app = store.applications[q.applicationID] {
                    Button("Open the application") {
                        store.navigation.showReview(application: app.id, posting: app.postingID)
                    }
                }
            }
        }
    }

    private func composer(_ q: InterviewQuestion) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            TextEditor(text: $answer)
                .font(.body)
                .frame(minHeight: 70, maxHeight: 160)
                .focused($answering)
                .overlay(alignment: .topLeading) {
                    if answer.isEmpty {
                        Text("Your answer, in your own words: it's saved as a fact you stand behind")
                            .foregroundStyle(.tertiary).padding(.top, 1).padding(.leading, 5).allowsHitTesting(false)
                    }
                }
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            HStack {
                Button("Later") {
                    Task { await store.dismissInterview(target, question: q.id) }
                }
                .help(q.hasApplicationID ? "You can write this answer yourself in review" : "Skip this question for now")
                Spacer()
                Button("Send") { send(q) }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(14)
        .onAppear { answering = true }
    }

    private func send(_ q: InterviewQuestion) {
        let text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        answer = ""
        Task { await store.answerInterview(target, question: q.id, text: text) }
    }
}
