// AI that runs on this computer (Ollama), and private mode: nothing Roamies does leaves the computer.
//
// Local models: the engine (gg-core) already knows how to find Ollama's models and talk to them; this file asks it
// to, leaves out the ones that can't work here (no tool calling, or "cloud" models that Ollama relays to its own
// servers), and checks how much the model can hold at once, since Ollama gives a model only a small context
// window unless told otherwise and Roamies' instructions alone don't fit in that.
//
// Private mode: only a model on this computer answers, only this computer's voice speaks, and the ways out to the
// internet are shut: Roamies' own web requests (guardFetch), the fetch_url tool, links in the open tool, and
// commands that reach the network (networkCommand). It's a guard on what Roamies does, not a firewall for the PC.
//
// gg-core's functions are passed in (`core`), so this file's logic is tested without the engine or a server.

export const LOCAL = 'local';
export const OLLAMA = { id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', kind: 'ollama' };
export const OLLAMA_ROOT = 'http://127.0.0.1:11434';
// Roamies' instructions and tools take several thousand tokens before the conversation starts.
export const MIN_CONTEXT = 16_000;
export const GOOD_CONTEXT = 32_768;

/** Ollama's "cloud" models run on Ollama's servers, not here: "gemma4:cloud", "qwen3.5:31b-cloud". */
export const isCloudModel = (rawId) => /(?:^|[:\-_])cloud$/i.test(String(rawId ?? ''));

/** The models Ollama relays to a remote host, by name, from its own list (/api/tags). Never throws. */
export async function remoteModels({ fetchImpl = fetch, root = OLLAMA_ROOT, timeout = 1500 } = {}) {
  try {
    const r = await fetchImpl(`${root}/api/tags`, { signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json' } });
    if (!r.ok) return new Set();
    const list = (await r.json())?.models;
    return new Set((Array.isArray(list) ? list : []).filter((m) => m && (m.remote_host || m.remote_model)).flatMap((m) => [m.name, m.model]).filter((n) => typeof n === 'string'));
  } catch { return new Set(); }
}

/**
 * Looks for Ollama and lists what it can run here. Registers the usable models with the engine and keeps the
 * endpoint's credential in step (stored only while Ollama answers, as GG Coder does).
 * Returns { reachable, reason, models: [{ id, rawId, tools, images, thinking, context, contextKnown }] }: every
 * model on this computer, the ones without tool calling included (shown, not pickable).
 */
export async function scanLocal({ core, auth, fetchImpl = fetch, force = false, known = new Map() }) {
  let probe;
  try { probe = (await core.discoverLocalModels([OLLAMA], { force })).probes[0]; }
  catch (e) { probe = { endpoint: OLLAMA, reachable: false, reason: String(e?.message ?? e), models: [] }; }
  const remote = probe.reachable ? await remoteModels({ fetchImpl }) : new Set();
  const here = probe.models.filter((m) => !isCloudModel(m.rawId) && !remote.has(m.rawId))
    // A context size learned by loading the model (learnContext) outlives a rescan that can't see it.
    .map((m) => { const k = known.get(m.rawId); return k && !m.contextWindowKnown ? { ...m, contextWindow: k, contextWindowKnown: true } : m; });
  core.clearRuntimeModels((m) => m.provider === LOCAL);
  core.registerRuntimeModels(here.filter((m) => m.supportsTools).map((m) => core.toModelInfo(m, probe.endpoint)));
  try { if (probe.reachable) await auth.setLocalEndpoint(OLLAMA.id, OLLAMA.baseUrl); else await auth.removeLocalEndpoint(OLLAMA.id); }
  catch { /* the sign-in file couldn't be written: the model list still shows, picking one will say why it can't run */ }
  return {
    reachable: !!probe.reachable,
    reason: probe.reachable ? '' : String(probe.reason ?? 'Not running'),
    models: here.map((m) => ({
      id: core.formatLocalModelId(OLLAMA.id, m.rawId), rawId: m.rawId, tools: !!m.supportsTools, images: !!m.supportsImages, thinking: !!m.supportsThinking,
      context: m.contextWindow, contextKnown: !!m.contextWindowKnown,
    })),
  };
}

/**
 * Loads the model the way a request would and reads the context window Ollama really gives it, then tells the
 * engine. Returns the size, or undefined when Ollama didn't say. `state` is scanLocal's result, updated in place.
 */
export async function learnContext({ core, state, id, known = new Map(), timeoutMs = 180_000, signal }) {
  const parsed = core.parseLocalModelId(id);
  const model = parsed && state.models.find((m) => m.rawId === parsed.rawId);
  if (!model) return undefined;
  const served = await core.ollamaServedContext(OLLAMA, parsed.rawId, { load: true, timeoutMs, signal });
  if (!served) return undefined;
  known.set(parsed.rawId, served);
  Object.assign(model, { context: served, contextKnown: true });
  core.registerRuntimeModels([core.toModelInfo({
    rawId: model.rawId, endpointId: OLLAMA.id, contextWindow: served, contextWindowKnown: true,
    supportsTools: model.tools, supportsImages: model.images, supportsThinking: model.thinking,
  }, OLLAMA)]);
  return served;
}

/** What to say when the model's context window is too small for Roamies, or null when it's fine. */
export function contextProblem(tokens) {
  if (!tokens || tokens >= MIN_CONTEXT) return null;
  return `Ollama is giving this model only ${tokens.toLocaleString('en-US')} tokens of working memory, and my instructions alone need more. Open Ollama's settings and move the context length slider to 32k (or set OLLAMA_CONTEXT_LENGTH=32768), restart Ollama, then ask me again.`;
}

// ---------------------------------------------------------------- private mode

/** A host on this computer: localhost, 127.x.x.x or ::1. */
export function isLoopbackHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** Whether a URL (string, URL or Request) points at this computer. Anything unreadable counts as not. */
export function isLoopbackUrl(input) {
  try { return isLoopbackHost(new URL(typeof input === 'string' ? input : input?.url ?? String(input)).hostname); }
  catch { return false; }
}

export class PrivateModeError extends Error {
  constructor(what) { super(`Private mode is on, so ${what} was blocked: nothing leaves this computer.`); this.name = 'PrivateModeError'; this.code = 'private'; }
}

/** fetch, but while isPrivate() is true only this computer can be reached. */
export function guardFetch(realFetch, isPrivate) {
  return function fetch(input, init) {
    if (isPrivate() && !isLoopbackUrl(input)) {
      let host = 'the internet';
      try { host = new URL(typeof input === 'string' ? input : input?.url ?? String(input)).hostname || host; } catch { /* keep the default */ }
      return Promise.reject(new PrivateModeError(`a connection to ${host}`));
    }
    return realFetch(input, init);
  };
}

// Programs and commands whose job is to reach another machine. Not a sandbox: a guard against the model sending
// something out by the obvious routes. Package managers are here too: they download and run code.
const NET_PROGRAMS = /(?:^|[\s;&|("'`\\/])(curl|wget|aria2c|ftp|sftp|tftp|scp|ssh|rsync|rclone|telnet|ncat|nc|netcat|nmap|ping|tracert|traceroute|nslookup|dig|bitsadmin|invoke-webrequest|iwr|invoke-restmethod|irm|start-bitstransfer|test-netconnection|tnc|new-pssession|enter-pssession|winget|choco|scoop|brew|apt|apt-get|dnf|yum|pacman|pip|pip3|pipx|npm|npx|pnpm|yarn|cargo|docker|gh|aws|gcloud|gsutil|s3cmd|sendmail|msmtp|swaks|mailx|send-mailmessage|resolve-dnsname|yt-dlp|youtube-dl|az|azcopy|kubectl|go\s+get|conda|uv|ollama\s+(?:pull|push|signin|search|launch)|net\s+use)(?:\.exe)?(?=$|[\s;&|)"'`])/i;
const NET_CODE = /net\.webclient|net\.http|httpclient|net\.sockets|net\.mail|smtpclient|smtplib|ftplib|websocket|downloadstring|downloadfile|uploadfile|uploadstring|urlcache|xmlhttp|urllib|requests\.(?:get|post|put)|http\.client|socket\.(?:socket|connect)|fetch\s*\(|\/dev\/tcp\//i;
const GIT_NET = /(?:^|[\s;&|("'`])git(?:\.exe)?\s+(?:[^;&|]*\s)?(?:push|pull|fetch|clone|ls-remote|remote\s+(?:add|set-url|update)|submodule\s+(?:update|add))\b/i;

/** Why a shell command would reach the network, or null when nothing in it looks like it does. */
export function networkCommand(command) {
  const c = String(command ?? '');
  const program = NET_PROGRAMS.exec(c);
  if (program) return `"${program[1].toLowerCase().replace(/\s+/g, ' ')}" reaches the network or downloads software`;
  if (GIT_NET.test(c)) return 'that git command talks to a remote server';
  if (NET_CODE.test(c)) return 'it contains code that opens a network connection';
  // Any address with a scheme (https://, rtmp://, smb://…) that isn't a file or this computer.
  for (const m of c.matchAll(/\b([a-z][a-z0-9+.-]{1,15}):\/\/[^\s"'`<>|)]+/gi)) if (m[1].toLowerCase() !== 'file' && !isLoopbackUrl(m[0])) return 'it names an address on the network';
  if (/(?:^|[\s"'`=])\\\\[a-z0-9._-]+\\[^\s]/i.test(c)) return 'it names a shared folder on another computer';
  return null;
}

/** What the open tool was asked to open is a link out of this computer (a web page, a mail draft, another machine). */
export function opensOutside(target) {
  const t = String(target ?? '').trim();
  if (/^mailto:/i.test(t)) return false; // a draft in the mail app: sending is the user's own click
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return !/^file:/i.test(t) && !isLoopbackUrl(t);
  if (/^\\\\[a-z0-9._-]+\\/i.test(t)) return true; // \\server\share
  // A bare web address ("example.com/page"), as the open tool itself reads it.
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i.test(t) && !/\.(?:app|exe|lnk|txt|pdf|docx?|xlsx?|pptx?|csv|md|png|jpe?g|gif|mp4|mov|mkv|mp3|wav|zip)$/i.test(t);
}

// Tools that only make sense online (their whole job is the internet).
export const ONLINE_TOOLS = new Set(['fetch_url', 'see_photo']);
// The drawing tool's instructions are the largest thing sent with every request and small models misuse it. Its cards
// can also show pictures and site icons, which the screen loads straight from the internet: never in private mode.
export const HEAVY_TOOLS = new Set(['draw']);
const noDraw = ({ local, private: priv, draw }) => !!priv || (!!local && !draw);

/**
 * The tools for this request. local: a model on this computer answers (leaves out the heavy drawing tool unless
 * `draw` is asked for). private: private mode is on (leaves out the drawing and online tools, and guards open and
 * run_command).
 */
export function toolsFor(tools, { local = false, private: priv = false, draw = false } = {}) {
  let out = tools;
  if (noDraw({ local, private: priv, draw })) out = out.filter((t) => !HEAVY_TOOLS.has(t.name));
  if (!priv) return out;
  return out.filter((t) => !ONLINE_TOOLS.has(t.name)).map((t) => {
    if (t.name === 'open') {
      return { ...t, execute: async (args, ctx) => {
        if (opensOutside(args?.target)) throw new PrivateModeError('opening a link');
        return t.execute(args, ctx);
      } };
    }
    if (t.name === 'run_command') {
      return { ...t, execute: async (args, ctx) => {
        const why = networkCommand(args?.command);
        if (why) throw new Error(`Private mode is on, so that command wasn't run: ${why}. Nothing may leave this computer; do the task with local files and tools only, or tell the user it needs private mode off.`);
        return t.execute(args, ctx);
      } };
    }
    return t;
  });
}

/** Added to the instructions when a model on this computer answers, and when private mode is on. */
export function localNote({ local = false, private: priv = false, draw = false } = {}) {
  const lines = [];
  if (noDraw({ local, private: priv, draw })) lines.push('You are running as a model on this computer, without the draw tool: wherever the instructions above say to draw, point or show a card, answer in words instead (short "- " lines for lists and steps). Keep replies compact and call a tool only when it is needed.');
  if (priv) lines.push('Private mode is on: you work only with what is on this computer. There is no web search, no fetching pages, no opening links and no network commands, so never offer them; if a task truly needs the internet, say it needs private mode switched off (the Model page of the panel). Treat every file and document as confidential.');
  return lines.length ? `\n${lines.join('\n')}\n` : '';
}
