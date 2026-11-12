import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The system prompt is template literals in sidekick.mjs: an expression wrapped in a string (${"${x}"}) would reach
// the model as raw code instead of its value.
const side = readFileSync(fileURLToPath(new URL('../sidekick.mjs', import.meta.url)), 'utf8');
const quoted = side.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\$\{\s*["'`][^"'`]*\$\{/.test(l));
assert.deepEqual(quoted.map(([n]) => n), [], 'a ${…} inside a quoted string in a template literal is sent as text');
// Pointing is the draw tool now: the prompt never names the old tool.
assert.ok(!/point_at/.test(side), 'no point_at left in the prompt');
assert.match(side, /with draw/, 'the prompt says when to draw');
// Saving a reminder shows the reminders card by itself: the prompt and the draw tool say not to draw it again.
const tools = readFileSync(fileURLToPath(new URL('../tools.mjs', import.meta.url)), 'utf8');
assert.match(side, /remember_commitment[^\n]*shows their reminders list on screen by itself, so don't also draw a list or note/, 'the memory line says saved items show by themselves');
assert.match(tools, /remember_commitment or update_commitment already show on their reminders list by themselves: never draw a list or note of them/, 'the draw tool says saved items are not drawn again');
// Regression: every web search opened the card, because web answers always came as points plus sources. A quick fact
// is just said; the card is only for answers that break down into points.
assert.match(side, /An answer from the web is said like any other: a quick fact[^\n]*no points and no sources\. Only when the answer is genuinely a list/, 'web answers are spoken unless they are a list');
const host = readFileSync(fileURLToPath(new URL('../../../roamies/host.js', import.meta.url)), 'utf8');
const webCase = host.slice(host.indexOf("if (e.anim.tool === 'web')"), host.indexOf('jobs.push', host.indexOf("if (e.anim.tool === 'web')")));
assert.ok(webCase && !/panel\(\)\?\.open/.test(webCase), 'a web lookup does not open the card by itself');
// Regression: "how are you? draw something" drew first and said "I'm doing great" only after it, and the drawing's
// silent write held up the first words. The prompt asks for a short line before draw.
assert.match(side, /Before you call draw, write one short line first: the answer to anything they said or asked besides the drawing/, 'a line comes before the drawing');
// Knowing when to draw: the prompt picks a card by the kind of question, and says what stays plain speech.
const show = side.split('\n').find((l) => l.startsWith("Show, don't just tell."));
for (const [ask, card] of [['How something works or happens', /a model with moving parts for a physical thing[^.]*; a flow for a process/], ['Comparing two or more things', /table/], ['How many, how much', /bars \(graph for a curve/], ['Where a place is', /map/], ['When, in what order', /timeline/],
  ['Solving or working out maths', /math, a step per line \(geometry for a figure/], ['The parts of a thing', /see_photo, then a photo with labels/], ['"Test me" or "quiz me"', /quiz/]]) {
  const at = show.indexOf(ask);
  assert.ok(at >= 0, `the prompt covers: ${ask}`);
  assert.match(show.slice(at, at + 260), card, `${ask}: names its card`);
}
assert.match(show, /draw it without being asked/, 'explaining draws by itself');
assert.match(show, /Don't draw for a quick fact[^.]*, an opinion or advice, small talk, a yes or no, anything they asked for in one line or one sentence, or when they say not to: those are just said\./, 'what stays plain speech');
// Regression: the voice style said explanations are "spoken, not put on screen", which argued against drawing them.
assert.ok(!/an explanation, advice\) is spoken, not put on screen/.test(side), 'the voice style no longer keeps explanations off the screen');
assert.match(side, /An explanation is spoken too, in a few sentences, with a drawing beside it when a picture carries it/, 'spoken replies explain out loud and draw');
// Regression: "how tall are the five tallest mountains" came back as "- " points two runs in three, because the
// reply style's list card won over the drawing. Both styles now send those answers to draw.
assert.equal(side.split('Amounts, a comparison, a place, dates, a process and maths are drawn, not listed: for those use draw').length, 3, 'the bubble style and the voice style both hand lists that draw better to draw');
assert.match(show, /quiz \(they answer by clicking and you're told how they did with their next message, so never ask them to tell you their answers or score\)/, 'a quiz never asks for the score');
// Regression: counting out-of-stock items over three pages, the reply led with "4" and then named five, because the
// number was written before anything was counted. Per-page counts as it goes keep the total right.
assert.match(side, /A count or total gathered over several pages, files or results: note each one's count in a few words as you go[^\n]*check the total you lead with against the items you then name\./, 'totals are tallied before they are stated');
// The draw tool spells out every card it can make, and that labels need a look at the picture first.
const drawText = tools.slice(tools.indexOf("name: 'draw',"), tools.indexOf("name: 'see_photo'"));
for (const k of ['bars (bars [{label, value, tone}], unit)', 'table (columns [headings], rows [[one cell per column]]', 'flow (nodes [{id, text, shape: box|round|diamond, tone}], links [{from, to, label, flow}]', 'map (region:', 'math (steps [{tex, note}])',
  'geometry (vertices [{id, x, y}]', 'quiz (questions [{text, options: 2 to 4, answer: the right option word for word, explain}]', 'motion {do: spin|orbit|slide|pulse', 'labels [{text, x, y}]'])
  assert.ok(drawText.includes(k), `the draw tool describes: ${k}`);
assert.match(drawText, /only after see_photo has shown you that same picture/, 'labels come after a look');
// A quiz answered on screen reaches the model with the next message, once, and never from an older conversation.
assert.match(side, /m\.type === 'quiz_done'\) onQuizDone\(/, 'the overlay reports a finished quiz');
assert.match(side, /const quiz = takeQuizNote\(\);\s*const stamped = `\[\$\{stampNow\(\)\}\] \$\{text\}\$\{quiz \? `\\n\(\$\{quiz\}\)` : ''\}`;/, 'the score rides along with their next message');
assert.match(side, /newSession\(config\.provider, config\.model\); liveBlocks\.clear\(\); agent = null; pendingFold = null; lastInput = null; quizDone = null;/, 'a new conversation drops it');
console.log('prompt tests: passed');

// This computer's own voice reads the words as written: its style swaps the voice cues for a line saying not to write any.
assert.match(side, /const VOICE_STYLE = \(\) => `You talk out loud:/, 'the spoken style is worked out for the voice in use');
assert.match(side, /\n\$\{speech\.local \? PLAIN_VOICE : ACTED_VOICE\}\nBefore anything slow/, 'a plain voice gets no cue instructions');
assert.match(side, /const PLAIN_VOICE = `[^`]*never write cues in square brackets/, 'a plain voice is told not to write cues');
assert.match(side, /const ACTED_VOICE = `Your voice carries feeling: start a sentence with a cue in square brackets/, "Fish Audio's voices keep their cues");
assert.match(side, /const replyStyle = \(\) => \(VOICE_ON\(\) \? VOICE_STYLE\(\) : TEXT_STYLE\);/);
console.log('prompt: the plain voice has its own style');
