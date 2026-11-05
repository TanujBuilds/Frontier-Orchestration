import Foundation
import Darwin
@main struct ChatTransportFixture {
    static func main() {
        let mode=URL(fileURLWithPath:CommandLine.arguments[0]).lastPathComponent
        if mode.contains("malformed") { FileHandle.standardOutput.write(Data("invalid JSON\n".utf8)) }
        else if mode.contains("large") { FileHandle.standardOutput.write(Data(repeating:65,count:2_097_153)) }
        else if mode.contains("silent") { signal(SIGTERM,SIG_IGN) }
        else { return }
        while true { Thread.sleep(forTimeInterval:1) }
    }
}
