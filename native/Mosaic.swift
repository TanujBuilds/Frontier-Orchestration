import AppKit
import WebKit

// The renderer receives JSON results, never connection settings or bearer keys.
final class ViewerBridge: NSObject, WKScriptMessageHandlerWithReply, URLSessionTaskDelegate {
    private let chats=CodexChatReader()
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 15
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()
    func shutdown() { chats.shutdown();session.invalidateAndCancel() }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == "mosaic-app", message.frameInfo.securityOrigin.host == "ui",
              message.webView?.url?.absoluteString == "mosaic-app://ui/index.html",
              let invocation = try? ReadInvocation(body: message.body)
        else { replyHandler(nil,"Mosaic rejected an unsupported observer request."); return }
        if invocation.name == "recent_chats" {
            chats.list { result in
                switch result {
                case .success(let rows):replyHandler(["chats":rows],nil)
                case .failure:replyHandler(nil,"Recent Codex chats are unavailable. Check that the Codex CLI is installed, then retry.")
                }
            }
            return
        }
        if invocation.name == "open_chat" {
            guard let id=invocation.input["chatId"] as? String,let url=chats.link(id),let app=NSWorkspace.shared.urlForApplication(withBundleIdentifier:"com.openai.codex") else { replyHandler(nil,"This chat is no longer in the recent list. Refresh the list and try again.");return }
            NSWorkspace.shared.open([url],withApplicationAt:app,configuration:NSWorkspace.OpenConfiguration()) { _,error in
                DispatchQueue.main.async{if error != nil{replyHandler(nil,"The chat could not be opened in Codex.")}else{replyHandler(["opened":true],nil)}}
            }
            return
        }
        if invocation.name == "open_codex" {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier:"com.openai.codex") else { replyHandler(nil,"Codex is not installed in Applications."); return }
            NSWorkspace.shared.openApplication(at:url,configuration:NSWorkspace.OpenConfiguration()) { _,error in
                DispatchQueue.main.async { if error != nil { replyHandler(nil,"Codex could not be opened.") } else { replyHandler(["opened":true],nil) } }
            }
            return
        }
        do {
            let settings = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Mosaic/state/viewer-connection.json")
            let record = try JSONSerialization.jsonObject(with:Data(contentsOf:settings)) as? [String:Any] ?? [:]
            let endpoint = try ViewerEndpoint(record:record)
            var request = URLRequest(url:endpoint.url.appendingPathComponent("api/invoke"))
            request.httpMethod = "POST"
            request.setValue("Bearer " + endpoint.token,forHTTPHeaderField:"Authorization")
            request.setValue("application/json",forHTTPHeaderField:"Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject:["name":invocation.name,"input":invocation.input])
            session.dataTask(with:request) { data,response,error in
                let result: Any?, failure: String?
                if error != nil { result=nil;failure="The local Mosaic coordinator is unavailable. Check it in Codex, then retry." }
                else if let response=response as? HTTPURLResponse, response.statusCode == 401 || response.statusCode == 403 { result=nil;failure="The installed Mosaic viewer connection was rejected. Check the connection in Codex." }
                else if let response=response as? HTTPURLResponse, response.statusCode == 200,
                        let data=data, data.count <= 8_388_608, let object=try? JSONSerialization.jsonObject(with:data), object is [String:Any] || object is [Any] {
                    result=object;failure=nil
                } else { result=nil;failure="Mosaic could not read that saved observer record." }
                DispatchQueue.main.async { replyHandler(result,failure) }
            }.resume()
        } catch { replyHandler(nil,"The installed Mosaic viewer connection is missing or invalid. Open Codex to inspect the coordinator.") }
    }
}

final class LocalAssets: NSObject, WKURLSchemeHandler {
    let root: URL
    init(root:URL) { self.root=root }
    func webView(_ webView:WKWebView,start task:WKURLSchemeTask) {
        do {
            guard let url=task.request.url else { throw MosaicError.invalidResource }
            let file=try AssetPolicy.file(for:url,root:root), data=try Data(contentsOf:file)
            let mime=["html":"text/html","css":"text/css","js":"text/javascript","svg":"image/svg+xml","ttf":"font/ttf","txt":"text/plain"][file.pathExtension] ?? "application/octet-stream"
            task.didReceive(URLResponse(url:url,mimeType:mime,expectedContentLength:data.count,textEncodingName:["html","css","js","txt","svg"].contains(file.pathExtension) ? "utf-8":nil))
            task.didReceive(data);task.didFinish()
        } catch { task.didFailWithError(NSError(domain:"MosaicResource",code:404,userInfo:[NSLocalizedDescriptionKey:"This bundled Mosaic resource is unavailable."])) }
    }
    func webView(_ webView:WKWebView,stop task:WKURLSchemeTask) { /* Resources complete synchronously; no work remains. */ }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    var window:NSWindow!
    var webView:WKWebView!
    let bridge=ViewerBridge()
    var demo=false
    func applicationDidFinishLaunching(_ notification:Notification) {
        NSApp.setActivationPolicy(.regular)
        if let iconURL=Bundle.main.url(forResource:"Mosaic",withExtension:"icns"),let icon=NSImage(contentsOf:iconURL) { NSApp.applicationIconImage=icon }
        NSApp.appearance=NSAppearance(named:.darkAqua)
        installMenus()
        let config=WKWebViewConfiguration()
        config.setURLSchemeHandler(LocalAssets(root:Bundle.main.resourceURL!.appendingPathComponent("ui")),forURLScheme:"mosaic-app")
        config.userContentController.addScriptMessageHandler(bridge,contentWorld:.page,name:"mosaic")
        config.preferences.javaScriptCanOpenWindowsAutomatically=false
        webView=WKWebView(frame:.zero,configuration:config)
        webView.navigationDelegate=self;webView.uiDelegate=self
        webView.allowsBackForwardNavigationGestures=false
        webView.setValue(false,forKey:"drawsBackground")
        window=NSWindow(contentRect:NSRect(x:0,y:0,width:1360,height:850),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.title="Mosaic";window.minSize=NSSize(width:980,height:640)
        window.backgroundColor=NSColor(calibratedRed:0.063,green:0.078,blue:0.086,alpha:1)
        window.isReleasedWhenClosed=false;window.delegate=self
        window.contentView=webView;window.center()
        window.setFrameAutosaveName("MosaicMainWindow")
        if let visible=NSScreen.main?.visibleFrame, !visible.contains(window.frame) { window.setFrame(window.frame.intersection(visible),display:false) }
        load(false);showWindow(nil)
    }
    func load(_ demo:Bool) {
        self.demo=demo
        window.title=demo ? "Mosaic — Design demo" : "Mosaic"
        let controller=webView.configuration.userContentController
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(source:"window.MOSAIC_DEMO = \(demo ? "true":"false");",injectionTime:.atDocumentStart,forMainFrameOnly:true))
        webView.load(URLRequest(url:URL(string:"mosaic-app://ui/index.html")!))
    }
    func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows flag:Bool)->Bool { showWindow(nil);return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool { false }
    func applicationWillTerminate(_ notification:Notification) { bridge.shutdown() }
    func updateViewerVisibility(_ visible:Bool?=nil) {
        let active=visible ?? (window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible))
        webView.evaluateJavaScript("window.MosaicRuntime?.setHostVisible(\(active ? "true":"false"))",completionHandler:nil)
    }
    func windowWillClose(_ notification:Notification) { updateViewerVisibility(false) }
    func windowDidMiniaturize(_ notification:Notification) { updateViewerVisibility(false) }
    func windowDidDeminiaturize(_ notification:Notification) { updateViewerVisibility() }
    func windowDidChangeOcclusionState(_ notification:Notification) { updateViewerVisibility() }
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!) { updateViewerVisibility() }
    @objc func showWindow(_ sender:Any?) { window?.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true);updateViewerVisibility() }
    @objc func refresh(_ sender:Any?) { webView.evaluateJavaScript("window.MosaicRuntime.refresh()",completionHandler:nil) }
    @objc func showLive(_ sender:Any?) { load(false) }
    @objc func showDemo(_ sender:Any?) { load(true) }
    @objc func showAbout(_ sender:Any?) {
        NSApp.orderFrontStandardAboutPanel(options:[.applicationName:"Mosaic",.applicationVersion:"1.2.1",.credits:NSAttributedString(string:"A window into the work.\nInstructions stay in Codex.\nBased on your Mosaic desktop prototype.")])
    }
    func webView(_ webView:WKWebView,decidePolicyFor action:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void) {
        decisionHandler(action.targetFrame?.isMainFrame == true && action.request.url?.absoluteString == "mosaic-app://ui/index.html" ? .allow:.cancel)
    }
    func webView(_ webView:WKWebView,createWebViewWith configuration:WKWebViewConfiguration,for navigationAction:WKNavigationAction,windowFeatures:WKWindowFeatures)->WKWebView? { nil }
    func installMenus() {
        let main=NSMenu()
        func menu(_ title:String)->NSMenu { let item=NSMenuItem();let menu=NSMenu(title:title);item.submenu=menu;main.addItem(item);return menu }
        func item(_ menu:NSMenu,_ title:String,_ selector:Selector,_ key:String="",_ target:AnyObject?=nil) { let item=NSMenuItem(title:title,action:selector,keyEquivalent:key);item.target=target;menu.addItem(item) }
        let app=menu("Mosaic")
        item(app,"About Mosaic",#selector(showAbout(_:)),"",self);app.addItem(.separator())
        item(app,"Hide Mosaic",#selector(NSApplication.hide(_:)),"h");item(app,"Show All",#selector(NSApplication.unhideAllApplications(_:)))
        app.addItem(.separator());item(app,"Quit Mosaic",#selector(NSApplication.terminate(_:)),"q")
        let file=menu("File");item(file,"Show Mosaic",#selector(showWindow(_:)),"0",self);item(file,"Close Window",#selector(NSWindow.performClose(_:)),"w")
        let edit=menu("Edit");item(edit,"Copy",#selector(NSText.copy(_:)),"c");item(edit,"Paste",#selector(NSText.paste(_:)),"v");item(edit,"Select All",#selector(NSText.selectAll(_:)),"a")
        let view=menu("View");item(view,"Refresh Status",#selector(refresh(_:)),"r",self);view.addItem(.separator());item(view,"Live Work",#selector(showLive(_:)),"1",self);item(view,"Design Demo",#selector(showDemo(_:)),"2",self)
        let windows=menu("Window");item(windows,"Minimize",#selector(NSWindow.performMiniaturize(_:)),"m");item(windows,"Zoom",#selector(NSWindow.performZoom(_:)));item(windows,"Show Mosaic",#selector(showWindow(_:)),"",self);NSApp.windowsMenu=windows
        NSApp.mainMenu=main
    }
}

@main struct MosaicApplication {
    static func main() {
        let app=NSApplication.shared, delegate=AppDelegate()
        app.delegate=delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
