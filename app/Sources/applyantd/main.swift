// applyantd as launchd starts it: a signed Mach-O inside Applyant.app (launchd won't run a
// script as a bundle program), which replaces itself with the bundled Node running the
// daemon. launchd's KeepAlive watches this process, which after exec *is* the daemon.
import ApplyantKit
import Darwin
import Foundation

func executablePath() -> URL {
    var buffer = [UInt8](repeating: 0, count: Int(MAXPATHLEN) * 4)
    let length = proc_pidpath(getpid(), &buffer, UInt32(buffer.count))
    if length > 0 {
        return URL(fileURLWithPath: String(decoding: buffer.prefix(Int(length)), as: UTF8.self))
    }
    return URL(fileURLWithPath: CommandLine.arguments[0])
}

let layout = BundleLayout(executable: executablePath())
let plan = LaunchPlan(layout: layout, user: UserPaths(), env: ProcessInfo.processInfo.environment)

// stdout and stderr → the log file (append), unless started from a terminal.
if isatty(STDERR_FILENO) == 0 {
    try? FileManager.default.createDirectory(at: plan.log.deletingLastPathComponent(), withIntermediateDirectories: true)
    rotateLog(plan.log)
    let fd = open(plan.log.path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
    if fd >= 0 {
        dup2(fd, STDOUT_FILENO)
        dup2(fd, STDERR_FILENO)
        close(fd)
    }
}

let argv = plan.arguments.map { strdup($0) } + [nil]
let envp = plan.environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
execve(plan.executable, argv, envp)
FileHandle.standardError.write(Data("applyantd: can't start \(plan.executable): \(String(cString: strerror(errno)))\n".utf8))
exit(1)
