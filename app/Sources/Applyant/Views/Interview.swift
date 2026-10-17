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
                EmptyState(
                    title: "No projects yet",
                    systemImage: ApplyantKit.Section.interview.symbol,
                    detail: "Questions are asked about your projects. Import your CV or add a project first."
                ) {
                    Button("Open Projects") {
                        store.showOnboarding = false
                        store.navigation.section = .projects
                    }
                    .buttonStyle(.primary)
                    if store.showOnboarding {
                        Button("Back to Import") { store.onboarding.open(.importing) }.buttonStyle(.secondary)
                    }
                }
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
        .navigationTitle("Questions for you")
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
    @State private var dictation = Dictation()

    var body: some View {
        Group {
            if let thread = store.interviewThreads[target] {
                VStack(spacing: 0) {
                    ScrollViewReader { proxy in
                        ScrollView {
                            VStack(alignment: .leading, spacing: 16) {
                                header(thread)
                                ForEach(Array(thread.questions.enumerated()), id: \.element.id) { index, q in
                                    exchange(q).id(q.id).entrance(index + 1)
                                }
                                footer(thread)
                            }
                            .animation(Theme.Motion.smooth, value: thread.questions.map(\.status))
                            .padding(Theme.pagePadding)
                            .frame(maxWidth: 760, alignment: .leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .onChange(of: thread.questions.last?.id) { _, last in
                            if let last { withAnimation { proxy.scrollTo(last, anchor: .bottom) } }
                        }
                    }
                    if let open = InterviewText.openQuestion(thread) {
                        Divider().opacity(0.6)
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
        if thread.hasProject {
            let p = thread.project
            PageHeader(
                title: p.project.name,
                subtitle: p.gaps.isEmpty
                    ? "Its facts cover your role, what you built, the team and the results."
                    : "Its facts don't show yet: " + p.gapLabels.joined(separator: "; ") + ".",
                systemImage: "folder.fill"
            )
        } else if let first = thread.questions.first {
            PageHeader(
                title: first.hasApplication ? first.application : "An application",
                subtitle: "The application asks this, and nothing Applyant knows answers it yet. Your answer is saved as facts and used for this application and later ones.",
                systemImage: "doc.text.fill"
            )
        }
    }

    private func exchange(_ q: InterviewQuestion) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "sparkles")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(Theme.brand)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(q.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    if q.hasContext {
                        Text(q.origin == "application" ? "Missing: \(q.context)" : q.context)
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .bubble(mine: false)
            .padding(.trailing, 60)

            if q.hasAnswer {
                HStack {
                    Spacer(minLength: 60)
                    Text(q.answer)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .bubble(mine: true)
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
            HStack(spacing: 10) {
                TypingDots()
                Text(thread.questions.contains { $0.status == "processing" } ? "Reading your answer…" : "Writing a question…")
                    .foregroundStyle(.secondary)
            }
            .bubble(mine: false)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        } else if InterviewText.canAskMore(thread) {
            let p = thread.project
            HStack {
                if !thread.questions.isEmpty {
                    Text(p.gaps.isEmpty ? "That's all for now." : "Nothing more asked for now.").foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    Task { await store.startInterview(project: p.project.id) }
                } label: {
                    Label(p.asked == 0 ? "Start the interview" : "Ask me more", systemImage: "sparkles")
                }
                .buttonStyle(.primary)
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
                        store.navigation.showReview(app)
                    }
                    .buttonStyle(.secondary)
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
                .composerField()
            if case let .failed(why) = dictation.state {
                Text(why).font(.caption).foregroundStyle(.orange)
            } else if dictation.listening {
                Text("Listening: speak, then press Stop. You can correct the text before sending.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Button("Later") {
                    dictation.stop()
                    Task { await store.dismissInterview(target, question: q.id) }
                }
                .buttonStyle(.secondary)
                .help(q.hasApplicationID ? "You can write this answer yourself in review" : "Skip this question for now")
                DictateButton(dictation: dictation, spoken: store.spokenLanguages, text: $answer)
                Spacer()
                Button { send(q) } label: { Label("Send", systemImage: "arrow.up") }
                    .buttonStyle(.primary)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(14)
        .onAppear { answering = true }
        .task { await store.loadSpokenLanguages() }
        .onDisappear { dictation.stop() }
    }

    private func send(_ q: InterviewQuestion) {
        let text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        dictation.stop()
        answer = ""
        Task { await store.answerInterview(target, question: q.id, text: text) }
    }
}

/// The microphone button and its language: speaks the answer into the field.
private struct DictateButton: View {
    let dictation: Dictation
    /// Language codes from the candidate's preferences ("uk", "en").
    let spoken: [String]
    @Binding var text: String

    var body: some View {
        let offered = DictationLanguages.offered(supported: Dictation.supported, spoken: spoken, system: Locale.preferredLanguages)
        HStack(spacing: 4) {
            Button {
                if dictation.listening {
                    dictation.stop()
                } else {
                    if dictation.locale == nil || !offered.contains(dictation.locale ?? "") {
                        dictation.locale = DictationLanguages.initial(saved: dictation.locale, offered: offered)
                    }
                    dictation.start(base: text) { text = $0 }
                }
            } label: {
                Label(dictation.listening ? "Stop" : "Dictate", systemImage: dictation.listening ? "stop.circle.fill" : "mic")
            }
            .tint(dictation.listening ? .red : nil)
            .keyboardShortcut("d", modifiers: .command)
            .help("Speak your answer (⌘D starts and stops): it's turned into text here by the Mac's speech recognition")
            Picker("Language", selection: Binding(
                get: { DictationLanguages.initial(saved: dictation.locale, offered: offered) ?? "" },
                set: { dictation.locale = $0 }
            )) {
                ForEach(offered, id: \.self) { Text(DictationLanguages.name($0, among: offered)).tag($0) }
            }
            .labelsHidden()
            .fixedSize()
            .disabled(dictation.listening)
            .help("The language you'll speak")
        }
    }
}
