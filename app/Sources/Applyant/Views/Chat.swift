// Chat: questions about the candidate's own experience, answered from the profile, projects
// and confirmed facts. Messages rise in as they arrive; the reply's dots bounce while it's written.
import ApplyantKit
import SwiftUI

struct ChatView: View {
    let store: AppStore
    @State private var draft = ""
    @State private var confirmingClear = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            ModuleHeader(section: .chat, subtitle: "Answers from your profile, projects and confirmed facts") {
                Button("New conversation") { confirmingClear = true }
                    .buttonStyle(.secondary)
                    .controlSize(.small)
                    .disabled(store.chatMessages.isEmpty || store.chatSending)
            }
            .padding(.horizontal, 28)
            .padding(.top, 10)
            .padding(.bottom, 4)
            .frame(maxWidth: 900)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if store.chatMessages.isEmpty {
                            EmptyState(
                                title: "Ask about your experience",
                                systemImage: "bubble.left.and.text.bubble.right",
                                detail: "Chat uses your profile, projects and confirmed facts. You can ask what supports a claim, compare your experience with a role, or work through how to describe a project.",
                                art: .chat
                            )
                            .frame(maxWidth: .infinity, minHeight: 300)
                        }
                        ForEach(store.chatMessages, id: \.id) { message in
                            ChatBubble(message: message, facts: store.chatFacts)
                                .id(message.id)
                                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity).combined(with: .scale(scale: 0.96, anchor: message.role == "user" ? .bottomTrailing : .bottomLeading)))
                        }
                        if store.chatSending {
                            HStack(spacing: 10) {
                                TypingDots()
                                Text("Thinking…").foregroundStyle(.secondary)
                            }
                            .bubble(mine: false)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }
                    }
                    .animation(Theme.Motion.pick(Theme.Motion.bouncy, reduceMotion: reduceMotion), value: store.chatMessages.count)
                    .animation(Theme.Motion.smooth, value: store.chatSending)
                    .padding(24)
                    .frame(maxWidth: 850)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: store.chatMessages.count) { _, _ in
                    if let last = store.chatMessages.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }

            HStack(alignment: .bottom, spacing: 12) {
                TextEditor(text: $draft)
                    .font(.body)
                    .frame(minHeight: 52, maxHeight: 115)
                    .composerField()
                    .accessibilityLabel("Message")
                Button(action: send) { Label("Send", systemImage: "arrow.up") }
                    .buttonStyle(.primary)
                    .controlSize(.large)
                    .keyboardShortcut(.return, modifiers: .command)
                    .help("Send (⌘↩)")
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.chatSending)
            }
            .padding(14)
            .glass(radius: Theme.panelRadius)
            .padding(.horizontal, 16)
            .padding(.bottom, 14)
            .frame(maxWidth: 880)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("Chat")
        .confirmationDialog("Clear this conversation?", isPresented: $confirmingClear) {
            Button("Clear conversation", role: .destructive) { Task { await store.clearChat() } }
        } message: {
            Text("Its messages will be removed from Applyant. Your profile and facts stay available for the new conversation.")
        }
        .task { await store.openChat() }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { if await store.sendChat(text) { draft = "" } }
    }
}

private struct ChatBubble: View {
    let message: ChatMessage
    let facts: [Int64: Fact]

    var body: some View {
        HStack {
            if message.role == "user" { Spacer(minLength: 80) }
            VStack(alignment: .leading, spacing: 8) {
                Text(message.role == "user" ? "You" : "Applyant")
                    .font(.caption.weight(.semibold))
                    .opacity(0.7)
                Text(message.text).font(Theme.prose).lineSpacing(3).textSelection(.enabled)
                if !message.factIds.isEmpty {
                    DisclosureGroup("Confirmed facts used (\(message.factIds.count))") {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(message.factIds, id: \.self) { id in
                                if let fact = facts[id] {
                                    Text("#\(id) · \(fact.text)")
                                        .font(.caption)
                                        .textSelection(.enabled)
                                }
                            }
                        }
                        .padding(.top, 4)
                    }
                    .font(.caption)
                }
            }
            .bubble(mine: message.role == "user")
            if message.role != "user" { Spacer(minLength: 80) }
        }
    }
}
