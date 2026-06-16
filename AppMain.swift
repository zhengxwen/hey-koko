import Cocoa
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var serverProcess: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
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

        // Ensure full PATH is available to Node.js (includes Homebrew tools like pandoc, mineru)
        var env = ProcessInfo.processInfo.environment
        let commonPaths = [
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
        process.environment = env

        do {
            try process.run()
            serverProcess = process
        } catch {
            let alert = NSAlert()
            alert.messageText = "Unable to start server"
            alert.informativeText = "Please ensure Node.js is installed\nhttps://nodejs.org"
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

        window = NSWindow(
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
        window.contentView?.addSubview(webView)
    }

    func waitAndLoad() {
        DispatchQueue.global().async { [weak self] in
            let url = URL(string: "http://127.0.0.1:1314")!
            var ready = false
            for _ in 0..<100 { // up to 10 seconds
                if let _ = try? Data(contentsOf: url) {
                    ready = true
                    break
                }
                Thread.sleep(forTimeInterval: 0.1)
            }
            DispatchQueue.main.async {
                if ready {
                    self?.webView.load(URLRequest(url: url))
                    self?.window.makeKeyAndOrderFront(nil)
                    NSApp.activate(ignoringOtherApps: true)
                } else {
                    let alert = NSAlert()
                    alert.messageText = "Server startup timeout"
                    alert.informativeText = "Unable to connect to http://127.0.0.1:1314"
                    alert.alertStyle = .warning
                    alert.runModal()
                    NSApp.terminate(nil)
                }
            }
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
