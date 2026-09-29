// The share sheet's panel: "Adding…", then added / already known / Applyant isn't running.
import AppKit
import ApplyantKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class ShareModel: ObservableObject {
    @Published var outcome: ShareOutcome?
    @Published var url: URL?
}

struct ShareView: View {
    @ObservedObject var model: ShareModel
    let done: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: symbol).foregroundStyle(tint).font(.title2)
                Text(model.outcome?.headline ?? "Adding to Applyant…").font(.headline)
            }
            if let outcome = model.outcome {
                Text(outcome.detail).font(.callout).fixedSize(horizontal: false, vertical: true)
            } else {
                ProgressView().controlSize(.small)
            }
            if let url = model.url {
                Text(url.absoluteString).font(.caption).foregroundStyle(.secondary).lineLimit(2).truncationMode(.middle)
            }
            HStack {
                Spacer()
                Button("Done", action: done).keyboardShortcut(.defaultAction).disabled(model.outcome == nil)
            }
        }
        .padding(16)
        .frame(width: 340)
    }

    var symbol: String {
        switch model.outcome {
        case .added?: "checkmark.circle.fill"
        case .alreadyKnown?: "tray.full"
        case nil: "paperplane"
        default: "exclamationmark.triangle.fill"
        }
    }

    var tint: Color {
        switch model.outcome {
        case .added?: .green
        case .alreadyKnown?, nil: .accentColor
        default: .orange
        }
    }
}

@objc(ShareViewController)
final class ShareViewController: NSViewController {
    private let model = ShareModel()

    override var nibName: NSNib.Name? { nil }

    override func loadView() {
        let host = NSHostingView(rootView: ShareView(model: model) { [weak self] in self?.finish() })
        host.frame = NSRect(x: 0, y: 0, width: 340, height: 150)
        view = host
        preferredContentSize = host.fittingSize
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        Task { @MainActor in
            let url = await Self.sharedURL(in: items)
            model.url = url
            let outcome: ShareOutcome = if let url { await ShareClient().add(url) } else { .noURL }
            model.outcome = outcome
            preferredContentSize = view.fittingSize
            if case .added = outcome {
                try? await Task.sleep(for: .seconds(1.5))
                finish()
            }
        }
    }

    private var finished = false

    private func finish() {
        guard !finished else { return }
        finished = true
        extensionContext?.completeRequest(returningItems: nil)
    }

    /// Safari and Chrome share a public.url; some apps share only text with a link in it.
    static func sharedURL(in items: [NSExtensionItem]) async -> URL? {
        let providers = items.flatMap { $0.attachments ?? [] }
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = await load(provider, UTType.url.identifier) as? URL, !url.isFileURL { return url }
            if let data = await load(provider, UTType.url.identifier) as? Data,
               let url = URL(dataRepresentation: data, relativeTo: nil), !url.isFileURL { return url }
        }
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let text = await load(provider, UTType.plainText.identifier) as? String,
               let url = ShareClient.firstWebURL(in: text) { return url }
        }
        for item in items {
            if let text = item.attributedContentText?.string, let url = ShareClient.firstWebURL(in: text) { return url }
        }
        return nil
    }

    private static func load(_ provider: NSItemProvider, _ type: String) async -> NSSecureCoding? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, _ in
                nonisolated(unsafe) let item = item
                continuation.resume(returning: item)
            }
        }
    }
}
