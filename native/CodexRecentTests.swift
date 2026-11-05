import Foundation

@main struct CodexRecentTests {
    static func main() throws {
        let id="12345678-1234-5678-9abc-123456789abc"
        let raw:[String:Any]=["data":[["id":id,"name":"Build example checklist","cwd":"/projects/example-project","updatedAt":1793846003,"status":["type":"active"],"preview":"PRIVATE PROMPT","turns":["PRIVATE OUTPUT"]],["id":"new?prompt=send","name":"Bad chat"]]]
        let rows=try CodexChatCodec.rows(raw)
        precondition(rows.count==1)
        precondition(rows[0]["title"] as? String == "Build example checklist")
        precondition(rows[0]["project"] as? String == "example-project")
        precondition(rows[0]["preview"] == nil && rows[0]["turns"] == nil)
        let encoded=try JSONSerialization.data(withJSONObject:rows);precondition(!String(data:encoded,encoding:.utf8)!.contains("PRIVATE"))
        precondition(CodexChatCodec.link(id:id,known:[id])?.absoluteString == "codex://threads/\(id)")
        precondition(CodexChatCodec.link(id:id,known:[]) == nil)
        for bad in ["new","../new","codex://threads/new","\(id)?prompt=send","\(id)/new"] { precondition(CodexChatCodec.link(id:bad,known:[bad]) == nil) }
        let bounded=try CodexChatCodec.rows(["data":Array(repeating:["id":id,"name":"Chat"],count:50)]);precondition(bounded.count==20)
        let unnamed=try CodexChatCodec.rows(["data":[["id":id,"name":NSNull(),"preview":"Not a title","updatedAt":true]]])[0]
        precondition(unnamed["title"] as? String == "Untitled chat")
        precondition(unnamed["updatedAt"] is NSNull)
        var rejected=false;do{_ = try CodexChatCodec.rows(["data":"malformed"])}catch{rejected=true};precondition(rejected)
        let list=CodexChatCodec.listRequest
        precondition(list["method"] as? String == "thread/list")
        let params=list["params"] as! [String:Any]
        precondition(params["useStateDbOnly"] as? Bool == true && params["limit"] as? Int == 20)
        print("Native chat metadata filtering, bounds, protocol and cached-link cases passed")
    }
}
