// Applyant's Share extension (Applyant.app/Contents/PlugIns/ApplyantShare.appex): Share →
// Applyant in Safari or Chrome sends the page's URL to the daemon's AddPosting.
//
// SwiftPM builds it as a plain executable; scripts/bundle.sh wraps it in the .appex with
// app/Bundle/ShareExtension-Info.plist and signs it with ShareExtension.entitlements. An
// extension's entry point is Foundation's NSExtensionMain (Xcode links it with
// `-e _NSExtensionMain`); here main.swift calls it, and it never returns.
import Foundation

@_silgen_name("NSExtensionMain")
func NSExtensionMain(_ argc: Int32, _ argv: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Int32

// Referenced so the linker keeps the principal class the Info.plist names.
_ = ShareViewController.self
exit(NSExtensionMain(CommandLine.argc, CommandLine.unsafeArgv))
