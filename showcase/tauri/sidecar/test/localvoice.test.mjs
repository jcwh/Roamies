import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createSpeaker } from '../speaker.mjs';
import { SpeechText } from '../speech.mjs';
import { LocalVoice, SAPI_RATE, SAPI_SCRIPT, createSapi, createServerVoice, hasBuiltinVoice, localAddress, parseWav, plain, voiceForLook } from '../localvoice.mjs';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

{ // Windows has voices built in; the others need a speech server.
  assert.equal(hasBuiltinVoice('win32'), true);
  assert.equal(hasBuiltinVoice('darwin'), false);
  assert.equal(hasBuiltinVoice('linux'), false);
}

{ // JARVIS takes a British man's voice when Windows has one, else leaves it to the gender hint; other looks never pick by name.
  const david = { name: 'Microsoft David Desktop', gender: 'Male', lang: 'en-US' }, zira = { name: 'Microsoft Zira Desktop', gender: 'Female', lang: 'en-US' };
  const hazel = { name: 'Microsoft Hazel Desktop', gender: 'Female', lang: 'en-GB' }, george = { name: 'Microsoft George', gender: 'Male', lang: 'en-GB' };
  const james = { name: 'Microsoft James', gender: 'Male', lang: 'en-AU' };
  assert.equal(voiceForLook('jarvis', [david, zira, hazel, george]), 'Microsoft George');
  assert.equal(voiceForLook('jarvis', [david, james, hazel]), 'Microsoft James', 'no British man: another Commonwealth one before an American');
  assert.equal(voiceForLook('jarvis', [david, zira, hazel]), '', "a British woman's voice isn't it: the gender hint picks a man's");
  assert.equal(voiceForLook('jarvis', []), ''); assert.equal(voiceForLook('jarvis'), '');
  assert.equal(voiceForLook('sarah', [david, zira, hazel, george]), ''); assert.equal(voiceForLook('classic', [george]), '');
}

{ // A plain voice would read the Fish Audio cues out loud: they're dropped, the words stay.
  assert.equal(plain('[chuckling] Heh, fair enough.'), 'Heh, fair enough.');
  assert.equal(plain("[warm and curious] So what's next?"), "So what's next?");
  assert.equal(plain("It's [emphasis] today."), "It's today.");
  assert.equal(plain('Done. [slightly sad] Sorry about that.'), 'Done. Sorry about that.');
  assert.equal(plain('  Plain   words.  '), 'Plain words.');
  assert.equal(plain('[break]'), '');
}

{ // Only this computer's own addresses; a bare host gets the usual path.
  assert.equal(localAddress('http://127.0.0.1:8004/v1/audio/speech'), 'http://127.0.0.1:8004/v1/audio/speech');
  assert.equal(localAddress(' http://localhost:8880 '), 'http://localhost:8880/v1/audio/speech');
  assert.equal(localAddress('http://127.0.0.1:8004/'), 'http://127.0.0.1:8004/v1/audio/speech');
  assert.equal(localAddress('http://127.9.8.7:5000/tts'), 'http://127.9.8.7:5000/tts');
  assert.equal(localAddress('http://[::1]:8004/speak'), 'http://[::1]:8004/speak');
  assert.equal(localAddress('https://localhost/v1/audio/speech#x'), 'https://localhost/v1/audio/speech');
  for (const bad of ['', 'not a url', 'http://192.168.1.20:8004/v1/audio/speech', 'https://api.example.com/v1/audio/speech', 'http://127.0.0.1.evil.com/x',
    'http://localhost.evil.com/x', 'file:///C:/x.wav', 'ftp://127.0.0.1/x', 'http://user:pw@127.0.0.1/x', 'http://1270.0.0.1/x', null, undefined]) {
    assert.equal(localAddress(bad), null, String(bad));
  }
}

// ---- WAV files
const wav = ({ format = 1, channels = 1, rate = 24000, bits = 16, data, dataSize, extra = null, extensible = false }) => {
  const fmtBody = Buffer.alloc(extensible ? 40 : 16);
  fmtBody.writeUInt16LE(extensible ? 0xfffe : format, 0); fmtBody.writeUInt16LE(channels, 2); fmtBody.writeUInt32LE(rate, 4);
  fmtBody.writeUInt32LE(rate * channels * (bits >> 3), 8); fmtBody.writeUInt16LE(channels * (bits >> 3), 12); fmtBody.writeUInt16LE(bits, 14);
  if (extensible) { fmtBody.writeUInt16LE(22, 16); fmtBody.writeUInt16LE(format, 24); }
  const chunk = (id, body, size = body.length) => { const h = Buffer.alloc(8); h.write(id, 'latin1'); h.writeUInt32LE(size >>> 0, 4); return Buffer.concat([h, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const parts = [chunk('fmt ', fmtBody), ...(extra ? [chunk('LIST', extra)] : []), chunk('data', data, dataSize ?? data.length)];
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), ...parts]);
  const head = Buffer.alloc(8); head.write('RIFF', 'latin1'); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};
const i16 = (...v) => { const b = Buffer.alloc(v.length * 2); v.forEach((x, i) => b.writeInt16LE(x, i * 2)); return b; };
const samples = (pcm) => Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2));

{ // 16-bit mono comes through as it is, with its rate; other chunks are skipped.
  const r = parseWav(wav({ data: i16(1, -2, 300), extra: Buffer.from('odd') }));
  assert.equal(r.rate, 24000); assert.deepEqual(samples(r.pcm), [1, -2, 300]);
}
{ // Stereo is mixed down; 8-bit, 24-bit, 32-bit and float become 16-bit.
  assert.deepEqual(samples(parseWav(wav({ channels: 2, rate: 44100, data: i16(100, 300, -50, -150) })).pcm), [200, -100]);
  assert.deepEqual(samples(parseWav(wav({ bits: 8, data: Buffer.from([128, 255, 0]) })).pcm), [0, 32511, -32767]);
  const f = Buffer.alloc(12); f.writeFloatLE(0, 0); f.writeFloatLE(0.5, 4); f.writeFloatLE(-2, 8); // out of range is clipped
  assert.deepEqual(samples(parseWav(wav({ format: 3, bits: 32, data: f })).pcm), [0, 16384, -32768]);
  const b24 = Buffer.alloc(6); b24.writeIntLE(4194304, 0, 3); b24.writeIntLE(-4194304, 3, 3);
  assert.deepEqual(samples(parseWav(wav({ bits: 24, data: b24 })).pcm), [16384, -16383]);
  const b32 = Buffer.alloc(4); b32.writeInt32LE(1073741824, 0);
  assert.deepEqual(samples(parseWav(wav({ bits: 32, data: b32 })).pcm), [16384]);
  assert.deepEqual(samples(parseWav(wav({ extensible: true, data: i16(7, 8) })).pcm), [7, 8], 'the "extensible" header says PCM further in');
}
{ // A streamed WAV has no real length for its audio: it runs to the end. An odd byte at the end is dropped.
  assert.deepEqual(samples(parseWav(wav({ data: i16(5, 6, 7), dataSize: 0xffffffff })).pcm), [5, 6, 7]);
  assert.deepEqual(samples(parseWav(wav({ data: i16(5, 6, 7), dataSize: 0 })).pcm), [5, 6, 7]);
  assert.deepEqual(samples(parseWav(wav({ data: Buffer.concat([i16(9), Buffer.from([1])]) })).pcm), [9]);
}
{ // Not something to play.
  assert.throws(() => parseWav(Buffer.from('ID3\x04 an mp3, not a wav file at all')), /not a WAV/);
  assert.throws(() => parseWav(Buffer.alloc(4)), /not a WAV/);
  assert.throws(() => parseWav(wav({ format: 85, data: i16(1) })), /can't play/);
  const noData = wav({ data: i16(1) }).subarray(0, 36); // cut off after the format
  assert.throws(() => parseWav(noData), /no audio/);
}

// ---- Windows' voices: the PowerShell helper, played by a stand-in process
class FakeProc extends EventEmitter {
  constructor() {
    super();
    this.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    this.stderr = new EventEmitter();
    this.stdin = Object.assign(new EventEmitter(), { lines: [], write: (s) => { this.stdin.lines.push(JSON.parse(s)); this.onLine?.(JSON.parse(s)); return true; }, end() {} });
    this.killed = false;
  }
  kill() { this.killed = true; setImmediate(() => this.emit('exit', null)); }
  say(o) { this.stdout.emit('data', `${JSON.stringify(o)}\r\n`); }
}
const fakeSpawn = () => {
  const procs = [], calls = [];
  const spawnImpl = (cmd, args, opts) => { const p = new FakeProc(); procs.push(p); calls.push({ cmd, args, opts }); return p; };
  return { procs, calls, spawnImpl };
};
const READY = { ready: true, voices: [{ name: 'Microsoft David Desktop', gender: 'Male', lang: 'en-US' }, { name: 'Microsoft Zira Desktop', gender: 'Female', lang: 'en-US' }] };

{ // It starts hidden, with the script, and lists the voices once it's up.
  const { procs, calls, spawnImpl } = fakeSpawn();
  const sapi = createSapi({ spawnImpl, idle: 0 });
  const got = sapi.voices();
  await tick();
  assert.equal(calls[0].cmd, 'powershell.exe');
  assert.ok(calls[0].args.includes('-NoProfile') && calls[0].args.includes('-NonInteractive'));
  assert.equal(Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le'), SAPI_SCRIPT);
  assert.equal(calls[0].opts.windowsHide, true);
  procs[0].stdout.emit('data', '\uFEFFsome banner\r\n'); // noise before the first real line is ignored
  procs[0].say(READY);
  assert.deepEqual(await got, READY.voices);
  sapi.stop();
}
{ // A sentence goes in as ASCII JSON (so the console's code page can't spoil it) and comes back as PCM.
  const { procs, spawnImpl } = fakeSpawn();
  const sapi = createSapi({ spawnImpl, idle: 0 });
  const audio = sapi.speak('Café “déjà vu” 日本', { voice: 'Microsoft Zira Desktop', gender: 'Female', rate: 1 });
  await tick(); procs[0].say(READY); await tick();
  const sent = procs[0].stdin.lines[0];
  assert.deepEqual(sent, { id: 1, text: 'Café “déjà vu” 日本', voice: 'Microsoft Zira Desktop', gender: 'Female', rate: 1 });
  // What was really written had no byte above ASCII.
  const raw = [];
  procs[0].stdin.write = (s) => { raw.push(s); return true; };
  const second = sapi.speak('Zoë');
  await tick();
  assert.ok(/^[\x00-\x7f]+$/.test(raw[0]) && raw[0].includes('Zo\\u00eb') && raw[0].endsWith('\n'));
  // Replies can come split across chunks and out of order.
  const line = JSON.stringify({ id: 2, rate: SAPI_RATE, pcm: i16(3, 4).toString('base64') });
  procs[0].stdout.emit('data', line.slice(0, 20)); procs[0].stdout.emit('data', `${line.slice(20)}\n${JSON.stringify({ id: 1, rate: SAPI_RATE, pcm: i16(1, 2).toString('base64') })}\n`);
  assert.deepEqual(samples((await second).pcm), [3, 4]);
  const first = await audio;
  assert.equal(first.rate, SAPI_RATE); assert.deepEqual(samples(first.pcm), [1, 2]);
  assert.equal(procs.length, 1, 'one helper for every sentence');
  sapi.stop();
}
{ // The helper reports a failure for one sentence: only that one fails.
  const { procs, spawnImpl } = fakeSpawn();
  const sapi = createSapi({ spawnImpl, idle: 0 });
  const a = sapi.speak('One.'), b = sapi.speak('Two.');
  await tick(); procs[0].say(READY); await tick();
  procs[0].say({ id: 1, error: 'No voice installed' });
  procs[0].say({ id: 2, rate: SAPI_RATE, pcm: i16(9).toString('base64') });
  await assert.rejects(a, /failed \(No voice installed\)/);
  assert.deepEqual(samples((await b).pcm), [9]);
  sapi.stop();
}
{ // The helper dies: what was waiting fails, and the next sentence starts a new one.
  const { procs, spawnImpl } = fakeSpawn();
  const sapi = createSapi({ spawnImpl, idle: 0 });
  const a = sapi.speak('One.');
  await tick(); procs[0].say(READY); await tick();
  procs[0].stderr.emit('data', 'Out of memory\r\n');
  procs[0].emit('exit', 1);
  await assert.rejects(a, /stopped \(Out of memory\)/);
  const b = sapi.speak('Two.');
  await tick(); assert.equal(procs.length, 2);
  procs[1].say(READY); await tick();
  procs[1].say({ id: procs[1].stdin.lines[0].id, rate: SAPI_RATE, pcm: i16(5).toString('base64') });
  assert.deepEqual(samples((await b).pcm), [5]);
  sapi.stop();
}
{ // PowerShell isn't there, or never comes up.
  const spawnImpl = () => { const p = new FakeProc(); setImmediate(() => p.emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }))); return p; };
  await assert.rejects(createSapi({ spawnImpl, idle: 0 }).speak('Hi.'), /PowerShell was not found/);
  await assert.rejects(createSapi({ spawnImpl: () => { throw new Error('EPERM'); }, idle: 0 }).speak('Hi.'), /Couldn't start the voice on this PC \(EPERM\)/);
  const { procs, spawnImpl: slow } = fakeSpawn();
  await assert.rejects(createSapi({ spawnImpl: slow, startTimeout: 20, idle: 0 }).speak('Hi.'), /too long to start/);
  assert.ok(procs[0].killed);
}
{ // A stopped reply: its sentence is dropped straight away, and what comes back later is ignored.
  const { procs, spawnImpl } = fakeSpawn();
  const sapi = createSapi({ spawnImpl, idle: 0 });
  await Promise.all([sapi.voices(), tick().then(() => procs[0].say(READY))]);
  const ac = new AbortController();
  const a = sapi.speak('Long sentence.', { signal: ac.signal });
  await tick(); ac.abort();
  await assert.rejects(a, { name: 'AbortError' });
  procs[0].say({ id: 1, rate: SAPI_RATE, pcm: i16(1).toString('base64') }); // late: nobody is waiting
  const b = sapi.speak('Next.');
  await tick(); procs[0].say({ id: 2, rate: SAPI_RATE, pcm: i16(2).toString('base64') });
  assert.deepEqual(samples((await b).pcm), [2]);
  // A sentence that never comes back is given up on, and the helper is restarted for the next one.
  const stuck = createSapi({ spawnImpl, speakTimeout: 20, idle: 0 });
  const c = stuck.speak('Stuck.');
  await tick(); procs[1].say(READY);
  await assert.rejects(c, /too long/);
  assert.ok(procs[1].killed);
  sapi.stop();
}
{ // Unused for a while, the helper is closed; it comes back when needed.
  const { procs, spawnImpl } = fakeSpawn();
  const sapi = createSapi({ spawnImpl, idle: 30 });
  await Promise.all([sapi.voices(), tick().then(() => procs[0].say(READY))]);
  await tick(60);
  assert.ok(procs[0].killed);
  const v = sapi.voices();
  await tick(); assert.equal(procs.length, 2);
  procs[1].say(READY); await v;
  sapi.stop();
}

// ---- a speech server on this computer
{
  const asked = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      asked.push({ url: req.url, type: req.headers['content-type'], body: JSON.parse(body) });
      const text = JSON.parse(body).input;
      if (text === 'refuse') { res.writeHead(422, { 'content-type': 'application/json' }); return res.end('{"detail":"voice  not\n found"}'); }
      if (text === 'mp3') { res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(Buffer.from('ID3 this is not a wav file')); }
      if (text === 'slow') return; // never answers
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(wav({ rate: 24000, channels: 2, data: i16(10, 30, -10, -30) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = localAddress(`http://127.0.0.1:${server.address().port}`);
  try {
    const v = createServerVoice({ url, voice: 'Emily.wav' });
    const a = await v.speak('Hello there.');
    assert.equal(a.rate, 24000); assert.deepEqual(samples(a.pcm), [20, -20]);
    assert.deepEqual(asked[0], { url: '/v1/audio/speech', type: 'application/json', body: { model: 'tts-1', input: 'Hello there.', voice: 'Emily.wav', response_format: 'wav' } });
    await createServerVoice({ url }).speak('No voice named.');
    assert.equal('voice' in asked[1].body, false, 'no voice name: the server uses its own default');
    await assert.rejects(v.speak('refuse'), /said no \(422: \{"detail":"voice not found"\}\)/);
    await assert.rejects(v.speak('mp3'), /sent not a WAV file/);
    await assert.rejects(createServerVoice({ url, timeout: 40 }).speak('slow'), /took too long/);
    const ac = new AbortController();
    const stopped = v.speak('slow', { signal: ac.signal });
    await tick(20); ac.abort();
    await assert.rejects(stopped, { name: 'AbortError' });
  } finally { server.closeAllConnections?.(); server.close(); }
  await assert.rejects(createServerVoice({ url }).speak('Anyone?'), /Couldn't reach the voice server/);
}

// ---- one reply's voice
const fakeEngine = (answer = (text) => ({ rate: 100, pcm: i16(...Array.from(text, (c) => c.charCodeAt(0))) }), ms = 0) => {
  const e = { asked: [], warmed: 0, warm() { e.warmed++; }, async speak(text, opts) { e.asked.push({ text, ...opts }); await tick(ms); return answer(text, opts); } };
  return e;
};
const voiceOf = (engines, more = {}) => {
  const got = { audio: [], ended: 0, errors: [], fallbacks: [] };
  const v = new LocalVoice({ engines, onAudio: (pcm, rate) => got.audio.push({ rate, n: pcm.length, pcm: Buffer.from(pcm) }), onEnd: () => got.ended++, onError: (e) => got.errors.push(e), onFallback: (e) => got.fallbacks.push(e.message), ...more });
  return { v, got };
};

{ // Sentences are made one after another, in order, without their cues, and handed over in short pieces.
  const e = fakeEngine();
  const { v, got } = voiceOf([e], { voice: 'Microsoft David Desktop', gender: 'Male', piece: 0.05 }); // 0.05 s at 100 Hz: 5 samples a piece
  v.open(); assert.equal(e.warmed, 1, 'the helper starts while the model is still thinking');
  v.say('[warm] Hello there, friend.'); v.say('[break]'); v.say('Bye.'); v.end();
  assert.equal(got.ended, 0);
  await tick(20);
  assert.deepEqual(e.asked.map((a) => a.text), ['Hello there, friend.', 'Bye.']);
  assert.equal(e.asked[0].voice, 'Microsoft David Desktop'); assert.equal(e.asked[0].gender, 'Male'); assert.ok(e.asked[0].signal instanceof AbortSignal);
  assert.deepEqual(got.audio.map((a) => a.n), [10, 10, 10, 10, 8], '20 samples in pieces of 5, then 4');
  assert.ok(got.audio.every((a) => a.rate === 100));
  assert.equal(Buffer.concat(got.audio.map((a) => a.pcm)).length, ('Hello there, friend.'.length + 'Bye.'.length) * 2, 'nothing lost between pieces');
  assert.equal(got.ended, 1); assert.deepEqual(got.errors, []);
  v.say('Too late.'); await tick(10);
  assert.equal(e.asked.length, 2, 'nothing more after the end');
}
{ // Nothing said: it just ends. Ending twice is one end.
  const { v, got } = voiceOf([fakeEngine()]);
  v.open(); v.end(); v.end();
  assert.equal(got.ended, 1);
}
{ // Stopped: silent from then on, the sentence being made is cancelled, and no end is reported.
  const e = fakeEngine(undefined, 15);
  const { v, got } = voiceOf([e]);
  v.say('One.'); v.say('Two.');
  await tick(3); // "One." is being made
  v.abort();
  await tick(30);
  assert.equal(e.asked.length, 1); assert.ok(e.asked[0].signal.aborted);
  assert.deepEqual(got.audio, []); assert.equal(got.ended, 0); assert.deepEqual(got.errors, []);
}
{ // It fails before any audio: reported with heard false. After some audio: heard true, and the rest is dropped.
  const bad = fakeEngine(() => { throw new Error('The voice on this PC failed'); });
  const first = voiceOf([bad]);
  first.v.say('One.'); first.v.end();
  await tick(20);
  assert.equal(first.got.errors.length, 1); assert.equal(first.got.errors[0].heard, false); assert.equal(first.got.ended, 0);
  let n = 0;
  const flaky = fakeEngine((text) => { if (++n === 2) throw new Error('gone'); return { rate: 100, pcm: i16(1, 2) }; });
  const later = voiceOf([flaky]);
  later.v.say('One.'); later.v.say('Two.'); later.v.say('Three.'); later.v.end();
  await tick(30);
  assert.equal(later.got.audio.length, 1); assert.equal(later.got.errors[0].heard, true); assert.equal(flaky.asked.length, 2);
}
{ // The server is off: Windows' own voice takes over from that sentence on, and it isn't asked again this reply.
  const server = fakeEngine(() => { throw new Error("Couldn't reach the voice server. Is it running?"); });
  const sapi = fakeEngine();
  const { v, got } = voiceOf([server, sapi]);
  v.say('One.'); v.say('Two.'); v.end();
  await tick(30);
  assert.deepEqual(server.asked.map((a) => a.text), ['One.']);
  assert.deepEqual(sapi.asked.map((a) => a.text), ['One.', 'Two.']);
  assert.deepEqual(got.fallbacks, ["Couldn't reach the voice server. Is it running?"]);
  assert.equal(got.ended, 1); assert.deepEqual(got.errors, []);
  // No server set, or not on Windows: the missing one is simply left out.
  assert.equal(voiceOf([null, sapi]).v.engines.length, 1);
  const none = voiceOf([null, null]);
  none.v.say('Hi.'); await tick(10);
  assert.match(none.got.errors[0].message, /No voice on this computer/);
}

{ // All together, as the app runs it: a reply streams in, its sentences go to the speaker, and a voice server on this
  // computer says them. What reaches the overlay: a stop for whatever was playing, the audio in order, then the end.
  const asked = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { const text = JSON.parse(body).input; asked.push(text); res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav({ rate: 24000, data: i16(...Array.from(text, (c) => c.charCodeAt(0))) })); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = localAddress(`http://127.0.0.1:${server.address().port}/v1/audio/speech`);
  try {
    const out = [];
    const sp = createSpeaker({ emit: (m) => out.push(m), beatPhrases: [], bundled: () => null,
      local: { available: () => true, make: (on) => new LocalVoice({ engines: [createServerVoice({ url })], ...on }) } });
    const reply = sp.start();
    const spoken = new SpeechText((t) => reply.say(t));
    for (const part of ['[warm] Hello the', 're. It is **sunny** to', 'day.\n- a point for the screen\n', 'Bye']) spoken.push(part);
    spoken.flush(); reply.end();
    for (let i = 0; i < 200 && !out.some((m) => m.end); i++) await tick(10);
    assert.deepEqual(asked, ['Hello there.', 'It is sunny today.', 'Bye'], 'spoken in order, without the cue, the markdown or the list line');
    assert.deepEqual(out[0], { kind: 'speech', stop: true });
    const audio = out.slice(1, -1);
    assert.ok(audio.length === 3 && audio.every((m) => m.kind === 'speech' && m.id === reply.id && m.rate === 24000 && typeof m.pcm === 'string'));
    assert.equal(Buffer.concat(audio.map((m) => Buffer.from(m.pcm, 'base64'))).length, asked.join('').length * 2);
    assert.deepEqual(out.at(-1), { kind: 'speech', id: reply.id, end: true, chars: asked.join(' ').length });
  } finally { server.closeAllConnections?.(); server.close(); }
}

console.log('local voice tests: passed');
