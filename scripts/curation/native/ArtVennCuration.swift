import AppKit
import WebKit

struct LocalRuntime: Sendable {
    let source: URL
    let root: URL
    static func load() -> LocalRuntime? {
        guard let source = Bundle.main.object(forInfoDictionaryKey: "ArtVennSourceDirectory") as? String,
              let root = Bundle.main.object(forInfoDictionaryKey: "ArtVennRuntimeDirectory") as? String,
              source.hasPrefix("/"), root.hasPrefix("/") else { return nil }
        return LocalRuntime(source: URL(fileURLWithPath: source), root: URL(fileURLWithPath: root))
    }
}

struct ServiceReply: Sendable {
    let ok: Bool
    let category: String
    let uiPort: Int
    let reviewPort: Int
}

enum LocalService {
    static func run(_ action: String, runtime: LocalRuntime) -> ServiceReply {
        let task = Process()
        let output = Pipe()
        task.executableURL = runtime.root.appendingPathComponent("ls-env/bin/python")
        task.arguments = [runtime.source.appendingPathComponent("service.py").path, action, "--root", runtime.root.path]
        task.currentDirectoryURL = runtime.source
        task.standardOutput = output
        task.standardError = FileHandle.nullDevice
        do { try task.run() } catch { return ServiceReply(ok: false, category: "LOCAL_RUNTIME_UNAVAILABLE", uiPort: 0, reviewPort: 0) }
        let deadline = Date().addingTimeInterval(action == "start" ? 220 : 50)
        while task.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        if task.isRunning { task.terminate(); return ServiceReply(ok: false, category: "LOCAL_START_OR_STOP_TIMEOUT", uiPort: 0, reviewPort: 0) }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        guard data.count < 16384, let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ServiceReply(ok: false, category: "LOCAL_SERVICE_RESPONSE_INVALID", uiPort: 0, reviewPort: 0)
        }
        guard task.terminationStatus == 0 else { return ServiceReply(ok: false, category: value["category"] as? String ?? "LOCAL_SERVICE_FAILED", uiPort: 0, reviewPort: 0) }
        if action == "stop" { return ServiceReply(ok: true, category: "", uiPort: 0, reviewPort: 0) }
        guard let uiString = value["ui_url"] as? String, let reviewString = value["review_url"] as? String,
              let ui = URL(string: uiString), let review = URL(string: reviewString),
              ui.scheme == "http", review.scheme == "http", ui.host == "127.0.0.1", review.host == "127.0.0.1",
              ui.user == nil, ui.password == nil, review.user == nil, review.password == nil,
              let uiPort = ui.port, let reviewPort = review.port,
              (1024...65535).contains(uiPort), (1024...65535).contains(reviewPort), uiPort != reviewPort else {
            return ServiceReply(ok: false, category: "LOCAL_ORIGIN_INVALID", uiPort: 0, reviewPort: 0)
        }
        return ServiceReply(ok: true, category: "", uiPort: uiPort, reviewPort: reviewPort)
    }
}

struct LocalOrigins {
    let helper: Int
    let review: Int
    func contains(_ url: URL?) -> Bool {
        guard let url, url.scheme == "http", url.host == "127.0.0.1", url.user == nil, url.password == nil, let port = url.port else { return false }
        return port == helper || port == review
    }
}

@MainActor
final class AppController: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var progress: NSTextField!
    var retry: NSButton!
    var runtime: LocalRuntime?
    var uiPort = 0
    var reviewPort = 0
    var ready = false
    var starting = false
    var stopping = false
    var generation = 0
    let serviceQueue = DispatchQueue(label: "local.artvenn.lifecycle", qos: .userInitiated)
    var exiting = false
    var activePicker: NSOpenPanel?
    let syntheticView = CommandLine.arguments.contains("--synthetic-view")

    func applicationDidFinishLaunching(_ notification: Notification) {
        runtime = LocalRuntime.load()
        buildWindow()
        buildMenu()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        start()
    }

    func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 850), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "ArtVenn 本地整理"
        window.minSize = NSSize(width: 720, height: 620)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        let container = NSView()
        window.contentView = container
        let bar = NSStackView()
        bar.orientation = .horizontal; bar.spacing = 10; bar.edgeInsets = NSEdgeInsets(top: 9, left: 18, bottom: 9, right: 18)
        for (title, selector) in [("工作台", #selector(home)), ("对象资料库", #selector(objects)), ("返回", #selector(back)), ("刷新", #selector(refresh))] {
            let button = NSButton(title: title, target: self, action: selector)
            button.bezelStyle = .rounded; bar.addArrangedSubview(button)
        }
        progress = NSTextField(labelWithString: "正在启动本机工作环境…")
        progress.textColor = .secondaryLabelColor; progress.font = .systemFont(ofSize: 12)
        progress.setContentHuggingPriority(.defaultLow, for: .horizontal)
        bar.addArrangedSubview(progress)
        retry = NSButton(title: "重试启动", target: self, action: #selector(start))
        retry.bezelStyle = .rounded; retry.isHidden = true; bar.addArrangedSubview(retry)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "selectFolder")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self; webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        bar.translatesAutoresizingMaskIntoConstraints = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(bar); container.addSubview(webView)
        NSLayoutConstraint.activate([bar.topAnchor.constraint(equalTo: container.topAnchor), bar.leadingAnchor.constraint(equalTo: container.leadingAnchor), bar.trailingAnchor.constraint(equalTo: container.trailingAnchor), bar.heightAnchor.constraint(equalToConstant: 50), webView.topAnchor.constraint(equalTo: bar.bottomAnchor), webView.leadingAnchor.constraint(equalTo: container.leadingAnchor), webView.trailingAnchor.constraint(equalTo: container.trailingAnchor), webView.bottomAnchor.constraint(equalTo: container.bottomAnchor)])
    }

    func buildMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(title: "ArtVenn")
        appMenu.addItem(withTitle: "显示工作台", action: #selector(home), keyEquivalent: "1").target = self
        appMenu.addItem(withTitle: "打开本地草稿目录", action: #selector(openDrafts), keyEquivalent: "") .target = self
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "隐藏 ArtVenn", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 ArtVenn…", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); menu.addItem(editItem)
        let edit = NSMenu(title: "编辑")
        for (title, selector, key) in [("撤销", Selector(("undo:")), "z"), ("剪切", #selector(NSText.cut(_:)), "x"), ("复制", #selector(NSText.copy(_:)), "c"), ("粘贴", #selector(NSText.paste(_:)), "v"), ("全选", #selector(NSText.selectAll(_:)), "a")] { edit.addItem(withTitle: title, action: selector, keyEquivalent: key) }
        editItem.submenu = edit
        NSApp.mainMenu = menu
    }

    @objc func start() {
        guard !starting && !stopping else { return }
        guard let runtime else { showError("找不到本任务的运行目录，请保留原本地配置。"); return }
        starting = true; generation += 1
        let candidate = generation
        ready = false; retry.isHidden = true; progress.stringValue = "正在启动本机 AI 与审核环境…"
        serviceQueue.async { [weak self] in
            let reply = LocalService.run("start", runtime: runtime)
            DispatchQueue.main.async { self?.started(reply, generation: candidate) }
        }
    }

    func started(_ reply: ServiceReply, generation candidate: Int) {
        starting = false
        guard !stopping && candidate == generation else { return }
        guard reply.ok else { showError(message(reply.category)); return }
        uiPort = reply.uiPort; reviewPort = reply.reviewPort
        let rules: [[String: Any]] = [
            ["trigger": ["url-filter": "^https?://"], "action": ["type": "block"]],
            ["trigger": ["url-filter": "^http://127\\.0\\.0\\.1:\(uiPort)/"], "action": ["type": "ignore-previous-rules"]],
            ["trigger": ["url-filter": "^http://127\\.0\\.0\\.1:\(reviewPort)/"], "action": ["type": "ignore-previous-rules"]]
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: rules), let text = String(data: data, encoding: .utf8) else { showError("无法建立本机访问边界。"); return }
        guard let runtime else { showError("本地运行目录不可用。"); return }
        let rulesDirectory = runtime.root.appendingPathComponent("native-webkit-rules", isDirectory: true)
        try? FileManager.default.createDirectory(at: rulesDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard let ruleStore = WKContentRuleListStore(url: rulesDirectory) else { showError("本机访问规则存储不可用。"); return }
        ruleStore.compileContentRuleList(forIdentifier: "ArtVennLocalOnly-\(uiPort)-\(reviewPort)", encodedContentRuleList: text) { [weak self] list, error in
            guard let self, !self.stopping, candidate == self.generation else { return }
            let receipt: [String: Any] = ["status": list == nil ? "failed" : "ready", "category": error.map { ($0 as NSError).domain + ":" + String(($0 as NSError).code) } ?? "none", "message": error?.localizedDescription ?? "none"]
            if let data = try? JSONSerialization.data(withJSONObject: receipt) { try? data.write(to: runtime.root.appendingPathComponent("state/native-rule-result.json"), options: .atomic) }
            guard let list else { self.showError("无法建立本机访问边界，页面未加载。"); return }
            self.webView.configuration.userContentController.removeAllContentRuleLists()
            self.webView.configuration.userContentController.add(list)
            self.ready = true
            self.home()
        }
    }

    func message(_ category: String) -> String {
        if category.contains("PORT_OCCUPIED") { return "本地端口被其他程序占用；未停止其他程序。" }
        if category == "LOCAL_RUNTIME_UNAVAILABLE" { return "本任务运行目录不可用，请连接原盘并保留本地配置。" }
        if category.contains("TIMEOUT") { return "本机服务启动或停止超时；已有数据保留。可重试启动。" }
        return "本机环境未能启动。已有资料保留。类别：\(category)"
    }

    func showError(_ text: String) { progress.stringValue = text; retry.isHidden = false }
    func allowed(_ url: URL?) -> Bool {
        guard ready && LocalOrigins(helper: uiPort, review: reviewPort).contains(url) else { return false }
        if syntheticView, let url, url.port == uiPort {
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            if url.path == "/" || url.path == "/objects" { return items.contains { $0.name == "material" && $0.value == "synthetic" } }
            if url.path == "/review" { return items.contains { $0.name == "synthetic" && $0.value == "1" } }
            return false
        }
        return true
    }
    func load(_ path: String) {
        guard ready, let url = URL(string: "http://127.0.0.1:\(uiPort)" + path) else { return }
        window.makeKeyAndOrderFront(nil); webView.load(URLRequest(url: url))
    }
    @objc func home() { load(syntheticView ? "/?material=synthetic" : "/") }
    @objc func objects() { load(syntheticView ? "/objects?material=synthetic" : "/objects?material=local") }
    @objc func back() { if webView.canGoBack { webView.goBack() } else { home() } }
    @objc func refresh() { if ready { webView.reload() } else { start() } }
    @objc func openDrafts() {
        guard let runtime else { return }
        // Reveal the task's existing local package directory; never arbitrary page input.
        NSWorkspace.shared.open(runtime.root.appendingPathComponent("state", isDirectory: true))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard allowed(navigationAction.request.url) else { progress.stringValue = "此应用只打开本机整理与审核页面。"; decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if allowed(navigationAction.request.url) { webView.load(navigationAction.request) }
        return nil
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        progress.stringValue = webView.url?.port == reviewPort ? "人工审核 · Submit 后回工作台收集" : "照片与决定保存在本机"
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        showError("本地服务暂不可用。点击重试启动；数据保留。")
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage text: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard allowed(frame.request.url) else { completionHandler(false); return }
        let alert = NSAlert(); alert.messageText = "确认此操作"; alert.informativeText = text
        alert.addButton(withTitle: "继续"); alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    func helperHome() -> Bool { allowed(webView.url) && webView.url?.port == uiPort && webView.url?.path == "/" }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "selectFolder", message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == "http", message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.port == uiPort, helperHome(), activePicker == nil,
              let body = message.body as? [String: String], body == ["action": "choose"] else { return }
        let panel = NSOpenPanel(); activePicker = panel
        panel.title = "选择本机照片文件夹"; panel.message = "只读取你选择的文件夹；建议先选 20–50 张。原图不会移动或修改。"
        panel.prompt = "选择这一批"; panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.allowsMultipleSelection = false; panel.canCreateDirectories = false; panel.resolvesAliases = false
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }; self.activePicker = nil
            guard self.helperHome() else { return }
            if response != .OK || panel.url == nil { self.webView.evaluateJavaScript("window.artvennFolderCancelled?.()", completionHandler: nil); return }
            if self.syntheticView && panel.url!.standardizedFileURL != self.runtime?.root.appendingPathComponent("synthetic", isDirectory: true).standardizedFileURL {
                self.progress.stringValue = "测试窗口只使用合成资料；选择真实资料请重新打开普通 App。"
                self.webView.evaluateJavaScript("window.artvennFolderCancelled?.()", completionHandler: nil); return
            }
            guard let data = try? JSONSerialization.data(withJSONObject: [panel.url!.path]),
                  let array = String(data: data, encoding: .utf8) else { return }
            let argument = String(array.dropFirst().dropLast())
            self.webView.evaluateJavaScript("window.artvennFolderChosen?.(\(argument), \(self.syntheticView ? "true" : "false"))", completionHandler: nil)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil); return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if exiting { return .terminateNow }
        if stopping { return .terminateLater }
        let alert = NSAlert(); alert.messageText = "退出并停止本任务？"
        alert.informativeText = "会停止本任务的本机分析与审核服务。照片、已提交审核和已收集决定都会保留，下次打开可继续。审核页未提交的编辑请先 Submit。"
        alert.addButton(withTitle: "退出并停止"); alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return .terminateCancel }
        guard let runtime else { return .terminateNow }
        stopping = true; ready = false; generation += 1
        progress.stringValue = "正在停止本任务，保留资料…"
        serviceQueue.async { [weak self] in
            let reply = LocalService.run("stop", runtime: runtime)
            DispatchQueue.main.async {
                guard let self else { return }
                if reply.ok { self.exiting = true; NSApp.reply(toApplicationShouldTerminate: true) }
                else { self.stopping = false; self.showError(self.message(reply.category)); NSApp.reply(toApplicationShouldTerminate: false) }
            }
        }
        return .terminateLater
    }
}

@main
struct ArtVennMain {
    @MainActor static func main() {
        if CommandLine.arguments.contains("--self-test") {
            let boundary = LocalOrigins(helper: 3580, review: 3581)
            let cases: [(String, Bool)] = [
                ("http://127.0.0.1:3580/", true), ("http://127.0.0.1:3581/projects/1/data/?task=7", true),
                ("https://127.0.0.1:3580/", false), ("http://127.0.0.1:3582/", false),
                ("http://localhost:3580/", false), ("http://127.0.0.1.evil.invalid:3580/", false),
                ("http://SYNTHETIC:SYNTHETIC@127.0.0.1:3580/", false), ("file:///tmp/test", false)
            ]
            precondition(cases.allSatisfy { boundary.contains(URL(string: $0.0)) == $0.1 })
            print("{\"nativeOriginChecks\":8,\"status\":\"PASS\"}")
            return
        }
        let application = NSApplication.shared
        let controller = AppController()
        application.setActivationPolicy(.regular)
        application.delegate = controller
        application.run()
    }
}
