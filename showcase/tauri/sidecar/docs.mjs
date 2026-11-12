// Reading documents that aren't plain text, on this computer: Word, PowerPoint and Excel files (zip archives of XML,
// read here with nothing but Node) and PDFs (through pdftotext or Python's pypdf, whichever the computer has).
// Nothing is uploaded or converted online, so it works the same in private mode.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const WORD = new Set(['.docx', '.docm', '.dotx']), SLIDES = new Set(['.pptx', '.pptm', '.ppsx']), SHEETS = new Set(['.xlsx', '.xlsm']);
const OLD = { '.doc': '.docx', '.xls': '.xlsx', '.ppt': '.pptx' };
const ext = (file) => path.extname(String(file)).toLowerCase();

/** A file read_file opens as a document instead of as text. */
export const isDocument = (file) => { const e = ext(file); return WORD.has(e) || SLIDES.has(e) || SHEETS.has(e) || e === '.pdf' || e in OLD; };

// ---------------------------------------------------------------- zip

const MAX_ENTRY = 96 << 20, MAX_TOTAL = 256 << 20, MAX_FILE = 200 << 20;

/** The entries of a zip archive that `want(name)` picks, as a Map of name to Buffer. Stored and deflated entries only. */
export function unzip(buf, want = () => true) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  if (at === 0xffffffff || count === 0xffff) throw new Error('too large to read here');
  const out = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error('damaged zip archive');
    const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10);
    const packed = buf.readUInt32LE(at + 20), size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), noteLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + noteLen;
    if (!want(name)) continue;
    if (flags & 1) throw new Error('password-protected');
    if (size > MAX_ENTRY || (total += size) > MAX_TOTAL) throw new Error('too large to read here');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('damaged zip archive');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + packed);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY }));
    else throw new Error('packed in a way I can\'t read');
  }
  return out;
}

// ---------------------------------------------------------------- xml

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] !== '#') return NAMED[e.toLowerCase()];
  const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  try { return String.fromCodePoint(code); } catch { return m; }
});
const attr = (tag, name) => { const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag); return m ? unxml(m[1]) : null; };
// Newer drawings carry an older copy of themselves for old readers: read once, not twice.
const noFallback = (xml) => xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
const tidy = (text) => text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const xmlOf = (files, name) => files.get(name)?.toString('utf8') ?? '';
// "../notesSlides/notesSlide1.xml" seen from "ppt/slides" → "ppt/notesSlides/notesSlide1.xml".
const resolveTarget = (base, target) => (target.startsWith('/') ? target.slice(1) : path.posix.normalize(`${base}/${target}`));
const rels = (xml) => new Map([...xml.matchAll(/<Relationship\s[^>]*>/g)].map((m) => [attr(m[0], 'Id'), { target: attr(m[0], 'Target') ?? '', type: attr(m[0], 'Type') ?? '' }]));

/**
 * The paragraphs of WordprocessingML (ns "w") or DrawingML (ns "a") as lines of text: headings as "# ", list items
 * as "- ", a table row as "cell | cell". Tracked deletions and field codes are left out.
 */
function paragraphs(xml, ns) {
  const re = new RegExp([
    `<${ns}:p(?:\\s[^>]*[^>/])?>`, `</${ns}:p>`, `<${ns}:p/>`,
    `<${ns}:t(?:\\s[^>]*[^>/])?>([\\s\\S]*?)</${ns}:t>`,
    `<${ns}:tab(?:\\s[^>]*)?/>`, `<${ns}:(?:br|cr)(?:\\s[^>]*)?/>`,
    `<${ns}:tbl(?:\\s[^>]*)?>`, `</${ns}:tbl>`, `</${ns}:tc>`, `</${ns}:tr>`,
    `<${ns}:pStyle\\s[^>]*${ns}:val="([^"]*)"`, `<${ns}:numPr>`, `<${ns}:buChar\\s`, `<${ns}:buAutoNum\\s`,
  ].join('|'), 'g');
  // Tab stop settings (<w:tabs>) hold <w:tab/> elements that aren't tabs in the text.
  xml = xml.replace(new RegExp(`<${ns}:tabs>[\\s\\S]*?</${ns}:tabs>`, 'g'), '');
  const lines = [];
  let cur = '', mark = '', table = 0, cell = [], row = [];
  const endPara = () => {
    const text = cur.replace(/\s+$/, '');
    if (table) { if (text.trim()) cell.push(text.trim()); } else lines.push(text.trim() ? mark + text : '');
    cur = ''; mark = '';
  };
  for (const m of xml.matchAll(re)) {
    const t = m[0];
    if (m[1] !== undefined) cur += unxml(m[1]);
    else if (t === `</${ns}:p>` || t === `<${ns}:p/>`) endPara();
    else if (t.startsWith(`<${ns}:p`) && !t.startsWith(`<${ns}:pStyle`)) { cur = ''; mark = ''; }
    else if (t.startsWith(`<${ns}:pStyle`)) { const h = /^(?:heading\s*(\d)|(title))$/i.exec(m[2] ?? ''); if (h) mark = `${'#'.repeat(h[2] ? 1 : Math.min(6, Number(h[1]) || 1))} `; else if (/^list\s*(bullet|number)/i.test(m[2] ?? '')) mark = '- '; }
    else if (t === `<${ns}:numPr>` || t.startsWith(`<${ns}:bu`)) { if (!mark) mark = '- '; }
    else if (t.startsWith(`<${ns}:tab`) && !t.startsWith(`<${ns}:tbl`)) cur += '\t';
    else if (t.startsWith(`<${ns}:br`) || t.startsWith(`<${ns}:cr`)) cur += table ? ' ' : '\n';
    else if (t.startsWith(`<${ns}:tbl`)) table++;
    else if (t === `</${ns}:tbl>`) { table = Math.max(0, table - 1); if (!table) lines.push(''); }
    else if (t === `</${ns}:tc>`) { row.push(cell.join(' ')); cell = []; }
    else if (t === `</${ns}:tr>`) { if (row.some((c) => c)) lines.push(row.join(' | ')); row = []; }
  }
  if (cur.trim()) endPara();
  return lines;
}

// ---------------------------------------------------------------- Word

function word(buf) {
  const files = unzip(buf, (n) => /^word\/(document|footnotes|endnotes|comments)\.xml$/.test(n));
  const body = xmlOf(files, 'word/document.xml');
  if (!body) throw new Error('no document inside');
  const out = [paragraphs(noFallback(body), 'w').join('\n')];
  // Footnotes, endnotes and review comments, when there are any (the first two notes are just separator lines).
  for (const [part, title, item] of [['footnotes', 'Footnotes', 'footnote'], ['endnotes', 'Endnotes', 'endnote'], ['comments', 'Comments', 'comment']]) {
    const xml = xmlOf(files, `word/${part}.xml`);
    const notes = [...xml.matchAll(new RegExp(`<w:${item}\\s([^>]*)>([\\s\\S]*?)</w:${item}>`, 'g'))]
      .filter((m) => !/w:type="(separator|continuationSeparator|continuationNotice)"/.test(m[1]))
      .map((m) => { const who = item === 'comment' ? attr(m[1], 'w:author') : null; const text = paragraphs(m[2], 'w').filter(Boolean).join(' '); return text ? `- ${who ? `${who}: ` : ''}${text}` : ''; })
      .filter(Boolean);
    if (notes.length) out.push(`${title}:\n${notes.join('\n')}`);
  }
  return tidy(out.join('\n\n'));
}

// ---------------------------------------------------------------- PowerPoint

function slides(buf) {
  const files = unzip(buf, (n) => /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/(_rels\/)?slide\d+\.xml(\.rels)?|notesSlides\/notesSlide\d+\.xml)$/.test(n));
  // The order they're shown in, from the presentation (file numbers don't follow a reorder); else by number.
  const map = rels(xmlOf(files, 'ppt/_rels/presentation.xml.rels'));
  let order = [...xmlOf(files, 'ppt/presentation.xml').matchAll(/<p:sldId\s[^>]*>/g)].map((m) => map.get(attr(m[0], 'r:id'))?.target).filter(Boolean).map((t) => resolveTarget('ppt', t)).filter((n) => files.has(n));
  if (!order.length) order = [...files.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(/\d+/.exec(path.posix.basename(a))[0]) - Number(/\d+/.exec(path.posix.basename(b))[0]));
  if (!order.length) throw new Error('no slides inside');
  const text = (xml) => paragraphs(noFallback(xml).replace(/<a:fld\s[\s\S]*?<\/a:fld>/g, ''), 'a').join('\n').replace(/\n{2,}/g, '\n').trim();
  return order.map((name, i) => {
    const notesAt = [...rels(xmlOf(files, name.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'))).values()].find((r) => /notesSlide/.test(r.type) || /notesSlide/.test(r.target));
    const notes = notesAt ? text(xmlOf(files, resolveTarget('ppt/slides', notesAt.target))) : '';
    return `Slide ${i + 1}\n${text(xmlOf(files, name)) || '(no text)'}${notes ? `\nNotes: ${notes}` : ''}`;
  }).join('\n\n');
}

// ---------------------------------------------------------------- Excel

// Number formats that show a date or time: the built-in ones, and any custom one with date letters in it.
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
export const isDateFormat = (code) => /[dmyhs]/i.test(String(code).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/general/gi, '').replace(/[eE][+-]/g, ''));
const two = (n) => String(n).padStart(2, '0');
/** An Excel day number as a date, a time or both, the way a person would write it. */
export function excelDate(serial, date1904 = false) {
  const d = new Date(Math.round((serial + (date1904 ? 1462 : 0) - 25_569) * 86_400_000));
  if (Number.isNaN(d.getTime())) return String(serial);
  const day = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
  const time = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}${d.getUTCSeconds() ? `:${two(d.getUTCSeconds())}` : ''}`;
  return Number.isInteger(serial) ? day : serial < 1 ? time : `${day} ${time}`;
}
const colIndex = (ref) => { let n = 0; for (const ch of /^[A-Z]+/i.exec(ref ?? '')?.[0].toUpperCase() ?? '') n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const siText = (xml) => [...xml.replace(/<rPh[\s>][\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*[^>/])?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');
const MAX_SHEET_TEXT = 4_000_000, MAX_COLS = 200;

function sheets(buf) {
  const files = unzip(buf, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(n));
  const book = xmlOf(files, 'xl/workbook.xml');
  if (!book) throw new Error('no workbook inside');
  const shared = [...xmlOf(files, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => siText(m[1] ?? ''));
  const styles = xmlOf(files, 'xl/styles.xml');
  const custom = new Map([...styles.matchAll(/<numFmt\s[^>]*>/g)].map((m) => [Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') ?? '']));
  const dateStyle = [.../<cellXfs[\s>][\s\S]*?<\/cellXfs>/.exec(styles)?.[0].matchAll(/<xf\s[^>]*>/g) ?? []].map((m) => { const id = Number(attr(m[0], 'numFmtId')); return custom.has(id) ? isDateFormat(custom.get(id)) : DATE_IDS.has(id); });
  const date1904 = /<workbookPr\s[^>]*date1904="(1|true)"/.test(book);
  const map = rels(xmlOf(files, 'xl/_rels/workbook.xml.rels'));
  const out = [];
  let size = 0, cut = false;
  for (const m of book.matchAll(/<sheet\s[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? 'Sheet', hidden = /^(hidden|veryHidden)$/.test(attr(m[0], 'state') ?? '');
    const target = map.get(attr(m[0], 'r:id'))?.target;
    const xml = target ? xmlOf(files, resolveTarget('xl', target)) : '';
    const rows = [];
    for (const r of xml.matchAll(/<row(?:\s[^>]*[^>/])?>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      let next = 0;
      for (const c of r[1].matchAll(/<c(?=[\s/>])(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = c[1] ?? '', inner = c[2] ?? '';
        const at = attr(tag, 'r') ? colIndex(attr(tag, 'r')) : next;
        next = at + 1;
        if (at < 0 || at >= MAX_COLS) continue;
        const type = attr(tag, 't'), raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let v = '';
        if (type === 'inlineStr') v = siText(inner);
        // No stored result (the file was written by a program that doesn't calculate): show the formula itself.
        else if (raw === undefined || raw === '') { const f = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(inner)?.[1]; v = f ? `=${unxml(f).replace(/^=/, '')}` : ''; }
        else if (type === 's') v = shared[Number(raw)] ?? '';
        else if (type === 'b') v = raw === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'str' || type === 'e' || type === 'd') v = unxml(raw);
        else { const n = Number(raw); v = !Number.isFinite(n) ? unxml(raw) : dateStyle[Number(attr(tag, 's'))] ? excelDate(n, date1904) : String(parseFloat(n.toPrecision(15))); }
        cells[at] = v.replace(/\s*\n\s*/g, ' ').trim();
      }
      if (!cells.some((v) => v)) continue;
      const line = Array.from(cells, (v) => v ?? '').join('\t');
      const num = Number(attr(r[0].slice(0, r[0].indexOf('>') + 1), 'r')) || rows.length + 1;
      if ((size += line.length + 8) > MAX_SHEET_TEXT) { cut = true; break; }
      rows.push(`${num}\t${line}`);
    }
    out.push(`Sheet: ${name}${hidden ? ' (hidden)' : ''}\n${rows.length ? `Row\t${Array.from({ length: Math.min(MAX_COLS, rows.reduce((n, l) => Math.max(n, l.split('\t').length - 1), 0)) }, (_, i) => colName(i)).join('\t')}\n${rows.join('\n')}` : '(empty)'}`);
    if (cut) { out.push('(The workbook goes on: the rest was too much to read in one go.)'); break; }
  }
  if (!out.length) throw new Error('no sheets inside');
  return out.join('\n\n');
}
const colName = (i) => { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

// ---------------------------------------------------------------- PDF

const exec = (cmd, args, opts = {}) => new Promise((res) => {
  execFile(cmd, args, { maxBuffer: 96 << 20, timeout: 90_000, windowsHide: true, encoding: 'utf8', ...opts }, (err, stdout, stderr) => res({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
});
// Tries pypdf, then PyMuPDF. Pages are split by form feeds, as pdftotext does. Exit 3: neither is installed.
const PY = `import sys
sys.path[:] = [p for p in sys.path if p]
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
f = sys.argv[1]
try:
    from pypdf import PdfReader
    r = PdfReader(f)
    if r.is_encrypted and not r.decrypt(""):
        sys.exit(4)
    sys.stdout.write("\\f".join((p.extract_text() or "") for p in r.pages))
except ImportError:
    try:
        import fitz
    except ImportError:
        sys.exit(3)
    d = fitz.open(f)
    if d.needs_pass:
        sys.exit(4)
    sys.stdout.write("\\f".join(p.get_text() for p in d))
`;
export const NO_PDF_READER = "I can't read PDFs on this computer yet. Install one of these once, then ask again: Poppler (it brings pdftotext), or Python with pypdf (pip install pypdf). Both work offline.";

/** The text of a PDF, page by page. `run(cmd, args)` resolves { err, stdout, stderr }. */
export async function pdf(file, { run = exec, platform = process.platform } = {}) {
  const pages = (out) => {
    const list = out.replace(/\f\s*$/, '').split('\f').map((p) => p.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim());
    if (!list.some((p) => p)) throw new Error('This PDF has no text in it: its pages are pictures (a scan). It needs text recognition (OCR) first.');
    return list.length === 1 ? list[0] : list.map((p, i) => `Page ${i + 1}\n${p}`).join('\n\n');
  };
  const missing = (r) => r.err && (r.err.code === 'ENOENT' || r.err.code === 9009 || /not recognized|not found|No such file/i.test(r.stderr));
  const first = await run('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-']);
  if (!first.err) return pages(first.stdout);
  if (!missing(first)) throw new Error(/password|encrypt/i.test(first.stderr) ? 'This PDF is locked with a password.' : `That PDF couldn't be read${first.stderr.trim() ? `: ${first.stderr.trim().split('\n')[0].slice(0, 200)}` : '.'}`);
  for (const py of platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = await run(py, ['-c', PY, file], { cwd: os.tmpdir() });
    if (!r.err) return pages(r.stdout);
    if (r.err.code === 4) throw new Error('This PDF is locked with a password.');
    if (r.err.code === 3 || missing(r)) continue;
    // Windows' "python" can be a stub that opens the Store: it fails without saying "not found".
    if (platform === 'win32' && py === 'python') continue;
    throw new Error(`That PDF couldn't be read${r.stderr.trim() ? `: ${r.stderr.trim().split('\n').pop().slice(0, 200)}` : '.'}`);
  }
  throw new Error(NO_PDF_READER);
}

// ---------------------------------------------------------------- reading

/** A document's text. Throws an Error whose message says, in plain words, why it couldn't be read. */
export async function readDocument(file, { run, platform } = {}) {
  const e = ext(file), base = path.basename(String(file));
  if (e in OLD) throw new Error(`${base} is in the old ${e} format, which I can't read. Open it and use Save As to make a ${OLD[e]} copy, then ask me again.`);
  if (e === '.pdf') return pdf(file, { run, platform });
  const stat = await fs.stat(file);
  if (stat.size > MAX_FILE) throw new Error(`${base} is too large to read here (${Math.round(stat.size / (1 << 20))} MB).`);
  const buf = await fs.readFile(file);
  try { return WORD.has(e) ? word(buf) : SLIDES.has(e) ? slides(buf) : sheets(buf); }
  catch (err) {
    const why = String(err?.message ?? err);
    // A file with a password isn't a zip at all (it's wrapped in an encrypted container).
    if (why === 'not a zip archive' || why === 'password-protected') throw new Error(`${base} couldn't be opened: it's locked with a password, or it's damaged. Save a copy without the password and ask me again.`);
    throw new Error(`${base} couldn't be read: ${why}.`);
  }
}

/**
 * One part of a long text, from character `from`, at most `limit` long, ending on a line break where it can.
 * The last line says how to get the next part.
 */
export function part(text, from = 0, limit = 60_000) {
  text = String(text);
  from = Math.max(0, Math.floor(Number(from) || 0));
  if (from >= text.length && text.length) return `(Nothing more: the file is ${text.length.toLocaleString('en-US')} characters long.)`;
  let end = Math.min(text.length, from + limit);
  if (end < text.length) { const nl = text.lastIndexOf('\n', end); if (nl > from + limit * 0.6) end = nl + 1; }
  const body = text.slice(from, end);
  if (end >= text.length) return body;
  return `${body}\n…(${(text.length - end).toLocaleString('en-US')} more characters. For the next part call read_file again with from: ${end})`;
}
