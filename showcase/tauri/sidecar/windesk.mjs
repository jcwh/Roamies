// The Windows desktop: opening apps and folders by the names people use, and arranging windows (front, minimize,
// maximize, close, snap, tile). The deciding is done here in plain JavaScript; Windows itself is reached through
// PowerShell, so nothing new has to be compiled into the helpers.

// ---------------------------------------------------------------- apps and folders by name

const norm = (s) => String(s ?? '').toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, ' ').trim().replace(/\.exe$/, '');
/** "the Downloads folder", "my documents", "File Explorer app" → "downloads", "documents", "file explorer". */
export const plainName = (s) => norm(s).replace(/^(?:the|my)\s+/, '').replace(/\s+(?:app|application|program|window)$/, '');

// Folders everyone has, by the name Explorer shows. shell: names are Windows' own and follow a moved folder.
const FOLDERS = {
  downloads: ['shell:Downloads', 'Downloads'], documents: ['shell:Personal', 'Documents'], desktop: ['shell:Desktop', 'Desktop'],
  pictures: ['shell:My Pictures', 'Pictures'], music: ['shell:My Music', 'Music'], videos: ['shell:My Video', 'Videos'],
  'this pc': ['shell:MyComputerFolder', 'This PC'], computer: ['shell:MyComputerFolder', 'This PC'], pc: ['shell:MyComputerFolder', 'This PC'],
  'recycle bin': ['shell:RecycleBinFolder', 'Recycle Bin'], 'home folder': ['shell:Profile', 'your home folder'], 'user folder': ['shell:Profile', 'your home folder'],
  'startup folder': ['shell:Startup', 'the Startup folder'], network: ['shell:NetworkPlacesFolder', 'Network'],
};
// Parts of Windows that aren't found by their spoken name ("File Explorer" is explorer.exe).
const PARTS = {
  'file explorer': 'explorer.exe', explorer: 'explorer.exe', 'windows explorer': 'explorer.exe', 'file manager': 'explorer.exe', files: 'explorer.exe',
  settings: 'ms-settings:', 'windows settings': 'ms-settings:', 'pc settings': 'ms-settings:', 'system settings': 'ms-settings:',
  'task manager': 'taskmgr.exe', 'control panel': 'control.exe', 'command prompt': 'cmd.exe', cmd: 'cmd.exe',
  powershell: 'powershell.exe', 'windows powershell': 'powershell.exe',
};
// Tried when the Start menu's list has nothing by that name (or couldn't be read).
const PROGRAMS = {
  calculator: 'calc.exe', notepad: 'notepad.exe', paint: 'mspaint.exe', 'snipping tool': 'SnippingTool.exe',
  edge: 'msedge.exe', 'microsoft edge': 'msedge.exe', chrome: 'chrome.exe', 'google chrome': 'chrome.exe', firefox: 'firefox.exe',
  word: 'winword.exe', 'microsoft word': 'winword.exe', excel: 'excel.exe', 'microsoft excel': 'excel.exe',
  powerpoint: 'powerpnt.exe', 'microsoft powerpoint': 'powerpnt.exe', outlook: 'outlook.exe', onenote: 'onenote.exe',
  'vs code': 'code', vscode: 'code', 'visual studio code': 'code', terminal: 'wt.exe', 'windows terminal': 'wt.exe',
};
// What people say → the name in the Start menu.
const START_NAMES = { edge: 'microsoft edge', chrome: 'google chrome', 'vs code': 'visual studio code', vscode: 'visual studio code', store: 'microsoft store', teams: 'microsoft teams', 'media player': 'media player' };
// Start menu entries that aren't the app itself.
const NOT_APPS = /\b(uninstall|readme|read me|release notes|documentation|help|license|licence|website|manual|user guide|changelog|faq)\b/i;
const words = (s) => norm(s).split(/[^a-z0-9+#]+/).filter(Boolean);

/** Start menu entries as [{ name, id }] from Get-StartApps' JSON (an array, or one object when there's only one). */
export function parseStartApps(json) {
  let v;
  try { v = JSON.parse(String(json).trim() || '[]'); } catch { return []; }
  return (Array.isArray(v) ? v : [v]).map((a) => ({ name: String(a?.Name ?? '').trim(), id: String(a?.AppID ?? '').trim() })).filter((a) => a.name && a.id);
}

/** The Start menu app for a spoken name, best match first: its exact name, the usual short form ("Edge"), the name
 *  without its maker ("Microsoft …"), then the shortest name that has every word asked for. Null when none fits. */
export function findStartApp(apps, name) {
  const want = plainName(name);
  if (!want) return null;
  const usable = apps.filter((a) => !/^https?:/i.test(a.id) && !/\.(url|chm|html?|txt|pdf)$/i.test(a.id) && (!NOT_APPS.test(a.name) || NOT_APPS.test(want)));
  const low = (a) => norm(a.name), bare = (a) => low(a).replace(/^(?:microsoft|google|windows|adobe|the)\s+/, '');
  const ask = words(want);
  const tests = [
    (a) => low(a) === want,
    (a) => low(a) === START_NAMES[want],
    (a) => bare(a) === want,
    (a) => { const have = words(a.name); return ask.every((w) => have.includes(w)); },
  ];
  for (const t of tests) {
    const hits = usable.filter(t);
    if (hits.length) return hits.sort((a, b) => words(a.name).length - words(b.name).length || a.name.length - b.name.length)[0];
  }
  return null;
}

/** Up to `n` Start menu names that share a word with what was asked for: what to say when nothing matched. */
export function nearStartApps(apps, name, n = 5) {
  const ask = words(plainName(name)).filter((w) => w.length > 2);
  if (!ask.length) return [];
  return [...new Set(apps.filter((a) => !NOT_APPS.test(a.name) && words(a.name).some((w) => w.length > 2 && ask.some((q) => w.startsWith(q) || q.startsWith(w)))).map((a) => a.name))].slice(0, n);
}

/**
 * How to open what was named, on Windows: { file, arg, label, how } for Start-Process (file alone, or file with
 * one argument), in the order to try them. Empty when the name is nothing known: the caller tries the name as is.
 */
export function resolveWinApp(name, startApps = []) {
  const want = plainName(name);
  if (!want) return [];
  const folder = FOLDERS[want] ?? FOLDERS[want.replace(/\s+(?:folder|directory)$/, '')];
  if (folder) return [{ file: 'explorer.exe', arg: folder[0], label: folder[1], how: 'folder' }];
  if (PARTS[want]) return [{ file: PARTS[want], label: String(name).trim(), how: 'windows' }];
  const out = [];
  const app = findStartApp(startApps, want);
  if (app) {
    // The id opens it the way the Start menu does, desktop and Store apps alike. Through Explorer if that's refused.
    out.push({ file: `shell:AppsFolder\\${app.id}`, label: app.name, how: 'start' }, { file: 'explorer.exe', arg: `shell:AppsFolder\\${app.id}`, label: app.name, how: 'start' });
  }
  if (PROGRAMS[want]) out.push({ file: PROGRAMS[want], label: String(name).trim(), how: 'program' });
  return out;
}

/**
 * Open an app or a well-known folder by name on Windows. open(target, app?) starts it and resolves { err, stderr }
 * (tools.mjs's winOpen); apps() resolves the Start menu list. Each known way is tried, then the name as it was
 * given. Resolves { r, label }: r.near lists the Start menu's nearest names when nothing by that name exists.
 */
export async function openByName(name, { open, apps }) {
  const list = await Promise.resolve().then(apps).catch(() => []);
  for (const way of resolveWinApp(name, list)) {
    const r = way.arg ? await open(way.arg, way.file) : await open(way.file);
    if (!r.err) return { r, label: way.label };
  }
  const r = await open(String(name).trim());
  if (r.err && /Unable to find application/i.test(r.stderr ?? '')) { const near = nearStartApps(list, name); if (near.length) r.near = near; }
  return { r, label: String(name).trim() };
}

/** A path as typed on Windows, made openable: %USERPROFILE% filled in, C:/x/y turned into C:\x\y. Else null. */
export function winPath(target, env = process.env) {
  let t = String(target ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (/%[^%]+%/.test(t)) t = t.replace(/%([^%]+)%/g, (m, k) => env[k] ?? env[k.toUpperCase()] ?? Object.entries(env).find(([n]) => n.toLowerCase() === k.toLowerCase())?.[1] ?? m);
  if (/^[a-z]:[\\/]/i.test(t)) return t.replace(/\//g, '\\');
  if (/^[a-z]:$/i.test(t)) return `${t}\\`;
  return null;
}

export const START_APPS_COMMAND = 'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress';

// ---------------------------------------------------------------- windows

// What a window is known by, besides its own names: the program behind it.
const WINDOW_APPS = {
  'file explorer': ['explorer'], explorer: ['explorer'], 'windows explorer': ['explorer'], files: ['explorer'], 'file manager': ['explorer'],
  edge: ['msedge'], 'microsoft edge': ['msedge'], chrome: ['chrome'], 'google chrome': ['chrome'], firefox: ['firefox'],
  browser: ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc'],
  word: ['winword'], excel: ['excel'], powerpoint: ['powerpnt'], outlook: ['outlook', 'olk'], onenote: ['onenote'], teams: ['ms-teams', 'teams'],
  'vs code': ['code'], vscode: ['code'], 'visual studio code': ['code'], terminal: ['windowsterminal'], 'windows terminal': ['windowsterminal'],
  'command prompt': ['cmd'], powershell: ['powershell', 'pwsh'], 'task manager': ['taskmgr'], settings: ['systemsettings'],
};

/** Roamies' own windows (its overlays, panel and bubbles) are never arranged. */
const own = (w) => /^roamies/i.test(w.exe ?? '');

/**
 * The window meant by `target`, from the list (front to back): 'front', 'window:<id>', or an app or title by name.
 * A window in view is preferred to a minimized one. Null when nothing fits.
 */
export function pickWindow(windows, target = 'front') {
  const all = windows.filter((w) => !own(w));
  const t = String(target ?? '').trim();
  const id = /^window:(-?\d+)$/i.exec(t)?.[1] ?? (/^\d{4,}$/.test(t) ? t : null);
  if (id !== null) return all.find((w) => String(w.id) === String(Number(id))) ?? null;
  const shown = all.filter((w) => !w.min);
  const want = plainName(t.replace(/^app:/i, ''));
  if (!want || want === 'front' || want === 'this' || want === 'current' || want === 'active') return shown.find((w) => w.front) ?? shown[0] ?? null;
  const exes = WINDOW_APPS[want];
  const ask = words(want);
  const has = (w) => [...words(w.app), ...words(w.title), ...words(w.exe)];
  const tests = [
    (w) => exes?.includes(norm(w.exe)),
    (w) => norm(w.app) === want || norm(w.exe) === want,
    (w) => norm(w.title) === want,
    (w) => { const h = has(w); return ask.every((q) => h.includes(q)); },
    (w) => norm(w.title).includes(want) || norm(w.app).includes(want),
  ];
  for (const test of tests) {
    const hit = shown.find(test) ?? all.find(test);
    if (hit) return hit;
  }
  return null;
}

export const PLACES = ['left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'full'];

/** Where a window goes on a screen. work: [x, y, width, height] of the screen without the taskbar. → [x, y, w, h]. */
export function placeRect(where, work) {
  const [x, y, w, h] = work;
  const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
  switch (String(where ?? '').toLowerCase().replace(/[_ ]/g, '-')) {
    case 'left': return [x, y, hw, h];
    case 'right': return [x + hw, y, w - hw, h];
    case 'top': return [x, y, w, hh];
    case 'bottom': return [x, y + hh, w, h - hh];
    case 'top-left': return [x, y, hw, hh];
    case 'top-right': return [x + hw, y, w - hw, hh];
    case 'bottom-left': return [x, y + hh, hw, h - hh];
    case 'bottom-right': return [x + hw, y + hh, w - hw, h - hh];
    case 'center': case 'centre': case 'middle': { const cw = Math.round(w * 0.7), ch = Math.round(h * 0.8); return [x + Math.round((w - cw) / 2), y + Math.round((h - ch) / 2), cw, ch]; }
    case 'full': return [x, y, w, h];
    default: return null;
  }
}

/** n windows side by side on one screen: 2 or 3 in columns, 4 in a grid. → n rects, in order. */
export function tileRects(n, work) {
  const [x, y, w, h] = work;
  if (n === 4) return ['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((p) => placeRect(p, work));
  const cw = Math.floor(w / n);
  return Array.from({ length: n }, (_, i) => [x + i * cw, y, i === n - 1 ? w - cw * (n - 1) : cw, h]);
}

const sameRect = (a, b) => a.length === 4 && b.length === 4 && a.every((v, i) => v === b[i]);
/** The screen after the one a window is on (round the list), for "move it to my other screen". Null with one screen. */
export function nextScreen(monitors, work) {
  if (!Array.isArray(monitors) || monitors.length < 2) return null;
  const at = monitors.findIndex((m) => sameRect(m.work, work));
  return monitors[(at + 1) % monitors.length];
}
/** The same spot on another screen, as a share of it (a window on the left half stays on the left half). */
export function carryRect(rect, from, to) {
  const fx = (rect[0] - from[0]) / from[2], fy = (rect[1] - from[1]) / from[3], fw = Math.min(1, rect[2] / from[2]), fh = Math.min(1, rect[3] / from[3]);
  const w = Math.round(fw * to[2]), h = Math.round(fh * to[3]);
  return [to[0] + Math.round(Math.max(0, Math.min(1 - fw, fx)) * to[2]), to[1] + Math.round(Math.max(0, Math.min(1 - fh, fy)) * to[3]), w, h];
}

const naming = (w) => `${w.app || w.exe || 'a window'}${w.title && norm(w.title) !== norm(w.app) ? ` (${w.title.length > 60 ? `${w.title.slice(0, 57)}…` : w.title})` : ''}`;
/** The open windows as lines for the model: id, app, title, and whether minimized or maximized. */
export const describeWindows = (windows) => windows.filter((w) => !own(w)).map((w) => `window:${w.id}  ${w.app || w.exe}${w.title ? ` — ${w.title}` : ''}${w.front ? '  (in front)' : ''}${w.min ? '  (minimized)' : w.max ? '  (maximized)' : ''}`).join('\n');

// One PowerShell run: do the steps asked for, then report every window and screen. C# 5 only (what Windows
// PowerShell's Add-Type compiles). Sizes are real pixels: the thread is made DPI-aware first.
export const WINDOW_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
$src = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class RoamiesWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cb; public RECT mon; public RECT work; public uint flags; }
  public delegate bool WinProc(IntPtr h, IntPtr l);
  public delegate bool MonProc(IntPtr m, IntPtr dc, IntPtr rc, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(WinProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetInt(IntPtr h, int a, out int v, int size);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  static readonly string[] SHELL = new string[] { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow", "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow" };

  public static void Init() { try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { } }

  static int[] Arr(RECT r) { return new int[] { r.L, r.T, r.R - r.L, r.B - r.T }; }
  static RECT Frame(IntPtr h) { RECT r; if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) GetWindowRect(h, out r); return r; }
  static bool Info(IntPtr m, out MONITORINFO mi) { mi = new MONITORINFO(); mi.cb = 40; return GetMonitorInfo(m, ref mi); }

  public static List<Dictionary<string, object>> Screens() {
    Init();
    List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr m, IntPtr dc, IntPtr rc, IntPtr l) {
      MONITORINFO mi;
      if (Info(m, out mi)) {
        Dictionary<string, object> d = new Dictionary<string, object>();
        d["work"] = Arr(mi.work); d["primary"] = (mi.flags & 1) != 0;
        list.Add(d);
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static List<Dictionary<string, object>> Windows() {
    Init();
    List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
    IntPtr fg = GetForegroundWindow();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int cloak;
      if (DwmGetInt(h, 14, out cloak, 4) == 0 && cloak != 0) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;
      StringBuilder cb = new StringBuilder(256); GetClassName(h, cb, 256);
      string cls = cb.ToString();
      if (Array.IndexOf(SHELL, cls) >= 0) return true;
      StringBuilder tb = new StringBuilder(512); GetWindowText(h, tb, 512);
      string title = tb.ToString();
      bool min = IsIconic(h);
      RECT fr = Frame(h);
      if (!min && (fr.R - fr.L <= 80 || fr.B - fr.T <= 60)) return true;
      if (title.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      string exe = "", app = "";
      try {
        Process p = Process.GetProcessById((int)pid);
        exe = p.ProcessName;
        try { app = p.MainModule.FileVersionInfo.FileDescription ?? ""; } catch (Exception) { }
      } catch (Exception) { }
      if (cls == "ApplicationFrameWindow") app = title;
      if (app.Trim().Length == 0) app = exe;
      MONITORINFO mi; int[] work = new int[0];
      if (Info(MonitorFromWindow(h, 2), out mi)) work = Arr(mi.work);
      Dictionary<string, object> d = new Dictionary<string, object>();
      d["id"] = h.ToInt64(); d["title"] = title; d["exe"] = exe; d["app"] = app.Trim(); d["cls"] = cls;
      d["min"] = min; d["max"] = IsZoomed(h); d["front"] = (h == fg); d["rect"] = Arr(fr); d["work"] = work;
      list.Add(d);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static bool Front(IntPtr h) {
    if (!IsWindow(h)) return false;
    if (IsIconic(h)) ShowWindow(h, 9);
    uint pid; uint them = GetWindowThreadProcessId(h, out pid); uint me = GetCurrentThreadId();
    bool tied = them != 0 && them != me && AttachThreadInput(me, them, true);
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    if (tied) AttachThreadInput(me, them, false);
    if (!ok || GetForegroundWindow() != h) {
      // Windows lets a program in the background bring a window forward only right after a key: tap Alt.
      keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
      SetForegroundWindow(h);
    }
    return GetForegroundWindow() == h;
  }

  public static bool Show(IntPtr h, int how) { return IsWindow(h) && (ShowWindow(h, how) || true); }
  public static bool Close(IntPtr h) { return IsWindow(h) && PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); }

  // x, y, w, h are where the window should be seen. Windows 10 and 11 give windows an unseen border that
  // SetWindowPos counts, so it's measured and added, or tiled windows would have gaps between them.
  public static bool Move(IntPtr h, int x, int y, int w, int hgt) {
    Init();
    if (!IsWindow(h)) return false;
    if (IsIconic(h) || IsZoomed(h)) { ShowWindow(h, 9); System.Threading.Thread.Sleep(200); }
    bool ok = false;
    for (int i = 0; i < 2; i++) {
      RECT wr; RECT fr; int l = 0, t = 0, r = 0, b = 0;
      GetWindowRect(h, out wr);
      if (DwmGetWindowAttribute(h, 9, out fr, 16) == 0) { l = fr.L - wr.L; t = fr.T - wr.T; r = wr.R - fr.R; b = wr.B - fr.B; }
      ok = SetWindowPos(h, IntPtr.Zero, x - l, y - t, w + l + r, hgt + t + b, 0x0014);
      System.Threading.Thread.Sleep(60);
    }
    return ok;
  }
}
'@
try {
  Add-Type -TypeDefinition $src -IgnoreWarnings
  [RoamiesWin]::Init()
  $req = $env:ROAMIES_WIN | ConvertFrom-Json
  $res = @()
  foreach ($op in @($req.ops)) {
    $h = [IntPtr]::Zero
    if ($null -ne $op.id) { $h = New-Object System.IntPtr -ArgumentList ([long]$op.id) }
    switch ([string]$op.kind) {
      'focus' { $res += [RoamiesWin]::Front($h) }
      'show' { $res += [RoamiesWin]::Show($h, [int]$op.how) }
      'close' { $res += [RoamiesWin]::Close($h) }
      'move' { $res += [RoamiesWin]::Move($h, [int]$op.x, [int]$op.y, [int]$op.w, [int]$op.h) }
      'desktop' { (New-Object -ComObject Shell.Application).MinimizeAll(); $res += $true }
      'wait' { Start-Sleep -Milliseconds ([int]$op.ms); $res += $true }
      default { $res += $false }
    }
  }
  $out = @{ ok = $true; results = @($res); windows = @([RoamiesWin]::Windows()); monitors = @([RoamiesWin]::Screens()) }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Depth 6 -Compress))
} catch {
  [Console]::Out.WriteLine((@{ ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress))
}
`;

const SHOW = { minimize: 6, maximize: 3, restore: 9 };
const near = (a, b, tol = 24) => Array.isArray(a) && a.length === 4 && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const NO_WINDOW = (target, windows) => `No window matches "${target}". Open windows:\n${describeWindows(windows) || '(none)'}`;
const BLOCKED = ' Windows refused, which usually means that app runs as administrator.';

/**
 * Arrange windows. `ps(ops)` runs WINDOW_SCRIPT with the steps and resolves its report
 * ({ ok, results, windows, monitors } or { ok: false, error }). Returns what happened, in words, for the model.
 * action: list | focus | minimize | maximize | restore | close | place | tile | show_desktop.
 */
export async function manageWindow({ action, target = 'front', where, screen, targets } = {}, ps) {
  const call = async (ops) => {
    const r = await ps(ops);
    if (!r || r.ok === false) throw new Error(`Couldn't reach the desktop's windows${r?.error ? `: ${r.error}` : '.'}`);
    return { windows: Array.isArray(r.windows) ? r.windows : [], monitors: Array.isArray(r.monitors) ? r.monitors : [], results: r.results ?? [] };
  };
  const act = String(action ?? '').toLowerCase().replace(/[ -]/g, '_');
  if (act === 'show_desktop' || act === 'minimize_all') { await call([{ kind: 'desktop' }]); return 'Minimized every window: the desktop is showing.'; }
  const before = await call([]);
  if (act === 'list') return describeWindows(before.windows) || 'No windows are open.';
  const again = (id, list) => list.find((w) => String(w.id) === String(id));

  if (act === 'tile') {
    const names = (Array.isArray(targets) ? targets : []).map(String).filter(Boolean);
    if (names.length < 2 || names.length > 4) throw new Error('tile needs targets: two to four windows, by app name or window:<id>.');
    const picked = [];
    for (const n of names) {
      const w = pickWindow(before.windows.filter((x) => !picked.includes(x)), n);
      if (!w) throw new Error(NO_WINDOW(n, before.windows));
      picked.push(w);
    }
    const work = (before.monitors.find((m) => sameRect(m.work, picked[0].work)) ?? before.monitors[0])?.work ?? picked[0].work;
    if (!work?.length) throw new Error("Couldn't measure the screen.");
    const rects = tileRects(picked.length, work);
    // Placed back to front, so the first one named ends up in front with the keyboard.
    const ops = picked.flatMap((w, i) => [{ kind: 'move', id: w.id, x: rects[i][0], y: rects[i][1], w: rects[i][2], h: rects[i][3] }]).concat(picked.slice().reverse().map((w) => ({ kind: 'focus', id: w.id })), [{ kind: 'wait', ms: 250 }]);
    const after = await call(ops);
    const off = picked.filter((w, i) => !near(again(w.id, after.windows)?.rect, rects[i]));
    return `Put ${picked.map(naming).join(', ')} side by side.${off.length ? ` ${off.map(naming).join(', ')} didn't take the exact size (some windows have a fixed or smallest size).` : ''}`;
  }

  const win = pickWindow(before.windows, target);
  if (!win) throw new Error(NO_WINDOW(target, before.windows));
  const name = naming(win);
  if (act === 'focus' || act === 'front' || act === 'bring_to_front' || act === 'switch') {
    const after = await call([{ kind: 'focus', id: win.id }, { kind: 'wait', ms: 200 }]);
    return again(win.id, after.windows)?.front ? `${name} is in front now.` : `Asked for ${name} to come to the front, but another window still has the keyboard.${BLOCKED}`;
  }
  if (act in SHOW) {
    const after = await call([{ kind: 'show', id: win.id, how: SHOW[act] }, ...(act === 'minimize' ? [] : [{ kind: 'focus', id: win.id }]), { kind: 'wait', ms: 350 }]);
    const now = again(win.id, after.windows);
    const done = act === 'minimize' ? now?.min : act === 'maximize' ? now?.max : now && !now.min && !now.max;
    return done ? `${name} is ${act === 'restore' ? 'back to its normal size' : `${act}d`}.` : `Asked ${name} to ${act}, but it didn't change.${BLOCKED}`;
  }
  if (act === 'close') {
    const after = await call([{ kind: 'close', id: win.id }, { kind: 'wait', ms: 700 }]);
    return again(win.id, after.windows) ? `Asked ${name} to close, and it's still open: it may be asking whether to save. Look at it (take_screenshot) before doing anything else.` : `Closed ${name}.`;
  }
  if (act === 'place' || act === 'move' || act === 'snap') {
    let work = win.work?.length === 4 ? win.work : before.monitors[0]?.work;
    if (!work?.length) throw new Error("Couldn't measure the screen.");
    let rect = where ? placeRect(where, work) : null;
    if (where && !rect) throw new Error(`where must be one of: ${PLACES.join(', ')}.`);
    const other = /^(next|other|second)$/i.test(String(screen ?? ''));
    if (other) {
      const to = nextScreen(before.monitors, work);
      if (!to) throw new Error('There is only one screen.');
      rect = where ? placeRect(where, to.work) : win.max ? null : carryRect(win.rect, work, to.work);
      // A maximized window is moved across and maximized again there.
      if (!rect) {
        const mid = placeRect('center', to.work);
        const after = await call([{ kind: 'move', id: win.id, x: mid[0], y: mid[1], w: mid[2], h: mid[3] }, { kind: 'show', id: win.id, how: SHOW.maximize }, { kind: 'focus', id: win.id }, { kind: 'wait', ms: 300 }]);
        return sameRect(again(win.id, after.windows)?.work ?? [], to.work) ? `Moved ${name} to the other screen, maximized.` : `Asked ${name} to move to the other screen, but it stayed.${BLOCKED}`;
      }
      work = to.work;
    }
    if (!rect) throw new Error(`place needs where (${PLACES.join(', ')}) or screen: "next".`);
    if (String(where ?? '').toLowerCase() === 'full') {
      const after = await call([{ kind: 'move', id: win.id, x: rect[0], y: rect[1], w: Math.round(rect[2] * 0.8), h: Math.round(rect[3] * 0.8) }, { kind: 'show', id: win.id, how: SHOW.maximize }, { kind: 'focus', id: win.id }, { kind: 'wait', ms: 300 }]);
      return again(win.id, after.windows)?.max ? `${name} fills the screen.` : `Asked ${name} to fill the screen, but it didn't change.${BLOCKED}`;
    }
    const after = await call([{ kind: 'move', id: win.id, x: rect[0], y: rect[1], w: rect[2], h: rect[3] }, { kind: 'focus', id: win.id }, { kind: 'wait', ms: 250 }]);
    const now = again(win.id, after.windows)?.rect;
    const spot = `${where ? `on the ${String(where).replace(/-/g, ' ')}` : 'in the same spot'}${other ? ' of the other screen' : ''}`;
    if (near(now, rect)) return `${name} is ${spot} now.`;
    if (now && near(now.slice(0, 2).concat(rect.slice(2)), rect, 40)) return `${name} is ${spot} now, at its own size (it has a fixed or smallest size).`;
    return `Asked ${name} to move ${spot}, but it didn't go there.${BLOCKED}`;
  }
  throw new Error('action must be one of: list, focus, minimize, maximize, restore, close, place, tile, show_desktop.');
}
