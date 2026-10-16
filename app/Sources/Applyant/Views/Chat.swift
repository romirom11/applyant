import ApplyantKit
import SwiftUI

struct ChatView: View {
    let store: AppStore
    @State private var draft = ""
    @State private var confirmingClear = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if store.chatMessages.isEmpty {
                            ContentUnavailableView(
                                "Ask about your experience",
                                systemImage: "message",
                                description: Text("Chat uses your profile, projects and confirmed facts. You can ask what supports a claim, compare your experience with a role, or work through how to describe a project.")
                            )
                            .frame(maxWidth: .infinity, minHeight: 300)
                        }
                        ForEach(store.chatMessages, id: \.id) { message in
                            ChatBubble(message: message, facts: store.chatFacts)
                                .id(message.id)
                        }
                        if store.chatSending {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small)
                                Text("Thinking…").foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(24)
                    .frame(maxWidth: 850)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: store.chatMessages.count) { _, _ in
                    if let last = store.chatMessages.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }

            Divider()
            HStack(alignment: .bottom, spacing: 12) {
                TextEditor(text: $draft)
                    .font(.body)
                    .frame(minHeight: 65, maxHeight: 115)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
                    .accessibilityLabel("Message")
                Button("Send", action: send)
                    .buttonStyle(.borderedProminent)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.chatSending)
            }
            .padding(16)
            .frame(maxWidth: 850)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("Chat")
        .toolbar {
            Button("New conversation") { confirmingClear = true }
                .disabled(store.chatMessages.isEmpty || store.chatSending)
        }
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
                    .foregroundStyle(.secondary)
                Text(message.text).textSelection(.enabled)
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
            .padding(14)
            .frame(maxWidth: 620, alignment: .leading)
            .background(message.role == "user" ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
            if message.role != "user" { Spacer(minLength: 80) }
        }
    }
}
