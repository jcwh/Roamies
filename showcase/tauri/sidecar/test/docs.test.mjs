// Reading Word, PowerPoint, Excel and PDF files on this computer. Run: npm test
// The files are built here (a small zip writer), with XML shaped like what Word, Excel and PowerPoint write.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { NO_PDF_READER, excelDate, isDateFormat, isDocument, part, pdf, readDocument, unzip } from '../docs.mjs';

// A zip archive of { name: text }, every other entry deflated (both ways of storing are read).
function zip(entries, { flags = 0 } = {}) {
  const local = [], central = [];
  let at = 0, i = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text), packed = i++ % 2 ? raw : zlib.deflateRawSync(raw), method = packed === raw ? 0 : 8, n = Buffer.from(name);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(flags, 6); head.writeUInt16LE(method, 8);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(flags, 8); dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(at, 42);
    local.push(head, n, packed); central.push(dir, n);
    at += 30 + n.length + packed.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(i, 8); end.writeUInt16LE(i, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...local, cd, end]);
}
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roamies-docs-'));
const save = async (name, buf) => { const f = path.join(dir, name); await fs.writeFile(f, buf); return f; };

{ // Which files are documents.
  for (const f of ['a.docx', 'B.DOCX', 'deck.pptx', 'book.xlsx', 'macro.xlsm', 'memo.pdf', 'old.doc', 'C:\\Users\\me\\Report Final.PDF']) assert.ok(isDocument(f), f);
  for (const f of ['notes.txt', 'data.csv', 'code.mjs', 'page.html', 'README', 'archive.zip', 'photo.png']) assert.ok(!isDocument(f), f);
}
{ // The zip reader.
  const z = zip({ 'a.txt': 'alpha', 'dir/b.txt': 'beta '.repeat(500), 'c.txt': '' });
  const all = unzip(z);
  assert.deepEqual([...all.keys()], ['a.txt', 'dir/b.txt', 'c.txt']);
  assert.equal(all.get('a.txt').toString(), 'alpha'); assert.equal(all.get('dir/b.txt').toString(), 'beta '.repeat(500)); assert.equal(all.get('c.txt').length, 0);
  assert.deepEqual([...unzip(z, (n) => n.startsWith('dir/')).keys()], ['dir/b.txt'], 'only what was asked for is unpacked');
  assert.throws(() => unzip(Buffer.from('this is not a zip file at all, just some text')), /not a zip archive/);
  assert.throws(() => unzip(zip({ 'a.txt': 'x' }, { flags: 1 })), /password-protected/);
}
{ // Word: headings, lists, a table, tabs and line breaks, entities; tracked deletions, field codes and tab stops left out.
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W} xmlns:mc="x"><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Project Halcyon</w:t></w:r></w:p>
<w:p w:rsidR="00A1"><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t xml:space="preserve">Lease </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>terms</w:t></w:r></w:p>
<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Costs &amp; margins held (&quot;flat&quot;) &#8212; caf&#xE9; &lt;RESTRICTED&gt;</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Renew the lease</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>Hire two analysts</w:t></w:r></w:p>
<w:p/>
<w:tbl><w:tblPr><w:tblW w:w="0"/></w:tblPr><w:tr><w:tc><w:p><w:r><w:t>Site</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Jurong</w:t></w:r></w:p><w:p><w:r><w:t>(west)</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2.9m</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>Name</w:t></w:r><w:r><w:tab/><w:t>Value</w:t></w:r><w:r><w:br/><w:t>next line</w:t></w:r></w:p>
<w:p><w:r><w:t>Kept </w:t></w:r><w:del w:author="A"><w:r><w:delText>removed words</w:delText></w:r></w:del><w:ins w:author="A"><w:r><w:t>added words</w:t></w:r></w:ins><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r></w:p>
<mc:AlternateContent><mc:Choice Requires="wps"><w:p><w:r><w:t>Text box</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>Text box</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>
<w:sectPr/></w:body></w:document>`;
  const notes = `<w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>See the 2025 audit.</w:t></w:r></w:p></w:footnote></w:footnotes>`;
  const comments = `<w:comments ${W}><w:comment w:id="0" w:author="Mei Ling" w:date="2026-11-01T10:00:00Z"><w:p><w:r><w:t>Check this figure.</w:t></w:r></w:p></w:comment></w:comments>`;
  const text = await readDocument(await save('review.docx', zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': doc, 'word/footnotes.xml': notes, 'word/comments.xml': comments, 'word/styles.xml': '<w:styles/>' })));
  assert.equal(text, [
    '# Project Halcyon', '## Lease terms', 'Costs & margins held ("flat") — café <RESTRICTED>', '- Renew the lease', '- Hire two analysts', '',
    'Site | Revenue', 'Jurong (west) | 2.9m', '', 'Name\tValue', 'next line', 'Kept added words', 'Text box', '',
    'Footnotes:', '- See the 2025 audit.', '', 'Comments:', '- Mei Ling: Check this figure.',
  ].join('\n'));
  await assert.rejects(readDocument(await save('empty.docx', zip({ 'other.xml': '<x/>' }))), /empty\.docx couldn't be read: no document inside\./);
  // A file with a password is an encrypted container, not a zip.
  await assert.rejects(readDocument(await save('locked.docx', Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]))), /locked\.docx couldn't be opened: it's locked with a password, or it's damaged/);
  await assert.rejects(readDocument(path.join(dir, 'old.doc')), /old \.doc format[^\n]*Save As to make a \.docx copy/);
  await assert.rejects(readDocument(path.join(dir, 'figures.xls')), /Save As to make a \.xlsx copy/);
}
{ // Excel: shared and inline strings, numbers, booleans, dates by style, formulas, gaps, hidden sheets, the 1904 calendar.
  const book = (extra = '') => `<workbook xmlns="m" xmlns:r="r"><workbookPr${extra}/><sheets><sheet name="Budget &amp; plan" sheetId="1" r:id="rId1"/><sheet name="Old" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Blank" sheetId="3" r:id="rId3"/></sheets></workbook>`;
  const rels = '<Relationships><Relationship Id="rId1" Type="t/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="t/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="t/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId9" Type="t/styles" Target="styles.xml"/></Relationships>';
  const strings = '<sst><si><t>Item</t></si><si><t xml:space="preserve">Server </t><r><rPr><b/></rPr><t>lease</t></r><rPh sb="0" eb="1"><t>ignored reading</t></rPh></si><si/><si><t>Line one\nline two</t></si></sst>';
  const styles = '<styleSheet><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="#,##0.00 &quot;SGD&quot;"/></numFmts><cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="165"/><xf numFmtId="20"/></cellXfs></styleSheet>';
  const sheet1 = `<worksheet><cols><col min="1" max="1" width="20"/></cols><sheetData>
<row r="1" spans="1:4"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Date</t></is></c><c r="C1" t="str"><f>"Amo"&amp;"unt"</f><v>Amount</v></c></row>
<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="1"><v>46329</v></c><c r="C2" s="2"><v>1250.5</v></c><c r="D2" t="b"><v>1</v></c></row>
<row r="3" ht="15"/>
<row r="4"><c r="A4" t="s"><v>3</v></c><c r="B4" s="1"><v>46357.604166666664</v></c><c r="C4"><v>0.30000000000000004</v></c><c r="E4" s="3"><v>0.385416666666667</v></c></row>
<row r="6"><c r="A6" s="0"/><c r="C6"><f>SUM(C2:C4)</f><v>1250.8</v></c><c r="D6"><f>C6*2</f></c><c r="G6" t="e"><v>#DIV/0!</v></c></row>
</sheetData></worksheet>`;
  const files = { 'xl/workbook.xml': book(), 'xl/_rels/workbook.xml.rels': rels, 'xl/sharedStrings.xml': strings, 'xl/styles.xml': styles, 'xl/worksheets/sheet1.xml': sheet1, 'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row><c><v>7</v></c><c><v>8</v></c></row></sheetData></worksheet>', 'xl/worksheets/sheet3.xml': '<worksheet><sheetData/></worksheet>' };
  const text = await readDocument(await save('budget.xlsx', zip(files)));
  assert.equal(text, [
    'Sheet: Budget & plan', 'Row\tA\tB\tC\tD\tE\tF\tG', '1\tItem\tDate\tAmount', '2\tServer lease\t2026-11-03\t1250.5\tTRUE',
    '4\tLine one line two\t2026-12-01 14:30\t0.3\t\t09:15', '6\t\t\t1250.8\t=C6*2\t\t\t#DIV/0!', '',
    'Sheet: Old (hidden)', 'Row\tA\tB', '1\t7\t8', '', 'Sheet: Blank', '(empty)',
  ].join('\n'));
  // Workbooks from old Mac Excel count days from 1904.
  assert.match(await readDocument(await save('mac.xlsx', zip({ ...files, 'xl/workbook.xml': book(' date1904="1"') }))), /Server lease\t2030-11-04\t/);
  assert.equal(excelDate(46329), '2026-11-03'); assert.equal(excelDate(0.5), '12:00'); assert.equal(excelDate(46329.75), '2026-11-03 18:00'); assert.equal(excelDate(1, true), '1904-01-02');
  for (const f of ['yyyy-mm-dd', 'd/m/yy', 'h:mm AM/PM', '[$-409]mmmm d, yyyy', 'mm:ss']) assert.ok(isDateFormat(f), f);
  for (const f of ['General', '0.00', '#,##0', '0%', '#,##0.00 "SGD"', '0.00E+00', '"day" 0', '[Red]0.0']) assert.ok(!isDateFormat(f), f);
}
{ // PowerPoint: slides in the order they're shown, tables, notes without the slide number.
  const A = 'xmlns:a="a" xmlns:p="p" xmlns:r="r"';
  const slide = (...paras) => `<p:sld ${A}><p:cSld><p:spTree>${paras.join('')}</p:spTree></p:cSld></p:sld>`;
  const para = (text, bullet = false) => `<p:sp><p:txBody><a:bodyPr/><a:p>${bullet ? '<a:pPr><a:buChar char="&#8226;"/></a:pPr>' : ''}<a:r><a:rPr lang="en-SG"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const table = '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr h="1"><a:tc><a:txBody><a:p><a:r><a:t>Site</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr h="1"><a:tc><a:txBody><a:p><a:r><a:t>Jurong</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>2.9m</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  const files = {
    'ppt/presentation.xml': `<p:presentation ${A}><p:sldIdLst><p:sldId id="258" r:id="rId4"/><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId1" Type="t/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="t/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="t/slide" Target="slides/slide2.xml"/><Relationship Id="rId4" Type="t/slide" Target="slides/slide3.xml"/></Relationships>',
    'ppt/slides/slide1.xml': slide(para('Halcyon update'), para('Revenue up 12%', true), para('Two new hires', true)),
    'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Id="rId1" Type="t/slideLayout" Target="../slideLayouts/slideLayout2.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
    'ppt/notesSlides/notesSlide1.xml': `<p:notes ${A}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Mention the Tuas lease.</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:fld id="{1}" type="slidenum"><a:rPr/><a:t>2</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
    'ppt/slides/slide2.xml': slide(para('Numbers'), table),
    'ppt/slides/slide3.xml': slide(para('Cover: RESTRICTED')),
    'ppt/slides/slide10.xml': slide(para('Left out of the show')),
  };
  assert.equal(await readDocument(await save('deck.pptx', zip(files))), [
    'Slide 1', 'Cover: RESTRICTED', '', 'Slide 2', 'Halcyon update', '- Revenue up 12%', '- Two new hires', 'Notes: Mention the Tuas lease.', '', 'Slide 3', 'Numbers', 'Site | Revenue', 'Jurong | 2.9m',
  ].join('\n'));
  // Without the presentation's own order: by slide number (2 before 10).
  const { 'ppt/presentation.xml': _p, ...loose } = files;
  assert.match(await readDocument(await save('loose.pptx', zip(loose))), /^Slide 1\nHalcyon update[\s\S]*Slide 2\nNumbers[\s\S]*Slide 3\nCover: RESTRICTED\n\nSlide 4\nLeft out of the show$/);
}
{ // PDF: through pdftotext, else Python; and what's said when neither is there.
  const calls = [];
  const gone = { err: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' };
  const runner = (answers) => async (cmd, args) => { calls.push([cmd, ...args.filter((a) => !a.includes('\n'))]); return answers[cmd] ?? gone; };
  assert.equal(await pdf('m.pdf', { run: runner({ pdftotext: { err: null, stdout: 'MEMO   \nThe lease ends in March.\n\n\n\n\fPage two.\n\f', stderr: '' } }) }), 'Page 1\nMEMO\nThe lease ends in March.\n\nPage 2\nPage two.');
  assert.deepEqual(calls[0], ['pdftotext', '-layout', '-enc', 'UTF-8', 'm.pdf', '-'], 'the file is an argument, never part of a command line');
  assert.equal(await pdf('one.pdf', { run: runner({ pdftotext: { err: null, stdout: 'Just one page.\n\f', stderr: '' } }) }), 'Just one page.', 'one page needs no page heading');
  await assert.rejects(pdf('scan.pdf', { run: runner({ pdftotext: { err: null, stdout: '\f\f', stderr: '' } }) }), /no text in it: its pages are pictures/);
  await assert.rejects(pdf('p.pdf', { run: runner({ pdftotext: { err: Object.assign(new Error('x'), { code: 1 }), stdout: '', stderr: 'Command Line Error: Incorrect password\n' } }) }), /locked with a password/);
  // No pdftotext: Python. On Windows "python" may be the Store stub, so "py" is tried too.
  calls.length = 0;
  assert.equal(await pdf('m.pdf', { platform: 'win32', run: runner({ python: { err: Object.assign(new Error('x'), { code: 9009 }), stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store' }, py: { err: null, stdout: 'From pypdf.\fSecond.', stderr: '' } }) }), 'Page 1\nFrom pypdf.\n\nPage 2\nSecond.');
  assert.deepEqual(calls.map((c) => c[0]), ['pdftotext', 'python', 'py']);
  calls.length = 0;
  await assert.rejects(pdf('m.pdf', { platform: 'linux', run: runner({ python3: { err: Object.assign(new Error('x'), { code: 3 }), stdout: '', stderr: '' } }) }), (e) => e.message === NO_PDF_READER, 'Python without pypdf: say what to install');
  assert.deepEqual(calls.map((c) => c[0]), ['pdftotext', 'python3', 'python']);
  await assert.rejects(pdf('m.pdf', { platform: 'linux', run: runner({ python3: { err: Object.assign(new Error('x'), { code: 4 }), stdout: '', stderr: '' } }) }), /locked with a password/);
  await assert.rejects(pdf('m.pdf', { platform: 'win32', run: runner({}) }), (e) => e.message === NO_PDF_READER);
  assert.match(NO_PDF_READER, /Poppler[^\n]*pypdf[^\n]*offline/);
}
{ // Long files come in parts that end on a line and say how to get the next.
  const lines = Array.from({ length: 400 }, (_, i) => `Line ${String(i + 1).padStart(3, '0')} of the restricted report.`).join('\n');
  assert.equal(part('short', 0, 100), 'short'); assert.equal(part('', 0, 100), '');
  const first = part(lines, 0, 2000);
  const m = /\n…\(([\d,]+) more characters\. For the next part call read_file again with from: (\d+)\)$/.exec(first);
  assert.ok(m, 'a long text says how to go on');
  const body = first.slice(0, m.index);
  assert.ok(body.length <= 2000 && body.endsWith('report.\n'), 'it stops at the end of a line');
  assert.equal(Number(m[1].replace(/,/g, '')), lines.length - Number(m[2]));
  // Reading part after part gives back the whole text, nothing lost and nothing twice.
  let got = '', from = 0, guard = 0;
  for (;;) { const p = part(lines, from, 2000); const more = /\n…\([\d,]+ more characters\. For the next part call read_file again with from: (\d+)\)$/.exec(p); got += more ? p.slice(0, more.index) : p; if (!more) break; from = Number(more[1]); assert.ok(++guard < 50); }
  assert.equal(got, lines);
  assert.match(part(lines, 10 ** 9, 2000), /^\(Nothing more: the file is [\d,]+ characters long\.\)$/);
  assert.equal(part('abc', -5, 2), 'ab\n…(1 more characters. For the next part call read_file again with from: 2)', 'a line-less text is cut where the limit falls');
}
await fs.rm(dir, { recursive: true, force: true });
console.log('document reading tests: passed');
