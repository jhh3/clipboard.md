// axprobe — a disposable AppKit target for exercising clipmd-helper's selected-text
// chain without GUI automation.
//
// Driving a real app (Notes, Safari) from a script needs Automation TCC permission,
// which prompts a dialog and hangs in a headless/agent context. This harness selects
// its own text programmatically and comes up frontmost, so a plain `clipmd-helper
// selected-text` from another process exercises the real AX path against a real
// NSTextView with a real Edit▸Copy menu item.
//
//   swiftc -O -framework AppKit -o /tmp/axprobe axprobe.swift
//   /tmp/axprobe --text "hello" --seconds 6 &
//   sleep 2 && clipmd-helper selected-text
//
// Flags:
//   --text <s>     content to place and select (default: a known sentence)
//   --seconds <n>  how long to stay up before quitting (default 6)
//   --no-menu      omit the Edit menu, to force the tier-3 synthetic ⌘C path
//   --no-select    leave the selection empty, to test the "nothing selected" case

import AppKit

let args = CommandLine.arguments
func flagValue(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}

let text = flagValue("--text") ?? "The quick brown fox jumps over the lazy dog 12345"
let seconds = Double(flagValue("--seconds") ?? "6") ?? 6
let wantMenu = !args.contains("--no-menu")
let wantSelect = !args.contains("--no-select")

let app = NSApplication.shared
app.setActivationPolicy(.regular)

if wantMenu {
  // A real menu bar with a real ⌘C item — this is what tier 2 goes looking for.
  let mainMenu = NSMenu()
  let appItem = NSMenuItem()
  mainMenu.addItem(appItem)
  let appMenu = NSMenu()
  appMenu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
  appItem.submenu = appMenu

  let editItem = NSMenuItem()
  mainMenu.addItem(editItem)
  let editMenu = NSMenu(title: "Edit")
  // Paste must be here, not just Copy: Cocoa text views get ⌘V through the Edit
  // menu's key-equivalent matching, so a probe without it swallows every paste and
  // looks exactly like a broken helper.
  editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
  editMenu.addItem(
    NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
  editMenu.addItem(
    NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
  editMenu.addItem(
    NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
  editItem.submenu = editMenu
  app.mainMenu = mainMenu
}

let window = NSWindow(
  contentRect: NSRect(x: 200, y: 200, width: 520, height: 200),
  styleMask: [.titled, .closable],
  backing: .buffered,
  defer: false)
window.title = "axprobe"

let textView = NSTextView(frame: window.contentView!.bounds)
textView.autoresizingMask = [.width, .height]
textView.string = text
textView.isEditable = true
textView.isSelectable = true
window.contentView?.addSubview(textView)

window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(textView)
app.activate(ignoringOtherApps: true)

if wantSelect {
  textView.setSelectedRange(NSRange(location: 0, length: (text as NSString).length))
} else {
  textView.setSelectedRange(NSRange(location: 0, length: 0))
}

FileHandle.standardError.write("axprobe: ready (menu=\(wantMenu) select=\(wantSelect))\n".data(using: .utf8)!)

// On quit, print the text view's final contents to stdout. That is how a paste test
// observes its own result: post ⌘V here, then read what actually landed.
final class Reporter: NSObject {
  @objc func report() {
    FileHandle.standardOutput.write((textView.string + "\n").data(using: .utf8)!)
    NSApplication.shared.terminate(nil)
  }
}
let reporter = Reporter()

// Self-terminating so a hung test can never leave a stray window on the user's screen.
Timer.scheduledTimer(
  timeInterval: seconds, target: reporter, selector: #selector(Reporter.report),
  userInfo: nil, repeats: false)
app.run()
