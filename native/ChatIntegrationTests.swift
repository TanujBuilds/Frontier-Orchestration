import Foundation
import Darwin

@main struct ChatIntegrationTests {
    static func main() {
        let reader=CodexChatReader()
        var finished=false,passed=false
        reader.list { result in
            if case .success(let rows)=result,let first=rows.first,let id=first["id"] as? String {
                passed = reader.link(id)?.absoluteString == "codex://threads/"+id
                print("Live metadata-only chat query returned \(rows.count) entries; cached existing link validated: \(passed)")
            } else { print("Live metadata-only chat query unavailable") }
            finished=true
        }
        let deadline=Date().addingTimeInterval(13)
        while !finished && Date()<deadline { RunLoop.current.run(until:Date().addingTimeInterval(0.05)) }
        if !finished || !passed { FileHandle.standardError.write(Data("Live bounded metadata query failed; finished=\(finished) passed=\(passed)\n".utf8));exit(1) }
        RunLoop.current.run(until:Date().addingTimeInterval(0.8))
        if let pid=reader.lastProcessIdentifier { precondition(kill(pid,0) == -1 && errno==ESRCH,"Metadata helper must exit") }
    }
}
