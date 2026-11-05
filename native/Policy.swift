import Foundation
import CoreFoundation

enum MosaicError: Error { case invalidConnection, invalidCommand, invalidResource }

struct ViewerEndpoint {
    let url: URL
    let token: String
    init(record: [String: Any]) throws {
        guard record["role"] as? String == "viewer",
              let address = record["url"] as? String, let url = URL(string: address),
              url.scheme == "http", url.host == "127.0.0.1", let port = url.port, (1...65535).contains(port),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              let token = record["token"] as? String, !token.isEmpty, token.count <= 4096,
              token.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 })
        else { throw MosaicError.invalidConnection }
        self.url = url; self.token = token
    }
}

struct ReadInvocation {
    let name: String
    let input: [String: Any]
    init(body: Any) throws {
        guard let b = body as? [String: Any], Set(b.keys) == ["name", "input"],
              let name = b["name"] as? String, let input = b["input"] as? [String: Any]
        else { throw MosaicError.invalidCommand }
        let allowed: [String: Set<String>] = [
            "observer_snapshot":["goalId","actor"],
            "observer_timeline":["goalId","actor","after","limit"],
            "observer_evidence":["reference","start","length"],
            "observer_artifacts":["taskId"], "open_codex":[], "recent_chats":[], "open_chat":["chatId"]
        ]
        guard let fields = allowed[name], Set(input.keys).isSubset(of:fields) else { throw MosaicError.invalidCommand }
        for (key,value) in input {
            switch key {
            case "chatId": guard let id=value as? String,CodexChatCodec.validID(id) else { throw MosaicError.invalidCommand }
            case "actor": guard ["codex","deepseek"].contains(value as? String ?? "") else { throw MosaicError.invalidCommand }
            case "goalId","taskId": guard let id = value as? String, id.range(of:"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$", options:.regularExpression) != nil else { throw MosaicError.invalidCommand }
            case "reference": guard let reference = value as? String, reference.range(of:"^(task|request)-[a-zA-Z0-9_-]{1,120}$|^artifact-[a-f0-9]{64}$",options:.regularExpression) != nil else { throw MosaicError.invalidCommand }
            case "after","start","length","limit":
                guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.rounded() == number.doubleValue,
                      number.doubleValue.isFinite, number.doubleValue >= (key == "length" || key == "limit" ? 1 : 0),
                      number.doubleValue <= (key == "length" ? 32768 : key == "limit" ? 200 : 9_007_199_254_740_991)
                else { throw MosaicError.invalidCommand }
            default: throw MosaicError.invalidCommand
            }
        }
        if name == "observer_evidence" && input["reference"] == nil { throw MosaicError.invalidCommand }
        if name == "observer_artifacts" && input["taskId"] == nil { throw MosaicError.invalidCommand }
        if name == "open_chat" && input["chatId"] == nil { throw MosaicError.invalidCommand }
        self.name = name; self.input = input
    }
}

enum AssetPolicy {
    static func file(for url: URL, root: URL) throws -> URL {
        guard url.scheme == "mosaic-app", url.host == "ui", url.port == nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              !url.pathComponents.contains(".."), !url.path.contains("\\"), !url.path.contains("\0")
        else { throw MosaicError.invalidResource }
        let relative = String(url.path.drop(while:{$0 == "/"}))
        let top: Set<String> = ["index.html","styles.css","motion.css","app.js","adapter.js","runtime.js","mock-data.js"]
        guard top.contains(relative) || (relative.hasPrefix("assets/") && ["svg","ttf","txt"].contains(url.pathExtension)) else { throw MosaicError.invalidResource }
        let canonicalRoot = root.resolvingSymlinksInPath().standardizedFileURL
        let file = root.appendingPathComponent(relative).resolvingSymlinksInPath().standardizedFileURL
        guard file.path.hasPrefix(canonicalRoot.path + "/"),
              (try? file.resourceValues(forKeys:[.isRegularFileKey]).isRegularFile) == true
        else { throw MosaicError.invalidResource }
        return file
    }
}
