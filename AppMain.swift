// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

import Cocoa
import WebKit

// Custom window to handle zoom keyboard shortcuts
class ZoomWindow: NSWindow {
    var webView: WKWebView?

    override func keyDown(with event: NSEvent) {
        let commandKey = event.modifierFlags.contains(.command)
        let characters = event.characters?.lowercased() ?? ""

        if commandKey {
            if characters == "=" || characters == "+" {
                // Cmd+ : Zoom in
                webView?.magnification += 0.1
                return
            } else if characters == "-" {
                // Cmd- : Zoom out
                webView?.magnification -= 0.1
                return
            } else if characters == "0" {
                // Cmd+0 : Reset zoom
                webView?.magnification = 1.0
                return
            }
        }

        super.keyDown(with: event)
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var serverProcess: Process?
    var napActivity: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Disable App Nap so the background-job queue's timers and fetch/promise
        // callbacks keep firing even when the window is occluded or the user is idle
        // — otherwise macOS throttles the WebView and the next job won't start until
        // the user moves the mouse. Still permits genuine idle system sleep.
        napActivity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiatedAllowingIdleSystemSleep],
            reason: "hey-koko background job queue")
        startServer()
        createWindow()
        waitAndLoad()
    }

    func startServer() {
        let appPath = Bundle.main.resourcePath! + "/app"
        let nodePaths = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ]

        var nodeBin: String?
        for p in nodePaths {
            if FileManager.default.isExecutableFile(atPath: p) {
                nodeBin = p
                break
            }
        }
        // Also check PATH via /usr/bin/env
        if nodeBin == nil {
            nodeBin = "/usr/bin/env"
        }

        let process = Process()

        if nodeBin == "/usr/bin/env" {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["node", "server.js"]
        } else {
            process.executableURL = URL(fileURLWithPath: nodeBin!)
            process.arguments = ["server.js"]
        }
        process.currentDirectoryURL = URL(fileURLWithPath: appPath)

        // Ensure full PATH is available to Node.js (includes Homebrew tools like pandoc, mineru).
        // A Finder-launched app gets only a minimal PATH, so prepend the common tool dirs plus
        // the user's ~/local/bin and ~/.local/bin (where tools like mineru live).
        var env = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()
        let commonPaths = [
            home + "/local/bin",
            home + "/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/opt/homebrew/sbin",
            "/usr/local/sbin"
        ]
        if let existingPath = env["PATH"] {
            let pathSet = Set(existingPath.split(separator: ":").map(String.init))
            let combined = commonPaths.filter { !pathSet.contains($0) } + existingPath.split(separator: ":").map(String.init)
            env["PATH"] = combined.joined(separator: ":")
        } else {
            env["PATH"] = commonPaths.joined(separator: ":")
        }
        // ComfyUI endpoint. Read COMFYUI_URL from the environment so the server can
        // reach a ComfyUI on another host. A Finder-launched app gets only the
        // launchd environment, so set it once with:
        //     launchctl setenv COMFYUI_URL http://192.168.1.3:8188
        // (then relaunch the app), or export it when launching from a terminal.
        // env already inherits it; this just surfaces it explicitly + logs it.
        if let comfyUrl = ProcessInfo.processInfo.environment["COMFYUI_URL"], !comfyUrl.isEmpty {
            env["COMFYUI_URL"] = comfyUrl
            NSLog("[hey-koko] COMFYUI_URL = \(comfyUrl)")
        } else {
            NSLog("[hey-koko] COMFYUI_URL not set — server defaults to http://127.0.0.1:8188")
        }
        process.environment = env

        // Log the command being executed
        NSLog("[hey-koko] Starting server with: \(nodeBin ?? "node") \(process.arguments?.joined(separator: " ") ?? "")")
        NSLog("[hey-koko] Working directory: \(appPath)")

        do {
            try process.run()
            serverProcess = process
            NSLog("[hey-koko] Server process started with PID: \(process.processIdentifier)")
        } catch {
            let alert = NSAlert()
            alert.messageText = "Unable to start server"
            alert.informativeText = "Please ensure Node.js is installed\nhttps://nodejs.org\n\nError: \(error.localizedDescription)"
            alert.alertStyle = .critical
            alert.runModal()
            NSApp.terminate(nil)
        }
    }

    func createWindow() {
        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        let width: CGFloat = min(1280, screenFrame.width * 0.85)
        let height: CGFloat = min(900, screenFrame.height * 0.85)
        let x = screenFrame.origin.x + (screenFrame.width - width) / 2
        let y = screenFrame.origin.y + (screenFrame.height - height) / 2

        window = ZoomWindow(
            contentRect: NSRect(x: x, y: y, width: width, height: height),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Local AI Chat"
        window.minSize = NSSize(width: 600, height: 400)
        window.isReleasedWhenClosed = false
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.uiDelegate = self   // so JS alert()/confirm()/prompt() show native dialogs
        window.contentView?.addSubview(webView)

        // Connect webView to window for zoom handling
        (window as? ZoomWindow)?.webView = webView
    }

    func waitAndLoad() {
        DispatchQueue.global().async { [weak self] in
            let healthUrl = URL(string: "http://127.0.0.1:1314/health")!
            let indexUrl = URL(string: "http://127.0.0.1:1314")!
            var ready = false
            let maxAttempts = 300  // 30 seconds (more time for Node startup)

            NSLog("[hey-koko] Waiting for server at http://127.0.0.1:1314...")

            for attempt in 0..<maxAttempts {
                do {
                    let data = try Data(contentsOf: healthUrl, options: .alwaysMapped)
                    if !data.isEmpty {
                        ready = true
                        NSLog("[hey-koko] Server ready after \(attempt * 100)ms")
                        break
                    }
                } catch {
                    if attempt % 50 == 0 {  // Log every 5 seconds
                        NSLog("[hey-koko] Still waiting... attempt \(attempt)/\(maxAttempts)")
                    }
                }
                Thread.sleep(forTimeInterval: 0.1)
            }

            DispatchQueue.main.async {
                if ready {
                    NSLog("[hey-koko] Loading UI...")
                    self?.webView.load(URLRequest(url: indexUrl))
                    self?.window.makeKeyAndOrderFront(nil)
                    NSApp.activate(ignoringOtherApps: true)
                } else {
                    NSLog("[hey-koko] Server startup timeout - unable to reach health endpoint")
                    let alert = NSAlert()
                    alert.messageText = "Server startup timeout"
                    alert.informativeText = "Unable to connect to http://127.0.0.1:1314 after 30 seconds.\n\n1. Check Console.app for error logs\n2. Verify Node.js is installed: node --version\n3. Try running: cd ~/Documents/Codes/Repository/hey-koko && node server.js"
                    alert.alertStyle = .warning
                    alert.runModal()
                    NSApp.terminate(nil)
                }
            }
        }
    }

    // MARK: - WKUIDelegate (JS dialogs)
    // Without these, window.alert/confirm/prompt are silently dropped by WKWebView.
    // Shown as window sheets so they don't block the app's run loop.

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        if let win = webView.window {
            alert.beginSheetModal(for: win) { _ in completionHandler() }
        } else {
            alert.runModal(); completionHandler()
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        if let win = webView.window {
            alert.beginSheetModal(for: win) { resp in completionHandler(resp == .alertFirstButtonReturn) }
        } else {
            completionHandler(alert.runModal() == .alertFirstButtonReturn)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        let finish: (NSApplication.ModalResponse) -> Void = { resp in
            completionHandler(resp == .alertFirstButtonReturn ? field.stringValue : nil)
        }
        if let win = webView.window {
            alert.beginSheetModal(for: win, completionHandler: finish)
        } else {
            finish(alert.runModal())
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverProcess?.terminate()
        serverProcess?.waitUntilExit()
    }
}

// --- Main ---
let app = NSApplication.shared
app.setActivationPolicy(.regular)

// --- Setup Main Menu (enables Cmd+C, Cmd+V, Cmd+X, Cmd+A, Cmd+Z) ---
let mainMenu = NSMenu()

// App menu
let appMenuItem = NSMenuItem()
mainMenu.addItem(appMenuItem)
let appMenu = NSMenu()
appMenu.addItem(withTitle: "About hey-koko", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
appMenu.addItem(NSMenuItem.separator())
appMenu.addItem(withTitle: "Hide hey-koko", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
let hideOthers = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
hideOthers.keyEquivalentModifierMask = [.command, .option]
appMenu.addItem(hideOthers)
appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
appMenu.addItem(NSMenuItem.separator())
appMenu.addItem(withTitle: "Quit hey-koko", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
appMenuItem.submenu = appMenu

// Edit menu
let editMenuItem = NSMenuItem()
mainMenu.addItem(editMenuItem)
let editMenu = NSMenu(title: "Edit")
editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
editMenu.addItem(NSMenuItem.separator())
editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
editMenuItem.submenu = editMenu

// View menu
let viewMenuItem = NSMenuItem()
mainMenu.addItem(viewMenuItem)
let viewMenu = NSMenu(title: "View")
viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
viewMenuItem.submenu = viewMenu

// Window menu
let windowMenuItem = NSMenuItem()
mainMenu.addItem(windowMenuItem)
let windowMenu = NSMenu(title: "Window")
windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
windowMenuItem.submenu = windowMenu

app.mainMenu = mainMenu

let delegate = AppDelegate()
app.delegate = delegate
app.run()
