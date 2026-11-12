// Spoken replies made on this computer, with no account and nothing sent anywhere. Two ways to make the audio:
// - Windows' own voices (System.Speech), through one PowerShell process kept running while voice is in use. It
//   reads one JSON request per line and answers with the sentence as 16-bit mono PCM. Nothing to download.
// - A speech server already running on this computer that takes OpenAI's /v1/audio/speech request (Chatterbox,
//   Kokoro and others do) and answers with a WAV file. Only addresses on this computer are accepted.
// LocalVoice wraps either in the same shape as FishVoice (say, end, abort; onAudio, onEnd, onError), so the
// speaker (speaker.mjs) treats it like any other voice.
import { spawn } from 'node:child_process';

/** Windows has voices built in; elsewhere local voice needs a speech server's address. */
export const hasBuiltinVoice = (platform) => platform === 'win32';

// The Windows voice for the look when none was picked by name: for JARVIS a British man's if one is installed,
// else by gender (the helper picks). voices: [{ name, gender, lang }].
export const voiceForLook = (look, voices = []) => {
  if (look !== 'jarvis') return '';
  const men = voices.filter((v) => /^male$/i.test(v.gender));
  return (men.find((v) => /^en-GB$/i.test(v.lang)) ?? men.find((v) => /^en-(AU|IE|NZ|ZA|IN)$/i.test(v.lang)))?.name ?? '';
};

export const SAPI_RATE = 22050;
// Windows PowerShell 5.1 (on every Windows 10 and 11). Requests come in as ASCII JSON (\uXXXX for the rest), so the
// console's code page never matters; replies are JSON lines with the audio in base64.
export const SAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
Add-Type -AssemblyName System.Speech
$out = [Console]::Out
function Emit($o) { $out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); $out.Flush() }
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${SAPI_RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $i = $_.VoiceInfo; @{ name = $i.Name; gender = "$($i.Gender)"; lang = $i.Culture.Name } })
Emit @{ ready = $true; voices = $voices }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = 0
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    if ($req.voice) { try { $synth.SelectVoice([string]$req.voice) } catch { } }
    elseif ($req.gender) { try { $synth.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]([string]$req.gender)) } catch { } }
    $rate = 0
    if ($null -ne $req.rate) { $rate = [Math]::Max(-10, [Math]::Min(10, [int]$req.rate)) }
    $synth.Rate = $rate
    $ms = New-Object System.IO.MemoryStream
    $synth.SetOutputToAudioStream($ms, $fmt)
    $synth.Speak([string]$req.text)
    $synth.SetOutputToNull()
    # Written by hand: base64 needs no escaping, and a long sentence is close to a megabyte of it.
    $out.WriteLine('{"id":' + [int]$id + ',"rate":${SAPI_RATE},"pcm":"' + [Convert]::ToBase64String($ms.ToArray()) + '"}'); $out.Flush()
    $ms.Dispose()
  } catch {
    Emit @{ id = $id; error = $_.Exception.Message }
  }
}
`;

const ascii = (json) => json.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** What a plain voice is given: the Fish Audio voice cues ("[chuckling]", "[warm and curious]") would be read out. */
export const plain = (text) => String(text ?? '').replace(/\[[^\]\n]{1,48}\]/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/\s+/g, ' ').trim();

/**
 * Windows' voices. speak(text, { voice, gender, rate }) → { rate, pcm } (a Buffer of 16-bit mono samples);
 * voices() → [{ name, gender, lang }]; warm() starts the helper early; stop() ends it.
 * The helper starts on first use and is closed after a while unused (it restarts in a second or two).
 */
export function createSapi({ spawnImpl = spawn, command = 'powershell.exe', startTimeout = 20000, speakTimeout = 30000, idle = 10 * 60_000, log = () => {} } = {}) {
  let proc = null, ready = null, buf = '', seq = 0, list = [], idleTimer = null;
  const waiting = new Map(); // request id → { resolve, reject, timer }

  const failAll = (err) => {
    for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(err); }
    waiting.clear();
  };
  const stop = () => {
    clearTimeout(idleTimer);
    const p = proc;
    proc = null; ready = null; buf = '';
    if (p) { try { p.stdin.end(); } catch { /* gone */ } try { p.kill(); } catch { /* gone */ } }
    failAll(new Error('The voice on this PC was stopped'));
  };
  const rest = () => { clearTimeout(idleTimer); if (idle > 0) { idleTimer = setTimeout(() => { if (!waiting.size) stop(); }, idle); idleTimer.unref?.(); } };

  function start() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      let p;
      try {
        p = spawnImpl(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SAPI_SCRIPT, 'utf16le').toString('base64')],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) {
        queueMicrotask(() => { if (!proc) ready = null; }); // `ready` is only assigned once this function returns
        return reject(new Error(`Couldn't start the voice on this PC (${e.message})`));
      }
      proc = p;
      let up = false, errOut = '';
      const timer = setTimeout(() => { if (!up) { gone(new Error('The voice on this PC took too long to start')); try { p.kill(); } catch { /* gone */ } } }, startTimeout);
      const gone = (err) => {
        clearTimeout(timer);
        if (proc === p) { proc = null; ready = null; buf = ''; }
        if (!up) reject(err);
        failAll(err);
      };
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (chunk) => {
        if (proc !== p) return;
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/^﻿/, '').trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          if (m.ready) {
            up = true; clearTimeout(timer);
            list = (Array.isArray(m.voices) ? m.voices : m.voices ? [m.voices] : []).filter((v) => v && typeof v.name === 'string').map((v) => ({ name: v.name, gender: String(v.gender ?? ''), lang: String(v.lang ?? '') }));
            log('local_voice', { phase: 'ready', voices: list.length });
            resolve();
            continue;
          }
          const w = waiting.get(m.id);
          if (!w) continue;
          waiting.delete(m.id); clearTimeout(w.timer);
          if (m.error || typeof m.pcm !== 'string') w.reject(new Error(`The voice on this PC failed${m.error ? ` (${String(m.error).slice(0, 160)})` : ''}`));
          else w.resolve({ rate: Number(m.rate) || SAPI_RATE, pcm: Buffer.from(m.pcm, 'base64') });
        }
      });
      p.stderr?.on('data', (d) => { errOut = (errOut + d).slice(-400); });
      p.stdin.on('error', () => {}); // a write after it died is reported by its exit
      p.on('error', (e) => gone(new Error(`Couldn't start the voice on this PC (${e.code === 'ENOENT' ? 'PowerShell was not found' : e.message})`)));
      p.on('exit', () => gone(new Error(`The voice on this PC stopped${errOut.trim() ? ` (${errOut.trim().replace(/\s+/g, ' ').slice(0, 200)})` : ''}`)));
    });
    ready.catch(() => {});
    return ready;
  }

  return {
    warm() { start().then(rest, () => {}); },
    async voices() { await start(); rest(); return list; },
    async speak(text, { voice = '', gender = '', rate = 0, signal } = {}) {
      await start();
      if (signal?.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' });
      const p = proc;
      if (!p) throw new Error('The voice on this PC stopped');
      const id = ++seq;
      clearTimeout(idleTimer);
      return new Promise((resolve, reject) => {
        const done = (f) => (v) => { signal?.removeEventListener('abort', onAbort); if (!waiting.size) rest(); f(v); };
        // A stopped reply: its audio is dropped when it comes back (the helper finishes the sentence anyway).
        const onAbort = () => { const w = waiting.get(id); if (w) { waiting.delete(id); clearTimeout(w.timer); w.reject(Object.assign(new Error('stopped'), { name: 'AbortError' })); } };
        const timer = setTimeout(() => { if (waiting.delete(id)) { done(reject)(new Error('The voice on this PC took too long')); stop(); } }, speakTimeout);
        waiting.set(id, { resolve: done(resolve), reject: done(reject), timer });
        signal?.addEventListener('abort', onAbort, { once: true });
        try { p.stdin.write(`${ascii(JSON.stringify({ id, text, voice, gender, rate }))}\n`); }
        catch (e) { onAbort(); reject(e); }
      });
    },
    stop,
  };
}

/** Only this computer: localhost, 127.x.x.x or [::1], over http or https. Returns the cleaned address, or null.
 *  path: what a bare host gets (the speech-to-text server in ears.mjs has its own). */
export function localAddress(input, path = '/v1/audio/speech') {
  let u;
  try { u = new URL(String(input ?? '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!(host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host))) return null;
  if (u.pathname === '/' || u.pathname === '') u.pathname = path;
  u.hash = '';
  return u.toString();
}

/** A WAV file → { rate, pcm }: 16-bit mono, whatever it came as (8/16/24/32-bit PCM or 32-bit float, any channels). */
export function parseWav(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null, data = null;
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString('latin1', at, at + 4);
    let size = b.readUInt32LE(at + 4);
    const from = at + 8;
    // A WAV that was streamed has no real length for its audio (0 or 0xFFFFFFFF): it runs to the end.
    if (id === 'data' && (size === 0 || from + size > b.length)) size = b.length - from;
    if (id === 'fmt ' && size >= 16) {
      fmt = { format: b.readUInt16LE(from), channels: b.readUInt16LE(from + 2), rate: b.readUInt32LE(from + 4), bits: b.readUInt16LE(from + 14) };
      if (fmt.format === 0xfffe && size >= 26) fmt.format = b.readUInt16LE(from + 24); // "extensible": the real format follows
    } else if (id === 'data') { data = b.subarray(from, from + size); break; }
    at = from + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('a WAV file with no audio in it');
  const { format, channels, rate, bits } = fmt;
  const width = bits >> 3;
  if (!channels || !rate || ![1, 3].includes(format) || ![1, 2, 3, 4].includes(width) || (format === 3 && width !== 4)) throw new Error(`a kind of WAV I can't play (format ${format}, ${bits}-bit)`);
  if (format === 1 && width === 2 && channels === 1) return { rate, pcm: data.subarray(0, data.length - (data.length % 2)) };
  const frames = Math.floor(data.length / (width * channels));
  const pcm = Buffer.alloc(frames * 2);
  const read = format === 3 ? (o) => data.readFloatLE(o)
    : width === 1 ? (o) => (data[o] - 128) / 128
    : width === 2 ? (o) => data.readInt16LE(o) / 32768
    : width === 3 ? (o) => data.readIntLE(o, 3) / 8388608
    : (o) => data.readInt32LE(o) / 2147483648;
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read((i * channels + c) * width);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((sum / channels) * 32767))), i * 2);
  }
  return { rate, pcm };
}

/** A speech server on this computer, asked the way OpenAI's /v1/audio/speech is. */
export function createServerVoice({ url, voice = '', model = 'tts-1', fetchImpl = fetch, timeout = 90_000 }) {
  return {
    warm() {},
    async speak(text, { signal } = {}) {
      const stopAt = AbortSignal.timeout(timeout);
      let r;
      try {
        r = await fetchImpl(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: text, ...(voice ? { voice } : {}), response_format: 'wav' }),
          signal: signal ? AbortSignal.any([signal, stopAt]) : stopAt,
        });
      } catch (e) {
        if (signal?.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' });
        throw new Error(stopAt.aborted ? 'The voice server took too long' : "Couldn't reach the voice server. Is it running?");
      }
      if (!r.ok) {
        const said = (await r.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160);
        throw new Error(`The voice server said no (${r.status}${said ? `: ${said}` : ''})`);
      }
      try { return parseWav(Buffer.from(await r.arrayBuffer())); }
      catch (e) { throw new Error(`The voice server sent ${e.message}`); }
    },
    stop() {},
  };
}

/**
 * One reply's voice, made on this computer. Same shape as FishVoice: say() as often as needed, then end();
 * abort() stops at once, silently. Sentences are made one after another, each handed over in short pieces so
 * stopping is quick. onAudio(Uint8Array, rate); onEnd() once after the last audio; onError(err) instead when it
 * fails (err.heard: whether any audio had gone out).
 * engines: tried in order for each sentence; one that fails is dropped for the rest of this reply.
 */
export class LocalVoice {
  constructor({ engines, voice = '', gender = '', rate = 0, onAudio, onEnd, onError, onFallback, piece = 0.25 }) {
    Object.assign(this, { engines: engines.filter(Boolean), voice, gender, rate, onAudio, onEnd, onError, onFallback, piece });
    this.queue = [];
    this.state = 'open'; // open → ending → done
    this.busy = false;
    this.heard = false;
    this.said = 0;
    this.ac = new AbortController();
  }

  open() { this.engines[0]?.warm?.(); return this; }

  say(text) {
    if (this.state !== 'open') return;
    const t = plain(text);
    if (!t || !/[\p{L}\p{N}]/u.test(t)) return;
    this.said++;
    this.queue.push(t);
    this.pump();
  }

  end() {
    if (this.state !== 'open') return;
    this.state = 'ending';
    if (!this.busy && !this.queue.length) this.finish();
  }

  abort() { this.close(); }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length && this.state !== 'done') {
      const text = this.queue.shift();
      let audio = null;
      while (!audio && this.state !== 'done') {
        const engine = this.engines[0];
        if (!engine) return this.fail(new Error('No voice on this computer is working'));
        try { audio = await engine.speak(text, { voice: this.voice, gender: this.gender, rate: this.rate, signal: this.ac.signal }); }
        catch (e) {
          if (this.state === 'done') return;
          // The next way of speaking takes over (the server is off: Windows' own voice), or it ends here.
          if (this.engines.length > 1) { this.engines.shift(); this.onFallback?.(e); continue; }
          return this.fail(e);
        }
      }
      if (this.state === 'done') return;
      const { pcm, rate } = audio;
      const step = Math.max(2, Math.floor(rate * this.piece) * 2);
      for (let at = 0; at < pcm.length && this.state !== 'done'; at += step) {
        this.heard = true;
        this.onAudio?.(pcm.subarray(at, Math.min(pcm.length, at + step)), rate);
      }
    }
    this.busy = false;
    if (this.state === 'ending') this.finish();
  }

  close() {
    if (this.state === 'done') return;
    this.state = 'done';
    this.queue.length = 0;
    this.ac.abort();
  }

  finish() { if (this.state === 'done') return; this.close(); this.onEnd?.(); }

  fail(err) {
    if (this.state === 'done') return;
    this.close();
    err.heard = this.heard;
    this.onError?.(err);
  }
}
