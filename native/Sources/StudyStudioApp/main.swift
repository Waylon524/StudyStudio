import AppKit
import WebKit
import Darwin

private let appIdentifier = "com.waylon.studystudio"

// A native overlay owns only the blank header and the real window controls.
// Returning WebKit's hit-tested view keeps normal web controls in its responder chain.
private final class UnifiedWindowChrome: NSView {
    weak var webView: WKWebView?
    var interactiveRects: [NSRect] = []
    var standardButtons: [NSButton] = []
    var passAllWebContent = false
    var dragStarts = 0
    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden else { return nil }
        let local = convert(point, from: superview)
        guard bounds.contains(local) else { return nil }
        for button in standardButtons where !button.isHidden && button.frame.contains(local) {
            return button.hitTest(local) ?? button
        }
        if passAllWebContent || interactiveRects.contains(where: { $0.contains(local) }) {
            guard let webView else { return nil }
            return webView.hitTest(convert(local, to: webView.superview)) ?? webView
        }
        return self
    }
    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        if event.clickCount == 2 {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window.performMiniaturize(nil)
            case "None": break
            default: window.performZoom(nil)
            }
        } else {
            dragStarts += 1
            // performDrag requires the original mouse-down event from AppKit.
            window.performDrag(with: event)
        }
    }
}

private struct StandardButtonPlacement {
    let name: String
    let button: NSButton
    let kind: NSWindow.ButtonType
}

final class StudyStudioDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var contentRoot: NSView!
    private var loadingView: NSView!
    private var backend: Process?
    private var backendLog: FileHandle?
    private var startupTimer: Timer?
    private var startupDeadline = Date.distantPast
    private var startupToken = ""
    private var checkingHealth = false
    private var terminating = false
    private var failureVisible = false
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var downloadPaths: [ObjectIdentifier: (temporary: URL, destination: URL)] = [:]
    private var qaTimer: Timer?
    private var qaInFlight = false
    private var qaScriptStarted = false
    private var qaScriptResult: Any?
    private var qaScreenshotWritten = false
    private var signalSources: [DispatchSourceSignal] = []
    private var chrome: UnifiedWindowChrome?
    private var standardButtonPlacements: [StandardButtonPlacement] = []
    private var chromeHeight: CGFloat = 58
    private var fullScreenTransition = false
    private var settingsRequested = false

    private var servicePort: Int {
        guard argument("--qa-report") != nil, let raw = argument("--port"), let port = Int(raw), (1...65535).contains(port) else { return 4317 }
        return port
    }
    private var serviceURL: URL { URL(string: "http://127.0.0.1:\(servicePort)/")! }
    private var dataDirectory: URL {
        if argument("--qa-report") != nil, let path = argument("--data-root"), path.hasPrefix("/") { return URL(fileURLWithPath: path, isDirectory: true) }
        return supportDirectory.appendingPathComponent("data", isDirectory: true)
    }
    private var runtimeDirectory: URL { argument("--qa-report") != nil ? dataDirectory.deletingLastPathComponent() : supportDirectory }

    private var supportDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Study Studio", isDirectory: true)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: appIdentifier)
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier && !$0.isTerminated }
        if let existing = others.first {
            existing.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            NSApp.terminate(nil)
            return
        }
        NSApp.setActivationPolicy(.regular)
        for number in [SIGTERM, SIGINT] {
            Darwin.signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
        makeMenus()
        makeWindow()
        startBackend()
        NSApp.activate(ignoringOtherApps: true)
    }

    private func makeWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsAirPlayForMediaPlayback = false
        configuration.userContentController.add(self, name: "studyChrome")
        configuration.userContentController.addUserScript(WKUserScript(source: nativeChromeBootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let errorCapture = """
        window.__studyNativeErrors=[];
        addEventListener('error',e=>{if(window.__studyNativeErrors.length<20)window.__studyNativeErrors.push(String(e.message||'页面错误').slice(0,500));});
        addEventListener('unhandledrejection',e=>{if(window.__studyNativeErrors.length<20)window.__studyNativeErrors.push(String(e.reason?.message||e.reason||'页面错误').slice(0,500));});
        """
        if argument("--qa-report") != nil {
            configuration.userContentController.addUserScript(WKUserScript(source: errorCapture, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = .white
        webView.allowsBackForwardNavigationGestures = false
        webView.isInspectable = ProcessInfo.processInfo.environment["STUDY_NATIVE_INSPECT"] == "1"

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 950), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Study Studio"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.delegate = self
        window.minSize = NSSize(width: 900, height: 620)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("StudyStudioMainWindow")
        window.center()
        contentRoot = NSView(frame: window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 1440, height: 950))
        window.contentView = contentRoot
        webView.frame = contentRoot.bounds
        webView.autoresizingMask = [.width, .height]
        contentRoot.addSubview(webView)
        window.makeKeyAndOrderFront(nil)
        installUnifiedChrome()
        showLoading()
    }

    private var nativeChromeBootstrap: String {
        """
        (()=>{
          const mark=()=>{const root=document.documentElement;if(root&&!root.classList.contains('study-native-window'))root.classList.add('study-native-window')};mark();
          const chromeSelector='.studio-topbar,.studio-course-add,.embed-pdf-reader-header,.pdf-reader-header,.doc-reader-header,.embed-pdf-download-menu,.pdf-download-menu';
          const interactiveSelector='button,a[href],input,select,textarea,summary,[role="button"],[contenteditable="true"]';
          const modalSelector='[aria-modal="true"],dialog[open],.teaching-canvas-backdrop';
          let queued=false;
          const publish=()=>{
            queued=false;mark();
            const header=document.querySelector('.studio-topbar');
            const height=Math.max(44,Math.min(96,header?.getBoundingClientRect().height||58));
            const modal=!!document.querySelector(modalSelector);
            const rects=[];
            if(!modal){
              const seen=new Set();
              for(const root of document.querySelectorAll(chromeSelector)){
                for(const element of root.querySelectorAll(interactiveSelector)){
                  if(seen.has(element))continue;seen.add(element);
                  const r=element.getBoundingClientRect();
                  if(r.width>0&&r.height>0&&r.top<height&&r.bottom>0&&r.right>0&&r.left<innerWidth){
                    rects.push({x:Math.max(0,r.left-2),y:Math.max(0,r.top-2),width:Math.min(innerWidth,r.right+2)-Math.max(0,r.left-2),height:Math.min(height,r.bottom+2)-Math.max(0,r.top-2)});
                    if(rects.length>=128)break;
                  }
                }
                if(rects.length>=128)break;
              }
            }
            window.webkit?.messageHandlers.studyChrome.postMessage({height,rects,modal});
          };
          const schedule=()=>{if(!queued){queued=true;requestAnimationFrame(publish)}};
          const hasModalNode=(list)=>{for(const n of list){if(n&&n.nodeType===1&&(n.matches?.(modalSelector)||n.querySelector?.(modalSelector)))return true;}return false;};
          const isRelevant=(records)=>{
            for(const m of records){
              const t=m.target;
              if(!t||t.nodeType!==1)return true;
              if(t.matches?.(modalSelector))return true;
              if(t.closest?.('.reading-pane,.context-panel-body')){
                if(hasModalNode(m.addedNodes)||hasModalNode(m.removedNodes))return true;
                continue;
              }
              return true;
            }
            return false;
          };
          new MutationObserver((records)=>{if(isRelevant(records))schedule();}).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','hidden','open','aria-expanded','aria-modal']});
          addEventListener('resize',schedule);
          addEventListener('transitionend',(e)=>{if(e.target?.classList?.contains?.('studio-panel-frame'))schedule();});
          document.addEventListener('DOMContentLoaded',()=>{mark();new ResizeObserver(schedule).observe(document.documentElement);schedule()},{once:true});
          schedule();
        })();
        """
    }

    private func installUnifiedChrome() {
        guard let frameView = contentRoot else { return }
        let overlay = UnifiedWindowChrome()
        overlay.webView = webView
        overlay.autoresizingMask = [.width, .minYMargin]
        frameView.addSubview(overlay, positioned: .above, relativeTo: nil)
        chrome = overlay
        let names: [(String, NSWindow.ButtonType)] = [("close", .closeButton), ("minimize", .miniaturizeButton), ("fullscreen", .zoomButton)]
        standardButtonPlacements = names.compactMap { name, kind in
            guard let button = NSWindow.standardWindowButton(kind, for: window.styleMask) else { return nil }
            button.target = window
            if button.action == nil {
                button.action = kind == .closeButton ? #selector(NSWindow.performClose(_:)) : kind == .miniaturizeButton ? #selector(NSWindow.performMiniaturize(_:)) : #selector(NSWindow.toggleFullScreen(_:))
            }
            return StandardButtonPlacement(name: name, button: button, kind: kind)
        }
        attachStandardButtons()
        layoutUnifiedChrome()
    }

    private func attachStandardButtons() {
        guard let chrome, !fullScreenTransition, !window.styleMask.contains(.fullScreen) else { return }
        for placement in standardButtonPlacements where placement.button.superview !== chrome {
            chrome.addSubview(placement.button)
        }
        syncOriginalWindowButtons()
        chrome.standardButtons = standardButtonPlacements.map(\.button)
        chrome.isHidden = false
        layoutUnifiedChrome()
    }

    private func restoreStandardButtons() {
        for placement in standardButtonPlacements {
            window.standardWindowButton(placement.kind)?.isHidden = false
        }
        chrome?.isHidden = true
    }

    private func layoutUnifiedChrome() {
        guard let chrome, let parent = chrome.superview else { return }
        chrome.frame = NSRect(x: 0, y: parent.bounds.height - chromeHeight, width: parent.bounds.width, height: chromeHeight)
        guard !fullScreenTransition, !window.styleMask.contains(.fullScreen) else { return }
        syncOriginalWindowButtons()
        for (index, placement) in standardButtonPlacements.enumerated() where placement.button.superview === chrome {
            let size = placement.button.frame.size
            placement.button.frame.origin = NSPoint(x: 18 + CGFloat(index) * 20, y: (chromeHeight-size.height)/2)
        }
    }

    private func syncOriginalWindowButtons() {
        guard !fullScreenTransition, !window.styleMask.contains(.fullScreen) else { return }
        for placement in standardButtonPlacements {
            if let original = window.standardWindowButton(placement.kind), original !== placement.button, !original.isHidden { original.isHidden = true }
        }
    }

    func windowDidBecomeKey(_ notification: Notification) { layoutUnifiedChrome(); chrome?.standardButtons.forEach { $0.needsDisplay = true } }
    func windowDidResignKey(_ notification: Notification) { chrome?.standardButtons.forEach { $0.needsDisplay = true } }
    func windowDidUpdate(_ notification: Notification) { syncOriginalWindowButtons() }

    // This bridge accepts geometry only from the app's main document. No page
    // can use it to issue native commands or manufacture a mouse event.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "studyChrome", trustedMainFrame(message.frameInfo),
              let value = message.body as? [String: Any], let rawHeight = value["height"] as? Double,
              rawHeight.isFinite, (44...96).contains(rawHeight),
              let rectangles = value["rects"] as? [[String: Any]], rectangles.count <= 128 else { return }
        let width = Double(webView.bounds.width)
        var accepted: [NSRect] = []
        for raw in rectangles {
            guard let x = raw["x"] as? Double, let y = raw["y"] as? Double,
                  let w = raw["width"] as? Double, let h = raw["height"] as? Double,
                  [x,y,w,h].allSatisfy({ $0.isFinite }), x >= 0, y >= 0, w > 0, h > 0,
                  x <= width, y <= rawHeight, x+w <= width+1, y+h <= rawHeight+1 else { continue }
            accepted.append(NSRect(x: x, y: y, width: w, height: h))
        }
        chromeHeight = CGFloat(rawHeight)
        chrome?.interactiveRects = accepted
        chrome?.passAllWebContent = value["modal"] as? Bool == true
        layoutUnifiedChrome()
    }

    func windowDidResize(_ notification: Notification) { layoutUnifiedChrome() }
    func windowDidEndLiveResize(_ notification: Notification) { layoutUnifiedChrome() }
    func windowWillEnterFullScreen(_ notification: Notification) {
        fullScreenTransition = true
        restoreStandardButtons()
    }
    func windowDidEnterFullScreen(_ notification: Notification) { fullScreenTransition = false; chrome?.isHidden = true }
    func windowWillExitFullScreen(_ notification: Notification) { fullScreenTransition = true }
    func windowDidExitFullScreen(_ notification: Notification) { fullScreenTransition = false; attachStandardButtons() }
    func windowDidFailToEnterFullScreen(_ window: NSWindow) { fullScreenTransition = false; attachStandardButtons() }
    func windowDidFailToExitFullScreen(_ window: NSWindow) { fullScreenTransition = false; chrome?.isHidden = true }

    private func windowChromeReport() -> [String: Any] {
        func rect(_ value: NSRect) -> [String: CGFloat] { ["x":value.minX,"y":value.minY,"width":value.width,"height":value.height] }
        let buttons = standardButtonPlacements.map { placement -> [String: Any] in
            guard placement.button.window === self.window else { return ["name":placement.name,"hidden":placement.button.isHidden,"nativeManaged":true] }
            var location = webView.convert(placement.button.bounds, from: placement.button)
            if !webView.isFlipped { location.origin.y = webView.bounds.height-location.maxY }
            return ["name":placement.name,"rect":rect(location),"hidden":placement.button.isHidden,"inUnifiedHeader":placement.button.superview === chrome,"action":placement.button.action.map(NSStringFromSelector) ?? ""]
        }
        return ["frame":rect(window.frame),"contentFrame":rect(window.contentView?.frame ?? .zero),"webViewFrame":rect(webView.frame),"trafficButtons":buttons,"fullscreen":window.styleMask.contains(.fullScreen),"dragRectCount":chrome?.interactiveRects.count ?? 0,"chromeHidden":chrome?.isHidden ?? true,"dragStarts":chrome?.dragStarts ?? 0]
    }

    private func showLoading() {
        loadingView?.removeFromSuperview()
        let view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.white.cgColor
        view.translatesAutoresizingMaskIntoConstraints = false
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        let label = NSTextField(labelWithString: "正在打开 Study Studio…")
        label.font = .systemFont(ofSize: 13)
        label.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [spinner, label])
        stack.orientation = .horizontal
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        webView.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: webView.leadingAnchor), view.trailingAnchor.constraint(equalTo: webView.trailingAnchor),
            view.topAnchor.constraint(equalTo: webView.topAnchor), view.bottomAnchor.constraint(equalTo: webView.bottomAnchor),
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor), stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
        loadingView = view
    }

    private func makeMenus() {
        let menu = NSMenu()
        let appMenu = NSMenu(title: "Study Studio")
        appMenu.addItem(withTitle: "关于 Study Studio", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let settings = appMenu.addItem(withTitle: "设置…", action: #selector(openSettings), keyEquivalent: ",")
        settings.keyEquivalentModifierMask = [.command]
        settings.target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 Study Studio", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 Study Studio", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem(); appItem.submenu = appMenu; menu.addItem(appItem)

        let edit = NSMenu(title: "编辑")
        for (title, selector, key) in [("撤销", "undo:", "z"), ("重做", "redo:", "Z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: NSSelectorFromString(selector), keyEquivalent: key)
        }
        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: ""); editItem.submenu = edit; menu.addItem(editItem)
        let view = NSMenu(title: "显示")
        let reload = view.addItem(withTitle: "重新载入", action: #selector(reloadPage), keyEquivalent: "r"); reload.target = self
        let fullscreen = view.addItem(withTitle: "切换全屏", action: #selector(toggleFullScreen), keyEquivalent: "f")
        fullscreen.keyEquivalentModifierMask = [.control, .command]
        fullscreen.target = self
        let viewItem = NSMenuItem(title: "显示", action: nil, keyEquivalent: ""); viewItem.submenu = view; menu.addItem(viewItem)
        let windows = NSMenu(title: "窗口")
        windows.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windows.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windows.addItem(withTitle: "全部置于前方", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        let windowItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: ""); windowItem.submenu = windows; menu.addItem(windowItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windows
    }

    @objc private func openSettings() {
        settingsRequested = true
        if window?.isMiniaturized == true { window.deminiaturize(nil) }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        deliverSettingsRequest()
    }

    private func deliverSettingsRequest() {
        guard settingsRequested, let webView, isLocal(webView.url), !webView.isLoading else { return }
        // The flag survives an early menu request until React installs its
        // listener; dispatching does not reload the active course conversation.
        webView.evaluateJavaScript("window.__studyOpenSettingsRequested=true;window.dispatchEvent(new Event('study:open-settings'));") { [weak self] _, error in
            if error == nil { self?.settingsRequested = false }
        }
    }

    @objc private func reloadPage() { webView?.reload() }
    @objc private func toggleFullScreen() { window.toggleFullScreen(nil) }

    private func startBackend() {
        stopBackend()
        failureVisible = false
        checkingHealth = false
        showLoading()
        guard let resource = Bundle.main.resourceURL else { failStartup("应用文件不完整，请重新安装。"); return }
        let app = resource.appendingPathComponent("app", isDirectory: true)
        let node = resource.appendingPathComponent("runtime/node")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: app.appendingPathComponent("server/index.mjs").path) else {
            failStartup("应用文件不完整，请重新安装。"); return
        }
        do {
            try FileManager.default.createDirectory(at: runtimeDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let logURL = runtimeDirectory.appendingPathComponent("server.log")
            if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            let log = try FileHandle(forWritingTo: logURL)
            try log.seekToEnd()
            backendLog = log
            let process = Process()
            process.executableURL = node
            process.arguments = ["server/index.mjs"]
            process.currentDirectoryURL = app
            var environment = ProcessInfo.processInfo.environment
            environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            environment["STUDY_DATA_ROOT"] = dataDirectory.path
            environment["STUDY_PORT"] = String(servicePort)
            startupToken = UUID().uuidString
            environment["STUDY_INSTANCE_TOKEN"] = startupToken
            process.environment = environment
            process.standardOutput = log
            process.standardError = log
            process.standardInput = FileHandle.nullDevice
            process.terminationHandler = { [weak self, weak process] _ in
                DispatchQueue.main.async {
                    guard let self, let process, self.backend === process, !self.terminating else { return }
                    self.startupTimer?.invalidate()
                    self.failStartup("学习平台意外关闭了，请重新打开。")
                }
            }
            backend = process
            try process.run()
            startupDeadline = Date().addingTimeInterval(30)
            startupTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in self?.checkHealth() }
            checkHealth()
        } catch { failStartup("暂时无法启动学习平台，请重试。") }
    }

    private func checkHealth() {
        guard !checkingHealth, !failureVisible, !terminating else { return }
        if Date() > startupDeadline { failStartup("打开时间较长，请重试。若有其他学习平台窗口正在运行，请先退出。"); return }
        checkingHealth = true
        let token = startupToken
        var request = URLRequest(url: serviceURL.appendingPathComponent("api/health"))
        request.timeoutInterval = 1
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self, token == self.startupToken, !self.terminating else { return }
                self.checkingHealth = false
                guard let data, let response = response as? HTTPURLResponse, response.statusCode == 200,
                      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any], value["app"] as? String == "study-studio" else { return }
                guard value["instanceToken"] as? String == token else {
                    self.failStartup("另一个学习平台正在运行。请先退出，再点击重试。"); return
                }
                self.startupTimer?.invalidate()
                self.webView.load(URLRequest(url: self.serviceURL))
            }
        }.resume()
    }

    private func failStartup(_ message: String) {
        guard !failureVisible, !terminating else { return }
        failureVisible = true
        startupTimer?.invalidate()
        stopBackend()
        let alert = NSAlert()
        alert.messageText = "Study Studio 暂时无法打开"
        alert.informativeText = message
        alert.addButton(withTitle: "重试")
        alert.addButton(withTitle: "退出")
        alert.beginSheetModal(for: window) { [weak self] response in
            if response == .alertFirstButtonReturn { self?.startBackend() } else { NSApp.terminate(nil) }
        }
    }

    private func stopBackend() {
        startupTimer?.invalidate(); startupTimer = nil
        guard let process = backend else { try? backendLog?.close(); backendLog = nil; return }
        backend = nil
        if process.isRunning {
            process.terminate()
            let end = Date().addingTimeInterval(3)
            while process.isRunning && Date() < end { Thread.sleep(forTimeInterval: 0.05) }
            if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
        }
        try? backendLog?.close(); backendLog = nil
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return false
    }
    func applicationWillTerminate(_ notification: Notification) {
        terminating = true
        qaTimer?.invalidate()
        stopBackend()
    }

    private func isLocal(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == servicePort
    }
    private func trustedMainFrame(_ frame: WKFrameInfo) -> Bool {
        frame.isMainFrame && isLocal(frame.request.url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if navigationAction.shouldPerformDownload {
            let downloadable = isLocal(url) || ["blob", "data"].contains(url?.scheme ?? "")
            decisionHandler(trustedMainFrame(navigationAction.sourceFrame) && downloadable ? .download : .cancel)
            return
        }
        if isLocal(url) { decisionHandler(.allow); return }
        if navigationAction.targetFrame?.isMainFrame != true && url?.scheme == "about" { decisionHandler(.allow); return }
        if trustedMainFrame(navigationAction.sourceFrame), navigationAction.navigationType == .linkActivated,
           let url, ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if !navigationResponse.canShowMIMEType {
            decisionHandler(navigationResponse.isForMainFrame && isLocal(navigationResponse.response.url) ? .download : .cancel)
        } else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if trustedMainFrame(navigationAction.sourceFrame), navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url {
            if isLocal(url) { webView.load(navigationAction.request) }
            else if ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isLocal(webView.url) else { return }
        loadingView?.removeFromSuperview()
        deliverSettingsRequest()
        if argument("--qa-report") != nil && qaTimer == nil {
            qaTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.writeQAReport() }
            writeQAReport()
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { failStartup("页面暂时无法打开，请重试。") }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard trustedMainFrame(frame) else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = !parameters.allowsDirectories
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard trustedMainFrame(frame) else { completionHandler(); return }
        let alert = NSAlert(); alert.messageText = String(message.prefix(2000)); alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard trustedMainFrame(frame) else { completionHandler(false); return }
        let alert = NSAlert(); alert.messageText = String(message.prefix(2000)); alert.addButton(withTitle: "确定"); alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { track(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { track(download) }
    private func track(_ download: WKDownload) { downloads[ObjectIdentifier(download)] = download; download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard downloads[ObjectIdentifier(download)] != nil else { completionHandler(nil); return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] result in
            guard result == .OK, let destination = panel.url else { completionHandler(nil); return }
            let temporary = destination.deletingLastPathComponent().appendingPathComponent(".StudyStudio-download-" + UUID().uuidString)
            self?.downloadPaths[ObjectIdentifier(download)] = (temporary, destination)
            completionHandler(temporary)
        }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(isLocal(request.url) ? .allow : .cancel)
    }
    func downloadDidFinish(_ download: WKDownload) {
        let key = ObjectIdentifier(download)
        defer { downloads.removeValue(forKey: key); downloadPaths.removeValue(forKey: key) }
        guard let paths = downloadPaths[key] else { return }
        do {
            if FileManager.default.fileExists(atPath: paths.destination.path) {
                _ = try FileManager.default.replaceItemAt(paths.destination, withItemAt: paths.temporary)
            } else { try FileManager.default.moveItem(at: paths.temporary, to: paths.destination) }
        } catch { try? FileManager.default.removeItem(at: paths.temporary); showDownloadFailure() }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let key = ObjectIdentifier(download)
        if let paths = downloadPaths.removeValue(forKey: key) { try? FileManager.default.removeItem(at: paths.temporary) }
        downloads.removeValue(forKey: key)
        if (error as NSError).code != NSURLErrorCancelled { showDownloadFailure() }
    }
    private func showDownloadFailure() {
        let alert = NSAlert(); alert.messageText = "文件暂时无法保存"; alert.informativeText = "请重试，或选择其他保存位置。"; alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window)
    }

    private func argument(_ name: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: name), args.indices.contains(index + 1) else { return nil }
        return args[index + 1]
    }
    private func writeQAReport() {
        guard let reportPath = argument("--qa-report"), !qaInFlight else { return }
        qaInFlight = true
        let probe = """
        (()=>({url:location.href,title:document.title,ready:!!document.querySelector('.studio-shell')&&!document.querySelector('.course-loading'),textLength:document.body.innerText.length,appError:document.querySelector('.app-error')?.innerText?.slice(0,1000)||null,errors:window.__studyNativeErrors||[],course:document.querySelector('select[aria-label="课程"]')?.value||null,canvasCount:document.querySelectorAll('.teaching-canvas iframe').length,pdfBusy:document.querySelector('.pdf-reader-stage')?.getAttribute('aria-busy')||null,buttonCount:document.querySelectorAll('button').length,nativeWindow:document.documentElement.classList.contains('study-native-window'),headerRect:(()=>{const r=document.querySelector('.studio-topbar')?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null})()}))()
        """
        webView.evaluateJavaScript(probe) { [weak self] result, error in
            guard let self else { return }
            self.qaInFlight = false
            var report = result as? [String: Any] ?? [:]
            report["nativeBundle"] = Bundle.main.bundlePath
            report["windowChrome"] = self.windowChromeReport()
            report["timestamp"] = ISO8601DateFormatter().string(from: Date())
            if let error { report["probeError"] = error.localizedDescription }
            if let scriptResult = self.qaScriptResult { report["scriptResult"] = scriptResult }
            if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: URL(fileURLWithPath: reportPath), options: .atomic) }
            guard report["ready"] as? Bool == true else { return }
            if !self.qaScriptStarted, let scriptPath = self.argument("--qa-script"), let script = try? String(contentsOfFile: scriptPath, encoding: .utf8) {
                self.qaScriptStarted = true
                self.webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
                    switch result {
                    case .success(let value): self?.qaScriptResult = JSONSerialization.isValidJSONObject(["result": value]) ? value : String(describing: value)
                    case .failure(let error): self?.qaScriptResult = ["error": error.localizedDescription]
                    }
                    self?.writeQAReport()
                }
            }
            if !self.qaScreenshotWritten, let screenshotPath = self.argument("--qa-screenshot"), self.argument("--qa-script") == nil || self.qaScriptResult != nil {
                self.qaScreenshotWritten = true
                self.webView.takeSnapshot(with: nil) { image, _ in
                    guard let image, let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil), let data = NSBitmapImageRep(cgImage: cgImage).representation(using: .png, properties: [:]) else { return }
                    try? data.write(to: URL(fileURLWithPath: screenshotPath))
                }
            }
        }
    }
}

let application = NSApplication.shared
let delegate = StudyStudioDelegate()
application.delegate = delegate
application.run()
