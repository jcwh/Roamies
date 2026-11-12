// A speech server on this computer for listening (speech to text), for accents the built-in model mishears: a
// Whisper tuned for Singapore English, for example (tools/local-ears has one ready to run). It's asked the way
// OpenAI's /v1/audio/transcriptions is. The voice helper sends it each finished take (voice-win/src/remote.rs) and
// falls back to the built-in model when it's off; this side checks an address before it's saved and writes it where
// the helper reads it: the first line of speech-server.txt, beside the model folder.
import fs from 'node:fs/promises';
import path from 'node:path';
import { localAddress } from './localvoice.mjs';

export const SETTING = 'speech-server.txt';
export const DEFAULT_PATH = '/v1/audio/transcriptions';

/** Plain http to this computer only (the helper has no TLS). Returns the cleaned address, or null. */
export function speechAddress(input) {
  const url = localAddress(input, DEFAULT_PATH);
  return url && url.startsWith('http://') ? url : null;
}

/** Where the helper looks for the address, given the model's folder. */
export const settingFile = (modelDir) => path.join(path.dirname(modelDir), SETTING);

/** Writes the address for the helper, or removes it (url null). The file is the setting as far as the helper goes. */
export async function writeSetting(modelDir, url) {
  const file = settingFile(modelDir);
  if (!url) return fs.rm(file, { force: true });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${url}\n`);
}

/** Silence as a 16 kHz mono 16-bit WAV file, to try a server with. */
export function quietWav(seconds = 1) {
  const n = Math.round(16000 * seconds), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36, 'latin1'); b.writeUInt32LE(n * 2, 40);
  return b;
}

/**
 * Sends a WAV file to the server the way the helper does and returns its text. Throws with a line for the user
 * when it can't be reached, says no, or doesn't answer with {"text": "…"}.
 */
export async function transcribeWith(url, wav, { fetchImpl = fetch, timeout = 60_000 } = {}) {
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('response_format', 'json');
  form.append('language', 'en');
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  const stopAt = AbortSignal.timeout(timeout);
  let r;
  try { r = await fetchImpl(url, { method: 'POST', body: form, headers: { accept: 'application/json' }, signal: stopAt }); }
  catch { throw new Error(stopAt.aborted ? 'The speech server took too long' : "Couldn't reach the speech server. Is it running?"); }
  const body = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`The speech server said no (${r.status}${body.trim() ? `: ${body.replace(/\s+/g, ' ').trim().slice(0, 160)}` : ''})`);
  let text;
  try { text = JSON.parse(body).text; } catch { /* not JSON */ }
  if (typeof text !== 'string') throw new Error("The speech server's answer had no text in it");
  return text.replace(/\s+/g, ' ').trim();
}
