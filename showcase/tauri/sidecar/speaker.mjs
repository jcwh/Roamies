// Speaks replies with Fish Audio and hands the audio to the overlay ({ kind: 'speech' } messages).
// - The model is the one the user picked (Drama 3 or S2.1 Pro) while the account has credit, the free tier
//   otherwise (checked when the key is set, at start and after a failure). If a reply's voice fails before any
//   audio, it's retried on the next model down from the pick, never a pricier one (Drama 3 → S2.1 Pro → free;
//   S2.1 Pro → free) with everything said so far, and one that works is kept from then on; if it fails after
//   audio, the rest stays text only.
// - Each reply has its own id, so audio from one that was stopped can never play over the next.
// - A voice made on this computer (localvoice.mjs) stands in when it's the one picked, or when there's no Fish Audio
//   key: no account, no model to choose and no ready-made beats (a beat is just said).
// - Beats: when something slow starts (a web search, a page, the screen) and the model hasn't said anything,
//   a short line ("One sec.", "On it." and 32 more, picked at random) plays so it's never silent. They're made once
//   in the voice and kept, so they play instantly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VOICE, FISH_MODELS, FREE_MODEL, FishVoice, RATE, fishAccount } from './fish.mjs';

// One or two words each, so a beat never sounds canned; any of them must fit before a search, a page, the screen or a drawing.
export const BEATS = [
  'One sec.', 'On it.', 'Hang on.', 'Hold on.', 'Got it.', 'Okay.', 'Sure.', 'Right.', 'Alright.', 'Gotcha.',
  'Checking.', "Let's see.", 'Sure thing.', 'Coming up.', 'Sec.', 'One moment.', 'Bear with.', 'Hmm, okay.', 'Got you.', 'Right, sec.',
  'Sure, sec.', 'Okay, sec.', 'Roger.', 'Yep.', 'Yep, sec.', 'Two secs.', 'Hold tight.', 'Mm-hmm.', 'Will do.', 'Righto.',
  'Moment.', 'Okay, checking.', 'Sure, checking.', 'Okie-dokie.',
];
const RECENT = 8; // a beat isn't picked again until this many others have played

// The beats shipped with the app (beats/make.mjs), next to this file or the bundle: (voice, model) → Map of phrase →
// { rate, pcm } (base64), or null for a voice or model not recorded. The free tier uses the S2.1 Pro takes.
export function bundledBeats(dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'beats')) {
  let index = null;
  try { index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { return () => null; }
  const sets = new Map();
  return (voice, model) => {
    const k = `${voice}:${model === FREE_MODEL ? 's2.1-pro' : model}`, set = index.sets?.[k];
    if (!set) return null;
    if (!sets.has(k)) {
      let all = null;
      try { all = fs.readFileSync(path.join(dir, set.file)); } catch {}
      sets.set(k, all && new Map(Object.entries(set.beats).map(([phrase, [at, n]]) => [phrase, { rate: index.rate, pcm: all.subarray(at, at + n).toString('base64') }])));
    }
    return sets.get(k);
  };
}

// local: { available() → whether this computer can speak by itself, make({ onAudio, onEnd, onError }) → a voice
// shaped like FishVoice } or null.
export function createSpeaker({ emit, onProblem = () => {}, log = () => {}, FishVoiceImpl = FishVoice, account = fishAccount, beatPhrases = BEATS, bundled = bundledBeats(), local = null }) {
  let key = null, voice = DEFAULT_VOICE, pref = FISH_MODELS[0], model = pref, seq = 0, current = null, checking = null;
  // Which voice speaks: 'auto' is Fish Audio when there's a key and this computer's voice when there isn't.
  let engine = 'auto';
  const useLocal = () => !!local?.available() && (engine === 'local' || (engine === 'auto' && !key));
  // The pick and the cheaper ones after it (FISH_MODELS runs from priciest to free).
  const chain = () => FISH_MODELS.slice(Math.max(0, FISH_MODELS.indexOf(pref)));
  let beats = new Map(), recent = [], warming = null; // phrase → [base64 PCM chunks], for the current key and voice
  // A random beat, not one of the last few: one that's already made if there is one, so it plays instantly.
  const shipped = () => bundled(voice, model);
  const ready = (p) => beats.has(p) || !!shipped()?.has(p);
  const pickBeat = () => {
    const fresh = beatPhrases.filter((p) => !recent.includes(p));
    const pool = [fresh.filter(ready), beatPhrases.filter(ready), fresh, beatPhrases].find((x) => x.length);
    const phrase = pool?.[Math.floor(Math.random() * pool.length)] ?? BEATS[0];
    recent = [...recent, phrase].slice(-Math.min(RECENT, Math.max(0, beatPhrases.length - 1)));
    return phrase;
  };

  // Make the beats once, one at a time (well under Fish's concurrency limit). Failures just leave a gap:
  // that beat is then spoken live instead.
  function warm() {
    const k = key, vo = voice;
    warming ??= (async () => {
      for (const phrase of beatPhrases) {
        if (key !== k || voice !== vo) break;
        if (beats.has(phrase) || bundled(vo, model)?.has(phrase)) continue; // shipped with the app
        const chunks = await new Promise((done) => {
          const got = [];
          const v = new FishVoiceImpl({ key: k, voice: vo, model, onAudio: (pcm) => got.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')), onEnd: () => done(got), onError: () => done(null) }).open();
          v.say(phrase); v.end();
        });
        if (chunks?.length && key === k && voice === vo) beats.set(phrase, chunks);
      }
    })().finally(() => { warming = null; });
    return warming;
  }

  // Returns the account check: { ok, credit } or { ok: false, reason: 'key' | 'network' }.
  async function check() {
    if (!key) return { ok: false, reason: 'key' };
    checking ??= account(key).then((a) => {
      // No credit: the free tier. Credit again: back to the best model, else keep the paid one that worked.
      if (a.ok) model = a.credit != null && a.credit <= 0.01 ? FREE_MODEL : model === FREE_MODEL ? pref : model;
      log('fish_account', { ok: a.ok, reason: a.reason, model });
      if (a.ok) warm();
      return a;
    }).finally(() => { checking = null; });
    return checking;
  }

  function stopAll() {
    if (current) { current.abort(); current = null; }
    emit({ kind: 'speech', stop: true });
  }

  /** A reply spoken by this computer's own voice. Same handle as start() gives. */
  function startLocal() {
    stopAll();
    const id = `s${++seq}`, said = [], t0 = Date.now();
    let ended = false, heard = false, done = false, beat = false;
    const finish = (whole = false) => {
      if (done) return;
      done = true;
      const chars = whole && heard ? said.join(' ').replace(/\[[^\]]*\]\s*/g, '').length : 0;
      emit({ kind: 'speech', id, end: true, ...(chars ? { chars } : {}) });
      if (current === me) current = null;
    };
    const v = local.make({
      onAudio: (pcm, rate) => {
        if (done) return;
        if (!heard) { heard = true; log('speech_first_audio', { id, model: 'local', ms: Date.now() - t0 }); }
        emit({ kind: 'speech', id, rate: rate || RATE, pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') });
      },
      onEnd: () => finish(true),
      onError: (err) => {
        if (done) return;
        log('speech_error', { id, model: 'local', heard, message: err.message });
        if (!heard) onProblem(err.message);
        finish();
      },
    }).open();
    const me = {
      id,
      say(s) { if (done) return; said.push(s); v.say(s); },
      beat() { if (done || beat || said.length || heard) return false; beat = true; me.say(pickBeat()); return true; },
      end() { if (done || ended) return; ended = true; v.end(); },
      abort() { if (done) return; done = true; v.abort(); if (current === me) current = null; },
    };
    log('speech_start', { id, model: 'local' });
    current = me;
    return me;
  }

  /** A new reply's voice, its socket opening now. say(sentence) as they come, then end(). */
  function start() {
    if (useLocal()) return startLocal();
    if (!key) return null;
    stopAll();
    const id = `s${++seq}`, said = [];
    let ended = false, tries = 0, v = null, heard = false, done = false, beat = false, t0 = Date.now();
    const me = {
      id,
      say(s) { if (done) return; said.push(s); v.say(s); },
      /** Something slow is starting: a short beat, unless it's already said something. */
      beat() {
        if (done || beat || said.length || heard) return false;
        beat = true;
        const phrase = pickBeat(), shippedBeat = shipped()?.get(phrase), chunks = beats.get(phrase);
        if (!shippedBeat && !chunks) { me.say(phrase); return true; }
        log('speech_beat', { id, ms: Date.now() - t0 });
        if (shippedBeat) emit({ kind: 'speech', id, rate: shippedBeat.rate, pcm: shippedBeat.pcm });
        else for (const pcm of chunks) emit({ kind: 'speech', id, rate: RATE, pcm });
        return true;
      },
      end() { if (done || ended) return; ended = true; v.end(); },
      abort() { if (done) return; done = true; v?.abort(); if (current === me) current = null; },
    };
    // A reply that played to its end also says how much it said (without the voice cues), so the overlay can learn
    // how fast the voice talks and pace drawings to it.
    const finish = (whole = false) => {
      if (done) return;
      done = true;
      const chars = whole && heard ? said.join(' ').replace(/\[[^\]]*\]\s*/g, '').length : 0;
      emit({ kind: 'speech', id, end: true, ...(chars ? { chars } : {}) });
      if (current === me) current = null;
    };
    const connect = (m) => {
      tries++;
      v = new FishVoiceImpl({
        key, voice, model: m,
        onAudio: (pcm) => {
          if (done) return;
          if (!heard) { heard = true; if (m !== model) model = m; log('speech_first_audio', { id, model: m, ms: Date.now() - t0 }); }
          emit({ kind: 'speech', id, rate: RATE, pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') });
        },
        onEnd: () => finish(true),
        onError: async (err) => {
          if (done) return;
          log('speech_error', { id, model: m, heard: err.heard, message: err.message });
          if (!err.heard && !heard && tries < chain().length) {
            const a = await check();
            if (done) return;
            if (!a.ok && a.reason === 'key') { onProblem('key'); return finish(); }
            // Retry: the free tier when there's no credit, else the next model down (the free one again once at the bottom).
            const c = chain();
            const next = a.ok && model === FREE_MODEL ? FREE_MODEL : c[Math.min(c.indexOf(m) + 1, c.length - 1)];
            connect(next);
            for (const s of said) v.say(s);
            if (ended) v.end();
            return;
          }
          if (!heard) onProblem(err.message);
          finish();
        },
      }).open();
    };
    log('speech_start', { id, model });
    connect(model);
    current = me;
    return me;
  }

  return {
    setKey(k) { if ((k || null) !== key) { beats = new Map(); if (!k) stopAll(); } key = k || null; if (key) check(); },
    // The user's pick. Beats are remade in it; with no credit it stays on the free tier until there is some.
    setModel(m) {
      if (!FISH_MODELS.includes(m) || m === FREE_MODEL || m === pref) return;
      pref = m; beats = new Map();
      if (model !== FREE_MODEL) model = m;
      if (key) warm();
    },
    get pick() { return pref; },
    setVoice(v) { if ((v || DEFAULT_VOICE) !== voice) beats = new Map(); voice = v || DEFAULT_VOICE; if (key) warm(); },
    get ready() { return beats.size + beatPhrases.filter((p) => !beats.has(p) && shipped()?.has(p)).length; },
    get model() { return model; },
    // 'auto', 'fish' or 'local'. A reply already being spoken finishes in the voice it started in.
    setEngine(e) { if (['auto', 'fish', 'local'].includes(e) && e !== engine) { engine = e; stopAll(); } },
    get engine() { return engine; },
    /** Whether the next reply is spoken by this computer's own voice. */
    get local() { return useLocal(); },
    get hasKey() { return !!key; },
    get on() { return useLocal() || !!key; },
    check,
    start,
    stop: stopAll,
  };
}
