// applyant-native: reads JSON-line requests on stdin, answers on stdout, and writes wake
// events as they happen. Requests are read one at a time off the main thread (classify_email
// is answered from a task when the on-device model is done); the main
// thread runs the run loop NSWorkspace needs for its notifications. When stdin closes (the
// daemon exited), the helper exits too.
import Foundation
import NativeCore

final class Output: @unchecked Sendable {
    private let lock = NSLock()

    func write(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}

let output = Output()

let wake = WakeObserver { output.write(encode(["event": "wake"])) }

let reader = Thread { [output] in
    let dispatcher = Dispatcher()
    while let line = readLine(strippingNewline: true) {
        if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
        dispatcher.handle(line: line) { output.write($0) }
    }
    exit(0)
}
reader.name = "stdin"
reader.start()

withExtendedLifetime(wake) {
    RunLoop.main.run()
}
