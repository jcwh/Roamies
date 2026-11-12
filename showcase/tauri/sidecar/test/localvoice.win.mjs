// The real thing, on a real Windows machine: starts the PowerShell helper, lists Windows' voices and has one say a
// sentence (to memory, not the speakers). CI runs it on the Windows runner; anywhere else it says so and passes.
//   node test/localvoice.win.mjs [--play out.wav]   --play also writes what was said to a WAV file to listen to.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LocalVoice, SAPI_RATE, createSapi } from '../localvoice.mjs';

if (process.platform !== 'win32') { console.log('local voice on Windows: skipped (not Windows)'); process.exit(0); }

const sapi = createSapi({ idle: 0 });
const t0 = Date.now();
const voices = await sapi.voices();
console.log(`helper ready in ${Date.now() - t0} ms; voices: ${voices.map((v) => `${v.name} (${v.gender}, ${v.lang})`).join(', ') || 'none'}`);
assert.ok(voices.length > 0, 'Windows has at least one voice installed');
assert.ok(voices.every((v) => v.name && v.gender && v.lang));

// One sentence, with characters outside ASCII, in the first voice by name.
const t1 = Date.now();
const one = await sapi.speak('Hello from Roamies. Café, déjà vu.', { voice: voices[0].name });
console.log(`a sentence: ${(one.pcm.length / 2 / one.rate).toFixed(2)} s of audio, made in ${Date.now() - t1} ms`);
assert.equal(one.rate, SAPI_RATE);
assert.ok(one.pcm.length > SAPI_RATE, 'more than half a second of audio');
assert.equal(one.pcm.length % 2, 0);
let peak = 0;
for (let i = 0; i < one.pcm.length; i += 2) peak = Math.max(peak, Math.abs(one.pcm.readInt16LE(i)));
assert.ok(peak > 1000, `it isn't silence (peak ${peak})`);

// A whole reply through LocalVoice, the way the app uses it: by gender, cues dropped, in pieces, then the end.
const got = [];
await new Promise((resolve, reject) => {
  const v = new LocalVoice({ engines: [sapi], gender: 'Female', onAudio: (pcm, rate) => got.push({ rate, pcm: Buffer.from(pcm) }), onEnd: resolve, onError: reject }).open();
  v.say('[warm] This is how I sound.'); v.say('Two sentences, one after the other.'); v.end();
});
const all = Buffer.concat(got.map((g) => g.pcm));
console.log(`a reply: ${got.length} pieces, ${(all.length / 2 / SAPI_RATE).toFixed(2)} s`);
assert.ok(got.length > 4 && got.every((g) => g.rate === SAPI_RATE && g.pcm.length <= SAPI_RATE * 0.25 * 2 + 2));
assert.ok(all.length > SAPI_RATE * 2, 'more than a second of audio');

// A voice that isn't installed falls back to the current one instead of failing.
assert.ok((await sapi.speak('Still here.', { voice: 'No Such Voice 9000' })).pcm.length > 0);

const at = process.argv.indexOf('--play');
if (at > 0 && process.argv[at + 1]) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + all.length, 4); h.write('WAVEfmt ', 8, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAPI_RATE, 24); h.writeUInt32LE(SAPI_RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36, 'latin1'); h.writeUInt32LE(all.length, 40);
  fs.writeFileSync(process.argv[at + 1], Buffer.concat([h, all]));
  console.log(`wrote ${process.argv[at + 1]}`);
}
sapi.stop();
console.log('local voice on Windows: passed');
