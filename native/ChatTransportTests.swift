import Foundation
import Darwin
@main struct ChatTransportTests {
    static func main() {
        for mode in ["silent","malformed","large","exit"] {
            let executable=URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("codex-"+mode)
            precondition(FileManager.default.isExecutableFile(atPath:executable.path),"Fixture executable required")
            let reader=CodexChatReader(testExecutable:executable,timeout:0.3)
            var replies=0,failed=false
            reader.list { result in replies+=1;if case .failure=result{failed=true} }
            let deadline=Date().addingTimeInterval(3)
            while replies==0 && Date()<deadline { RunLoop.current.run(until:Date().addingTimeInterval(0.02)) }
            precondition(replies==1&&failed,"Expected one bounded failure: \(mode)")
            RunLoop.current.run(until:Date().addingTimeInterval(0.8))
            precondition(replies==1,"No second callback after termination")
            guard let pid=reader.lastProcessIdentifier else { fatalError("Fixture must actually run") };precondition(kill(pid,0) == -1 && errno==ESRCH,"Owned child must be gone: \(mode)")
            print("PASS bounded \(mode) metadata transport and child cleanup")
        }
        let terminating=CodexChatReader(testExecutable:URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("codex-silent"),timeout:0.1)
        var stoppedAfterCompletion=false
        terminating.list{_ in terminating.shutdown();stoppedAfterCompletion=true}
        let completionDeadline=Date().addingTimeInterval(3)
        while !stoppedAfterCompletion && Date()<completionDeadline { RunLoop.current.run(until:Date().addingTimeInterval(0.01)) }
        RunLoop.current.run(until:Date().addingTimeInterval(0.15))
        guard let retiringPID=terminating.lastProcessIdentifier else { fatalError("Fixture must run") }
        precondition(stoppedAfterCompletion && kill(retiringPID,0) == -1 && errno==ESRCH,"Immediate shutdown must kill already-terminating child")
        print("PASS completion followed by immediate shutdown cleans terminating child")
        let reader=CodexChatReader(testExecutable:URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("codex-silent"),timeout:60)
        var ended=false
        reader.list{_ in ended=true}
        RunLoop.current.run(until:Date().addingTimeInterval(0.2))
        reader.shutdown()
        RunLoop.current.run(until:Date().addingTimeInterval(0.8))
        guard let pid=reader.lastProcessIdentifier else{fatalError("Fixture must run")}
        precondition(ended && kill(pid,0) == -1 && errno==ESRCH,"Shutdown must close owned metadata child")
        print("PASS application shutdown cleans metadata child")
    }
}
