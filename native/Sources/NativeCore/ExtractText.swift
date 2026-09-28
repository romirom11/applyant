// Documents → text with Apple's own readers: PDFKit for PDF, AppKit for DOCX (and RTF).
// The daemon keeps pdfjs-dist / mammoth as the fallback when this fails or finds no text.
import AppKit
import Foundation
import PDFKit

public struct ExtractedText {
    /// One entry per PDF page; one entry for other formats.
    public let pages: [String]
    public let title: String?
}

public enum TextExtraction {
    public static func extract(path: String, format: String?) throws -> ExtractedText {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.isReadableFile(atPath: path) else {
            throw RequestError("can't read \(path)")
        }
        switch format ?? url.pathExtension.lowercased() {
        case "pdf":
            return try pdf(url)
        case "docx", "rtf":
            return try attributed(url)
        default:
            throw RequestError("unsupported format \(format ?? url.pathExtension)")
        }
    }

    static func pdf(_ url: URL) throws -> ExtractedText {
        guard let doc = PDFDocument(url: url) else {
            throw RequestError("PDFKit could not open \(url.lastPathComponent)")
        }
        if doc.isLocked { throw RequestError("\(url.lastPathComponent) is password-protected") }
        let pages = (0..<doc.pageCount).map { doc.page(at: $0)?.string ?? "" }
        let title = doc.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String
        return ExtractedText(pages: pages, title: nonEmpty(title))
    }

    static func attributed(_ url: URL) throws -> ExtractedText {
        var attributes: NSDictionary?
        let text: NSAttributedString
        do {
            text = try NSAttributedString(url: url, options: [:], documentAttributes: &attributes)
        } catch {
            throw RequestError("AppKit could not read \(url.lastPathComponent): \(error.localizedDescription)")
        }
        let title = attributes?[NSAttributedString.DocumentAttributeKey.title] as? String
        return ExtractedText(pages: [text.string], title: nonEmpty(title))
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }
}
