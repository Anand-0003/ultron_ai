// ULTRON computer control: mouse, keyboard, and accessibility (reading / pressing UI elements).
//
//   control perm [--prompt]            permission status (and ask macOS for them)
//   control target [app]               JSON for the window ULTRON should act on
//   control ui [app]                   list visible UI elements of the target window
//   control marks [app] <out.jpg>      like ui, plus a screenshot with a numbered box on every clickable thing
//   control press <name> [app]         press a button / link / menu item by its visible name
//   control click <x> <y> [left|right|double]
//   control move <x> <y>
//   control drag <x1> <y1> <x2> <y2>
//   control scroll <up|down|left|right> [amount] [app]
//   control type <text> [app]
//   control key <combo e.g. cmd+shift+t> [app]
//   control pos                        current mouse position
//   control media <play|next|previous|volup|voldown|mute|brightup|brightdown>   hardware media keys
//
// Without an app name, the target is the frontmost app, unless that's the ULTRON window itself,
// in which case the app behind it is used, so "type hello" never types into ULTRON.

import AppKit
import ApplicationServices
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func die(_ msg: String) -> Never { print("ERROR: \(msg)"); exit(1) }

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { die("no command") }
func arg(_ i: Int) -> String { i < args.count ? args[i] : "" }
func num(_ i: Int) -> Double { Double(arg(i)) ?? 0 }

// Window titles of the assistant's own UI, never act on these.
let ASSISTANT_TITLES = ["ULTRON"]
func isAssistantTitle(_ t: String) -> Bool { ASSISTANT_TITLES.contains { t.contains($0) } }

// Permissions

func axTrusted(prompt: Bool) -> Bool {
  AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary)
}

if command == "perm" {
  let prompt = arg(1) == "--prompt"
  let ax = axTrusted(prompt: prompt)
  var screen = CGPreflightScreenCaptureAccess()
  if prompt && !screen { screen = CGRequestScreenCaptureAccess() }
  print("{\"accessibility\":\(ax),\"screen\":\(screen)}")
  exit(0)
}

if command != "pos" && command != "target" && !axTrusted(prompt: false) {
  die("Accessibility permission is off. Enable it for the app running ULTRON (Terminal or VS Code) in System Settings → Privacy & Security → Accessibility, then restart ULTRON.")
}

// Events

func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }

// Events stamped as coming from the hardware state, like a real mouse and keyboard.
let source = CGEventSource(stateID: .hidSystemState)

func mouseEvent(_ t: CGEventType, _ p: CGPoint, _ b: CGMouseButton = .left, clicks: Int64 = 1) {
  let e = CGEvent(mouseEventSource: source, mouseType: t, mouseCursorPosition: p, mouseButton: b)
  e?.setIntegerValueField(.mouseEventClickState, value: clicks)
  post(e)
}

// Hardware media / special keys (work with any player: Music, Spotify, YouTube in a browser...).
func mediaKey(_ key: Int) {
  for down in [true, false] {
    let ev = NSEvent.otherEvent(
      with: .systemDefined, location: .zero,
      modifierFlags: NSEvent.ModifierFlags(rawValue: down ? 0xa00 : 0xb00),
      timestamp: 0, windowNumber: 0, context: nil, subtype: 8,
      data1: (key << 16) | ((down ? 0xa : 0xb) << 8), data2: -1)
    ev?.cgEvent?.post(tap: .cghidEventTap)
    usleep(20_000)
  }
}

func mouseLocation() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

// Glide the cursor so you can see ULTRON moving it.
func glide(to p: CGPoint, dragging: Bool = false) {
  let start = mouseLocation()
  let dist = hypot(p.x - start.x, p.y - start.y)
  let steps = max(8, min(40, Int(dist / 25)))
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let e = t * t * (3 - 2 * t)
    let q = CGPoint(x: start.x + (p.x - start.x) * e, y: start.y + (p.y - start.y) * e)
    mouseEvent(dragging ? .leftMouseDragged : .mouseMoved, q)
    usleep(7_000)
  }
}

func click(_ p: CGPoint, button: String = "left") {
  let right = button == "right"
  let count = button == "double" ? 2 : 1
  glide(to: p)
  // The first click on an inactive window only activates it, so bring that window forward first.
  raiseWindow(at: p)
  usleep(40_000)
  for i in 1...count {
    mouseEvent(right ? .rightMouseDown : .leftMouseDown, p, right ? .right : .left, clicks: Int64(i))
    usleep(30_000)
    mouseEvent(right ? .rightMouseUp : .leftMouseUp, p, right ? .right : .left, clicks: Int64(i))
    usleep(60_000)
  }
}

let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
  "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
  "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
  "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
  "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51,
  "escape": 53, "esc": 53, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
  "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111, "home": 115, "pageup": 116,
  "forwarddelete": 117, "end": 119, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
]

func pressCombo(_ combo: String) {
  var flags: CGEventFlags = []
  var key: CGKeyCode?
  let parts = combo.lowercased().replacingOccurrences(of: " ", with: "").split(separator: "+").map(String.init)
  for part in parts {
    switch part {
    case "cmd", "command", "⌘", "meta", "super": flags.insert(.maskCommand)
    case "shift", "⇧": flags.insert(.maskShift)
    case "alt", "option", "opt", "⌥": flags.insert(.maskAlternate)
    case "ctrl", "control", "⌃": flags.insert(.maskControl)
    case "fn": flags.insert(.maskSecondaryFn)
    default:
      guard let k = keyCodes[part] else { die("unknown key '\(part)'") }
      key = k
    }
  }
  guard let k = key else { die("no key in '\(combo)'") }
  let d = CGEvent(keyboardEventSource: source, virtualKey: k, keyDown: true)
  d?.flags = flags
  post(d)
  usleep(25_000)
  let u = CGEvent(keyboardEventSource: source, virtualKey: k, keyDown: false)
  u?.flags = flags
  post(u)
}

func typeText(_ s: String) {
  for ch in s {
    if ch == "\n" { pressCombo("return"); usleep(10_000); continue }
    if ch == "\t" { pressCombo("tab"); usleep(10_000); continue }
    var u = Array(String(ch).utf16)
    let d = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
    d?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
    post(d)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
    up?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
    post(up)
    usleep(7_000)
  }
}

// Accessibility

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func str(_ el: AXUIElement, _ name: String) -> String {
  ((attr(el, name) as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
}
func frame(_ el: AXUIElement) -> CGRect? {
  guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
  var pt = CGPoint.zero, sz = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &pt)
  AXValueGetValue(s as! AXValue, .cgSize, &sz)
  return CGRect(origin: pt, size: sz)
}
func label(_ el: AXUIElement) -> String {
  // Name plus current value, e.g. "Edit field: 10" or "To: tony@stark.com".
  let name = [kAXTitleAttribute, kAXDescriptionAttribute].map { str(el, $0) }.first { !$0.isEmpty } ?? ""
  let value = str(el, kAXValueAttribute)
  let parts = [name, value == name ? "" : value].filter { !$0.isEmpty }
  if !parts.isEmpty { return parts.joined(separator: ": ").replacingOccurrences(of: "\n", with: " ") }
  for k in ["AXPlaceholderValue", kAXHelpAttribute] {
    let s = str(el, k)
    if !s.isEmpty { return s.replacingOccurrences(of: "\n", with: " ") }
  }
  // Buttons often carry their name on a child text element.
  if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
    for k in kids.prefix(3) where str(k, kAXRoleAttribute) == "AXStaticText" {
      let s = str(k, kAXValueAttribute)
      if !s.isEmpty { return s }
    }
  }
  return ""
}

struct Item { let el: AXUIElement; let role: String; let label: String; let rect: CGRect?; var web = false }

let listed: Set<String> = [
  "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXSearchField", "AXCheckBox", "AXRadioButton",
  "AXPopUpButton", "AXMenuButton", "AXComboBox", "AXTab", "AXStaticText", "AXCell", "AXHeading",
  "AXSlider", "AXDisclosureTriangle", "AXImage", "AXMenuItem", "AXMenuBarItem", "AXIncrementor",
]
let inputs: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]

// web: inside a page (AXWebArea), as opposed to the browser's own toolbar.
func walk(_ el: AXUIElement, _ depth: Int, _ items: inout [Item], limit: Int, needFrame: Bool, web: Bool = false) {
  if items.count >= limit || depth > 45 { return }
  let role = str(el, kAXRoleAttribute)
  let web = web || role == "AXWebArea"
  if listed.contains(role) {
    let l = label(el)
    let r = frame(el)
    let visible = r.map { $0.width > 1 && $0.height > 1 } ?? false
    let named = l.rangeOfCharacter(from: .alphanumerics) != nil // skip icon-font glyphs
    if (named || inputs.contains(role)) && (visible || !needFrame) {
      items.append(Item(el: el, role: role, label: l, rect: r, web: web))
    }
  }
  guard let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] else { return }
  for k in kids { walk(k, depth + 1, &items, limit: limit, needFrame: needFrame, web: web) }
}

func windowTitle(_ w: AXUIElement?) -> String { w.map { str($0, kAXTitleAttribute) } ?? "" }


func windowList() -> [[String: Any]] {
  (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
    .filter { ($0[kCGWindowLayer as String] as? Int) == 0 }
}


// What ULTRON acts on: an app plus the specific window. Targeting a window (not just an app) matters
// when ULTRON itself lives in a Chrome window and you ask it to work in another Chrome window.
struct Target { let app: NSRunningApplication; let window: AXUIElement? }

func appElement(_ app: NSRunningApplication) -> AXUIElement {
  let ax = AXUIElementCreateApplication(app.processIdentifier)
  // Chromium / Electron apps (Chrome, VS Code, Slack...) only expose their UI tree when asked to.
  AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  // Chromium browsers only expose web page content to "assistive" clients that set this.
  let browsers = ["com.google.Chrome", "com.brave.Browser", "com.microsoft.edgemac", "company.thebrowser.Browser", "org.chromium.Chromium"]
  if let bid = app.bundleIdentifier, browsers.contains(where: { bid.hasPrefix($0) }) {
    AXUIElementSetAttributeValue(ax, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  }
  return ax
}
func focusedWindow(_ app: NSRunningApplication) -> AXUIElement? {
  attr(appElement(app), kAXFocusedWindowAttribute).map { $0 as! AXUIElement }
}
func axWindows(_ app: NSRunningApplication) -> [AXUIElement] {
  (attr(appElement(app), kAXWindowsAttribute) as? [AXUIElement]) ?? []
}
func notUltron(_ w: AXUIElement) -> Bool { !isAssistantTitle(windowTitle(w)) }

func isUltron(_ app: NSRunningApplication) -> Bool {
  focusedWindow(app).map { !notUltron($0) } ?? false
}

func findApp(_ name: String) -> NSRunningApplication? {
  let n = name.lowercased().replacingOccurrences(of: ".app", with: "")
  let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
  let aliases = ["chrome": "google chrome", "vscode": "code", "vs code": "code", "visual studio code": "code"]
  let q = aliases[n] ?? n
  return apps.first { ($0.localizedName ?? "").lowercased() == q }
    ?? apps.first { ($0.localizedName ?? "").lowercased().contains(q) }
    ?? apps.first { ($0.bundleIdentifier ?? "").lowercased().contains(q.replacingOccurrences(of: " ", with: "")) }
}

func resolveTarget(_ name: String) -> Target {
  if !name.isEmpty {
    guard let a = findApp(name) else { die("'\(name)' is not running — open it first") }
    if let f = focusedWindow(a), notUltron(f) { return Target(app: a, window: f) }
    return Target(app: a, window: axWindows(a).first(where: notUltron))
  }
  guard let front = NSWorkspace.shared.frontmostApplication else { die("no frontmost app") }
  if let f = focusedWindow(front), notUltron(f) { return Target(app: front, window: f) }
  if focusedWindow(front) == nil && !axWindows(front).contains(where: { !notUltron($0) }) {
    return Target(app: front, window: nil) // e.g. Finder with only the desktop
  }
  // ULTRON is in front: take the next real window down, whichever app owns it.
  for w in windowList() {
    let title = (w[kCGWindowName as String] as? String) ?? ""
    let bounds = (w[kCGWindowBounds as String] as? [String: CGFloat]) ?? [:]
    guard !isAssistantTitle(title), (bounds["Height"] ?? 0) > 80, (bounds["Width"] ?? 0) > 80,
          let pid = w[kCGWindowOwnerPID as String] as? pid_t,
          let a = NSRunningApplication(processIdentifier: pid), a.activationPolicy == .regular else { continue }
    let wins = axWindows(a).filter(notUltron)
    return Target(app: a, window: wins.first { windowTitle($0) == title } ?? wins.first)
  }
  return Target(app: front, window: nil)
}

// Bring the target app *and window* to the front so keystrokes land there.
func focus(_ t: Target) {
  if t.window == nil && axWindows(t.app).contains(where: { !notUltron($0) }) {
    die("\(t.app.localizedName ?? "That app") only has the assistant window open — open a page or window first (open_url opens a new one)")
  }
  let front = NSWorkspace.shared.frontmostApplication
  if front?.processIdentifier == t.app.processIdentifier,
     let cur = focusedWindow(t.app), let w = t.window, CFEqual(cur, w) { return }
  if front?.processIdentifier != t.app.processIdentifier {
    if let bid = t.app.bundleIdentifier {
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
      p.arguments = ["-b", bid]
      try? p.run()
      p.waitUntilExit()
    } else {
      t.app.activate()
    }
    usleep(300_000)
  }
  if let w = t.window {
    AXUIElementPerformAction(w, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(w, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(appElement(t.app), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    usleep(250_000)
  }
}

func items(of t: Target, limit: Int) -> [Item] {
  guard let w = t.window else { return [] }
  var found: [Item] = []
  walk(w, 0, &found, limit: limit, needFrame: true)
  // Chromium / Electron build their tree lazily the first time it's requested. For browsers,
  // wait until actual page content (links, headings, text) shows up, not just the toolbar.
  let browser = isBrowser(t.app)
  func thin(_ f: [Item]) -> Bool {
    f.count < 4 || (browser && f.filter { ["AXLink", "AXHeading", "AXStaticText"].contains($0.role) }.count < 3)
  }
  var tries = 0
  while thin(found) && tries < 5 {
    usleep(500_000)
    found = []
    walk(w, 0, &found, limit: limit, needFrame: true)
    tries += 1
  }
  return found
}

func windowName(_ t: Target) -> String {
  let n = t.window.map(windowTitle) ?? ""
  return n.isEmpty ? "(untitled)" : n
}

// Activates the window at a screen point (front-most window whose bounds contain it).
func raiseWindow(at p: CGPoint) {
  for w in windowList() {
    guard let b = w[kCGWindowBounds as String] as? [String: CGFloat],
          CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0).contains(p),
          let pid = w[kCGWindowOwnerPID as String] as? pid_t,
          let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular else { continue }
    let title = (w[kCGWindowName as String] as? String) ?? ""
    let wins = axWindows(app)
    let match = wins.first { windowTitle($0) == title && frame($0)?.contains(p) == true }
      ?? wins.first { frame($0)?.contains(p) == true }
    let front = NSWorkspace.shared.frontmostApplication
    let alreadyKey = front?.processIdentifier == pid && match != nil && focusedWindow(app).map { CFEqual($0, match!) } == true
    if !alreadyKey { focus(Target(app: app, window: match)); usleep(120_000) }
    return
  }
}

func center(_ r: CGRect) -> CGPoint { CGPoint(x: r.midX, y: r.midY) }

// Screens in accessibility coordinates (origin top-left of the primary display).
func screenRects() -> [CGRect] {
  let primaryH = NSScreen.screens.first?.frame.height ?? 0
  return NSScreen.screens.map { CGRect(x: $0.frame.minX, y: primaryH - $0.frame.maxY, width: $0.frame.width, height: $0.frame.height) }
}
// Actually visible: its center is inside the window and on a display (not scrolled away or hidden).
func onScreen(_ r: CGRect?, in t: Target) -> Bool {
  guard let r else { return false }
  let c = center(r)
  if let w = t.window, let wf = frame(w), !wf.insetBy(dx: -2, dy: -2).contains(c) { return false }
  return screenRects().contains { $0.contains(c) }
}

let browserIDs = ["com.google.Chrome", "com.brave.Browser", "com.microsoft.edgemac", "company.thebrowser.Browser",
                  "org.chromium.Chromium", "com.apple.Safari"]
func isBrowser(_ app: NSRunningApplication) -> Bool { browserIDs.contains { (app.bundleIdentifier ?? "").hasPrefix($0) } }

func focusedElement(_ app: NSRunningApplication) -> AXUIElement? {
  attr(appElement(app), kAXFocusedUIElementAttribute).map { $0 as! AXUIElement }
}
// Can this element take typed text? (Web chat boxes are contenteditable: they carry AXEditableAncestor.)
func takesText(_ el: AXUIElement) -> Bool {
  inputs.contains(str(el, kAXRoleAttribute)) || attr(el, "AXEditableAncestor") != nil
}
func describe(_ el: AXUIElement) -> String {
  var l = label(el)
  if l.count > 70 { l = String(l.prefix(70)) + "…" }
  let at = frame(el).map { " at \(Int($0.midX)),\(Int($0.midY))" } ?? ""
  return "\(short(str(el, kAXRoleAttribute))) \"\(l)\"\(at)"
}
func short(_ role: String) -> String { String(role.dropFirst(2)) }

// Commands

switch command {
case "pos":
  let p = mouseLocation()
  print("\(Int(p.x)),\(Int(p.y))")

case "target":
  let t = resolveTarget(arg(1))
  let app = t.app
  let pid = app.processIdentifier
  let title = t.window.map(windowTitle) ?? ""
  let mine = windowList().filter {
    ($0[kCGWindowOwnerPID as String] as? pid_t) == pid && !isAssistantTitle(($0[kCGWindowName as String] as? String) ?? "")
  }
  let win = mine.first { ($0[kCGWindowName as String] as? String) == title } ?? mine.first
  let id = (win?[kCGWindowNumber as String] as? Int) ?? 0
  let name = ((win?[kCGWindowName as String] as? String) ?? "").replacingOccurrences(of: "\"", with: "'")
  let frontIsUltron = NSWorkspace.shared.frontmostApplication.map { isUltron($0) } ?? false
  print("{\"app\":\"\(app.localizedName ?? "")\",\"windowId\":\(id),\"title\":\"\(name)\",\"frontIsUltron\":\(frontIsUltron)}")

case "ui":
  let t = resolveTarget(arg(1))
  let found = items(of: t, limit: 400)
  print("App: \(t.app.localizedName ?? "?") — Window: \(windowName(t))")
  if t.window == nil { print("(no open window)") }
  if let f = focusedElement(t.app) {
    print("Keyboard focus: \(describe(f))\(takesText(f) ? " (typing goes here)" : " (not a text box)")")
  }
  let m = mouseLocation()
  print("Mouse at \(Int(m.x)),\(Int(m.y))")
  var seen = Set<String>()
  var n = 0
  for it in found {
    guard let r = it.rect, onScreen(r, in: t) else { continue }
    var l = it.label
    if l.count > 70 { l = String(l.prefix(70)) + "…" }
    let line = "\(short(it.role)) \"\(l)\" at \(Int(r.midX)),\(Int(r.midY))"
    if seen.contains(line) { continue }
    seen.insert(line)
    print(line)
    n += 1
    if n >= 140 { print("… more elements not shown"); break }
  }

case "marks":
  let t = resolveTarget(arg(1))
  let out = arg(2)
  if out.isEmpty { die("marks needs an output path") }
  let found = items(of: t, limit: 1500)
  // The window as the window server sees it: that's what screencapture grabs.
  let pid = t.app.processIdentifier
  let title = t.window.map(windowTitle) ?? ""
  let mine = windowList().filter {
    ($0[kCGWindowOwnerPID as String] as? pid_t) == pid && !isAssistantTitle(($0[kCGWindowName as String] as? String) ?? "")
  }
  // Match the accessibility window to its window-server twin by frame (titles can be blank, e.g. full-screen video).
  func cgRect(_ w: [String: Any]) -> CGRect? {
    guard let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
    return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
  }
  let axFrame = t.window.flatMap(frame)
  let byFrame = axFrame.flatMap { f in mine.first { cgRect($0).map { abs($0.minX - f.minX) + abs($0.minY - f.minY) + abs($0.width - f.width) + abs($0.height - f.height) < 8 } ?? false } }
  let win = t.window == nil ? nil : (byFrame ?? mine.first { !title.isEmpty && ($0[kCGWindowName as String] as? String) == title } ?? mine.first)
  let png = out + ".png"
  var bounds = screenRects().first ?? .zero
  var shotArgs = ["-x", "-m", png]
  if let win, let b = win[kCGWindowBounds as String] as? [String: CGFloat], let id = win[kCGWindowNumber as String] as? Int {
    bounds = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
    shotArgs = ["-x", "-o", "-l", String(id), png]
  }
  let cap = Process()
  cap.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  cap.arguments = shotArgs
  try? cap.run()
  cap.waitUntilExit()
  defer { try? FileManager.default.removeItem(atPath: png) }

  // Everything visible, in reading order; clickable things get a number.
  let markable: Set<String> = ["AXButton", "AXLink", "AXTextField", "AXTextArea", "AXSearchField", "AXCheckBox",
                               "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXComboBox", "AXTab", "AXCell",
                               "AXSlider", "AXDisclosureTriangle", "AXMenuItem", "AXIncrementor"]
  let inView = { (r: CGRect) in bounds.insetBy(dx: -2, dy: -2).contains(center(r)) && r.width >= 3 && r.height >= 3 }
  var marks: [(Int, Item, CGRect)] = []
  var lines: [String] = []
  var seenLines = Set<String>(), seenRects = Set<String>()
  for it in found {
    guard let r = it.rect, onScreen(r, in: t), inView(r) else { continue }
    var l = it.label
    if l.count > 70 { l = String(l.prefix(70)) + "…" }
    let line = "\(short(it.role)) \"\(l)\" at \(Int(r.midX)),\(Int(r.midY))"
    if seenLines.contains(line) { continue }
    seenLines.insert(line)
    let key = "\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width)),\(Int(r.height))"
    if markable.contains(it.role) && !seenRects.contains(key) && marks.count < 150 {
      seenRects.insert(key)
      marks.append((marks.count + 1, it, r))
      lines.append("[\(marks.count)] " + line)
    } else {
      lines.append(line)
    }
  }

  // Draw the boxes and numbers onto the screenshot.
  if let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: png) as CFURL, nil),
     let img = CGImageSourceCreateImageAtIndex(src, 0, nil), bounds.width > 0 {
    let W = min(img.width, 1600)
    let H = Int(Double(img.height) * Double(W) / Double(img.width))
    let fx = CGFloat(W) / bounds.width, fy = CGFloat(H) / bounds.height
    if let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0,
                           space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
      ctx.interpolationQuality = .high
      ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
      ctx.translateBy(x: 0, y: CGFloat(H))
      ctx.scaleBy(x: 1, y: -1)
      NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
      let palette: [NSColor] = [.systemRed, .systemBlue, .systemGreen, .systemPurple, .systemOrange, .systemPink, .systemTeal, .brown]
      let font = NSFont.boldSystemFont(ofSize: 13)
      for (n, _, r) in marks {
        let color = palette[(n - 1) % palette.count]
        let box = CGRect(x: (r.minX - bounds.minX) * fx, y: (r.minY - bounds.minY) * fy, width: r.width * fx, height: r.height * fy)
        ctx.setStrokeColor(color.cgColor)
        ctx.setLineWidth(2)
        ctx.stroke(box)
        let tag = "\(n)" as NSString
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
        let sz = tag.size(withAttributes: attrs)
        let y = box.minY - sz.height >= 0 ? box.minY - sz.height : box.minY
        let tagBox = CGRect(x: box.minX, y: y, width: sz.width + 4, height: sz.height)
        ctx.setFillColor(color.cgColor)
        ctx.fill(tagBox)
        tag.draw(at: CGPoint(x: tagBox.minX + 2, y: tagBox.minY), withAttributes: attrs)
      }
      NSGraphicsContext.current = nil
      if let marked = ctx.makeImage(),
         let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, "public.jpeg" as CFString, 1, nil) {
        CGImageDestinationAddImage(dest, marked, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        CGImageDestinationFinalize(dest)
      }
    }
  }

  print("App: \(t.app.localizedName ?? "?") — Window: \(windowName(t))")
  if t.window == nil { print("(no open window)") }
  if let f = focusedElement(t.app) {
    print("Keyboard focus: \(describe(f))\(takesText(f) ? " (typing goes here)" : " (not a text box)")")
  }
  let m = mouseLocation()
  print("Mouse at \(Int(m.x)),\(Int(m.y))")
  for l in lines.prefix(200) { print(l) }

case "press":
  // Labels shown by `ui` are cut at 70 chars with "..."; accept those too.
  var query = arg(1).lowercased().trimmingCharacters(in: .whitespaces)
  while query.hasSuffix("…") || query.hasSuffix("...") || query.hasSuffix("\"") {
    query = String(query.dropLast(query.hasSuffix("...") ? 3 : 1)).trimmingCharacters(in: .whitespaces)
  }
  if query.hasPrefix("\"") { query.removeFirst() }
  if query.isEmpty { die("no element name given") }
  let actionable: Set<String> = ["AXButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXCheckBox", "AXRadioButton",
                                 "AXPopUpButton", "AXMenuButton", "AXTab", "AXCell", "AXTextField", "AXTextArea",
                                 "AXSearchField", "AXComboBox"]
  // Controls are often named in words while people say symbols ("+" is the "Add" button).
  let aliases: [String: [String]] = [
    "+": ["add", "plus"], "plus": ["add"], "-": ["subtract", "minus"], "minus": ["subtract"],
    "*": ["multiply", "times"], "×": ["multiply"], "x": ["multiply", "close"], "times": ["multiply"],
    "/": ["divide"], "÷": ["divide"], "=": ["equals", "equal"], "equal": ["equals"],
    "%": ["percent"], ".": ["decimal", "point"], "c": ["clear", "all clear"], "ac": ["all clear", "clear"],
    "ok": ["okay", "done"], "back": ["go back", "back"], "forward": ["go forward"],
  ]
  let queries = [query] + (aliases[query] ?? [])
  func score(_ it: Item) -> Int {
    let l = it.label.lowercased()
    let act = actionable.contains(it.role)
    var s = queries.map { q -> Int in
      if l == q { return 100 }
      if l.hasPrefix(q) { return 60 }
      // "contains" only for controls or short labels, never a match buried in a paragraph or terminal line
      if q.count > 1 && l.contains(q) && (act || l.count <= q.count * 2) { return 30 }
      return 0
    }.max() ?? 0
    if s == 0 { return 0 }
    if act { s += 20 }
    if it.role == "AXMenuItem" || it.role == "AXMenuBarItem" { s -= 5 } // prefer on-screen controls
    return s
  }
  var others: [Item] = []
  func bestIn(_ t: Target, menus: Bool) -> Item? {
    var found = items(of: t, limit: 2500)
    // Something you can see beats something scrolled away or hidden behind a popup.
    let browser = isBrowser(t.app)
    func total(_ it: Item) -> Int {
      let sc = score(it)
      return sc == 0 ? 0 : sc + (onScreen(it.rect, in: t) ? 15 : -40) + (browser && it.web ? 25 : 0)
    }
    if menus, let bar = attr(appElement(t.app), kAXMenuBarAttribute) {
      walk(bar as! AXUIElement, 0, &found, limit: 5000, needFrame: false)
    }
    let ranked = found.map { ($0, total($0)) }.filter { $0.1 > 0 }.sorted { $0.1 > $1.1 }
    guard let b = ranked.first else { return nil }
    others = ranked.dropFirst().filter { $0.1 == b.1 && onScreen($0.0.rect, in: t) }.map { $0.0 }
    return b.0
  }
  var t = resolveTarget(arg(2))
  var hit = bestIn(t, menus: true)
  if hit == nil && arg(2).isEmpty {
    // Not in the current window: look through the other visible windows, front to back.
    var checked = 0
    for w in windowList() where checked < 8 {
      let title = (w[kCGWindowName as String] as? String) ?? ""
      guard !isAssistantTitle(title), let pid = w[kCGWindowOwnerPID as String] as? pid_t,
            let a = NSRunningApplication(processIdentifier: pid), a.activationPolicy == .regular else { continue }
      let wins = axWindows(a).filter(notUltron)
      guard let win = wins.first(where: { windowTitle($0) == title }) ?? wins.first,
            t.window.map({ !CFEqual($0, win) }) ?? true else { continue }
      checked += 1
      let cand = Target(app: a, window: win)
      if let h = bestIn(cand, menus: false) { t = cand; hit = h; break }
    }
  }
  guard let best = hit else {
    die("no element named '\(arg(1))' in \(t.app.localizedName ?? "the app") — use read_screen to see the exact labels")
  }
  let app = t.app
  focus(t)
  if !onScreen(best.rect, in: t) && !(best.role == "AXMenuItem" || best.role == "AXMenuBarItem") {
    print("Note: that element is not visible on screen right now (scrolled away or hidden).")
  }
  if !others.isEmpty {
    let list = others.prefix(4).compactMap { o in o.rect.map { "\(short(o.role)) \"\(o.label)\" at \(Int($0.midX)),\(Int($0.midY))" } }
    print("Careful: \(others.count) other element(s) match that name too: \(list.joined(separator: "; ")). If this was the wrong one, click the right one by its coordinates.")
  }
  let name = "\(short(best.role)) \"\(best.label)\""
  if inputs.contains(best.role), let r = best.rect {
    click(center(r))
    print("Clicked into \(name) in \(app.localizedName ?? "")")
  } else if isBrowser(app), let r = best.rect, onScreen(r, in: t) {
    click(center(r))
    print("Clicked \(name) at \(Int(r.midX)),\(Int(r.midY))")
  } else if AXUIElementPerformAction(best.el, kAXPressAction as CFString) == .success {
    if let r = best.rect, r.width > 1 { glide(to: center(r)) }
    print("Pressed \(name) in \(app.localizedName ?? "")")
  } else if let r = best.rect, r.width > 1 {
    click(center(r))
    print("Clicked \(name) at \(Int(r.midX)),\(Int(r.midY))")
  } else {
    die("found \(name) but couldn't press it")
  }

case "click":
  click(CGPoint(x: num(1), y: num(2)), button: arg(3).isEmpty ? "left" : arg(3).lowercased())
  print("Clicked at \(Int(num(1))),\(Int(num(2)))")

case "move":
  glide(to: CGPoint(x: num(1), y: num(2)))
  print("Moved mouse to \(Int(num(1))),\(Int(num(2)))")

case "drag":
  let a = CGPoint(x: num(1), y: num(2)), b = CGPoint(x: num(3), y: num(4))
  glide(to: a)
  mouseEvent(.leftMouseDown, a)
  usleep(80_000)
  glide(to: b, dragging: true)
  usleep(80_000)
  mouseEvent(.leftMouseUp, b)
  print("Dragged from \(Int(a.x)),\(Int(a.y)) to \(Int(b.x)),\(Int(b.y))")

case "scroll":
  let dir = arg(1).lowercased()
  let amount = Int32(max(1, min(50, Int(num(2)) == 0 ? 5 : Int(num(2)))))
  let t = resolveTarget(arg(3))
  let app = t.app
  focus(t)
  // Scroll events go to the window under the pointer, so put the pointer over the target window.
  if let w = t.window, let r = frame(w), !r.contains(mouseLocation()) { glide(to: CGPoint(x: r.midX, y: r.midY)) }
  let (dy, dx): (Int32, Int32) = dir == "up" ? (amount, 0) : dir == "left" ? (0, amount) : dir == "right" ? (0, -amount) : (-amount, 0)
  for _ in 0..<abs(Int(dy != 0 ? dy : dx)) {
    post(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
                 wheel1: dy == 0 ? 0 : (dy > 0 ? 3 : -3), wheel2: dx == 0 ? 0 : (dx > 0 ? 3 : -3), wheel3: 0))
    usleep(16_000)
  }
  print("Scrolled \(dir.isEmpty ? "down" : dir) in \(app.localizedName ?? "")")

case "type":
  let t = resolveTarget(arg(2))
  focus(t)
  // In a browser, keystrokes with no text box focused hit page shortcuts (or nothing). Don't type blind.
  if isBrowser(t.app), let f = focusedElement(t.app), !takesText(f) {
    die("no text box has keyboard focus in \(t.app.localizedName ?? "the browser") (focus is on \(describe(f))), so the text would go nowhere. Click into the text box first (click_element its name or click its coordinates), check the screen, then type.")
  }
  typeText(arg(1))
  print("Typed \(arg(1).count) characters into \(t.app.localizedName ?? "") — \(windowName(t))")

case "key":
  let t = resolveTarget(arg(2))
  focus(t)
  pressCombo(arg(1))
  print("Pressed \(arg(1)) in \(t.app.localizedName ?? "") — \(windowName(t))")

case "media":
  let keys = ["volup": 0, "voldown": 1, "brightup": 2, "brightdown": 3, "mute": 7,
              "play": 16, "pause": 16, "playpause": 16, "next": 17, "previous": 18, "prev": 18]
  guard let k = keys[arg(1).lowercased()] else { die("unknown media key '\(arg(1))'") }
  for _ in 0..<max(1, min(16, Int(num(2)))) { mediaKey(k); usleep(40_000) }
  print("Pressed \(arg(1))")

case "window":
  // control window <minimize|unminimize|fullscreen|maximize|center|left|right|top|bottom
  //                 |move <x> <y>|size <w> <h>> [app]
  let op = arg(1).lowercased()
  let hasNums = op == "move" || op == "size"
  let t = resolveTarget(arg(hasNums ? 4 : 2))
  guard let win = t.window else { die("no window to manage in \(t.app.localizedName ?? "that app")") }
  focus(t)
  func axVisible(_ scr: NSScreen) -> CGRect {
    let primaryH = NSScreen.screens.first?.frame.height ?? scr.frame.height
    let vf = scr.visibleFrame
    return CGRect(x: vf.minX, y: primaryH - vf.minY - vf.height, width: vf.width, height: vf.height)
  }
  let wr = frame(win) ?? CGRect(x: 0, y: 0, width: 800, height: 600)
  let center = CGPoint(x: wr.midX, y: wr.midY)
  let vis = NSScreen.screens.map(axVisible).first { $0.contains(center) } ?? axVisible(NSScreen.main ?? NSScreen.screens[0])
  func setFrame(_ r: CGRect) {
    var p = r.origin, s = r.size
    if let v = AXValueCreate(.cgPoint, &p) { AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, v) }
    if let v = AXValueCreate(.cgSize, &s) { AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, v) }
  }
  let H = vis.height, W = vis.width
  switch op {
  case "minimize": AXUIElementSetAttributeValue(win, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
  case "unminimize", "restore": AXUIElementSetAttributeValue(win, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
  case "fullscreen":
    let cur = (attr(win, "AXFullScreen") as? Bool) ?? false
    AXUIElementSetAttributeValue(win, "AXFullScreen" as CFString, cur ? kCFBooleanFalse : kCFBooleanTrue)
  case "maximize", "zoom": setFrame(vis)
  case "center": setFrame(CGRect(x: vis.midX - wr.width / 2, y: vis.midY - wr.height / 2, width: wr.width, height: wr.height))
  case "left", "left half": setFrame(CGRect(x: vis.minX, y: vis.minY, width: W / 2, height: H))
  case "right", "right half": setFrame(CGRect(x: vis.midX, y: vis.minY, width: W / 2, height: H))
  case "top", "top half": setFrame(CGRect(x: vis.minX, y: vis.minY, width: W, height: H / 2))
  case "bottom", "bottom half": setFrame(CGRect(x: vis.minX, y: vis.midY, width: W, height: H / 2))
  case "move": setFrame(CGRect(x: num(2), y: num(3), width: wr.width, height: wr.height))
  case "size": setFrame(CGRect(x: wr.minX, y: wr.minY, width: num(2), height: num(3)))
  default: die("unknown window op '\(op)'")
  }
  print("Window \(op) — \(t.app.localizedName ?? "") \(windowName(t))")

default:
  die("unknown command '\(command)'")
}
