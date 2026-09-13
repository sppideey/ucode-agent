/**
 * provider.js — the only module that knows a model provider exists.
 *
 * Everything above this file speaks one small neutral message format and calls
 * ask(). Moving ucode to a different host means rewriting this file and
 * nothing else.
 *
 * The neutral formats:
 *   { role: 'system',    content }
 *   { role: 'user',      content, images?: [dataUrl] }
 *   { role: 'assistant', content?, toolCalls?: [{ id, name, args }] }
 *   { role: 'tool',      toolCallId, name, content }
 *
 *   tool: { name, description, parameters: <JSON Schema> }
 *
 * ask() resolves to:
 *   { text, reasoning, toolCalls, usage, finishReason, model }
 */

import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { jsonrepair } from 'jsonrepair';
import { Failure } from './failure.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..', '..');

/** Personal config lives here, outside the package, so upgrades never touch it. */
export const UCODE_HOME = join(homedir(), '.ucode');
export const ENV_FILE = join(UCODE_HOME, '.env');

export const BASE_URL = 'https://openrouter.ai/api/v1';
export const PROVIDER = 'OpenRouter';

// First definition wins — dotenv never overwrites a variable that already
// exists — so the order here is the precedence order:
//   real environment  >  ./.env (this project)  >  ~/.ucode/.env (this machine)
//   >  the checkout's own .env (only when developing on a clone)
dotenv.config({ path: join(process.cwd(), '.env'), quiet: true });
dotenv.config({ path: ENV_FILE, quiet: true });
dotenv.config({ path: join(PACKAGE_ROOT, '.env'), quiet: true });

/**
 * The whole model list. Not a starting point — the list.
 *
 * ucode runs on NVIDIA and Cohere only. Both vendors serve genuinely capable
 * models free through OpenRouter, both handle tool calling properly, and
 * keeping the set to five means every one of them has been used in anger
 * rather than listed on the strength of a benchmark. A picker offering sixty
 * models is a picker nobody reads.
 *
 * `name` is what the status bar shows. `note` is what the picker shows.
 */
export const MODELS = {
  'nvidia/nemotron-3-ultra-550b-a55b:free': {
    name: 'Nemotron 3 Ultra',
    context: 1_000_000,
    star: true,
    note: 'deepest reasoning, 1M context — slowest to answer',
  },
  'nvidia/nemotron-3.5-lightning:free': {
    name: 'Nemotron 3.5 Lightning',
    context: 1_000_000,
    note: 'same huge window, answers much sooner',
  },
  'nvidia/nemotron-3-super-120b-a12b:free': {
    name: 'Nemotron 3 Super',
    context: 262_144,
    note: 'strong all-rounder, quick to first token',
  },
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': {
    name: 'Nemotron 3 Nano Omni',
    context: 256_000,
    note: 'small and fast, reasoning tuned',
  },
  'cohere/north-mini-code:free': {
    name: 'North Mini Code',
    context: 256_000,
    star: true,
    note: 'the default — built for code and interface work, quick to answer',
  },
};

/**
 * North Mini Code is the default: it is built for code and interface work,
 * which is what ucode is mostly asked to do, and it answers far sooner than
 * the big reasoning models. /model moves to Ultra when a problem needs the
 * million-token window and the long think more than it needs the speed.
 */
export const DEFAULT_MODEL = 'cohere/north-mini-code:free';

/**
 * Where to go when a model is busy, in order of preference. Each is served by
 * a different upstream, so a rate limit on one rarely means a limit on the
 * next — which is what lets a long build keep going instead of stopping at
 * the first "too many requests".
 */
export const FALLBACKS = [
  'cohere/north-mini-code:free',
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
];

/** The next model to try after `id`, skipping any already tried this round. */
export function fallbackFor(id, tried = new Set()) {
  // Off unless UCODE_FALLBACK=1. A build that starts on one model and finishes
  // on another finishes to a different standard, and the swap lands exactly
  // when the user is least placed to work out why the output changed —
  // mid-build, behind a note that scrolls past. Which model to run is the one
  // decision they made before starting; it is not one to take back for them.
  //
  // Every caller already reads "no fallback" as "wait, then try this one
  // again": failover waits a minute and returns to the same model, the
  // stuck-detector simply does not switch, and a worker retries its own. That
  // is why this can be a single gate rather than four.
  if (process.env.UCODE_FALLBACK !== '1') return null;

  const start = Math.max(0, FALLBACKS.indexOf(id));
  for (let i = 1; i <= FALLBACKS.length; i++) {
    const next = FALLBACKS[(start + i) % FALLBACKS.length];
    if (next !== id && !tried.has(next)) return next;
  }
  return null;
}

/** Seconds to wait on successive rate limits that come with no retry-after. */
const RATE_LIMIT_BACKOFF = [5, 10, 20];

let current = process.env.UCODE_MODEL || DEFAULT_MODEL;
let client = null;

export function model() {
  return current;
}

export function setModel(id) {
  const wanted = String(id ?? '').trim();
  if (!wanted) {
    throw new Failure({
      kind: 'bad_model',
      attempted: 'switching model',
      failed: 'No model name was given.',
      fix: `Pick one of: ${Object.keys(MODELS).join(', ')}`,
    });
  }
  if (!MODELS[wanted]) {
    throw new Failure({
      kind: 'bad_model',
      attempted: `switching to "${wanted}"`,
      failed: 'ucode only runs NVIDIA and Cohere models, and that is not one of them.',
      fix: `Run /model to choose from: ${Object.keys(MODELS).join(', ')}`,
    });
  }
  current = wanted;
  return current;
}

/** The short name for a model id: "Nemotron 3 Ultra". */
export function modelName(id = current) {
  return MODELS[id]?.name ?? id;
}

/** Every model, in list order, annotated with whether it is the active one. */
export function modelList() {
  return Object.entries(MODELS).map(([id, info]) => ({
    id,
    ...info,
    active: id === current,
  }));
}

/**
 * How many tokens one request may occupy.
 *
 * OpenRouter meters requests rather than tokens, so nothing here is rationing
 * a quota — the binding limit is simply the window the model has. On the two
 * million-token models compaction essentially never fires.
 */
export function contextLimit(id = current) {
  const override = Number(process.env.UCODE_MAX_CONTEXT_TOKENS);
  if (Number.isFinite(override) && override > 0) return override;
  return MODELS[id]?.context ?? 128_000;
}

/**
 * A rough local token count, used to decide when to compact *before* a
 * request goes out. Real numbers come back in the response usage; this only
 * has to be close enough to trigger at the right time.
 */
export function estimateTokens(text) {
  return text ? Math.ceil(String(text).length / 4) : 0;
}

export function estimateConversation(messages) {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content || '');
    for (const call of m.toolCalls || []) {
      total += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.args || {}));
    }
    total += 4; // role and framing overhead per message
  }
  return total;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * No key is bundled here, and none ever should be. A key committed to a public
 * package is readable by anyone who runs `npm pack ucode-agent`, and no amount
 * of first-run convenience is worth handing out a live credential.
 */
function apiKey() {
  // UCODE_API_KEY is the documented name. The provider's own variable name is
  // still read, so a key set up for another tool keeps working here.
  const key = (process.env.UCODE_API_KEY || process.env.OPENROUTER_API_KEY || '').trim();
  if (!key) {
    throw new Failure({
      kind: 'no_api_key',
      attempted: 'connecting to the model',
      failed: 'No API key is set - UCODE_API_KEY is missing from the environment and from every .env file.',
      fix:
        `Put UCODE_API_KEY=your-key in ${ENV_FILE} — that applies to every ` +
        'project on this machine — or in a .env file beside your code. ' +
        'Free keys: https://openrouter.ai/keys',
    });
  }
  return key;
}

function connection() {
  if (client) return client;
  client = new OpenAI({
    apiKey: apiKey(),
    baseURL: process.env.UCODE_BASE_URL || BASE_URL,
    // Nemotron Ultra can think for a long time before its first token, so the
    // ceiling is deliberately generous. maxRetries is 0 because ask() owns
    // retrying: its attempts are narrated on screen instead of happening
    // silently somewhere inside the SDK.
    timeout: Number(process.env.UCODE_REQUEST_TIMEOUT_MS) || 300_000,
    maxRetries: 0,
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/sppideey/ucode-agent',
      'X-Title': 'ucode',
    },
  });
  return client;
}

/** Drop the cached client so the next request picks up a changed key. */
export function resetConnection() {
  client = null;
}

// ---------------------------------------------------------------------------
// Live quota, taken from whatever rate-limit headers come back
// ---------------------------------------------------------------------------

let limits = null;

export function rateLimits() {
  return limits;
}

/** "1.5s", "2m59.56s", "1h2m" -> seconds */
function seconds(value) {
  if (!value) return null;
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)m?s)?$/
    .exec(String(value).trim());
  if (!m) return null;
  const total = (parseFloat(m[1]) || 0) * 3600 + (parseFloat(m[2]) || 0) * 60 + (parseFloat(m[3]) || 0);
  return total > 0 ? total : null;
}

function noteLimits(headers) {
  if (!headers?.get) return;
  const num = (name) => {
    const n = Number(headers.get(name));
    return Number.isFinite(n) ? n : null;
  };
  limits = {
    requestsLimit: num('x-ratelimit-limit-requests'),
    requestsRemaining: num('x-ratelimit-remaining-requests'),
    requestsReset: seconds(headers.get('x-ratelimit-reset-requests')),
    tokensLimit: num('x-ratelimit-limit-tokens'),
    tokensRemaining: num('x-ratelimit-remaining-tokens'),
    tokensReset: seconds(headers.get('x-ratelimit-reset-tokens')),
    at: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Neutral format -> wire format
// ---------------------------------------------------------------------------

function wireTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

function wireMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user' && m.images?.length) {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: m.content ?? '' },
          ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      });
    } else if (m.role === 'system' || m.role === 'user') {
      out.push({ role: m.role, content: m.content ?? '' });
    } else if (m.role === 'assistant') {
      const wire = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls?.length) {
        wire.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        }));
      }
      out.push(wire);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Turning provider errors into something a person can act on
// ---------------------------------------------------------------------------

function bodyOf(err) {
  if (err?.error) return { error: err.error };
  const raw = String(err?.message ?? '');
  const start = raw.indexOf('{');
  if (start === -1) return null;
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
}

export function explain(err, id) {
  if (err instanceof Failure) return err;

  const status = err?.status ?? err?.statusCode ?? null;
  const body = bodyOf(err);
  const detail = body?.error?.message ?? String(err?.message ?? err);
  const attempted = `asking ${modelName(id)} for a reply`;

  // The useful text is often not on the error itself. undici reports a socket
  // that closed mid-response as a bare `TypeError: terminated` and puts the
  // real reason on `cause`, so the whole chain is matched rather than the top
  // message alone — otherwise an ordinary dropped connection, which is worth
  // retrying, gets reported as an unknown fault, which is not.
  const chain = [err?.message, err?.code, err?.cause?.message, err?.cause?.code]
    .filter(Boolean)
    .join(' | ');
  const raw = chain || String(err);

  if (err?.name === 'AbortError' || /aborted|The operation was aborted/i.test(raw)) {
    return new Failure({
      kind: 'aborted',
      attempted,
      failed: 'The request was cancelled.',
      fix: 'Send the message again when you are ready.',
      cause: err,
    });
  }

  if (status === 401 || status === 403 || /invalid[_ ]api[_ ]key/i.test(raw)) {
    return new Failure({
      kind: 'invalid_api_key',
      attempted,
      failed: `The API key was rejected (HTTP ${status ?? 401}).`,
      fix:
        'Check UCODE_API_KEY in ~/.ucode/.env for a typo or trailing space, and ' +
        'confirm the key is still active in your account.',
      cause: err,
    });
  }

  if (status === 429 || /rate[_ ]limit/i.test(raw)) {
    // `??` cannot be used to chain through Number(): Number(undefined) is NaN,
    // which is neither null nor undefined, so it would swallow every fallback
    // after it and the wait would silently never be found.
    const header = err?.headers?.get?.('retry-after');
    const asNumber = Number(header);
    const retryAfter =
      seconds(header) ??
      (Number.isFinite(asNumber) && asNumber > 0 ? asNumber : null) ??
      seconds(/try again in ([\dhms.]+)/i.exec(detail)?.[1]) ??
      null;
    // The daily cap reads "free-models-per-day-high-balance", with hyphens, and
    // names its source in the metadata. It is one cap across every free model,
    // so it is reported at once rather than waited on model after model.
    const meta = body?.error?.metadata ?? {};
    const daily = /per[- ]day|RPD|TPD|daily/i.test(`${detail} ${meta.limit_source ?? ''}`);
    const resetMs = Number(meta.headers?.['X-RateLimit-Reset'] ?? err?.headers?.get?.('x-ratelimit-reset'));
    const resetAt = daily && Number.isFinite(resetMs) && resetMs > Date.now() ? new Date(resetMs) : null;
    const cap = Number(meta.headers?.['X-RateLimit-Limit']) || null;
    const wait = Number.isFinite(retryAfter) && retryAfter
      ? (retryAfter >= 60 ? `${Math.ceil(retryAfter / 60)} min` : `${Math.ceil(retryAfter)}s`)
      : null;

    return new Failure({
      kind: 'rate_limit',
      attempted,
      failed: daily
        ? `This key's free daily limit${cap ? ` of ${cap} requests` : ''} is used up. It covers every free model, so switching will not help.`
        : `Too many requests for ${modelName(id)} just now${wait ? ` — clear in ${wait}` : ''}.`,
      fix: daily
        ? `It resets ${resetAt ? `at ${resetAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'once a day'}. ` +
          'Adding credit to your account raises the limit.'
        : 'ucode waits these out on its own. Free endpoints are shared, so it usually ' +
          'clears in seconds; /model moves to a quieter one.',
      detail: { retryAfter, daily, resetAt: resetAt?.getTime() ?? null },
      cause: err,
    });
  }

  // A 404 on a model in this list is almost never a bad name. It is OpenRouter
  // having no upstream free to serve it at that instant, and it clears by
  // itself — so it is retried rather than reported as a missing model.
  if (status === 404 || /does not exist|not found|decommissioned/i.test(raw)) {
    if (MODELS[id]) {
      return new Failure({
        kind: 'server',
        attempted,
        failed: `No provider was free to serve ${modelName(id)} at that moment.`,
        fix: 'ucode retries this by itself. If it keeps up, /model switches.',
        detail: { status },
        cause: err,
      });
    }
    return new Failure({
      kind: 'bad_model',
      attempted,
      failed: `No model "${id}" is available to this key.`,
      fix: `Run /model. ucode ships with: ${Object.keys(MODELS).join(', ')}`,
      cause: err,
    });
  }

  // Some upstreams validate tool calls themselves and reject an invented one,
  // which fails the whole request. Recoverable: the loop feeds this back.
  if (body?.error?.code === 'tool_use_failed' || /tool call validation failed/i.test(detail)) {
    const attemptedName = /call tool '([^']+)'/.exec(detail)?.[1];
    return new Failure({
      kind: 'bad_tool_call',
      attempted,
      failed: attemptedName
        ? `The model tried to call "${attemptedName}", which is not one of its tools.`
        : `The model produced a tool call the provider rejected: ${detail}`,
      fix: 'Use only the tools supplied with the request.',
      detail: { attemptedName },
      cause: err,
    });
  }

  if (status === 400) {
    const noTools = /tool calling.*not supported/i.test(detail);
    return new Failure({
      kind: noTools ? 'no_tool_support' : 'bad_request',
      attempted,
      failed: noTools
        ? `${modelName(id)} cannot call tools, which ucode needs for every task.`
        : `The request was rejected as malformed (HTTP 400): ${detail}`,
      fix: noTools
        ? 'Run /model and pick another one.'
        : 'The conversation has something in it the provider will not accept. /new starts a fresh one.',
      cause: err,
    });
  }

  if (status === 413 || /too large|context.*length/i.test(detail)) {
    return new Failure({
      kind: 'too_large',
      attempted,
      failed: `The conversation no longer fits in ${modelName(id)}: ${detail}`,
      fix: 'Run /new for a fresh session, or lower UCODE_MAX_CONTEXT_TOKENS so ucode folds older turns away sooner.',
      cause: err,
    });
  }

  // OpenRouter drops a request when the upstream goes quiet on it. That is the
  // ordinary failure mode of a busy free endpoint, and of a big reasoning model
  // that spends a long time thinking before its first token. Nothing was
  // generated, so retrying is safe — and ask() does it before anyone notices.
  if (
    status === 408 || status === 504 || status === 524 || status === 522 ||
    err?.name === 'APIConnectionTimeoutError' ||
    /idle timeout|timed out|timeout/i.test(detail) || /idle timeout|timed out/i.test(raw)
  ) {
    return new Failure({
      kind: 'timeout',
      attempted,
      failed: `${modelName(id)} sent nothing back in time — the provider dropped the request.`,
      fix:
        'Free endpoints stall under load, and the largest reasoning models are the ' +
        'first to. ucode already retried. If it keeps happening, /model to Nemotron ' +
        '3.5 Lightning or North Mini Code, which answer sooner.',
      detail: { status },
      cause: err,
    });
  }

  if (status >= 500 || /internal|unavailable|overloaded/i.test(raw)) {
    return new Failure({
      kind: 'server',
      attempted,
      failed: `The provider returned HTTP ${status}. That is their side, not yours.`,
      fix: 'Wait a few seconds and send again. If it persists, /model to another one.',
      cause: err,
    });
  }

  // `terminated` and `premature close` are what a connection dropped part way
  // through a reply looks like. Nothing usable arrived, so it is safe to send
  // again — and on a free endpoint under load it happens often enough that
  // treating it as fatal would be the single most visible flaw in the agent.
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|EPIPE|network|fetch failed|socket hang up|terminated|premature close|other side closed|UND_ERR/i.test(raw) ||
    err?.name === 'APIConnectionError' ||
    (err instanceof TypeError && /terminated/i.test(raw))
  ) {
    return new Failure({
      kind: 'network',
      attempted,
      failed: `The connection to the model dropped: ${raw}`,
      fix:
        'ucode retries this by itself. If it keeps happening, check your connection, ' +
        'VPN and any corporate proxy (HTTPS_PROXY) — or /model to a lighter one, since ' +
        'a long think on a busy free endpoint is the usual cause.',
      cause: err,
    });
  }

  return new Failure({
    kind: 'unknown',
    attempted,
    failed: detail,
    fix: 'Retry once. If it repeats, run ucode --debug for the full trace.',
    cause: err,
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The one call
// ---------------------------------------------------------------------------

/**
 * Send a conversation and get a normalized reply.
 *
 * @param {Array}  messages neutral messages
 * @param {Array}  [tools]  neutral tool definitions
 * @param {object} [opts]   { model, temperature, signal, maxOutputTokens,
 *                            reasoning, attempts, onText, onThinking, onWait }
 */
export async function ask(messages, tools = [], opts = {}) {
  const id = opts.model || current;

  const request = {
    model: id,
    messages: wireMessages(messages),
    // Ask for the working. Without it OpenRouter withholds reasoning entirely,
    // and on a reasoning model that *is* the whole reply until the very end:
    // the socket sits silent for the length of the think, the screen shows
    // nothing, and the provider eventually drops the request as idle. Asking
    // for it fixes the blank screen and the dropped request together. Models
    // that do not reason ignore the flag.
    include_reasoning: true,
  };

  const wired = wireTools(tools);
  if (wired) {
    request.tools = wired;
    request.tool_choice = 'auto';
  }
  if (opts.temperature !== undefined) request.temperature = opts.temperature;
  if (opts.maxOutputTokens) request.max_tokens = opts.maxOutputTokens;
  if (opts.reasoning) request.reasoning = opts.reasoning;

  // A side call (the design review) passes fewer: it is better skipped than
  // waited on through a string of rate-limit pauses.
  const attempts = opts.attempts ?? 4;
  let problem;

  // Text already on screen cannot be unprinted, so a stream is only safe to
  // retry while it is still silent. Every timeout worth retrying happens
  // before the first token, so this costs nothing in practice.
  let printed = 0;
  const callOpts = opts.onText
    ? { ...opts, onText: (d) => { printed += d.length; opts.onText(d); } }
    : opts;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (opts.onText) return await streamed(request, callOpts, id);
      const { data, response } = await connection().chat.completions
        .create(request, { signal: opts.signal })
        .withResponse();
      noteLimits(response?.headers);
      return normalize(data, id);
    } catch (err) {
      noteLimits(err?.headers);
      problem = explain(err, id);

      // A per-minute limit is a wait, not a failure. Sit it out rather than
      // making the user retype their message. Free endpoints often refuse
      // without saying how long to wait, so when there is no retry-after the
      // pauses grow on their own — 5s, 10s, 20s — and only then does the
      // error go up to the loop, which moves to another model.
      const told = problem.detail?.retryAfter;
      const wait = Number.isFinite(told) && told > 0 && told <= 90 ? told : RATE_LIMIT_BACKOFF[attempt - 1];
      if (
        problem.kind === 'rate_limit' && !problem.detail?.daily &&
        wait && attempt < attempts && printed === 0 && !opts.signal?.aborted
      ) {
        const until = Date.now() + wait * 1000;
        while (Date.now() < until && !opts.signal?.aborted) {
          opts.onWait?.(`rate limited — resuming in ${Math.ceil((until - Date.now()) / 1000)}s`);
          await pause(Math.min(1000, until - Date.now()));
        }
        if (opts.signal?.aborted) break;
        continue;
      }

      const worthRetrying =
        problem.kind === 'server' || problem.kind === 'network' || problem.kind === 'timeout';
      if (!worthRetrying || attempt === attempts || opts.signal?.aborted) break;
      if (printed > 0) break; // half an answer is on screen; do not print it twice

      // A stalled provider needs longer to come back than a dropped socket
      // does, and the wait is narrated so a slow turn never looks like a hang.
      const backoff = problem.kind === 'timeout'
        ? 1500 * 2 ** (attempt - 1)
        : 400 * 2 ** (attempt - 1);
      opts.onWait?.(
        `${problem.kind === 'timeout' ? 'provider stalled' : 'connection failed'} — ` +
        `retrying (${attempt + 1}/${attempts})`
      );
      await pause(backoff);
    }
  }

  throw problem;
}

/** Collect a streamed reply, handing deltas out as they land. */
async function streamed(request, opts, id) {
  const { data: stream, response } = await connection().chat.completions
    .create(
      { ...request, stream: true, stream_options: { include_usage: true } },
      { signal: opts.signal }
    )
    .withResponse();
  noteLimits(response?.headers);

  let text = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage = null;
  const partial = new Map();
  const handed = new Set();
  let highest = -1;

  for await (const chunk of stream) {
    if (opts.signal?.aborted) break;
    if (chunk.usage) usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};

    // Reasoning arrives on a separate channel: `reasoning` on OpenRouter,
    // `reasoning_content` on some upstreams.
    const thinking = delta.reasoning ?? delta.reasoning_content;
    if (thinking) {
      reasoning += thinking;
      opts.onThinking?.(thinking);
    }

    if (delta.content) {
      text += delta.content;
      opts.onText(delta.content);
    }

    // A tool call's name and arguments arrive across several chunks, keyed by
    // index, so they are stitched back together here.
    for (const call of delta.tool_calls ?? []) {
      // Calls arrive one after another, so the first chunk of call N means
      // every call before it is complete. Those are handed over at once, and
      // the caller can start running them while the rest are still being
      // written — the reply streaming and the tools working overlap.
      if (opts.onToolCall && call.index > highest) {
        for (const [index, slot] of partial) {
          if (index < call.index && !handed.has(index)) {
            handed.add(index);
            opts.onToolCall(readCall({ id: slot.id || `call_${index}`, name: slot.name, raw: slot.args }));
          }
        }
        highest = call.index;
      }

      const slot = partial.get(call.index) ?? { id: '', name: '', args: '' };
      if (call.id) slot.id = call.id;
      if (call.function?.name) slot.name += call.function.name;
      if (call.function?.arguments) slot.args += call.function.arguments;
      partial.set(call.index, slot);

      // A whole app arrives as one enormous arguments string that takes a
      // minute or two to write. Handing it over as it grows is what lets the
      // caller say which file is being written right now, instead of showing
      // a spinner that has meant nothing for ninety seconds.
      if (call.function?.arguments) opts.onToolArgs?.({ index: call.index, name: slot.name, args: slot.args });
    }
  }

  const toolCalls = [];
  for (const [index, slot] of partial) {
    toolCalls.push(readCall({ id: slot.id || `call_${index}`, name: slot.name, raw: slot.args, cutOff: finishReason === 'length' }));
  }

  return {
    text: text.trim(),
    reasoning: reasoning.trim(),
    toolCalls,
    usage: {
      promptTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
    },
    finishReason,
    model: id,
  };
}

/**
 * Recover the files from a file-write call whose JSON will not parse.
 *
 * The usual cause is a double quote inside the code that the model forgot to
 * escape — `className="flex"` — which ends the JSON string early. No general
 * repair can know which quote was meant, but a file write has a fixed shape:
 * "path", then "content", then either the next file or the end. Splitting on
 * that shape and escaping the stray quotes gets every file back.
 */
export function salvageWrites(text) {
  const heads = [...text.matchAll(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"content"\s*:\s*"/g)];
  if (!heads.length) return null;

  const files = [];
  for (let i = 0; i < heads.length; i++) {
    const from = heads[i].index + heads[i][0].length;
    const to = i + 1 < heads.length ? heads[i + 1].index : text.length;
    // The string ends at the last quote that is followed by nothing but JSON
    // punctuation — `"}, {`, or `"}}, {` when the model added a brace, or `"}]}`.
    const body = text.slice(from, to).replace(/"[\s,{}[\]]*$/, '');
    const content = unescapeLoose(body);
    const pathValue = unescapeLoose(heads[i][1]);
    if (!pathValue || !content) return null; // not the shape we thought — leave it an honest error
    files.push({ path: pathValue, content });
  }
  return files.length ? files : null;
}

/**
 * Decode a JSON string body the forgiving way: the standard escapes are
 * honoured, and everything JSON would reject — a raw line break, a tab, a stray
 * quote, an escape JSON does not know — is kept as the character it plainly is.
 */
function unescapeLoose(s) {
  const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i === s.length - 1) { out += c; continue; }
    const next = s[++i];
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
      i += 4;
    } else {
      out += simple[next] ?? next;
    }
  }
  return out;
}

/**
 * Parse one tool call's arguments.
 *
 * A parse error is recorded on the call rather than thrown. The loop hands it
 * back to the model, which usually fixes its own JSON on the next step —
 * cheaper than failing the whole turn over a stray comma.
 */
export function readCall({ id, name, raw, cutOff = false }) {
  const call = { id, name, args: {} };
  const text = String(raw ?? '').trim();
  if (!text) return call;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) call.args = parsed;
    else call.parseError = `arguments must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`;
  } catch (err) {
    // A missing comma or a stray control character in a 3,000-token
    // batch_write used to throw the whole step away — half a minute of output
    // discarded over one character. Repair the usual slips instead. Never when
    // the reply was cut off at the output limit, though: repairing that would
    // close the string and quietly write half a file.
    if (!cutOff) {
      try {
        const fixed = JSON.parse(jsonrepair(text));
        if (fixed && typeof fixed === 'object' && !Array.isArray(fixed)) {
          call.args = fixed;
          call.repaired = true;
          return call;
        }
      } catch { /* beyond general repair — try the file-write shape next */ }

      const salvaged = (name === 'write_file' || name === 'batch_write') ? salvageWrites(text) : null;
      if (salvaged) {
        call.args = name === 'write_file' ? salvaged[0] : { files: salvaged };
        call.repaired = true;
        return call;
      }
    }
    call.parseError = `${err.message} — the raw arguments were: ${text.slice(0, 300)}`;
  }
  return call;
}

function normalize(data, id) {
  const choice = data?.choices?.[0];
  const message = choice?.message ?? {};

  const toolCalls = (message.tool_calls ?? []).map((c) =>
    readCall({ id: c.id, name: c.function?.name, raw: c.function?.arguments, cutOff: choice?.finish_reason === 'length' })
  );

  const u = data?.usage ?? {};
  const finishReason = choice?.finish_reason ?? 'stop';
  const text = (message.content ?? '').trim();

  if (!text && toolCalls.length === 0 && finishReason === 'length') {
    throw new Failure({
      kind: 'no_content',
      attempted: `asking ${modelName(id)} for a reply`,
      failed: 'The reply hit the output limit before producing anything at all.',
      fix: 'Ask for something shorter, or split the task into steps.',
      detail: { finishReason },
    });
  }

  return {
    text,
    reasoning: (message.reasoning ?? '').trim(),
    toolCalls,
    usage: {
      promptTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      totalTokens: u.total_tokens ?? 0,
    },
    finishReason,
    model: id,
  };
}
