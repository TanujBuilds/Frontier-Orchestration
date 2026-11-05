import Foundation

@main struct PolicyTests {
    static func main() throws {
        var count = 0
        func rejects(_ label: String, _ operation: () throws -> Void) {
            do { try operation(); fatalError("Expected rejection: \(label)") }
            catch { count += 1; print("PASS \(label)") }
        }
        let good: [String: Any] = ["url":"http://127.0.0.1:4332", "token":"test-viewer", "role":"viewer"]
        let endpoint = try ViewerEndpoint(record: good)
        precondition(endpoint.url.host == "127.0.0.1"); count += 1
        for address in ["https://127.0.0.1:4332", "http://localhost:4332", "http://127.0.0.1.evil:4332", "http://user:pass@127.0.0.1:4332", "http://127.0.0.1:4332/path", "http://127.0.0.1:4332?key=x", "http://127.0.0.1:4332#x"] {
        var bad = good; bad["url"] = address
            rejects("reject endpoint \(address)") { _ = try ViewerEndpoint(record: bad) }
        }
        _ = try ReadInvocation(body:["name":"recent_chats","input":[:]])
        _ = try ReadInvocation(body:["name":"open_chat","input":["chatId":"12345678-1234-5678-9abc-123456789abc"]])
        rejects("reject arbitrary chat URL") { _ = try ReadInvocation(body:["name":"open_chat","input":["chatId":"codex://threads/new?prompt=send"]]) }
        rejects("reject extra chat command") { _ = try ReadInvocation(body:["name":"recent_chats","input":["method":"write"]]) }
        rejects("reject absent chat ID") { _ = try ReadInvocation(body:["name":"open_chat","input":[:]]) }
        count += 2
        var bad = good; bad["role"] = "operator"
        rejects("reject operator credential") { _ = try ViewerEndpoint(record: bad) }
        bad = good; bad["token"] = "test\r\nHeader:bad"
        rejects("reject header injection") { _ = try ViewerEndpoint(record: bad) }
        _ = try ReadInvocation(body:["name":"observer_snapshot", "input":[:]])
        _ = try ReadInvocation(body:["name":"observer_timeline", "input":["after":0,"limit":200]])
        _ = try ReadInvocation(body:["name":"observer_evidence", "input":["reference":"task-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","start":0,"length":32768]])
        count += 3
        for name in ["task_submit","work_control","goal_activate","open_url","exec","observer_snapshot;"] {
            rejects("reject unlisted command \(name)") { _ = try ReadInvocation(body:["name":name,"input":[:]]) }
        }
        rejects("reject unknown snapshot fields") { _ = try ReadInvocation(body:["name":"observer_snapshot","input":["path":"/etc/passwd"]]) }
        rejects("reject arbitrary evidence path") { _ = try ReadInvocation(body:["name":"observer_evidence","input":["reference":"/etc/passwd"]]) }
        rejects("reject overlong evidence window") { _ = try ReadInvocation(body:["name":"observer_evidence","input":["reference":"task-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","length":999999]]) }
        rejects("reject noninteger cursor") { _ = try ReadInvocation(body:["name":"observer_timeline","input":["after":1.5]]) }
        rejects("reject Boolean cursor") { _ = try ReadInvocation(body:["name":"observer_timeline","input":["after":true]]) }
        rejects("reject open Codex parameters") { _ = try ReadInvocation(body:["name":"open_codex","input":["url":"evil:"]]) }
        let fm = FileManager.default, root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at:root,withIntermediateDirectories:true)
        defer { try? fm.removeItem(at:root) }
        try Data("ok".utf8).write(to:root.appendingPathComponent("index.html"))
        try fm.createSymbolicLink(at:root.appendingPathComponent("escape.js"),withDestinationURL:URL(fileURLWithPath:"/etc/passwd"))
        _ = try AssetPolicy.file(for:URL(string:"mosaic-app://ui/index.html")!,root:root); count += 1
        for address in ["mosaic-app://evil/index.html", "mosaic-app://ui/../etc/passwd", "mosaic-app://ui/%2e%2e/etc/passwd", "mosaic-app://ui/escape.js", "mosaic-app://ui/index.html?x=1", "mosaic-app://ui/connection.json", "https://ui/index.html"] {
            rejects("reject local resource \(address)") { _ = try AssetPolicy.file(for:URL(string:address)!,root:root) }
        }
        print("\(count) native trust-boundary cases passed")
    }
}
