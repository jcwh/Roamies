import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PATH, SETTING, quietWav, settingFile, speechAddress, transcribeWith, writeSetting } from '../ears.mjs';
import { parseWav } from '../localvoice.mjs';

{ // Plain http on this computer only (the helper has no TLS); a bare host gets the usual path.
  assert.equal(speechAddress('http://127.0.0.1:8123'), `http://127.0.0.1:8123${DEFAULT_PATH}`);
  assert.equal(speechAddress(' http://localhost:9000/inference '), 'http://localhost:9000/inference');
  assert.equal(speechAddress('http://[::1]:8123/v1/audio/transcriptions'), 'http://[::1]:8123/v1/audio/transcriptions');
  for (const bad of ['https://127.0.0.1:8123/x', 'http://192.168.1.9:8123/x', 'http://example.com/x', 'http://localhost.evil.com/x', 'nope', '', null]) assert.equal(speechAddress(bad), null, String(bad));
}

{ // The address goes where the helper reads it: one line, beside the model folder. Clearing the setting removes it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-ears-'));
  const model = path.join(root, 'models', 'parakeet-tdt-0.6b-v3-int8');
  assert.equal(settingFile(model), path.join(root, 'models', SETTING));
  await writeSetting(model, 'http://127.0.0.1:8123/v1/audio/transcriptions'); // the folders don't exist yet
  assert.equal(fs.readFileSync(settingFile(model), 'utf8'), 'http://127.0.0.1:8123/v1/audio/transcriptions\n');
  await writeSetting(model, null);
  assert.equal(fs.existsSync(settingFile(model)), false);
  await writeSetting(model, null); // nothing to remove: fine
  fs.rmSync(root, { recursive: true, force: true });
}

{ // The test take: a second of silence, as the kind of WAV the helper sends.
  const w = quietWav(1);
  const { rate, pcm } = parseWav(w);
  assert.equal(rate, 16000); assert.equal(pcm.length, 32000); assert.ok(pcm.every((b) => b === 0));
}

{ // Asked like OpenAI's transcription endpoint: a form with the file; the text comes back tidied.
  const got = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      got.push({ url: req.url, type: req.headers['content-type'], body });
      const say = (status, text, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(text); };
      if (req.url === '/busy') return say(503, 'model  still\n loading', 'text/plain');
      if (req.url === '/html') return say(200, '<html>hello</html>', 'text/html');
      if (req.url === '/notext') return say(200, '{"segments":[]}');
      if (req.url === '/slow') return;
      say(200, JSON.stringify({ text: '  Eh,   can or not? ' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await transcribeWith(speechAddress(base), quietWav(0.25)), 'Eh, can or not?');
    assert.equal(got[0].url, DEFAULT_PATH);
    assert.match(got[0].type, /^multipart\/form-data; boundary=/);
    const text = got[0].body.toString('latin1');
    for (const part of ['name="model"\r\n\r\nwhisper-1', 'name="response_format"\r\n\r\njson', 'name="language"\r\n\r\nen', 'name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFF']) assert.ok(text.includes(part), part);
    assert.ok(got[0].body.includes(quietWav(0.25)), 'the whole WAV is in the form');
    await assert.rejects(transcribeWith(`${base}/busy`, quietWav(0.1)), /said no \(503: model still loading\)/);
    await assert.rejects(transcribeWith(`${base}/html`, quietWav(0.1)), /had no text/);
    await assert.rejects(transcribeWith(`${base}/notext`, quietWav(0.1)), /had no text/);
    await assert.rejects(transcribeWith(`${base}/slow`, quietWav(0.1), { timeout: 40 }), /took too long/);
  } finally { server.closeAllConnections?.(); server.close(); }
  await assert.rejects(transcribeWith(base, quietWav(0.1)), /Couldn't reach the speech server/);
}

console.log('speech server tests: passed');
