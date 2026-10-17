// The app's 3D illustrations: glossy glass objects, one per section and a few for states
// (success, all caught up, searching). They're PNGs in app/Bundle/Art, copied into
// Contents/Resources/Art by scripts/bundle.sh; a run from .build reads them from the source
// tree. A missing picture falls back to the section's symbol on a tinted glass blob, so a view
// never shows a hole.
import AppKit
import ApplyantKit
import SwiftUI

enum Art: String, CaseIterable, Sendable {
    case overview, toReview, newJobs, saved, skipped
    case applied, interviews, offers, whichApplication
    case profile, projects, questions, chat
    case search, agentRuns, companies, settings
    case success, allCaughtUp, searching, writing, sending

    /// The section's picture.
    init(_ section: ApplyantKit.Section) {
        self = switch section {
        case .overview: .overview
        case .new: .newJobs
        case .toReview: .toReview
        case .saved: .saved
        case .skipped: .skipped
        case .applied: .applied
        case .interviews: .interviews
        case .offers: .offers
        case .whichApplication: .whichApplication
        case .profile: .profile
        case .projects: .projects
        case .interview: .questions
        case .chat: .chat
        case .search: .search
        case .agentRuns: .agentRuns
        case .companies: .companies
        case .settings: .settings
        }
    }

    /// Drawn instead while the picture is missing.
    var fallbackSymbol: String {
        switch self {
        case .overview: "chart.pie.fill"
        case .toReview: "checklist"
        case .newJobs: "tray.full.fill"
        case .saved: "bookmark.fill"
        case .skipped: "xmark"
        case .applied: "paperplane.fill"
        case .interviews: "phone.fill"
        case .offers: "trophy.fill"
        case .whichApplication: "questionmark.bubble.fill"
        case .profile: "person.fill"
        case .projects: "folder.fill"
        case .questions: "bubble.left.and.bubble.right.fill"
        case .chat: "message.fill"
        case .search: "magnifyingglass"
        case .agentRuns: "gearshape.2.fill"
        case .companies: "building.2.fill"
        case .settings: "gearshape.fill"
        case .success: "checkmark"
        case .allCaughtUp: "sparkles"
        case .searching: "dot.radiowaves.left.and.right"
        case .writing: "pencil.and.scribble"
        case .sending: "paperplane.fill"
        }
    }

    /// The picture's main colour: the fallback's glass, and a tint views can match.
    var hue: Double {
        switch self {
        case .toReview, .questions: 0.86
        case .newJobs, .projects, .searching: 0.48
        case .saved, .offers: 0.11
        case .skipped, .settings: 0.67
        case .applied, .search, .companies, .sending: 0.6
        case .interviews, .success: 0.36
        case .whichApplication, .agentRuns: 0.07
        case .overview, .profile, .chat, .allCaughtUp, .writing: 0.76
        }
    }

    @MainActor var image: NSImage? { ArtLibrary.shared.image(rawValue) }
}

/// Loads each picture once.
@MainActor
final class ArtLibrary {
    static let shared = ArtLibrary()
    private var cache: [String: NSImage] = [:]
    private var missing: Set<String> = []

    /// Contents/Resources/Art in the app; app/Bundle/Art when run from the build directory.
    private let folders: [URL] = {
        var urls: [URL] = []
        if let resources = Bundle.main.resourceURL { urls.append(resources.appendingPathComponent("Art")) }
        // …/app/Sources/Applyant/Views/Art.swift → …/app/Bundle/Art
        let source = URL(fileURLWithPath: #filePath)
        urls.append(source.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Bundle/Art"))
        return urls
    }()

    func image(_ name: String) -> NSImage? {
        if let cached = cache[name] { return cached }
        guard !missing.contains(name) else { return nil }
        for folder in folders {
            let url = folder.appendingPathComponent("\(name).png")
            if let image = NSImage(contentsOf: url) {
                cache[name] = image
                return image
            }
        }
        missing.insert(name)
        return nil
    }
}

/// A 3D illustration at a given size, or its fallback.
struct ArtImage: View {
    let art: Art
    var size: CGFloat = 96

    init(_ art: Art, size: CGFloat = 96) {
        self.art = art
        self.size = size
    }

    var body: some View {
        if let image = art.image {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
        } else {
            ArtFallback(art: art, size: size)
        }
    }
}

/// The section's symbol on a glossy blob of its colour.
private struct ArtFallback: View {
    let art: Art
    let size: CGFloat

    var body: some View {
        let base = Color(hue: art.hue, saturation: 0.75, brightness: 0.85)
        let deep = Color(hue: art.hue, saturation: 0.85, brightness: 0.45)
        RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
            .fill(LinearGradient(colors: [base, deep], startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay(
                RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
                    .strokeBorder(.white.opacity(0.35), lineWidth: max(1, size * 0.02))
            )
            .overlay(alignment: .top) {
                Ellipse().fill(.white.opacity(0.22)).frame(width: size * 0.6, height: size * 0.22).offset(y: size * 0.08)
            }
            .overlay {
                Image(systemName: art.fallbackSymbol)
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(.white)
                    .shadow(color: deep.opacity(0.6), radius: size * 0.04, y: size * 0.03)
            }
            .frame(width: size * 0.82, height: size * 0.82)
            .shadow(color: deep.opacity(0.5), radius: size * 0.08, y: size * 0.06)
            .frame(width: size, height: size)
    }
}
