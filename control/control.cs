// ULTRON computer control for Windows: mouse, keyboard and UI Automation.
// Same commands and the same output as control.swift, so the server doesn't care which one it runs.
//
//   control perm                       permission status (always granted on Windows)
//   control target [app]               JSON for the window ULTRON should act on
//   control ui [app]                   list visible UI elements of the target window
//   control marks [app] <out.jpg>      like ui, plus a screenshot with a numbered box on every clickable thing
//   control press <name> [app]         press a button / link / menu item by its visible name
//   control click <x> <y> [left|right|double]
//   control move <x> <y>
//   control drag <x1> <y1> <x2> <y2>
//   control scroll <up|down|left|right> [amount] [app]
//   control type <text> [app]
//   control key <combo e.g. ctrl+shift+t> [app]
//   control pos                        current mouse position
//   control media <play|next|previous|volup|voldown|mute|brightup|brightdown> [times]
//   control window <op> [args] [app]
// Windows only:
//   control shot <out.jpg> [app] [auto|window|screen]
//   control image <in> <out.jpg>       any image to a JPEG, at most 1600 px wide
//   control volume <0-100>
//   control display off | awake | wake
//
// Built on first run by server.js with the C# compiler that ships with Windows (.NET Framework 4),
// so this file sticks to C# 5.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

static class Native {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }

  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char c);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
}

// Core Audio, for setting the master volume to an exact level.
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int GetChannelCount(out uint count);
  [PreserveSig] int SetMasterVolumeLevel(float levelDB, ref Guid context);
  [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
  [PreserveSig] int GetMasterVolumeLevel(out float levelDB);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
  [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDB, ref Guid context);
  [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
  [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDB);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

class Item {
  public AutomationElement El;
  public string Role;       // "Button", "Edit", "Hyperlink"...
  public string Label;
  public Rectangle Rect;    // empty when the element has no size
  public bool Offscreen;
}

class Target {
  public IntPtr Hwnd;       // IntPtr.Zero when there's no window
  public uint Pid;
  public string App;
}

static class Program {
  static TextWriter Out;
  static string[] Args;
  static string Arg(int i) { return i < Args.Length ? Args[i] : ""; }
  static double Num(int i) { double d; return double.TryParse(Arg(i), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out d) ? d : 0; }

  static void Print(string s) { Out.WriteLine(s); }
  static void Die(string msg) { Out.WriteLine("ERROR: " + msg); Out.Flush(); Environment.Exit(1); }

  // Window titles of the assistant's own UI: never act on these.
  static readonly string[] ASSISTANT_TITLES = { "ULTRON" };
  static bool IsAssistantTitle(string t) { return ASSISTANT_TITLES.Any(a => t.Contains(a)); }

  static readonly string[] BROWSERS = { "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "arc" };

  // Windows

  static string Title(IntPtr h) {
    int n = Native.GetWindowTextLength(h);
    if (n <= 0) return "";
    var sb = new StringBuilder(n + 1);
    Native.GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }

  static bool IsAppWindow(IntPtr h) {
    if (!Native.IsWindowVisible(h) || Title(h).Length == 0) return false;
    if ((Native.GetWindowLong(h, -20) & 0x80) != 0) return false;          // WS_EX_TOOLWINDOW
    if (Native.GetAncestor(h, 3) != h) return false;                       // owned popups
    int cloaked;
    if (Native.DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return false;   // hidden Store app shells
    string t = Title(h);
    return t != "Program Manager" && t != "Windows Input Experience";
  }

  static List<IntPtr> Windows() {
    var list = new List<IntPtr>();
    Native.EnumWindows((h, l) => { if (IsAppWindow(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;   // front to back
  }

  static uint PidOf(IntPtr h) { uint pid; Native.GetWindowThreadProcessId(h, out pid); return pid; }

  static string ProcName(uint pid) {
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }

  static string AppName(uint pid) {
    try {
      var p = Process.GetProcessById((int)pid);
      try {
        string d = p.MainModule.FileVersionInfo.FileDescription;
        if (!string.IsNullOrWhiteSpace(d)) return d.Trim();
      } catch { }
      return p.ProcessName;
    } catch { return "?"; }
  }

  static string Squash(string s) { return new string((s ?? "").ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray()); }

  static bool MatchesApp(IntPtr h, string app) {
    string q = Squash(app);
    if (q.Length == 0) return false;
    uint pid = PidOf(h);
    string proc = Squash(ProcName(pid));
    if (proc == q || (proc.Length >= 4 && q.Contains(proc)) || (q.Length >= 3 && proc.Contains(q))) return true;
    if (Squash(Title(h)).Contains(q)) return true;
    string desc = Squash(AppName(pid));
    return desc == q || (q.Length >= 3 && desc.Contains(q));
  }

  static bool IsUltron(IntPtr h) { return h != IntPtr.Zero && IsAssistantTitle(Title(h)); }

  static Target MakeTarget(IntPtr h) {
    var t = new Target { Hwnd = h };
    t.Pid = h == IntPtr.Zero ? 0 : PidOf(h);
    t.App = t.Pid == 0 ? "Desktop" : AppName(t.Pid);
    return t;
  }

  // Without an app name: the frontmost window, unless that's ULTRON itself, then the one behind it.
  static Target Resolve(string app) {
    var wins = Windows().Where(w => !IsUltron(w)).ToList();
    if (!string.IsNullOrWhiteSpace(app)) {
      foreach (var w in wins) if (MatchesApp(w, app)) return MakeTarget(w);
      Die(app + " has no open window. Open it first (open_app).");
    }
    IntPtr fg = Native.GetAncestor(Native.GetForegroundWindow(), 2);
    if (fg != IntPtr.Zero && !IsUltron(fg) && IsAppWindow(fg)) return MakeTarget(fg);
    return MakeTarget(wins.Count > 0 ? wins[0] : IntPtr.Zero);
  }

  static bool IsBrowser(Target t) { string p = ProcName(t.Pid).ToLowerInvariant(); return BROWSERS.Contains(p); }

  static Rectangle WindowRect(IntPtr h) {
    Native.RECT r;
    if (Native.DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(Native.RECT))) != 0) Native.GetWindowRect(h, out r);   // visible frame, no shadow
    return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
  }

  static Rectangle WorkArea(IntPtr h) {
    var mi = new Native.MONITORINFO { cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO)) };
    Native.GetMonitorInfo(Native.MonitorFromWindow(h, 2), ref mi);
    return Rectangle.FromLTRB(mi.rcWork.Left, mi.rcWork.Top, mi.rcWork.Right, mi.rcWork.Bottom);
  }

  static string WindowName(Target t) { return t.Hwnd == IntPtr.Zero ? "(none)" : Title(t.Hwnd); }

  static void Focus(Target t) {
    IntPtr h = t.Hwnd;
    if (h == IntPtr.Zero) return;
    if (Native.IsIconic(h)) Native.ShowWindow(h, 9);
    if (Native.GetForegroundWindow() == h) return;
    uint fgThread = Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out _unused);
    uint me = Native.GetCurrentThreadId();
    Native.AttachThreadInput(fgThread, me, true);
    Native.BringWindowToTop(h);
    Native.SetForegroundWindow(h);
    Native.AttachThreadInput(fgThread, me, false);
    if (Native.GetForegroundWindow() != h) {
      // Windows only hands focus to the process that sent the last input, so send some.
      Native.keybd_event(0x12, 0, 0x1, UIntPtr.Zero);
      Native.keybd_event(0x12, 0, 0x1 | 0x2, UIntPtr.Zero);
      Native.SetForegroundWindow(h);
    }
    Thread.Sleep(120);
  }
  static uint _unused;

  // Input

  static Native.POINT MouseLocation() { Native.POINT p; Native.GetCursorPos(out p); return p; }

  static void Send(params Native.INPUT[] inputs) { Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Native.INPUT))); }

  static Native.INPUT Mouse(uint flags, uint data) {
    var i = new Native.INPUT { type = 0 };
    i.u.mi = new Native.MOUSEINPUT { dwFlags = flags, mouseData = data };
    return i;
  }

  static Native.INPUT Key(ushort vk, ushort scan, uint flags) {
    var i = new Native.INPUT { type = 1 };
    i.u.ki = new Native.KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
    return i;
  }

  // The pointer moves visibly, so you can watch it work.
  static void Glide(int x, int y) {
    var p = MouseLocation();
    double dist = Math.Sqrt(Math.Pow(x - p.X, 2) + Math.Pow(y - p.Y, 2));
    int steps = Math.Max(1, Math.Min(30, (int)(dist / 25)));
    for (int i = 1; i <= steps; i++) {
      double k = (double)i / steps;
      k = k * k * (3 - 2 * k);
      Native.SetCursorPos((int)Math.Round(p.X + (x - p.X) * k), (int)Math.Round(p.Y + (y - p.Y) * k));
      Thread.Sleep(8);
    }
    Native.SetCursorPos(x, y);
  }

  static void Click(int x, int y, string button) {
    Glide(x, y);
    Thread.Sleep(40);
    uint down = 0x2, up = 0x4;
    if (button == "right") { down = 0x8; up = 0x10; }
    int n = button == "double" ? 2 : 1;
    for (int i = 0; i < n; i++) {
      Send(Mouse(down, 0));
      Thread.Sleep(30);
      Send(Mouse(up, 0));
      if (i + 1 < n) Thread.Sleep(70);
    }
  }

  static void TypeText(string text) {
    foreach (char c in text.Replace("\r\n", "\n")) {
      if (c == '\n') { Tap(0x0D); continue; }
      if (c == '\t') { Tap(0x09); continue; }
      Send(Key(0, c, 0x4), Key(0, c, 0x4 | 0x2));   // KEYEVENTF_UNICODE
      Thread.Sleep(4);
    }
  }

  static readonly HashSet<ushort> EXTENDED = new HashSet<ushort> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C };
  static void Down(ushort vk) { Send(Key(vk, 0, EXTENDED.Contains(vk) ? 0x1u : 0u)); }
  static void Up(ushort vk) { Send(Key(vk, 0, (EXTENDED.Contains(vk) ? 0x1u : 0u) | 0x2)); }
  static void Tap(ushort vk) { Down(vk); Thread.Sleep(15); Up(vk); }

  static readonly Dictionary<string, ushort> KEYS = new Dictionary<string, ushort> {
    { "return", 0x0D }, { "enter", 0x0D }, { "tab", 0x09 }, { "escape", 0x1B }, { "esc", 0x1B }, { "space", 0x20 },
    { "backspace", 0x08 }, { "delete", 0x2E }, { "del", 0x2E }, { "forwarddelete", 0x2E }, { "insert", 0x2D },
    { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 }, { "home", 0x24 }, { "end", 0x23 },
    { "pageup", 0x21 }, { "pagedown", 0x22 }, { "capslock", 0x14 }, { "printscreen", 0x2C },
    { "=", 0xBB }, { "plus", 0xBB }, { "-", 0xBD }, { "minus", 0xBD }, { "[", 0xDB }, { "]", 0xDD }, { ",", 0xBC },
    { ".", 0xBE }, { "/", 0xBF }, { ";", 0xBA }, { "'", 0xDE }, { "`", 0xC0 }, { "\\", 0xDC },
  };

  static ushort VkFor(string k) {
    ushort vk;
    if (KEYS.TryGetValue(k, out vk)) return vk;
    if (k.Length > 1 && k[0] == 'f') { int n; if (int.TryParse(k.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x6F + n); }
    if (k.Length == 1) {
      char c = char.ToUpperInvariant(k[0]);
      if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
      short s = Native.VkKeyScan(k[0]);
      if (s != -1) return (ushort)(s & 0xFF);
    }
    Die("unknown key '" + k + "'");
    return 0;
  }

  static void PressCombo(string combo) {
    var mods = new List<ushort>();
    ushort key = 0;
    var parts = combo.ToLowerInvariant().Replace(" ", "").Split('+');
    for (int i = 0; i < parts.Length; i++) {
      string p = parts[i];
      if (p == "" && i == parts.Length - 1) p = "=";   // "ctrl++"
      if (p == "") continue;
      if (p == "ctrl" || p == "control" || p == "cmd" || p == "command") mods.Add(0x11);
      else if (p == "shift") mods.Add(0x10);
      else if (p == "alt" || p == "option" || p == "opt") mods.Add(0x12);
      else if (p == "win" || p == "super" || p == "meta" || p == "windows") mods.Add(0x5B);
      else key = VkFor(p);
    }
    foreach (var m in mods) Down(m);
    if (key != 0) Tap(key);
    else if (mods.Count == 1) { Thread.Sleep(15); }
    mods.Reverse();
    foreach (var m in mods) Up(m);
  }

  // UI Automation

  static Item ToItem(AutomationElement e) {
    try {
      var c = e.Cached;
      string role = c.ControlType == null ? "Unknown" : c.ControlType.ProgrammaticName.Replace("ControlType.", "");
      string label = (c.Name ?? "").Trim();
      object v = e.GetCachedPropertyValue(ValuePattern.ValueProperty, true);
      string val = v == AutomationElement.NotSupported || v == null ? "" : v.ToString().Trim();
      if (val.Length > 0 && val != label && (role == "Edit" || role == "ComboBox" || role == "Document" || role == "Spinner" || role == "Slider"))
        label = label.Length > 0 ? label + ": " + val : val;
      label = System.Text.RegularExpressions.Regex.Replace(label, @"\s+", " ");
      var r = c.BoundingRectangle;
      var rect = r.IsEmpty || double.IsInfinity(r.Width) ? Rectangle.Empty
        : new Rectangle((int)r.X, (int)r.Y, (int)Math.Max(0, r.Width), (int)Math.Max(0, r.Height));
      return new Item { El = e, Role = role, Label = label, Rect = rect, Offscreen = c.IsOffscreen };
    } catch { return null; }
  }

  static CacheRequest Request() {
    var cr = new CacheRequest();
    cr.Add(AutomationElement.NameProperty);
    cr.Add(AutomationElement.ControlTypeProperty);
    cr.Add(AutomationElement.BoundingRectangleProperty);
    cr.Add(AutomationElement.IsOffscreenProperty);
    cr.Add(ValuePattern.ValueProperty);
    cr.TreeScope = TreeScope.Element;
    return cr;
  }

  static List<Item> Items(Target t, int limit) {
    var list = new List<Item>();
    if (t.Hwnd == IntPtr.Zero) return list;
    try {
      var root = AutomationElement.FromHandle(t.Hwnd);
      AutomationElementCollection all;
      using (Request().Activate()) { all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition); }
      foreach (AutomationElement e in all) {
        var it = ToItem(e);
        if (it == null || (it.Label.Length == 0 && it.Role != "Edit" && it.Role != "Document")) continue;
        list.Add(it);
        if (list.Count >= limit) break;
      }
    } catch { }
    return list;
  }

  static AutomationElement FocusedElement(Target t) {
    try {
      AutomationElement f;
      using (Request().Activate()) { f = AutomationElement.FocusedElement; }
      if (f == null || (t.Pid != 0 && f.Current.ProcessId != (int)t.Pid)) return null;
      return f;
    } catch { return null; }
  }

  static bool TakesText(AutomationElement e) {
    try {
      var ct = e.Current.ControlType;
      if (ct == ControlType.Edit || ct == ControlType.Document || ct == ControlType.ComboBox) return true;
      object p;
      if (e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return !((ValuePattern)p).Current.IsReadOnly;
    } catch { }
    return false;
  }

  static string Describe(AutomationElement e) {
    var it = ToItem(e);
    if (it == null) return "an element";
    return it.Role + " \"" + Cut(it.Label) + "\"";
  }

  static string Cut(string l) { return l.Length > 70 ? l.Substring(0, 70) + "..." : l; }

  static Point Center(Rectangle r) { return new Point(r.X + r.Width / 2, r.Y + r.Height / 2); }

  static bool OnScreen(Item it, Target t) {
    if (it.Rect.IsEmpty || it.Rect.Width < 1 || it.Rect.Height < 1 || it.Offscreen) return false;
    if (t.Hwnd == IntPtr.Zero) return true;
    return WindowRect(t.Hwnd).Contains(Center(it.Rect));
  }

  static string Line(Item it) {
    var c = Center(it.Rect);
    return it.Role + " \"" + Cut(it.Label) + "\" at " + c.X + "," + c.Y;
  }

  static void PrintHead(Target t) {
    Print("App: " + t.App + " - Window: " + WindowName(t));
    if (t.Hwnd == IntPtr.Zero) Print("(no open window)");
    var f = FocusedElement(t);
    if (f != null) Print("Keyboard focus: " + Describe(f) + (TakesText(f) ? " (typing goes here)" : " (not a text box)"));
    var m = MouseLocation();
    Print("Mouse at " + m.X + "," + m.Y);
  }

  // Screenshots

  static Bitmap CaptureRect(Rectangle r) {
    var bmp = new Bitmap(Math.Max(1, r.Width), Math.Max(1, r.Height), PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(r.Left, r.Top, 0, 0, bmp.Size, CopyPixelOperation.SourceCopy);
    return bmp;
  }

  // The window itself, even when something (like ULTRON) is in front of it.
  static Bitmap CaptureWindow(IntPtr h, out Rectangle bounds) {
    bounds = WindowRect(h);
    Native.RECT wr;
    Native.GetWindowRect(h, out wr);
    var full = Rectangle.FromLTRB(wr.Left, wr.Top, wr.Right, wr.Bottom);
    if (full.Width > 0 && full.Height > 0 && !Native.IsIconic(h)) {
      using (var bmp = new Bitmap(full.Width, full.Height, PixelFormat.Format32bppArgb)) {
        bool ok;
        using (var g = Graphics.FromImage(bmp)) {
          IntPtr hdc = g.GetHdc();
          ok = Native.PrintWindow(h, hdc, 2);   // PW_RENDERFULLCONTENT
          g.ReleaseHdc(hdc);
        }
        if (ok && !Blank(bmp)) {
          var crop = new Rectangle(bounds.Left - full.Left, bounds.Top - full.Top, bounds.Width, bounds.Height);
          crop.Intersect(new Rectangle(0, 0, bmp.Width, bmp.Height));
          if (crop.Width > 0 && crop.Height > 0) return bmp.Clone(crop, bmp.PixelFormat);
        }
      }
    }
    return CaptureRect(bounds);
  }

  static bool Blank(Bitmap b) {
    for (int i = 0; i < 40; i++) {
      var c = b.GetPixel((b.Width - 1) * (i % 8) / 7, (b.Height - 1) * (i / 8) / 4);
      if (c.R > 8 || c.G > 8 || c.B > 8) return false;
    }
    return true;
  }

  static Bitmap Scaled(Image img, out double scale) {
    int w = Math.Min(img.Width, 1600);
    scale = (double)w / img.Width;
    int h = Math.Max(1, (int)Math.Round(img.Height * scale));
    var outImg = new Bitmap(w, h, PixelFormat.Format24bppRgb);
    using (var g = Graphics.FromImage(outImg)) {
      g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      g.DrawImage(img, 0, 0, w, h);
    }
    return outImg;
  }

  static void SaveJpeg(Image img, string path) {
    var codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
    var ps = new EncoderParameters(1);
    ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 80L);
    img.Save(path, codec, ps);
  }

  static string Json(string s) {
    var sb = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') sb.Append('\\').Append(c);
      else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    return sb.Append('"').ToString();
  }

  // Commands

  static readonly HashSet<string> MARKABLE = new HashSet<string> {
    "Button", "Hyperlink", "Edit", "CheckBox", "RadioButton", "ComboBox", "TabItem", "ListItem", "DataItem",
    "TreeItem", "MenuItem", "SplitButton", "Slider", "Spinner", "Document", "HeaderItem",
  };
  static readonly HashSet<string> ACTIONABLE = new HashSet<string> {
    "Button", "Hyperlink", "MenuItem", "CheckBox", "RadioButton", "ComboBox", "TabItem", "ListItem", "DataItem",
    "TreeItem", "SplitButton", "Edit", "Document",
  };
  static readonly HashSet<string> INPUTS = new HashSet<string> { "Edit", "Document", "ComboBox" };

  static void CmdMarks() {
    var t = Resolve(Arg(1));
    string outPath = Arg(2);
    if (outPath.Length == 0) Die("marks needs an output path");
    var found = Items(t, 1500);
    Rectangle bounds;
    Bitmap shot;
    if (t.Hwnd != IntPtr.Zero) shot = CaptureWindow(t.Hwnd, out bounds);
    else { bounds = System.Windows.Forms.Screen.PrimaryScreen.Bounds; shot = CaptureRect(bounds); }

    var inView = bounds;
    inView.Inflate(2, 2);
    var marks = new List<KeyValuePair<int, Item>>();
    var lines = new List<string>();
    var seenLines = new HashSet<string>();
    var seenRects = new HashSet<string>();
    foreach (var it in found) {
      if (!OnScreen(it, t) || !inView.Contains(Center(it.Rect)) || it.Rect.Width < 3 || it.Rect.Height < 3) continue;
      string line = Line(it);
      if (!seenLines.Add(line)) continue;
      string key = it.Rect.X + "," + it.Rect.Y + "," + it.Rect.Width + "," + it.Rect.Height;
      if (MARKABLE.Contains(it.Role) && !seenRects.Contains(key) && marks.Count < 150) {
        seenRects.Add(key);
        marks.Add(new KeyValuePair<int, Item>(marks.Count + 1, it));
        lines.Add("[" + marks.Count + "] " + line);
      } else lines.Add(line);
    }

    double scale;
    using (shot)
    using (var img = Scaled(shot, out scale))
    using (var g = Graphics.FromImage(img))
    using (var font = new Font("Segoe UI", 10, FontStyle.Bold, GraphicsUnit.Pixel)) {
      g.SmoothingMode = SmoothingMode.AntiAlias;
      Color[] palette = { Color.FromArgb(255, 59, 48), Color.FromArgb(0, 122, 255), Color.FromArgb(52, 199, 89), Color.FromArgb(175, 82, 222),
                          Color.FromArgb(255, 149, 0), Color.FromArgb(255, 45, 85), Color.FromArgb(48, 176, 199), Color.FromArgb(162, 132, 94) };
      foreach (var m in marks) {
        var color = palette[(m.Key - 1) % palette.Length];
        var r = m.Value.Rect;
        var box = new RectangleF((float)((r.X - bounds.X) * scale), (float)((r.Y - bounds.Y) * scale), (float)(r.Width * scale), (float)(r.Height * scale));
        using (var pen = new Pen(color, 2)) g.DrawRectangle(pen, box.X, box.Y, box.Width, box.Height);
        string tag = m.Key.ToString();
        var sz = g.MeasureString(tag, font);
        float y = box.Y - sz.Height >= 0 ? box.Y - sz.Height : box.Y;
        using (var brush = new SolidBrush(color)) g.FillRectangle(brush, box.X, y, sz.Width + 2, sz.Height);
        g.DrawString(tag, font, Brushes.White, box.X + 1, y);
      }
      SaveJpeg(img, outPath);
    }

    PrintHead(t);
    foreach (var l in lines.Take(200)) Print(l);
  }

  static readonly Dictionary<string, string[]> ALIASES = new Dictionary<string, string[]> {
    { "+", new[] { "add", "plus" } }, { "plus", new[] { "add" } }, { "-", new[] { "subtract", "minus" } }, { "minus", new[] { "subtract" } },
    { "*", new[] { "multiply", "times" } }, { "×", new[] { "multiply" } }, { "x", new[] { "multiply", "close" } }, { "times", new[] { "multiply" } },
    { "/", new[] { "divide" } }, { "÷", new[] { "divide" } }, { "=", new[] { "equals", "equal" } }, { "equal", new[] { "equals" } },
    { "%", new[] { "percent" } }, { ".", new[] { "decimal separator", "decimal", "point" } }, { "c", new[] { "clear", "clear entry" } },
    { "ac", new[] { "clear", "all clear" } }, { "ok", new[] { "okay", "done" } }, { "back", new[] { "go back", "back" } },
    { "forward", new[] { "go forward" } }, { "close", new[] { "close" } },
  };

  static void CmdPress() {
    string query = Arg(1).ToLowerInvariant().Trim();
    while (query.EndsWith("…") || query.EndsWith("...") || query.EndsWith("\""))
      query = query.Substring(0, query.Length - (query.EndsWith("...") ? 3 : 1)).Trim();
    if (query.StartsWith("\"")) query = query.Substring(1);
    if (query.Length == 0) Die("no element name given");
    var queries = new List<string> { query };
    string[] more;
    if (ALIASES.TryGetValue(query, out more)) queries.AddRange(more);

    Func<Item, int> score = it => {
      string l = it.Label.ToLowerInvariant();
      bool act = ACTIONABLE.Contains(it.Role);
      int s = queries.Select(q => l == q ? 100 : l.StartsWith(q) ? 60
        : (q.Length > 1 && l.Contains(q) && (act || l.Length <= q.Length * 2)) ? 30 : 0).Max();
      if (s == 0) return 0;
      if (act) s += 20;
      if (it.Role == "MenuItem") s -= 5;
      return s;
    };

    List<Item> others = new List<Item>();
    Func<Target, Item> bestIn = win => {
      // Something you can see beats something scrolled away or hidden behind a popup.
      var ranked = Items(win, 2500)
        .Select(it => new { it, s = score(it) })
        .Where(x => x.s > 0)
        .Select(x => new { x.it, s = x.s + (OnScreen(x.it, win) ? 15 : -40) })
        .OrderByDescending(x => x.s).ToList();
      if (ranked.Count == 0) return null;
      var b = ranked[0];
      others = ranked.Skip(1).Where(x => x.s == b.s && OnScreen(x.it, win)).Select(x => x.it).ToList();
      return b.it;
    };

    var t = Resolve(Arg(2));
    var hit = bestIn(t);
    if (hit == null && Arg(2).Length == 0) {
      // Not in the current window: look through the other visible windows, front to back.
      int checkedN = 0;
      foreach (var w in Windows()) {
        if (checkedN >= 8) break;
        if (IsUltron(w) || w == t.Hwnd) continue;
        checkedN++;
        var other = MakeTarget(w);
        var found = bestIn(other);
        if (found != null) { t = other; hit = found; break; }
      }
    }
    if (hit == null) Die("no element named '" + Arg(1) + "' in " + t.App + " - use read_screen to see the exact labels");

    Focus(t);
    if (!OnScreen(hit, t) && hit.Role != "MenuItem") Print("Note: that element is not visible on screen right now (scrolled away or hidden).");
    if (others.Count > 0) {
      var list = others.Take(4).Where(o => !o.Rect.IsEmpty).Select(Line);
      Print("Careful: " + others.Count + " other element(s) match that name too: " + string.Join("; ", list) + ". If this was the wrong one, click the right one by its coordinates.");
    }
    string name = hit.Role + " \"" + hit.Label + "\"";
    var c = Center(hit.Rect);
    bool visible = OnScreen(hit, t);
    if (INPUTS.Contains(hit.Role) && visible) { Click(c.X, c.Y, "left"); Print("Clicked into " + name + " in " + t.App); return; }
    if (IsBrowser(t) && visible) { Click(c.X, c.Y, "left"); Print("Clicked " + name + " at " + c.X + "," + c.Y); return; }
    object p;
    try {
      if (hit.El.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { if (visible) Glide(c.X, c.Y); ((InvokePattern)p).Invoke(); Print("Pressed " + name + " in " + t.App); return; }
      if (hit.El.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { if (visible) Glide(c.X, c.Y); ((TogglePattern)p).Toggle(); Print("Toggled " + name + " in " + t.App); return; }
      if (hit.El.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { if (visible) Glide(c.X, c.Y); ((SelectionItemPattern)p).Select(); Print("Selected " + name + " in " + t.App); return; }
      if (hit.El.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { if (visible) Glide(c.X, c.Y); ((ExpandCollapsePattern)p).Expand(); Print("Opened " + name + " in " + t.App); return; }
    } catch { }
    if (!hit.Rect.IsEmpty && hit.Rect.Width > 1) { Click(c.X, c.Y, "left"); Print("Clicked " + name + " at " + c.X + "," + c.Y); return; }
    Die("found " + name + " but couldn't press it");
  }

  static void CmdScroll() {
    string dir = Arg(1).ToLowerInvariant();
    int amount = (int)Num(2);
    amount = Math.Max(1, Math.Min(50, amount == 0 ? 5 : amount));
    var t = Resolve(Arg(3));
    Focus(t);
    // Wheel events go to the window under the pointer, so put the pointer over the target window.
    if (t.Hwnd != IntPtr.Zero) {
      var r = WindowRect(t.Hwnd);
      var m = MouseLocation();
      if (!r.Contains(m.X, m.Y)) { var c = Center(r); Glide(c.X, c.Y); }
    }
    bool horizontal = dir == "left" || dir == "right";
    int sign = (dir == "up" || dir == "right") ? 1 : -1;
    for (int i = 0; i < amount; i++) {
      Send(Mouse(horizontal ? 0x1000u : 0x0800u, unchecked((uint)(sign * 120))));
      Thread.Sleep(16);
    }
    Print("Scrolled " + (dir.Length == 0 ? "down" : dir) + " in " + t.App);
  }

  static void CmdType() {
    var t = Resolve(Arg(2));
    Focus(t);
    // In a browser, keystrokes with no text box focused hit page shortcuts (or nothing). Don't type blind.
    if (IsBrowser(t)) {
      var f = FocusedElement(t);
      if (f != null && !TakesText(f))
        Die("no text box has keyboard focus in " + t.App + " (focus is on " + Describe(f) + "), so the text would go nowhere. Click into the text box first (click_element its name or click its coordinates), check the screen, then type.");
    }
    TypeText(Arg(1));
    Print("Typed " + Arg(1).Length + " characters into " + t.App + " - " + WindowName(t));
  }

  static void CmdMedia() {
    string k = Arg(1).ToLowerInvariant();
    int times = Math.Max(1, Math.Min(16, (int)Num(2)));
    if (k == "brightup" || k == "brightdown") { Brightness(k == "brightup" ? 10 * times : -10 * times); return; }
    var keys = new Dictionary<string, ushort> {
      { "volup", 0xAF }, { "voldown", 0xAE }, { "mute", 0xAD }, { "play", 0xB3 }, { "pause", 0xB3 }, { "playpause", 0xB3 },
      { "next", 0xB0 }, { "previous", 0xB1 }, { "prev", 0xB1 },
    };
    ushort vk;
    if (!keys.TryGetValue(k, out vk)) Die("unknown media key '" + Arg(1) + "'");
    for (int i = 0; i < times; i++) { Tap(vk); Thread.Sleep(40); }
    Print("Pressed " + Arg(1));
  }

  static void Brightness(int delta) {
    try {
      int current = 50;
      using (var s = new ManagementObjectSearcher(new ManagementScope("root\\WMI"), new SelectQuery("WmiMonitorBrightness")))
        foreach (ManagementObject o in s.Get()) { current = Convert.ToInt32(o["CurrentBrightness"]); break; }
      int level = Math.Max(0, Math.Min(100, current + delta));
      bool done = false;
      using (var s = new ManagementObjectSearcher(new ManagementScope("root\\WMI"), new SelectQuery("WmiMonitorBrightnessMethods")))
        foreach (ManagementObject o in s.Get()) { o.InvokeMethod("WmiSetBrightness", new object[] { (uint)1, (byte)level }); done = true; break; }
      if (!done) throw new Exception();
      Print("Brightness " + level + "%");
    } catch {
      Die("this display doesn't let Windows change its brightness (external monitors usually don't)");
    }
  }

  static void CmdVolume() {
    int level = Math.Max(0, Math.Min(100, (int)Num(1)));
    try {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice dev;
      Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
      var iid = typeof(IAudioEndpointVolume).GUID;
      object o;
      Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
      var vol = (IAudioEndpointVolume)o;
      var ctx = Guid.Empty;
      Marshal.ThrowExceptionForHR(vol.SetMasterVolumeLevelScalar(level / 100f, ref ctx));
      vol.SetMute(level == 0, ref ctx);
      Print("Volume " + level + "%");
    } catch (Exception e) {
      Die("couldn't set the volume (" + e.Message + ")");
    }
  }

  static void CmdWindow() {
    string op = Arg(1).ToLowerInvariant();
    bool hasNums = op == "move" || op == "size";
    var t = Resolve(Arg(hasNums ? 4 : 2));
    IntPtr h = t.Hwnd;
    if (h == IntPtr.Zero) Die("no window to manage in " + t.App);
    Focus(t);
    var work = WorkArea(h);
    var wr = WindowRect(h);
    Action<Rectangle> setFrame = r => {
      if (Native.IsZoomed(h) || Native.IsIconic(h)) { Native.ShowWindow(h, 9); Thread.Sleep(80); }
      // Windows 10/11 windows have invisible borders: size the outer rect so the visible frame lands on r.
      Native.RECT outer;
      Native.GetWindowRect(h, out outer);
      var vis = WindowRect(h);
      int l = vis.Left - outer.Left, tp = vis.Top - outer.Top, rt = outer.Right - vis.Right, b = outer.Bottom - vis.Bottom;
      Native.SetWindowPos(h, IntPtr.Zero, r.X - l, r.Y - tp, r.Width + l + rt, r.Height + tp + b, 0x4 | 0x10);
    };
    int W = work.Width, H = work.Height;
    switch (op) {
      case "minimize": Native.ShowWindow(h, 6); break;
      case "unminimize": case "restore": Native.ShowWindow(h, 9); break;
      case "fullscreen": case "maximize": case "zoom": Native.ShowWindow(h, Native.IsZoomed(h) && op == "fullscreen" ? 9 : 3); break;
      case "center": setFrame(new Rectangle(work.X + (W - wr.Width) / 2, work.Y + (H - wr.Height) / 2, wr.Width, wr.Height)); break;
      case "left": case "left half": setFrame(new Rectangle(work.X, work.Y, W / 2, H)); break;
      case "right": case "right half": setFrame(new Rectangle(work.X + W / 2, work.Y, W - W / 2, H)); break;
      case "top": case "top half": setFrame(new Rectangle(work.X, work.Y, W, H / 2)); break;
      case "bottom": case "bottom half": setFrame(new Rectangle(work.X, work.Y + H / 2, W, H - H / 2)); break;
      case "move": setFrame(new Rectangle((int)Num(2), (int)Num(3), wr.Width, wr.Height)); break;
      case "size": setFrame(new Rectangle(wr.X, wr.Y, (int)Num(2), (int)Num(3))); break;
      default: Die("unknown window op '" + op + "'"); break;
    }
    Print("Window " + op + " - " + t.App + " " + WindowName(t));
  }

  static void CmdShot() {
    string outPath = Arg(1);
    if (outPath.Length == 0) Die("shot needs an output path");
    string app = Arg(2), mode = Arg(3).Length == 0 ? "auto" : Arg(3).ToLowerInvariant();
    IntPtr fg = Native.GetAncestor(Native.GetForegroundWindow(), 2);
    bool frontIsUltron = IsUltron(fg);
    bool window = mode == "window" || (mode == "auto" && (app.Length > 0 || frontIsUltron));
    Target t = window ? Resolve(app) : null;
    Rectangle bounds;
    Bitmap shot;
    if (t != null && t.Hwnd != IntPtr.Zero) shot = CaptureWindow(t.Hwnd, out bounds);
    else { window = false; shot = CaptureRect(System.Windows.Forms.Screen.PrimaryScreen.Bounds); }
    double scale;
    using (shot) using (var img = Scaled(shot, out scale)) SaveJpeg(img, outPath);
    Print("{\"app\":" + Json(t == null ? "" : t.App) + ",\"window\":" + (window ? "true" : "false") + "}");
  }

  static void CmdImage() {
    try {
      double scale;
      using (var src = Image.FromFile(Arg(1))) using (var img = Scaled(src, out scale)) SaveJpeg(img, Arg(2));
      Print("ok");
    } catch (Exception e) {
      Die("couldn't read that image (" + e.Message + ")");
    }
  }

  static int Main(string[] argv) {
    var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    stdout.AutoFlush = true;
    Out = stdout;
    Args = argv;
    try { if (Native.SetProcessDpiAwareness(2) != 0) Native.SetProcessDPIAware(); } catch { try { Native.SetProcessDPIAware(); } catch { } }
    if (argv.Length == 0) Die("no command");

    switch (argv[0]) {
      case "perm": Print("{\"accessibility\":true,\"screen\":true}"); break;
      case "pos": { var p = MouseLocation(); Print(p.X + "," + p.Y); break; }
      case "target": {
        var t = Resolve(Arg(1));
        bool front = IsUltron(Native.GetAncestor(Native.GetForegroundWindow(), 2));
        Print("{\"app\":" + Json(t.App) + ",\"windowId\":" + t.Hwnd.ToInt64() + ",\"title\":" + Json(WindowName(t).Replace("\"", "'")) + ",\"frontIsUltron\":" + (front ? "true" : "false") + "}");
        break;
      }
      case "ui": {
        var t = Resolve(Arg(1));
        var found = Items(t, 400);
        PrintHead(t);
        var seen = new HashSet<string>();
        int n = 0;
        foreach (var it in found) {
          if (!OnScreen(it, t)) continue;
          string line = Line(it);
          if (!seen.Add(line)) continue;
          Print(line);
          if (++n >= 140) { Print("... more elements not shown"); break; }
        }
        break;
      }
      case "marks": CmdMarks(); break;
      case "press": CmdPress(); break;
      case "click": {
        string b = Arg(3).Length == 0 ? "left" : Arg(3).ToLowerInvariant();
        Click((int)Num(1), (int)Num(2), b);
        Print("Clicked at " + (int)Num(1) + "," + (int)Num(2));
        break;
      }
      case "move": Glide((int)Num(1), (int)Num(2)); Print("Moved mouse to " + (int)Num(1) + "," + (int)Num(2)); break;
      case "drag": {
        int x1 = (int)Num(1), y1 = (int)Num(2), x2 = (int)Num(3), y2 = (int)Num(4);
        Glide(x1, y1);
        Send(Mouse(0x2, 0));
        Thread.Sleep(80);
        Glide(x2, y2);
        Thread.Sleep(80);
        Send(Mouse(0x4, 0));
        Print("Dragged from " + x1 + "," + y1 + " to " + x2 + "," + y2);
        break;
      }
      case "scroll": CmdScroll(); break;
      case "type": CmdType(); break;
      case "key": {
        var t = Resolve(Arg(2));
        Focus(t);
        PressCombo(Arg(1));
        Print("Pressed " + Arg(1) + " in " + t.App + " - " + WindowName(t));
        break;
      }
      case "media": CmdMedia(); break;
      case "window": CmdWindow(); break;
      case "shot": CmdShot(); break;
      case "image": CmdImage(); break;
      case "volume": CmdVolume(); break;
      case "display":
        Native.PostMessage((IntPtr)0xFFFF, 0x0112, (IntPtr)0xF170, (IntPtr)2);   // SC_MONITORPOWER, off
        Print("Display asleep");
        break;
      case "wake": {
        Native.SetThreadExecutionState(0x2);   // ES_DISPLAY_REQUIRED
        var p = MouseLocation();
        Native.SetCursorPos(p.X + 1, p.Y);
        Thread.Sleep(30);
        Native.SetCursorPos(p.X, p.Y);
        Print("Display awake");
        break;
      }
      case "awake":
        // Keeps the PC out of sleep for as long as this runs (the server kills it to stop).
        Native.SetThreadExecutionState(0x80000000 | 0x1);
        Print("ok");
        Thread.Sleep(Timeout.Infinite);
        break;
      default: Die("unknown command '" + argv[0] + "'"); break;
    }
    return 0;
  }
}
