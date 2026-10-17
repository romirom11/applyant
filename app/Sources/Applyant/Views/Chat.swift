// Chat: questions about the candidate's own experience, answered from the profile, projects
// and confirmed facts. Messages rise in as they arrive; the reply's dots bounce while it's written.
import ApplyantKit
import SwiftUI

struct ChatView: View {
    let store: AppStore
    @State private var draft = ""
    @State private var confirmingClear = false
    /// The conversation's width: a bubble gets 70% of it.
    @State private var columnWidth: CGFloat = 800
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            ModuleHeader(section: .chat, subtitle: "Answers from your profile, projects and confirmed facts") {
                Button("New Conversation") { confirmingClear = true }
                    .buttonStyle(.secondary)
                    .controlSize(.small)
                    .disabled(store.chatMessages.isEmpty || store.chatSending)
            }
            .padding(.horizontal, Theme.pagePadding)
            .padding(.top, Theme.Space.m)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Theme.blockSpacing) {
                        if store.chatMessages.isEmpty {
                            EmptyState(
                                title: "Ask about your experience",
                                systemImage: "bubble.left.and.text.bubble.right",
                                detail: "Chat uses your profile, projects and confirmed facts. You can ask what supports a claim, compare your experience with a role, or work through how to describe a project.",
                                art: .chat
                            )
                            .frame(maxWidth: .infinity, minHeight: 300)
                        }
                        ForEach(Array(store.chatMessages.enumerated()), id: \.element.id) { index, message in
                            ChatBubble(
                                message: message,
                                facts: store.chatFacts,
                                maxWidth: (columnWidth - 2 * Theme.pagePadding) * 0.7,
                                retry: retry(before: index)
                            )
                            .id(message.id)
                            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity).combined(with: .scale(scale: 0.96, anchor: message.role == "user" ? .bottomTrailing : .bottomLeading)))
                        }
                        if store.chatSending {
                            HStack(spacing: 10) {
                                TypingDots()
                                Text("Thinking…").textRole(.body, color: Theme.secondaryText)
                            }
                            .bubble(mine: false)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }
                    }
                    .animation(Theme.Motion.pick(Theme.Motion.bouncy, reduceMotion: reduceMotion), value: store.chatMessages.count)
                    .animation(Theme.Motion.smooth, value: store.chatSending)
                    .pageColumn()
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { columnWidth = $0 }
                // The top message slides under a soft edge, not a hard cut.
                .overlay(alignment: .top) { EdgeScrim(edge: .top, height: 24) }
                .onChange(of: store.chatMessages.count) { _, _ in
                    if let last = store.chatMessages.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }

            Composer(
                text: $draft,
                placeholder: "Ask about your experience…",
                canSend: !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                sending: store.chatSending,
                send: send
            )
            .padding(Theme.cardPadding)
            .glass(radius: Theme.panelRadius)
            .pageColumn()
        }
        .navigationTitle("Chat")
        .confirmationDialog("Clear this conversation?", isPresented: $confirmingClear) {
            Button("Clear Conversation", role: .destructive) { Task { await store.clearChat() } }
        } message: {
            Text("Its messages will be removed from Applyant. Your profile and facts stay available for the new conversation.")
        }
        .task { await store.openChat() }
    }

    /// An answer's Retry: asks the question before it again (nil for the candidate's own).
    private func retry(before index: Int) -> (() -> Void)? {
        let messages = store.chatMessages
        guard messages[index].role != "user",
              let question = messages[..<index].last(where: { $0.role == "user" })?.text
        else { return nil }
        return { Task { _ = await store.sendChat(question) } }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { if await store.sendChat(text) { draft = "" } }
    }
}

private struct ChatBubble: View {
    let message: ChatMessage
    let facts: [Int64: Fact]
    /// The widest the bubble gets: 70% of the conversation's width.
    let maxWidth: CGFloat
    /// Asks the question again; nil for the candidate's own messages.
    var retry: (() -> Void)?
    @State private var showsFacts = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let mine = message.role == "user"
        HStack {
            if mine { Spacer(minLength: 0) }
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    Text(mine ? "You" : "Applyant").textRole(.label, color: mine ? .white : nil)
                    Text(message.text)
                        .textRole(.prose, color: mine ? .white : nil)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    if !message.factIds.isEmpty {
                        DisclosureLine("\(message.factIds.count) confirmed fact\(message.factIds.count == 1 ? "" : "s") used", isExpanded: $showsFacts)
                        if showsFacts {
                            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                                ForEach(message.factIds, id: \.self) { id in
                                    if let fact = facts[id] {
                                        Text(fact.text)
                                            .textRole(.body, color: Theme.secondaryText)
                                            .textSelection(.enabled)
                                            .help("Fact \(id)")
                                    }
                                }
                            }
                            .transition(.reveal(reduceMotion: reduceMotion))
                        }
                    }
                }
                .bubble(mine: mine)
                .animation(Theme.Motion.pick(Theme.Motion.disclose, reduceMotion: reduceMotion), value: showsFacts)
                if !mine {
                    // What's generated can be taken away or asked for again.
                    HStack(spacing: Theme.Space.s) {
                        small("Copy", help: "Copy this answer") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(message.text, forType: .string)
                        }
                        if let retry { small("Retry", help: "Ask the question again", action: retry) }
                    }
                    .padding(.leading, Theme.Space.xs)
                }
            }
            .frame(maxWidth: max(maxWidth, 280), alignment: mine ? .trailing : .leading)
            if !mine { Spacer(minLength: 0) }
        }
    }

    /// A quiet action under an answer, padded to a 22-point target.
    private func small(_ title: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.secondaryText)
                .padding(.vertical, 4)
                .padding(.horizontal, 4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}
