// clipmd-helper — the macOS side-car for clipboard.md.
//
// Electron cannot post synthetic key events, read the accessibility tree, or decode
// compressed audio, so each of those lives here as a subcommand the main process
// spawns. Everything writes its result to stdout and uses the exit code for
// success/failure; errors go to stderr so a caller can `execFile` and read stdout raw.
//
// Build: src/native/mac/build.sh (universal arm64 + x86_64, macOS 12 baseline).

import AVFoundation
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// ── small utilities ──────────────────────────────────────────────────────────

func fail(_ message: String, code: Int32 = 1) -> Never {
  FileHandle.standardError.write(("clipmd-helper: " + message + "\n").data(using: .utf8)!)
  exit(code)
}

func output(_ text: String) {
  FileHandle.standardOutput.write(text.data(using: .utf8) ?? Data())
}

/// Virtual keycodes (Carbon `kVK_*`), hardcoded so we don't drag in Carbon.HIToolbox.
let kVirtualKeyC: CGKeyCode = 0x08
let kVirtualKeyV: CGKeyCode = 0x09

// ── accessibility trust ──────────────────────────────────────────────────────

func isTrusted(prompt: Bool) -> Bool {
  // The prompt is what makes System Settings list us; without it the user has no
  // affordance to grant anything. It is shown at most once per process.
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
  return AXIsProcessTrustedWithOptions(options)
}

// ── synthetic keystrokes ─────────────────────────────────────────────────────

/// Post a ⌘-modified keystroke to the session, the way Maccy does it.
///
/// `.combinedSessionState` matters: with a private state the synthetic ⌘ does not
/// combine with the real keyboard's state, and apps see a bare keypress with no
/// modifier. The suppression filter keeps the user's own input from being swallowed
/// during the (very short) posting interval.
func postCommandKey(_ key: CGKeyCode) {
  guard let source = CGEventSource(stateID: .combinedSessionState) else {
    fail("could not create a CGEventSource")
  }
  source.setLocalEventsFilterDuringSuppressionState(
    [.permitLocalMouseEvents, .permitLocalKeyboardEvents],
    state: .eventSuppressionStateSuppressionInterval
  )

  guard let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true),
    let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)
  else {
    fail("could not create key events")
  }
  down.flags = .maskCommand
  up.flags = .maskCommand
  down.post(tap: .cghidEventTap)
  up.post(tap: .cghidEventTap)

  // Posting is asynchronous to the window server, and this is a short-lived CLI
  // process: exiting immediately after `post` destroys the events before they are
  // delivered, and the keystroke is silently dropped. Measured against
  // src/native/mac/axprobe.swift — 0ms drain: 0/3 pastes landed; 5ms: 3/3. 30ms is
  // margin over that threshold and is invisible next to the 120ms focus-settle wait
  // the caller already budgets in paste.ts.
  Thread.sleep(forTimeInterval: 0.03)
}

// ── pasteboard ───────────────────────────────────────────────────────────────

/// A full snapshot of the general pasteboard, so a synthetic ⌘C can be undone.
///
/// Copying the user's selection to read it is destructive — it replaces whatever they
/// had copied. We save every representation of every item (not just the string) and
/// put it all back, so the only trace is a bumped `changeCount`.
struct PasteboardSnapshot {
  let items: [[String: Data]]

  static func capture() -> PasteboardSnapshot {
    var saved: [[String: Data]] = []
    for item in NSPasteboard.general.pasteboardItems ?? [] {
      var reps: [String: Data] = [:]
      for type in item.types {
        if let data = item.data(forType: type) { reps[type.rawValue] = data }
      }
      if !reps.isEmpty { saved.append(reps) }
    }
    return PasteboardSnapshot(items: saved)
  }

  func restore() {
    let pb = NSPasteboard.general
    pb.clearContents()
    guard !items.isEmpty else { return }
    var restored: [NSPasteboardItem] = []
    for reps in items {
      let item = NSPasteboardItem()
      for (type, data) in reps { item.setData(data, forType: NSPasteboard.PasteboardType(type)) }
      restored.append(item)
    }
    pb.writeObjects(restored)
  }
}

// ── accessibility tree ───────────────────────────────────────────────────────

func axCopyAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
    return nil
  }
  return value
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
  guard let raw = axCopyAttribute(element, kAXChildrenAttribute as String) else { return [] }
  return (raw as? [AXUIElement]) ?? []
}

/// Read `kAXSelectedText` from an element, or from its own focused descendant.
///
/// Some apps answer on the focused element itself; others (web areas, split views)
/// only answer one level down, on the element they report as focused.
func selectedText(of element: AXUIElement) -> String? {
  if let value = axCopyAttribute(element, kAXSelectedTextAttribute as String),
    let text = value as? String, !text.isEmpty
  {
    return text
  }
  guard let raw = axCopyAttribute(element, kAXFocusedUIElementAttribute as String),
    CFGetTypeID(raw) == AXUIElementGetTypeID()
  else { return nil }
  let inner = raw as! AXUIElement
  guard let value = axCopyAttribute(inner, kAXSelectedTextAttribute as String),
    let text = value as? String, !text.isEmpty
  else { return nil }
  return text
}

/// Tier 1: ask the focused element for its selection directly.
///
/// Instant and non-destructive: no pasteboard round trip, nothing to restore. Works in
/// native Cocoa text views (Notes, TextEdit, Mail) and Safari. Electron and JetBrains
/// apps generally don't answer, which is what the later tiers are for.
///
/// The per-application element is tried FIRST and the system-wide one only as a
/// fallback. Measured against a plain NSTextView (src/native/mac/axprobe.swift): the
/// system-wide element returns nothing for a background CLI caller, so a system-wide
/// -only implementation silently skips tier 1 and always pays for a pasteboard copy.
func axSelectedText() -> String? {
  if let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier {
    let app = AXUIElementCreateApplication(pid)
    if let raw = axCopyAttribute(app, kAXFocusedUIElementAttribute as String),
      CFGetTypeID(raw) == AXUIElementGetTypeID()
    {
      if let text = selectedText(of: raw as! AXUIElement) { return text }
    }
  }
  guard let raw = axCopyAttribute(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as String),
    CFGetTypeID(raw) == AXUIElementGetTypeID()
  else { return nil }
  return selectedText(of: raw as! AXUIElement)
}

enum CopyMenuProbe {
  case enabled(AXUIElement)
  /// Copy exists but is greyed out — proof that nothing is selected.
  case disabled
  /// No ⌘C item at all; the app may still copy, so this is inconclusive.
  case notFound
}

/// Find the frontmost app's Copy menu item by its ⌘C shortcut rather than its title.
///
/// Matching on the string "Copy" breaks on every non-English system; the command-key
/// character is the same everywhere. Modifiers == 0 means "command only", which is
/// what distinguishes Copy from ⌥⌘C, ⇧⌘C and friends.
func findCopyMenuItem(pid: pid_t) -> CopyMenuProbe {
  let app = AXUIElementCreateApplication(pid)
  guard let barRaw = axCopyAttribute(app, kAXMenuBarAttribute as String),
    CFGetTypeID(barRaw) == AXUIElementGetTypeID()
  else { return .notFound }
  let menuBar = barRaw as! AXUIElement

  for topLevel in axChildren(menuBar) {
    for menu in axChildren(topLevel) {
      for item in axChildren(menu) {
        guard let charValue = axCopyAttribute(item, kAXMenuItemCmdCharAttribute as String),
          let char = charValue as? String, char.uppercased() == "C"
        else { continue }
        let modsValue = axCopyAttribute(item, kAXMenuItemCmdModifiersAttribute as String)
        let mods = (modsValue as? NSNumber)?.intValue ?? -1
        guard mods == 0 else { continue }
        if let enabledValue = axCopyAttribute(item, kAXEnabledAttribute as String),
          let enabled = enabledValue as? Bool, !enabled
        {
          return .disabled
        }
        return .enabled(item)
      }
    }
  }
  return .notFound
}

/// Wait for the pasteboard to change, polling until `timeout`.
///
/// A fixed sleep is either too short (empty result on a slow app) or too slow to feel
/// instant. `changeCount` gives us a definite signal, so we can poll fast and return
/// the moment the copy lands.
func waitForPasteboardChange(from baseline: Int, timeout: TimeInterval) -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if NSPasteboard.general.changeCount != baseline { return true }
    Thread.sleep(forTimeInterval: 0.01)
  }
  return false
}

/// Read the selection by copying it, then put the user's pasteboard back.
///
/// `viaMenu` presses the real Copy menu item (works even where synthetic keys are
/// filtered); otherwise we post ⌘C. Both share the backup/restore dance.
func selectedTextByCopying(viaMenu menuItem: AXUIElement?) -> String? {
  let pb = NSPasteboard.general
  let snapshot = PasteboardSnapshot.capture()
  let baseline = pb.changeCount

  if let item = menuItem {
    guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else { return nil }
  } else {
    postCommandKey(kVirtualKeyC)
  }

  let changed = waitForPasteboardChange(from: baseline, timeout: 0.6)
  let text = changed ? pb.string(forType: .string) : nil

  // Restore even when nothing changed: `capture()` is cheap and this keeps the
  // failure path from leaving a half-cleared pasteboard behind.
  snapshot.restore()
  guard let text, !text.isEmpty else { return nil }
  return text
}

/// Silence the alert beep an unhandled ⌘C produces when there is no selection.
///
/// `set volume alert volume` is Standard Additions, not an app-targeted Apple event,
/// so it does not trip the automation-permission prompt. Spawning osascript costs
/// ~40ms, which is why only the synthetic-⌘C tier pays it — the AX and menu tiers
/// never beep.
func withAlertSoundMuted<T>(_ body: () -> T) -> T {
  func runOsascript(_ script: String) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = ["-e", script]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  guard let previous = runOsascript("output volume of (get volume settings)"),
    let restore = runOsascript("alert volume of (get volume settings)"),
    !restore.isEmpty
  else {
    return body()  // could not read the current level; better to beep than to guess
  }
  _ = previous
  _ = runOsascript("set volume alert volume 0")
  defer { _ = runOsascript("set volume alert volume \(restore)") }
  return body()
}

// ── audio decoding ───────────────────────────────────────────────────────────

/// Decode any AVFoundation-readable container to 16 kHz mono 16-bit WAV.
///
/// This exists because sherpa-onnx wants raw samples and macOS does not ship ffmpeg.
/// AVFoundation covers m4a/mp4/AAC, mp3, wav, aiff and caf — it does NOT read WebM or
/// Opus, so the renderer records mp4/AAC on darwin (see lib/audio.ts).
func decodeToWav(input: String, output outputPath: String) throws {
  let asset = AVURLAsset(url: URL(fileURLWithPath: input))
  guard let track = asset.tracks(withMediaType: .audio).first else {
    throw NSError(
      domain: "clipmd", code: 2,
      userInfo: [NSLocalizedDescriptionKey: "no audio track in \(input)"])
  }

  let sampleRate = 16000.0
  let settings: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVSampleRateKey: sampleRate,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
    AVLinearPCMIsNonInterleaved: false
  ]

  let reader = try AVAssetReader(asset: asset)
  let readerOutput = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
  reader.add(readerOutput)
  guard reader.startReading() else {
    throw reader.error
      ?? NSError(
        domain: "clipmd", code: 3, userInfo: [NSLocalizedDescriptionKey: "could not start reading"])
  }

  var pcm = Data()
  while let buffer = readerOutput.copyNextSampleBuffer() {
    guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
    var length = 0
    var pointer: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(
      block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer)
      == kCMBlockBufferNoErr, let pointer
    else { continue }
    pcm.append(UnsafeBufferPointer(start: UnsafeRawPointer(pointer).assumingMemoryBound(to: UInt8.self), count: length))
  }

  if reader.status == .failed {
    throw reader.error
      ?? NSError(domain: "clipmd", code: 4, userInfo: [NSLocalizedDescriptionKey: "decode failed"])
  }
  guard !pcm.isEmpty else {
    throw NSError(
      domain: "clipmd", code: 5, userInfo: [NSLocalizedDescriptionKey: "decoded zero samples"])
  }

  try writeWav(pcm: pcm, sampleRate: Int(sampleRate), channels: 1, to: outputPath)
}

/// Minimal canonical RIFF/WAVE header around the PCM payload.
func writeWav(pcm: Data, sampleRate: Int, channels: Int, to path: String) throws {
  var header = Data()
  func append32(_ value: Int) { withUnsafeBytes(of: UInt32(value).littleEndian) { header.append(contentsOf: $0) } }
  func append16(_ value: Int) { withUnsafeBytes(of: UInt16(value).littleEndian) { header.append(contentsOf: $0) } }

  let bitsPerSample = 16
  let byteRate = sampleRate * channels * bitsPerSample / 8
  let blockAlign = channels * bitsPerSample / 8

  header.append(contentsOf: Array("RIFF".utf8))
  append32(36 + pcm.count)
  header.append(contentsOf: Array("WAVEfmt ".utf8))
  append32(16)  // PCM fmt chunk size
  append16(1)  // format = PCM
  append16(channels)
  append32(sampleRate)
  append32(byteRate)
  append16(blockAlign)
  append16(bitsPerSample)
  header.append(contentsOf: Array("data".utf8))
  append32(pcm.count)

  try (header + pcm).write(to: URL(fileURLWithPath: path))
}

// ── subcommands ──────────────────────────────────────────────────────────────

func cmdPaste() {
  guard isTrusted(prompt: false) else {
    fail("accessibility permission not granted", code: 3)
  }
  postCommandKey(kVirtualKeyV)
}

func cmdFrontmost() {
  guard let app = NSWorkspace.shared.frontmostApplication else { fail("no frontmost application") }
  // Tab-separated so the caller can use the human name for display and the bundle id
  // for matching, without either having to be parsed out of a formatted string.
  let name = app.localizedName ?? ""
  let bundleId = app.bundleIdentifier ?? ""
  output("\(name)\t\(bundleId)\n")
}

func cmdSelectedText(allowCopyFallback: Bool, mute: Bool) {
  // Tier 1 — AX, instant and non-destructive.
  if let text = axSelectedText() {
    output(text)
    return
  }
  guard isTrusted(prompt: false) else { fail("accessibility permission not granted", code: 3) }
  guard allowCopyFallback else { fail("no AX selection", code: 4) }

  let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier
  let probe = pid.map(findCopyMenuItem) ?? .notFound

  // A greyed-out Copy is a definitive "nothing is selected". Bailing here instead of
  // falling through keeps the overwhelmingly common miss — hitting the rewrite hotkey
  // with no selection — fast and silent: no pasteboard round trip, no synthetic ⌘C,
  // no beep, and none of the mute cost. Measured against a cold-launched target:
  // 1576ms before, 561ms after — and most of that remainder is the one-off cost of
  // opening an AX connection to a just-started app (~450ms), not this path.
  if case .disabled = probe { fail("nothing is selected", code: 4) }

  // Tier 2 — press the real Copy menu item. Survives apps that ignore synthetic keys.
  if case .enabled(let item) = probe, let text = selectedTextByCopying(viaMenu: item) {
    output(text)
    return
  }

  // Tier 3 — synthetic ⌘C. Last resort: this is the one that can beep.
  let text = mute
    ? withAlertSoundMuted { selectedTextByCopying(viaMenu: nil) }
    : selectedTextByCopying(viaMenu: nil)
  guard let text else { fail("no selection found", code: 4) }
  output(text)
}

func cmdChangeCount() {
  output("\(NSPasteboard.general.changeCount)\n")
}

/// Long-lived pasteboard watcher: print the new `changeCount` whenever it changes.
///
/// NSPasteboard has no change notification, so someone has to poll. Doing it in the
/// Electron main process meant reading — and for images, PNG-encoding — the whole
/// pasteboard every tick just to notice nothing had happened: measured at 55.7ms per
/// poll with a screenshot on the pasteboard, every 400ms, on the thread that must
/// never block. Polling `changeCount` here is a single cheap call in a process with
/// nothing else to do, and the main process reads the clipboard only when told to.
///
/// Exits when stdin closes, so it can never outlive the app that spawned it.
func cmdWatch(intervalMs: Int) {
  let interval = TimeInterval(max(50, intervalMs)) / 1000.0

  // stdin is never written to; its EOF is purely a parent-died signal.
  let watchdog = Thread {
    while true {
      if FileHandle.standardInput.availableData.isEmpty { exit(0) }
    }
  }
  watchdog.start()

  var last = NSPasteboard.general.changeCount
  output("\(last)\n")  // baseline, so the caller can prime without a second call
  while true {
    let current = NSPasteboard.general.changeCount
    if current != last {
      last = current
      output("\(current)\n")
    }
    Thread.sleep(forTimeInterval: interval)
  }
}

func cmdTrust(prompt: Bool) {
  let trusted = isTrusted(prompt: prompt)
  output(trusted ? "trusted\n" : "untrusted\n")
  exit(trusted ? 0 : 3)
}

func cmdDecodeAudio(_ args: [String]) {
  guard args.count >= 2 else { fail("usage: decode-audio <input> <output.wav>") }
  do {
    try decodeToWav(input: args[0], output: args[1])
  } catch {
    fail(error.localizedDescription, code: 5)
  }
}

// ── entry point ──────────────────────────────────────────────────────────────

let arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first else {
  fail("usage: clipmd-helper <paste|frontmost|selected-text|changecount|trust|decode-audio>")
}
let rest = Array(arguments.dropFirst())

switch command {
case "paste":
  cmdPaste()
case "frontmost":
  cmdFrontmost()
case "selected-text":
  cmdSelectedText(
    allowCopyFallback: !rest.contains("--ax-only"),
    mute: !rest.contains("--no-mute"))
case "changecount":
  cmdChangeCount()
case "watch":
  let index = rest.firstIndex(of: "--interval-ms").map { $0 + 1 }
  cmdWatch(intervalMs: index.flatMap { $0 < rest.count ? Int(rest[$0]) : nil } ?? 300)
case "trust":
  cmdTrust(prompt: rest.contains("--prompt"))
case "decode-audio":
  cmdDecodeAudio(rest)
default:
  fail("unknown subcommand: \(command)")
}
