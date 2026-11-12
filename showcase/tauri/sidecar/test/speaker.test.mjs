import assert from 'node:assert/strict';
import { createSpeaker, BEATS, bundledBeats } from '../speaker.mjs';
import { FISH_MODELS } from '../fish.mjs';
import { readFileSync } from 'node:fs';

// A FishVoice stand-in the test drives by hand.
const made = [];
class FakeVoice {
  constructor(o) { Object.assign(this, o); this.said = []; this.ended = false; this.aborted = false; made.push(this); }
  open() { return this; }
  say(s) { this.said.push(s); }
  end() { this.ended = true; }
  abort() { this.aborted = true; }
}
const setup = (acct = { ok: true, credit: 4.5 }, beatPhrases = [], bundled = () => null) => {
  made.length = 0;
  const out = [], problems = [];
  const sp = createSpeaker({ emit: (m) => out.push(m), onProblem: (p) => problems.push(p), FishVoiceImpl: FakeVoice, account: async () => acct, beatPhrases, bundled });
  return { sp, out, problems };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

{ // No key: no voice.
  const { sp } = setup();
  assert.equal(sp.start(), null);
}
{ // Credit → Drama 3; audio goes out as base64 with the reply's id; end marks the end.
  const { sp, out } = setup();
  sp.setKey('k'); await tick();
  assert.equal(sp.model, 'drama-3');
  const r = sp.start();
  assert.deepEqual(out.at(-1), { kind: 'speech', stop: true }, 'a new reply stops whatever was playing');
  r.say('Hi.'); r.end();
  const v = made[0];
  assert.equal(v.model, 'drama-3'); assert.deepEqual(v.said, ['Hi.']); assert.ok(v.ended);
  v.onAudio(new Uint8Array([1, 0, 2, 0]));
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, rate: 44100, pcm: Buffer.from([1, 0, 2, 0]).toString('base64') });
  v.onEnd();
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, end: true, chars: 3 }, 'a whole reply says how much it said');
}
{ // No credit → the free model.
  const { sp } = setup({ ok: true, credit: 0 });
  sp.setKey('k'); await tick();
  assert.equal(sp.model, 's2.1-pro-free');
}
{ // Fails before any audio → retried once on the free model with everything said so far, and ended again.
  const { sp, out, problems } = setup({ ok: true, credit: 0 });
  sp.setKey('k');
  const r = sp.start(); // started before the account check finished: still on production
  r.say('One.'); r.say('Two.'); r.end();
  await made[0].onError(Object.assign(new Error('Could not reach Fish Audio'), { heard: false }));
  assert.equal(made.length, 2); assert.equal(made[1].model, 's2.1-pro-free');
  assert.deepEqual(made[1].said, ['One.', 'Two.']); assert.ok(made[1].ended);
  made[1].onAudio(new Uint8Array([0, 0])); made[1].onEnd();
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, end: true, chars: 9 }); assert.deepEqual(problems, []);
}
{ // A bad key: no retry, one problem report, the reply ends (text stays).
  const { sp, out, problems } = setup({ ok: false, reason: 'key' });
  sp.setKey('bad');
  const r = sp.start(); r.say('Hi.');
  await made[0].onError(Object.assign(new Error('Could not reach Fish Audio'), { heard: false }));
  assert.equal(made.length, 1); assert.deepEqual(problems, ['key']);
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, end: true });
}
{ // Fails after audio started: no retry (it would repeat itself), no problem shown, just ends.
  const { sp, problems, out } = setup();
  sp.setKey('k');
  const r = sp.start(); r.say('Hi.');
  made[0].onAudio(new Uint8Array([0, 0]));
  await made[0].onError(Object.assign(new Error('dropped'), { heard: true }));
  assert.equal(made.length, 1); assert.deepEqual(problems, []);
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, end: true });
}
{ // A new reply aborts the old one; the old one's late audio and end are ignored.
  const { sp, out } = setup();
  sp.setKey('k');
  const a = sp.start(); a.say('Old.');
  const b = sp.start();
  assert.ok(made[0].aborted);
  const n = out.length;
  made[0].onAudio(new Uint8Array([0, 0])); made[0].onEnd();
  assert.equal(out.length, n, 'nothing from the stopped reply');
  b.say('New.'); assert.deepEqual(made[1].said, ['New.']);
}
{ // stop() (Stop, barge-in): aborts and tells the overlay to go quiet.
  const { sp, out } = setup();
  sp.setKey('k');
  sp.start().say('Hi.');
  sp.stop();
  assert.ok(made[0].aborted); assert.deepEqual(out.at(-1), { kind: 'speech', stop: true });
}
{ // Beats are made once in the voice; a slow tool with nothing said plays one instantly, only once per reply.
  const { sp, out } = setup(undefined, BEATS);
  sp.setKey('k'); await tick();
  for (let i = 0; i < BEATS.length; i++) { const w = made.at(-1); assert.deepEqual(w.said, [BEATS[i]]); w.onAudio(new Uint8Array([i, 0])); w.onEnd(); await tick(); await tick(); }
  assert.equal(sp.ready, BEATS.length);
  const r = sp.start(), n = made.length;
  assert.equal(r.beat(), true);
  const played = out.at(-1);
  assert.deepEqual({ ...played, pcm: undefined }, { kind: 'speech', id: r.id, rate: 44100, pcm: undefined });
  assert.ok(BEATS.some((_, i) => played.pcm === Buffer.from([i, 0]).toString('base64')), 'one of the made beats');
  assert.equal(made.length, n, 'no extra socket for the beat');
  assert.deepEqual(made.at(-1).said, [], 'the beat came from the cache, not the live socket');
  assert.equal(r.beat(), false, 'once per reply');
  const r2 = sp.start(); r2.say('Already talking.');
  assert.equal(r2.beat(), false, 'not when it already said something');
}
{ // No beats made yet (or making them failed): the beat is spoken live instead.
  const { sp } = setup(undefined, BEATS);
  sp.setKey('k');
  const r = sp.start(); const live = made.at(-1);
  assert.equal(r.beat(), true);
  assert.ok(BEATS.includes(live.said[0]));
}
{ // Drama 3 fails before any audio with credit left → S2.1 Pro, and the one that worked is kept for the next reply.
  const { sp, problems } = setup();
  sp.setKey('k'); await tick();
  const r = sp.start(); r.say('Hi.'); r.end();
  const v = made.slice(made.length - 1); // this reply's sockets (an earlier test's beat warm-up can add to made)
  await v[0].onError(Object.assign(new Error('Fish Audio closed the connection'), { heard: false }));
  v.push(made.at(-1));
  assert.equal(v[0].model, 'drama-3'); assert.equal(v[1].model, 's2.1-pro'); assert.deepEqual(v[1].said, ['Hi.']);
  v[1].onAudio(new Uint8Array([0, 0])); v[1].onEnd();
  assert.equal(sp.model, 's2.1-pro'); assert.deepEqual(problems, []);
  sp.start(); assert.equal(made.at(-1).model, 's2.1-pro');
}
{ // Every model fails before audio → tried once on each, then one problem report.
  const { sp, problems } = setup();
  sp.setKey('k'); await tick();
  sp.start().say('Hi.');
  const v = [made.at(-1)];
  for (let i = 0; i < 3; i++) { await v[i].onError(Object.assign(new Error('Could not reach Fish Audio'), { heard: false })); if (i < 2) v.push(made.at(-1)); }
  assert.deepEqual(v.map((x) => x.model), ['drama-3', 's2.1-pro', 's2.1-pro-free']);
  assert.equal(made.at(-1), v[2], 'no fourth try');
  assert.deepEqual(problems, ['Could not reach Fish Audio']);
}
{ // Picking S2.1 Pro: replies use it, and a failure falls back to the free tier, never up to the pricier Drama 3.
  const { sp, problems } = setup();
  sp.setModel('s2.1-pro');
  sp.setKey('k'); await tick();
  assert.equal(sp.pick, 's2.1-pro');
  sp.start().say('Hi.');
  const v = [made.at(-1)];
  assert.equal(v[0].model, 's2.1-pro');
  for (let i = 0; i < 2; i++) { await v[i].onError(Object.assign(new Error('Could not reach Fish Audio'), { heard: false })); if (i < 1) v.push(made.at(-1)); }
  assert.deepEqual(v.map((x) => x.model), ['s2.1-pro', 's2.1-pro-free']);
  assert.equal(made.at(-1), v[1], 'no third try, and never Drama 3');
  assert.deepEqual(problems, ['Could not reach Fish Audio']);
}
{ // Switching the pick: the next reply uses it; no credit keeps it on the free tier; only real choices count.
  const { sp } = setup({ ok: true, credit: 0 });
  sp.setKey('k'); await tick();
  sp.setModel('s2.1-pro');
  assert.equal(sp.pick, 's2.1-pro');
  assert.equal(sp.model, 's2.1-pro-free', 'no credit stays free');
  sp.setModel('s2.1-pro-free'); sp.setModel('nope');
  assert.equal(sp.pick, 's2.1-pro', 'the free tier and unknown names are not picks');
  const { sp: sp2 } = setup();
  sp2.setKey('k'); await tick();
  sp2.setModel('s2.1-pro');
  sp2.start(); assert.equal(made.at(-1).model, 's2.1-pro');
  sp2.setModel('drama-3');
  sp2.start(); assert.equal(made.at(-1).model, 'drama-3');
}
console.log('speaker tests: passed');
{ // Voice cues aren't counted as spoken text.
  const { sp, out } = setup();
  sp.setKey('k');
  const r = sp.start(); r.say('[warm] Hello there.'); r.end();
  made.at(-1).onAudio(new Uint8Array([0, 0])); made.at(-1).onEnd();
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, end: true, chars: 12 });
  console.log('speech pacing tests: passed');
}

{ // At least 30 short beats, one or two words each, picked at random with no repeat among the last few.
  assert.ok(BEATS.length >= 30, 'plenty of beats');
  assert.equal(new Set(BEATS).size, BEATS.length, 'no duplicates');
  for (const b of BEATS) assert.ok(b.replace(/[.,!]/g, '').trim().split(/\s+/).length <= 2, `${b} is one or two words`);
  const { sp, out } = setup(undefined, BEATS);
  sp.setKey('k'); await tick();
  for (let i = 0; i < BEATS.length; i++) { const w = made.at(-1); w.onAudio(new Uint8Array([i, 1])); w.onEnd(); await tick(); await tick(); }
  const seen = [];
  for (let i = 0; i < 40; i++) { const r = sp.start(); r.beat(); seen.push(out.at(-1).pcm); r.abort(); }
  for (let i = 0; i < seen.length; i++) assert.ok(!seen.slice(Math.max(0, i - 8), i).includes(seen[i]), 'no repeat within 8');
  assert.ok(new Set(seen).size > 12, 'they vary');
}
console.log('speaker beat variety: passed');

{ // Beats shipped with the app play at their own rate, and none are made over Fish for them.
  const clip = { rate: 24000, pcm: Buffer.from([7, 7]).toString('base64') };
  const { sp, out } = setup(undefined, BEATS, () => new Map(BEATS.map((b) => [b, clip])));
  sp.setKey('k'); await tick(); await tick();
  assert.equal(made.filter((v) => v.said.length).length, 0, 'no beat is recorded at run time');
  const r = sp.start();
  assert.equal(r.beat(), true);
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, rate: 24000, pcm: clip.pcm });
}
{ // Every look's voice has every beat recorded, in both paid models (re-run beats/make.mjs after changing BEATS).
  const side = readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const { DEFAULT_VOICE } = await import('../fish.mjs');
  const voices = [DEFAULT_VOICE, ...[...side.matchAll(/\['\w+', '[^']+', '([0-9a-f]{32})'\]/g)].map((m) => m[1])];
  const get = bundledBeats();
  for (const v of voices) for (const m of FISH_MODELS) {
    const set = get(v, m);
    assert.ok(set, `beats for ${v} on ${m}`);
    for (const b of BEATS) assert.ok(set.get(b)?.pcm.length > 1000, `"${b}" in ${v} on ${m}`);
  }
}
console.log('bundled beats: passed');

// ---- this computer's own voice (no Fish Audio key)
{
  const localMade = [];
  class FakeLocal {
    constructor(o) { Object.assign(this, o); this.said = []; this.ended = false; this.aborted = false; this.opened = false; localMade.push(this); }
    open() { this.opened = true; return this; }
    say(s) { this.said.push(s); }
    end() { this.ended = true; }
    abort() { this.aborted = true; }
  }
  const setupLocal = ({ available = true, acct = { ok: true, credit: 4.5 }, beatPhrases = [] } = {}) => {
    made.length = 0; localMade.length = 0;
    const out = [], problems = [], can = { on: available };
    const sp = createSpeaker({ emit: (m) => out.push(m), onProblem: (p) => problems.push(p), FishVoiceImpl: FakeVoice, account: async () => acct, beatPhrases, bundled: () => null,
      local: { available: () => can.on, make: (on) => new FakeLocal(on) } });
    return { sp, out, problems, can };
  };
  { // No key, and the computer can speak: replies are spoken by it, at the rate its audio comes in.
    const { sp, out } = setupLocal();
    assert.equal(sp.on, true); assert.equal(sp.hasKey, false); assert.equal(sp.local, true); assert.equal(sp.engine, 'auto');
    const r = sp.start();
    assert.ok(r); assert.equal(made.length, 0, 'Fish Audio is not asked'); assert.ok(localMade[0].opened);
    r.say('[warm] Hi there.'); r.say('Bye.'); r.end();
    const v = localMade[0];
    assert.deepEqual(v.said, ['[warm] Hi there.', 'Bye.']); assert.ok(v.ended);
    v.onAudio(new Uint8Array([1, 0, 2, 0]), 22050);
    assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, rate: 22050, pcm: Buffer.from([1, 0, 2, 0]).toString('base64') });
    v.onEnd();
    assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, end: true, chars: 14 }, 'how much it said, without the cue');
  }
  { // No key and no voice of its own: no voice at all, as before.
    const { sp, can } = setupLocal({ available: false });
    assert.equal(sp.on, false); assert.equal(sp.local, false); assert.equal(sp.start(), null);
    can.on = true; // a voice server's address was added
    assert.equal(sp.on, true); assert.ok(sp.start());
  }
  { // A key: Fish Audio speaks unless this computer's voice is picked; picking Fish Audio with no key is silent.
    const { sp } = setupLocal();
    sp.setKey('k'); await tick();
    assert.equal(sp.local, false); assert.equal(sp.hasKey, true);
    sp.start(); assert.equal(made.length, 1); assert.equal(localMade.length, 0);
    sp.setEngine('local');
    assert.equal(sp.local, true);
    sp.start(); assert.equal(localMade.length, 1); assert.ok(made[0].aborted, 'the Fish Audio reply was stopped');
    sp.setEngine('fish');
    sp.start(); assert.equal(made.length, 2);
    sp.setKey(null);
    assert.equal(sp.on, false); assert.equal(sp.start(), null, "Fish Audio was asked for, and there's no key");
    sp.setEngine('auto');
    assert.equal(sp.local, true); assert.ok(sp.start());
    sp.setEngine('nonsense'); assert.equal(sp.engine, 'auto');
  }
  { // A new reply stops the last one; stop() ends it; audio from a stopped reply never goes out.
    const { sp, out } = setupLocal();
    const a = sp.start(), b = sp.start();
    assert.ok(localMade[0].aborted); assert.notEqual(a.id, b.id);
    const n = out.length;
    localMade[0].onAudio(new Uint8Array([1, 0]), 22050); localMade[0].onEnd();
    assert.equal(out.length, n, 'nothing from the stopped reply');
    sp.stop();
    assert.ok(localMade[1].aborted); assert.deepEqual(out.at(-1), { kind: 'speech', stop: true });
  }
  { // A beat is simply said (none are recorded for this voice), once, and only before anything else.
    const { sp } = setupLocal({ beatPhrases: ['One sec.'] });
    const r = sp.start();
    assert.equal(r.beat(), true); assert.deepEqual(localMade[0].said, ['One sec.']);
    assert.equal(r.beat(), false);
    const r2 = sp.start(); r2.say('Already talking.');
    assert.equal(r2.beat(), false);
  }
  { // It fails before any audio: one problem report, and the reply ends (the text stays). After audio: no report.
    const { sp, out, problems } = setupLocal();
    const r = sp.start(); r.say('Hi.');
    localMade[0].onError(Object.assign(new Error("Couldn't reach the voice server. Is it running?"), { heard: false }));
    assert.deepEqual(problems, ["Couldn't reach the voice server. Is it running?"]);
    assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, end: true });
    const r2 = sp.start(); r2.say('Hi.');
    localMade[1].onAudio(new Uint8Array([1, 0]), 24000);
    localMade[1].onError(Object.assign(new Error('gone'), { heard: true }));
    assert.equal(problems.length, 1); assert.deepEqual(out.at(-1), { kind: 'speech', id: r2.id, end: true });
  }
  { // Private mode: Fish Audio is never contacted. This computer's voice speaks if it has one; otherwise replies are text.
    let checks = 0;
    made.length = 0; localMade.length = 0;
    const can = { on: true };
    const sp = createSpeaker({ emit: () => {}, FishVoiceImpl: FakeVoice, account: async () => { checks++; return { ok: true, credit: 5 }; }, beatPhrases: ['One sec.'], bundled: () => null,
      local: { available: () => can.on, make: (on) => new FakeLocal(on) } });
    sp.setEngine('fish'); sp.setCloud(false);
    sp.setKey('k'); await tick();
    assert.equal(checks, 0, 'no account check'); assert.equal(made.length, 0, 'no beats made');
    assert.equal(sp.cloud, false); assert.equal(sp.local, true, "this computer's voice, though Fish Audio was the pick");
    sp.start(); assert.equal(localMade.length, 1); assert.equal(made.length, 0);
    assert.deepEqual(await sp.check(), { ok: false, reason: 'private' });
    can.on = false; // no voice of its own (not Windows, no voice server)
    assert.equal(sp.on, false); assert.equal(sp.start(), null, 'text only, rather than Fish Audio');
    sp.setCloud(true); await tick();
    assert.equal(checks, 1, 'allowed again: the account is checked'); assert.equal(sp.on, true);
    assert.ok(sp.start()); assert.ok(made.length >= 1, 'Fish Audio speaks again');
  }
  console.log('local voice in the speaker: passed');
}
