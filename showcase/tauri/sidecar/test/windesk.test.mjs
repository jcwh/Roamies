// The Windows desktop: apps and folders by name, and arranging windows. Run: npm test
// Windows itself is a stand-in here (a small fake desktop); the PowerShell script is checked for shape only.
import assert from 'node:assert/strict';
import {
  PLACES, START_APPS_COMMAND, WINDOW_SCRIPT, carryRect, describeWindows, findStartApp, manageWindow, nearStartApps, nextScreen,
  openByName, parseStartApps, pickWindow, placeRect, plainName, resolveWinApp, tileRects, winPath,
} from '../windesk.mjs';

// What Get-StartApps | ConvertTo-Json gives on a Windows 11 PC.
const START = parseStartApps(JSON.stringify([
  { Name: 'File Explorer', AppID: 'Microsoft.Windows.Explorer' }, { Name: 'Settings', AppID: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel' },
  { Name: 'Calculator', AppID: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }, { Name: 'Microsoft Edge', AppID: 'MSEdge' }, { Name: 'Google Chrome', AppID: 'Chrome' },
  { Name: 'Word', AppID: 'Microsoft.Office.WINWORD.EXE.15' }, { Name: 'WordPad', AppID: '{6D809377-6AF0-444B-8957-A3773F02200E}\\Windows NT\\Accessories\\wordpad.exe' },
  { Name: 'Visual Studio Code', AppID: 'Microsoft.VisualStudioCode' }, { Name: 'Spotify', AppID: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
  { Name: 'Adobe Photoshop 2026', AppID: '{6D809377}\\Adobe\\Photoshop.exe' }, { Name: 'Uninstall Photoshop', AppID: '{6D809377}\\Adobe\\uninstall.exe' },
  { Name: 'Photos', AppID: 'Microsoft.Windows.Photos_8wekyb3d8bbwe!App' }, { Name: 'Ollama', AppID: 'com.squirrel.ollama.ollama' },
  { Name: 'VLC media player', AppID: '{6D809377}\\VideoLAN\\VLC\\vlc.exe' }, { Name: 'VLC media player website', AppID: 'https://www.videolan.org/' },
  { Name: 'Microsoft Teams', AppID: 'MSTeams_8wekyb3d8bbwe!MSTeams' }, { Name: 'Python 3.12 Manuals', AppID: 'C:\\Python312\\Doc\\python312.chm' }, { Name: 'Python 3.12', AppID: 'C:\\Python312\\python.exe' },
  { Name: '', AppID: 'x' }, { Name: 'No id' },
]));

{ // Reading the Start menu's list.
  assert.equal(START.length, 18, 'entries without a name or an id are dropped');
  assert.deepEqual(parseStartApps('{"Name":"Only One","AppID":"one"}'), [{ name: 'Only One', id: 'one' }], 'a single app comes as one object');
  assert.deepEqual(parseStartApps(''), []); assert.deepEqual(parseStartApps('not json'), []);
  assert.match(START_APPS_COMMAND, /Get-StartApps[^\n]*ConvertTo-Json/);
}
{ // The names people say.
  assert.equal(plainName('  The Downloads  folder '), 'downloads folder'); assert.equal(plainName('my Documents'), 'documents');
  assert.equal(plainName('File Explorer app'), 'file explorer'); assert.equal(plainName('"Notepad.exe"'), 'notepad'); assert.equal(plainName('Chrome window'), 'chrome');
}
{ // Finding an app in the Start menu.
  const f = (n) => findStartApp(START, n)?.name ?? null;
  assert.equal(f('Calculator'), 'Calculator'); assert.equal(f('calculator'), 'Calculator');
  assert.equal(f('Edge'), 'Microsoft Edge', 'the usual short form'); assert.equal(f('chrome'), 'Google Chrome'); assert.equal(f('VS Code'), 'Visual Studio Code'); assert.equal(f('teams'), 'Microsoft Teams');
  assert.equal(f('Word'), 'Word', 'Word is not WordPad'); assert.equal(f('wordpad'), 'WordPad');
  assert.equal(f('Photoshop'), 'Adobe Photoshop 2026', 'never the uninstaller'); assert.equal(f('uninstall photoshop'), 'Uninstall Photoshop', 'unless that was asked for');
  assert.equal(f('VLC'), 'VLC media player', 'the app, not its website link'); assert.equal(f('python'), 'Python 3.12', 'not the manual');
  assert.equal(f('Photos'), 'Photos'); assert.equal(f('the Spotify app'), 'Spotify'); assert.equal(f('ollama'), 'Ollama');
  assert.equal(f('Final Cut Pro'), null); assert.equal(f(''), null); assert.equal(f('photo'), null, 'half a word is not a match');
  assert.deepEqual(nearStartApps(START, 'Photo shop'), ['Adobe Photoshop 2026', 'Photos']);
  assert.deepEqual(nearStartApps(START, 'Final Cut Pro'), []); assert.deepEqual(nearStartApps(START, 'vs'), [], 'two letters say too little');
}
{ // How each kind of name is opened.
  const ways = (n, apps = START) => resolveWinApp(n, apps).map((w) => (w.arg ? `${w.file} ${w.arg}` : w.file));
  // The complaint this fixes: "File Explorer" isn't a program name, so Start-Process alone said there was no such app.
  assert.deepEqual(ways('File Explorer'), ['explorer.exe']); assert.deepEqual(ways('explorer'), ['explorer.exe']); assert.deepEqual(ways('Windows Explorer'), ['explorer.exe']); assert.deepEqual(ways('the file explorer app'), ['explorer.exe']);
  assert.deepEqual(ways('Settings'), ['ms-settings:']); assert.deepEqual(ways('Task Manager'), ['taskmgr.exe']); assert.deepEqual(ways('command prompt'), ['cmd.exe']);
  assert.deepEqual(ways('Downloads'), ['explorer.exe shell:Downloads']); assert.deepEqual(ways('my Documents folder'), ['explorer.exe shell:Personal']); assert.deepEqual(ways('the Desktop'), ['explorer.exe shell:Desktop']);
  assert.deepEqual(ways('This PC'), ['explorer.exe shell:MyComputerFolder']); assert.deepEqual(ways('recycle bin'), ['explorer.exe shell:RecycleBinFolder']);
  assert.equal(resolveWinApp('Downloads')[0].label, 'Downloads');
  // A Start menu app: by its id, the way the Start menu opens it; through Explorer if that's refused; then the program.
  assert.deepEqual(ways('Calculator'), ['shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', 'explorer.exe shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', 'calc.exe']);
  assert.deepEqual(ways('Spotify'), ['shell:AppsFolder\\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', 'explorer.exe shell:AppsFolder\\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify']);
  assert.equal(resolveWinApp('edge', START)[0].label, 'Microsoft Edge');
  // The Start menu couldn't be read: well-known programs still open.
  assert.deepEqual(ways('Chrome', []), ['chrome.exe']); assert.deepEqual(ways('Word', []), ['winword.exe']); assert.deepEqual(ways('notepad', []), ['notepad.exe']);
  assert.deepEqual(ways('Some Unknown Thing', []), [], 'nothing known: the name is tried as it is');
}
{ // Opening by name, with the ways tried in order.
  const tried = [];
  const opener = (works) => async (target, app = '') => { tried.push(app ? `${app} ${target}` : target); return works(target, app) ? { err: null, stderr: '' } : { err: new Error('x'), stderr: 'Unable to find application' }; };
  const apps = async () => START;
  let got = await openByName('File Explorer', { open: opener(() => true), apps });
  assert.deepEqual(tried, ['explorer.exe']); assert.equal(got.r.err, null); assert.equal(got.label, 'File Explorer');
  tried.length = 0;
  got = await openByName('the Downloads folder', { open: opener(() => true), apps });
  assert.deepEqual(tried, ['explorer.exe shell:Downloads']); assert.equal(got.label, 'Downloads');
  tried.length = 0;
  got = await openByName('edge', { open: opener((t, app) => app === 'explorer.exe'), apps });
  assert.deepEqual(tried, ['shell:AppsFolder\\MSEdge', 'explorer.exe shell:AppsFolder\\MSEdge'], 'the second way is tried when the first is refused'); assert.equal(got.label, 'Microsoft Edge');
  tried.length = 0;
  got = await openByName('Photo shop', { open: opener(() => false), apps });
  assert.deepEqual(tried, ['Photo shop'], 'an unknown name is still tried as given');
  assert.ok(got.r.err); assert.deepEqual(got.r.near, ['Adobe Photoshop 2026', 'Photos'], 'and the nearest real names come back');
  tried.length = 0;
  got = await openByName('notepad', { open: opener(() => true), apps: async () => { throw new Error('Get-StartApps failed'); } });
  assert.deepEqual(tried, ['notepad.exe'], "the Start menu list failing doesn't stop a well-known program");
}
{ // Paths the way they're typed on Windows.
  const env = { USERPROFILE: 'C:\\Users\\mei', OneDrive: 'C:\\Users\\mei\\OneDrive' };
  assert.equal(winPath('C:/Users/mei/Documents/plan.docx', env), 'C:\\Users\\mei\\Documents\\plan.docx');
  assert.equal(winPath('c:\\AI\\Roamies', env), 'c:\\AI\\Roamies'); assert.equal(winPath('D:', env), 'D:\\');
  assert.equal(winPath('%USERPROFILE%\\Downloads', env), 'C:\\Users\\mei\\Downloads'); assert.equal(winPath('%onedrive%/Reports', env), 'C:\\Users\\mei\\OneDrive\\Reports');
  assert.equal(winPath('"C:\\Program Files\\App"', env), 'C:\\Program Files\\App');
  for (const t of ['Notepad', 'https://example.com', '~/Documents', 'File Explorer', '%NOPE%\\x', 'mailto:a@b.c']) assert.equal(winPath(t, env), null, t);
}

// A desktop: two screens side by side, the taskbar taking 48 pixels of each.
const SCREENS = [{ work: [0, 0, 2560, 1392], primary: true }, { work: [2560, 0, 1920, 1032], primary: false }];
const desk = () => [
  { id: 1001, app: 'Windows Explorer', exe: 'explorer', title: 'Downloads - File Explorer', cls: 'CabinetWClass', min: false, max: false, front: true, rect: [100, 100, 1200, 800], work: SCREENS[0].work },
  { id: 1002, app: 'Google Chrome', exe: 'chrome', title: 'Inbox (3) - Gmail - Google Chrome', cls: 'Chrome_WidgetWin_1', min: false, max: true, front: false, rect: [0, 0, 2560, 1392], work: SCREENS[0].work },
  { id: 1003, app: 'Microsoft Excel', exe: 'EXCEL', title: 'Budget.xlsx - Excel', cls: 'XLMAIN', min: true, max: false, front: false, rect: [-32000, -32000, 160, 28], work: SCREENS[0].work },
  { id: 1004, app: 'Roamies', exe: 'Roamies', title: 'Roamies', cls: 'Tauri', min: false, max: false, front: false, rect: [0, 0, 2560, 1440], work: SCREENS[0].work },
  { id: 1005, app: 'Calculator', exe: 'ApplicationFrameHost', title: 'Calculator', cls: 'ApplicationFrameWindow', min: false, max: false, front: false, rect: [3000, 200, 320, 500], work: SCREENS[1].work },
  { id: 1006, app: 'Windows Explorer', exe: 'explorer', title: 'Reports - File Explorer', cls: 'CabinetWClass', min: false, max: false, front: false, rect: [300, 200, 1200, 800], work: SCREENS[0].work },
  { id: 1007, app: 'Notepad', exe: 'Notepad', title: 'notes.txt - Notepad', cls: 'Notepad', min: false, max: false, front: false, rect: [500, 300, 900, 600], work: SCREENS[0].work },
];
{ // Which window is meant.
  const p = (t, list = desk()) => pickWindow(list, t)?.id ?? null;
  assert.equal(p('front'), 1001); assert.equal(p(undefined), 1001); assert.equal(p('this window'), 1001);
  assert.equal(p('File Explorer'), 1001, 'by the name people use, the one nearest the front'); assert.equal(p('explorer'), 1001); assert.equal(p('Reports'), 1006, 'by a word of its title');
  assert.equal(p('Chrome'), 1002); assert.equal(p('browser'), 1002); assert.equal(p('Gmail'), 1002); assert.equal(p('app:Google Chrome'), 1002);
  assert.equal(p('Excel'), 1003, 'a minimized window is still found'); assert.equal(p('Budget.xlsx'), 1003);
  assert.equal(p('Calculator'), 1005); assert.equal(p('notepad'), 1007); assert.equal(p('notes.txt'), 1007);
  assert.equal(p('window:1006'), 1006); assert.equal(p('1007'), 1007); assert.equal(p('window:9999'), null);
  assert.equal(p('Roamies'), null, "Roamies' own windows are never arranged"); assert.equal(p('window:1004'), null);
  assert.equal(p('Photoshop'), null);
  // The window in front is Roamies' own bubble: "front" is the next one down.
  assert.equal(p('front', desk().map((w) => ({ ...w, front: w.id === 1004 }))), 1001);
  // Only minimized windows of an app: that one.
  assert.equal(p('front', desk().filter((w) => w.id === 1003)), null, 'nothing is in view');
  assert.match(describeWindows(desk()), /^window:1001  Windows Explorer — Downloads - File Explorer  \(in front\)\nwindow:1002  Google Chrome — [^\n]*\(maximized\)\nwindow:1003  Microsoft Excel — Budget\.xlsx - Excel  \(minimized\)\nwindow:1005  Calculator/);
  assert.ok(!describeWindows(desk()).includes('Roamies'));
}
{ // Where a window goes.
  const W = [0, 0, 2560, 1392];
  assert.deepEqual(placeRect('left', W), [0, 0, 1280, 1392]); assert.deepEqual(placeRect('right', W), [1280, 0, 1280, 1392]);
  assert.deepEqual(placeRect('top-left', W), [0, 0, 1280, 696]); assert.deepEqual(placeRect('bottom_right', W), [1280, 696, 1280, 696]); assert.deepEqual(placeRect('Top Right', W), [1280, 0, 1280, 696]);
  assert.deepEqual(placeRect('full', W), W); assert.deepEqual(placeRect('center', W), [384, 139, 1792, 1114]); assert.equal(placeRect('sideways', W), null);
  // Halves of an odd width leave no gap and no overlap, and a second screen keeps its own origin.
  const odd = [2560, 10, 1921, 1033], l = placeRect('left', odd), r = placeRect('right', odd);
  assert.equal(l[0], 2560); assert.equal(l[0] + l[2], r[0]); assert.equal(r[0] + r[2], 2560 + 1921); assert.equal(placeRect('bottom', odd)[1] + placeRect('bottom', odd)[3], 10 + 1033);
  for (const pl of PLACES) assert.ok(placeRect(pl, W), pl);
  assert.deepEqual(tileRects(2, W), [[0, 0, 1280, 1392], [1280, 0, 1280, 1392]]);
  const three = tileRects(3, [0, 0, 2560, 1392]); assert.equal(three.length, 3); assert.equal(three[2][0] + three[2][2], 2560, 'the last column takes the leftover pixel');
  assert.deepEqual(tileRects(4, W).map((x) => x.slice(0, 2)), [[0, 0], [1280, 0], [0, 696], [1280, 696]]);
  assert.deepEqual(nextScreen(SCREENS, SCREENS[0].work), SCREENS[1]); assert.deepEqual(nextScreen(SCREENS, SCREENS[1].work), SCREENS[0], 'round the list'); assert.equal(nextScreen([SCREENS[0]], SCREENS[0].work), null);
  // The same spot on a smaller screen: the left half stays the left half, and nothing hangs off the edge.
  assert.deepEqual(carryRect([0, 0, 1280, 1392], SCREENS[0].work, SCREENS[1].work), [2560, 0, 960, 1032]);
  const c = carryRect([2000, 900, 1200, 800], SCREENS[0].work, SCREENS[1].work);
  assert.ok(c[0] >= 2560 && c[0] + c[2] <= 2560 + 1920 && c[1] >= 0 && c[1] + c[3] <= 1032, 'kept on the screen');
}

// A stand-in for Windows: applies the steps the script would, then reports the windows, front to back.
function fakeWindows({ windows = desk(), monitors = SCREENS, elevated = [], unsaved = [], fixed = [] } = {}) {
  const runs = [];
  const screenOf = (rect) => monitors.find((m) => rect[0] >= m.work[0] && rect[0] < m.work[0] + m.work[2])?.work ?? monitors[0].work;
  const ps = async (ops) => {
    runs.push(ops);
    for (const op of ops) {
      const w = windows.find((x) => x.id === op.id);
      if (op.kind === 'desktop') windows.forEach((x) => { x.min = true; x.front = false; });
      if (!w || elevated.includes(w.id)) continue;
      if (op.kind === 'focus') { windows.forEach((x) => { x.front = false; }); w.front = true; w.min = false; }
      if (op.kind === 'show') { w.min = op.how === 6; w.max = op.how === 3; if (op.how === 6) w.front = false; if (op.how === 3) w.rect = screenOf(w.rect).slice(); }
      if (op.kind === 'close' && !unsaved.includes(w.id)) windows = windows.filter((x) => x !== w);
      if (op.kind === 'move') { w.min = false; w.max = false; w.rect = fixed.includes(w.id) ? [op.x, op.y, w.rect[2], w.rect[3]] : [op.x, op.y, op.w, op.h]; w.work = screenOf(w.rect); }
    }
    return { ok: true, results: ops.map(() => true), windows: JSON.parse(JSON.stringify(windows)), monitors };
  };
  return { ps, runs, get: (id) => windows.find((w) => w.id === id), steps: () => runs.flat().filter((o) => o.kind !== 'wait') };
}
{ // Arranging.
  let d = fakeWindows();
  assert.match(await manageWindow({ action: 'list' }, d.ps), /^window:1001  Windows Explorer/);
  assert.deepEqual(d.steps(), [], 'listing changes nothing');

  d = fakeWindows();
  assert.equal(await manageWindow({ action: 'focus', target: 'Notepad' }, d.ps), 'Notepad (notes.txt - Notepad) is in front now.');
  assert.ok(d.get(1007).front); assert.deepEqual(d.steps(), [{ kind: 'focus', id: 1007 }]);

  d = fakeWindows();
  assert.equal(await manageWindow({ action: 'minimize', target: 'File Explorer' }, d.ps), 'Windows Explorer (Downloads - File Explorer) is minimized.');
  assert.ok(d.get(1001).min); assert.deepEqual(d.steps(), [{ kind: 'show', id: 1001, how: 6 }]);
  assert.equal(await manageWindow({ action: 'maximize', target: 'Notepad' }, d.ps), 'Notepad (notes.txt - Notepad) is maximized.'); assert.ok(d.get(1007).max);
  assert.match(await manageWindow({ action: 'restore', target: 'Excel' }, d.ps), /Microsoft Excel \(Budget\.xlsx - Excel\) is back to its normal size\./); assert.ok(!d.get(1003).min);

  d = fakeWindows();
  assert.equal(await manageWindow({ action: 'close', target: 'Calculator' }, d.ps), 'Closed Calculator.'); assert.equal(d.get(1005), undefined);
  d = fakeWindows({ unsaved: [1007] });
  assert.match(await manageWindow({ action: 'close', target: 'Notepad' }, d.ps), /still open: it may be asking whether to save/, 'a window that stays open is not reported as closed');

  d = fakeWindows();
  assert.equal(await manageWindow({ action: 'place', target: 'File Explorer', where: 'left' }, d.ps), 'Windows Explorer (Downloads - File Explorer) is on the left now.');
  assert.deepEqual(d.get(1001).rect, [0, 0, 1280, 1392]);
  assert.equal(await manageWindow({ action: 'place', target: 'Calculator', where: 'top-right' }, d.ps), 'Calculator is on the top right now.');
  assert.deepEqual(d.get(1005).rect, [2560 + 960, 0, 960, 516], 'on the screen the window is on');
  assert.equal(await manageWindow({ action: 'place', target: 'Notepad', where: 'full' }, d.ps), 'Notepad (notes.txt - Notepad) fills the screen.'); assert.ok(d.get(1007).max);

  // To the other screen: keeping its place, or to a named place there; a maximized one is maximized there.
  d = fakeWindows();
  assert.match(await manageWindow({ action: 'place', target: 'Notepad', screen: 'next' }, d.ps), /is in the same spot of the other screen now\./);
  assert.ok(d.get(1007).rect[0] >= 2560, 'it crossed over'); assert.deepEqual(d.get(1007).work, SCREENS[1].work);
  assert.equal(await manageWindow({ action: 'place', target: 'File Explorer', where: 'right', screen: 'next' }, d.ps), 'Windows Explorer (Downloads - File Explorer) is on the right of the other screen now.');
  assert.deepEqual(d.get(1001).rect, [2560 + 960, 0, 960, 1032]);
  assert.equal(await manageWindow({ action: 'place', target: 'Chrome', screen: 'next' }, d.ps), 'Moved Google Chrome (Inbox (3) - Gmail - Google Chrome) to the other screen, maximized.'); assert.ok(d.get(1002).max);
  d = fakeWindows({ monitors: [SCREENS[0]], windows: desk().filter((w) => w.id !== 1005) });
  await assert.rejects(manageWindow({ action: 'place', target: 'Notepad', screen: 'next' }, d.ps), /There is only one screen\./);
  await assert.rejects(manageWindow({ action: 'place', target: 'Notepad' }, d.ps), /place needs where/);

  // Side by side: the first named ends in front.
  d = fakeWindows();
  assert.equal(await manageWindow({ action: 'tile', targets: ['Chrome', 'Notepad'] }, d.ps), 'Put Google Chrome (Inbox (3) - Gmail - Google Chrome), Notepad (notes.txt - Notepad) side by side.');
  assert.deepEqual(d.get(1002).rect, [0, 0, 1280, 1392]); assert.deepEqual(d.get(1007).rect, [1280, 0, 1280, 1392]); assert.ok(d.get(1002).front);
  // Two windows of the same app are two windows.
  d = fakeWindows();
  await manageWindow({ action: 'tile', targets: ['File Explorer', 'File Explorer'] }, d.ps);
  assert.deepEqual(d.get(1001).rect, [0, 0, 1280, 1392]); assert.deepEqual(d.get(1006).rect, [1280, 0, 1280, 1392]);
  await assert.rejects(manageWindow({ action: 'tile', targets: ['Chrome'] }, d.ps), /two to four windows/);
  await assert.rejects(manageWindow({ action: 'tile', targets: ['Chrome', 'Photoshop'] }, d.ps), /No window matches "Photoshop"\. Open windows:\nwindow:1001/);
  d = fakeWindows({ fixed: [1005] });
  assert.match(await manageWindow({ action: 'tile', targets: ['Notepad', 'Calculator'] }, d.ps), /side by side\. Calculator didn't take the exact size/);
  d = fakeWindows({ fixed: [1005] });
  assert.match(await manageWindow({ action: 'place', target: 'Calculator', where: 'left' }, d.ps), /on the left now, at its own size/);

  d = fakeWindows();
  assert.equal(await manageWindow({ action: 'show_desktop' }, d.ps), 'Minimized every window: the desktop is showing.'); assert.ok(d.get(1001).min && d.get(1007).min);

  // A window Windows won't let another program touch (it runs as administrator): said plainly, never claimed done.
  d = fakeWindows({ elevated: [1007] });
  assert.match(await manageWindow({ action: 'minimize', target: 'Notepad' }, d.ps), /didn't change\. Windows refused, which usually means that app runs as administrator\./);
  assert.match(await manageWindow({ action: 'focus', target: 'Notepad' }, d.ps), /another window still has the keyboard/);
  assert.match(await manageWindow({ action: 'place', target: 'Notepad', where: 'left' }, d.ps), /didn't go there\. Windows refused/);

  d = fakeWindows();
  await assert.rejects(manageWindow({ action: 'minimize', target: 'Photoshop' }, d.ps), /No window matches "Photoshop"\. Open windows:\nwindow:1001  Windows Explorer/, 'the open windows come with the miss, so the next try can use a real name');
  await assert.rejects(manageWindow({ action: 'place', target: 'Notepad', where: 'sideways' }, d.ps), /where must be one of: left, right/);
  await assert.rejects(manageWindow({ action: 'juggle', target: 'Notepad' }, d.ps), /action must be one of/);
  await assert.rejects(manageWindow({ action: 'focus' }, async () => ({ ok: false, error: 'Cannot add type. Compilation errors occurred.' })), /Couldn't reach the desktop's windows: Cannot add type/);
  await assert.rejects(manageWindow({ action: 'focus' }, async () => null), /Couldn't reach the desktop's windows\./);
}
{ // The PowerShell script: it has to fit on a command line, and its C# must be what Windows PowerShell 5.1 compiles (C# 5).
  assert.ok(Buffer.from(WINDOW_SCRIPT, 'utf16le').toString('base64').length < 30_000, 'under the 32,767 character limit of a Windows command line');
  assert.ok(!WINDOW_SCRIPT.includes('${') && !WINDOW_SCRIPT.includes('`'), 'nothing JavaScript or PowerShell would re-read');
  const m = /\$src = @'\r?\n([\s\S]*?)\r?\n'@\r?\n/.exec(WINDOW_SCRIPT);
  assert.ok(m, 'the C# sits in a here-string that closes at the start of a line');
  const cs = m[1];
  // (Signatures may say "out RECT r"; a call may not declare one.)
  const calls = cs.split('\n').filter((l) => !/\bstatic\b/.test(l)).join('\n');
  assert.ok(!/\bout\s+(?:var|int|uint|RECT|MONITORINFO)\s+\w+\s*[,)]/.test(calls), 'C# 5 has no out variables declared in the call');
  for (const [bad, why] of [ [/\$"/, 'interpolated strings'], [/=>/, 'lambdas or expression bodies'], [/\?\./, 'null-conditional'], [/\bnameof\(/, 'nameof'], [/\bis\s+\w+\s+\w+\)/, 'pattern matching']]) assert.ok(!bad.test(cs), `C# 5 has no ${why}`);
  for (const [open, close] of ['{}', '()', '[]']) assert.equal(cs.split(open).length, cs.split(close).length, `${open}${close} balance`);
  // Every Windows function declared is used, and every one used is declared.
  const declared = [...cs.matchAll(/static extern [\w.\[\]]+ (\w+)\(/g)].map((x) => x[1]);
  assert.ok(declared.length > 20);
  for (const fn of declared) assert.ok(new RegExp(`\\b${fn}\\(`).test(cs.replace(new RegExp(`static extern [\\w.\\[\\]]+ ${fn}\\(`), '')), `${fn} is declared and used`);
  for (const call of ['Windows', 'Screens', 'Front', 'Show', 'Close', 'Move', 'Init']) {
    assert.ok(new RegExp(`public static [\\w<>, \\[\\]]+ ${call}\\(`).test(cs), `${call} exists`);
    assert.ok(WINDOW_SCRIPT.replace(cs, '').includes(`[RoamiesWin]::${call}(`), `${call} is called by the script`);
  }
  // Every step the JavaScript sends is one the script knows.
  const d = fakeWindows();
  await manageWindow({ action: 'tile', targets: ['Chrome', 'Notepad'] }, d.ps); await manageWindow({ action: 'close', target: 'Calculator' }, d.ps); await manageWindow({ action: 'minimize', target: 'Notepad' }, d.ps); await manageWindow({ action: 'show_desktop' }, d.ps);
  for (const kind of new Set(d.runs.flat().map((o) => o.kind))) assert.ok(WINDOW_SCRIPT.includes(`'${kind}' {`), `the script handles "${kind}"`);
  assert.match(WINDOW_SCRIPT, /\$env:ROAMIES_WIN \| ConvertFrom-Json/);
}
console.log('windows desktop tests: passed');
