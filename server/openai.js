// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Hidden cloud feature: proxy the local chat protocol to the OpenAI API — the
// sibling of server/claude.js. The frontend speaks Ollama's chat shape
// (messages[] in, NDJSON chunks out, tool_calls for function calling); this
// module makes OpenAI look like just another entry in the model dropdown.
//
// OpenAI's Chat Completions API is much closer to Ollama than Anthropic is, so
// the translation here is thinner than claude.js:
//   - system stays an inline message (no separate field to extract).
//   - tools are nearly pass-through (same {function:{name,description,parameters}}).
//   - streaming just picks choices[].delta.content until "data: [DONE]".
// The only real friction is on reasoning models (o1/o3/o4/gpt-5): they use
// max_completion_tokens instead of max_tokens, reject temperature, and prefer a
// "developer" role over "system".
//
// Config lives OUTSIDE the repo, in ~/.hey-koko/openai.json:
//   { "baseUrl": "https://api.openai.com", "apiKey": "sk-...", "models": ["gpt-5"] }
// baseUrl is the origin (an optional trailing /v1 is tolerated). Env vars
// override the file: OPENAI_BASE_URL / OPENAI_API_KEY. No key -> feature hidden.
// The file is re-read per request, so edits take effect without a restart.

const fs = require("fs");
const path = require("path");
const config = require("./config");
const { sendJson } = require("./utils");

const OPENAI_CONFIG_PATH = path.join(config.DATA_DIR, "openai.json");
const OPENROUTER_CONFIG_PATH = path.join(config.DATA_DIR, "openrouter.json");
const DEFAULT_BASE_URL = "https://api.openai.com";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODELS = ["gpt-5", "gpt-4o"];

// The families whose model ids auto-route WITHOUT an allowlist (clean, slash-free
// prefixes). OpenRouter ids are `provider/model` (slashed) so they DON'T match —
// OpenRouter always routes via its allowlist instead.
const PREFIX_RE = /^(gpt-|o1|o3|o4|chatgpt-|deepseek|grok|qwen|qwq)/i;

// Architectural context window per model (for /api/model-info — OpenAI's
// /v1/models does NOT report a context length, unlike Anthropic, so we read
// these instead). Prefix-matched longest-first in contextLengthFor().
const CONTEXT_LENGTHS = {
  // GPT-5 family: 5.5 (Apr 2026) is 1M, 5.4 is 1.05M; the original 5.0 is 400K.
  // Longest-prefix-wins picks the versioned key over the bare "gpt-5".
  "gpt-5.5": 1000000,
  "gpt-5.4": 1050000,
  "gpt-5": 400000,
  "gpt-4.1": 1000000,
  "gpt-4o": 128000,
  "gpt-4-turbo": 128000,
  "gpt-4": 8192,
  "gpt-3.5": 16385,
  "chatgpt-4o": 128000,
  "o1": 200000,
  "o3": 200000,
  "o4": 200000,
  // DeepSeek V4 (incl. Flash/Pro, from Apr 2026): 1M-token context.
  "deepseek-v4": 1000000,
  // DeepSeek V3.2 / R1 (api.deepseek.com deepseek-chat/-reasoner): 128K since Mar 2026.
  "deepseek": 131072,
  // xAI Grok (OpenAI-compatible at api.x.ai/v1): grok-4 is 256K, others ~128K.
  "grok-4": 256000,
  "grok": 131072,
  // Alibaba Qwen via DashScope compatible-mode: qwen-* chat + qwq/qwen3 reasoning,
  // ~128K typical (qwen-turbo/long go higher; 128K is a safe conservative floor).
  "qwen": 131072,
  "qwq": 131072,
  // Google Gemma 4 (OpenRouter, Apr 2026): 12B/26B/31B are 256K; E2B/E4B are 128K.
  "gemma-4": 262144,
};

// Reasoning-family models (o-series + gpt-5) behave differently: max_completion_tokens
// instead of max_tokens, no temperature/top_p, and a "developer" system role.
// NOTE: deepseek-reasoner is deliberately NOT here — it wants plain max_tokens and
// simply ignores temperature, so treating it as a classic model is correct; its
// chain-of-thought is handled separately via the reasoning_content field.
function isReasoningModel(model) {
  return /^(o1|o3|o4|gpt-5)/i.test(model || "");
}

// Load one provider config from {baseUrl, apiKey, models[]} on disk + env
// overrides. Returns null when no API key is available (that provider stays
// invisible). `kind` distinguishes routing behavior: "openai" auto-routes by
// prefix, "openrouter" routes ONLY via its allowlist (slashed model ids).
function loadProviderConfig({ file: filePath, kind, defaultBase, envKey, envBase }) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    file = {};
  }
  const apiKey = (envKey && process.env[envKey]) || file.apiKey || "";
  if (!apiKey) return null;
  let baseUrl = ((envBase && process.env[envBase]) || file.baseUrl || defaultBase).trim();
  baseUrl = baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = "https://" + baseUrl;
  // Tolerate a baseUrl that already ends in /v1 (common for OpenAI-compatible
  // relays) — apiBase() below normalizes it so we never double up the segment.
  const models = Array.isArray(file.models) ? file.models : [];
  return { apiKey, baseUrl, models, kind };
}

// Warn at most once per key (loadProviders runs per message — don't spam the log).
const _warned = new Set();
function warnOnce(key, msg) { if (!_warned.has(key)) { _warned.add(key); console.warn(msg); } }

// Names of locally-installed Ollama models, recorded from every /api/models poll
// (see injectModels). Ollama models are commonly namespaced with a slash
// (`huihui_ai/gemma-4-abliterated:12b-qat`), which would otherwise collide with
// the "any slashed id → OpenRouter" ad-hoc route below. The frontend always polls
// /api/models before a chat request can be issued, so this is populated in time.
const _localModels = new Set();
function noteLocalModels(models) {
  for (const m of models) if (m && !m.cloud && m.name) _localModels.add(m.name);
}

// All configured cloud providers, in ROUTING PRIORITY order. openai.json first
// (the generic/official slot, prefix-routed), then openrouter.json (allowlist-
// only). Each is independent — enable either, both, or neither.
function loadProviders() {
  const list = [];
  const oa = loadProviderConfig({ file: OPENAI_CONFIG_PATH, kind: "openai", defaultBase: DEFAULT_BASE_URL, envKey: "OPENAI_API_KEY", envBase: "OPENAI_BASE_URL" });
  if (oa) list.push(oa);
  const or = loadProviderConfig({ file: OPENROUTER_CONFIG_PATH, kind: "openrouter", defaultBase: OPENROUTER_BASE_URL, envKey: "OPENROUTER_API_KEY", envBase: "OPENROUTER_BASE_URL" });
  if (or) {
    // OpenRouter ids are slashed `provider/model` and its catalog has hundreds of
    // entries — REQUIRE an explicit allowlist. Without one the provider is ignored
    // (with a one-time warning) rather than flooding the dropdown or guessing.
    if (or.models.length) list.push(or);
    else warnOnce("openrouter-no-models", '[hey-koko] openrouter.json has apiKey configured but is missing "models" —— OpenRouter requires an explicit model list (e.g. ["anthropic/claude-3.5-sonnet"]); skipped this time.');
  }
  return list;
}

// Find the provider that owns a model name (network-free). Allowlist match wins;
// otherwise a prefix match, but ONLY for non-openrouter providers (OpenRouter's
// slashed ids must be listed explicitly). First provider in priority order wins.
function resolveProvider(model) {
  if (!model) return null;
  for (const p of loadProviders()) {
    if (p.models.length) {
      if (p.models.includes(model)) return p;
      // Ad-hoc pick from the "browse all models" dialog: a slashed `provider/model`
      // id is unmistakably OpenRouter's namespace, so route it there even when it
      // isn't in the curated allowlist. The allowlist still drives what the DROPDOWN
      // lists (that's what `models[]` is required for) — this only affects routing.
      // Exclude locally-installed Ollama models, which are ALSO slashed
      // (`huihui_ai/gemma-…:tag`) and must stay on local Ollama.
      if (p.kind === "openrouter" && model.includes("/") && !_localModels.has(model)) return p;
    } else if (p.kind !== "openrouter" && !model.includes("/") && PREFIX_RE.test(model)) {
      // Bare names only: a slashed id belongs to OpenRouter's namespace and must never
      // be prefix-routed to the openai.json provider (e.g. `deepseek/…` starts with
      // "deepseek" but must not be sent to api.openai.com).
      return p;
    }
  }
  return null;
}

// The /v1 prefix. Callers append "/chat/completions" or "/models".
function apiBase(cfg) {
  return /\/v1$/i.test(cfg.baseUrl) ? cfg.baseUrl : cfg.baseUrl + "/v1";
}

// Cache of auto-discovered chat model ids per baseUrl, so we don't hit /v1/models
// on every /api/models poll (keyed by baseUrl now that >1 provider can exist).
const _discovered = new Map(); // baseUrl -> { ts, ids }
const DISCOVER_TTL_MS = 5 * 60 * 1000;

// OpenAI's /v1/models lists EVERYTHING (embeddings, tts, whisper, dall-e, moderation,
// dated snapshots…). Keep only chat-capable text models and drop the noise.
function isChatModelId(id) {
  if (!PREFIX_RE.test(id)) return false;
  // Exclude non-chat / non-text variants that share the gpt- prefix.
  if (/(image|audio|realtime|transcribe|tts|whisper|embedding|moderation|search|dall-e)/i.test(id)) return false;
  return true;
}

// Collapse dated snapshots to their base alias (gpt-4o-2024-08-06 -> gpt-4o) so
// the dropdown shows one entry per model, preferring the undated alias when both
// are present. Never fabricates an id: the original string is emitted.
function denoiseModelIds(ids) {
  const best = new Map(); // base -> { id, dated }
  for (const id of ids) {
    const base = id.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{4}$/, "");
    const dated = id !== base;
    const cur = best.get(base);
    if (!cur || (cur.dated && !dated)) best.set(base, { id, dated });
  }
  return [...best.values()].map((v) => v.id);
}

// GET <apiBase>/models → chat model ids. Returns null on any failure (network
// error, relay doesn't implement it, empty) so callers fall back to allowlist.
async function discoverModels(cfg) {
  const now = Date.now();
  const cached = _discovered.get(cfg.baseUrl);
  if (cached && cached.ids && now - cached.ts < DISCOVER_TTL_MS) return cached;
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`${apiBase(cfg)}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(to);
    if (!r.ok) return null;
    const data = await r.json();
    const rawIds = [];
    for (const m of data.data || []) {
      if (m.id && isChatModelId(m.id)) rawIds.push(m.id);
    }
    if (!rawIds.length) return null;
    const entry = { ts: now, ids: denoiseModelIds(rawIds) };
    _discovered.set(cfg.baseUrl, entry);
    return entry;
  } catch {
    clearTimeout(to);
    return null;
  }
}

// Is this model name owned by an OpenAI-compatible provider? Drives /api/chat
// routing — network-free (called per message). Delegates to resolveProvider.
function isOpenAIModel(model) {
  return resolveProvider(model) != null;
}

function contextLengthFor(model) {
  if (!model) return 128000;
  // Strip an OpenRouter-style `provider/` prefix so a slashed id like
  // `deepseek/deepseek-v4-flash` matches the specific `deepseek-v4` entry rather
  // than stopping at the generic `deepseek`. Longest key wins (sorted below).
  const name = (model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model).toLowerCase();
  const keys = Object.keys(CONTEXT_LENGTHS).sort((a, b) => b.length - a.length);
  for (const k of keys) if (name.startsWith(k)) return CONTEXT_LENGTHS[k];
  return 128000;
}

// Append every configured provider's models to an existing list (mutates it in
// place). Called by claude.listModels so /api/models carries all clouds.
// cloud:true lets the frontend badge these (☁️) apart from local Ollama models.
async function injectModels(models) {
  noteLocalModels(models); // remember local Ollama names so routing won't hijack slashed ones
  const existing = new Set(models.map((m) => m.name));
  for (const cfg of loadProviders()) {
    let ids;
    if (cfg.models.length) {
      ids = cfg.models;                                 // manual allowlist (always used for openrouter)
    } else {
      const disc = await discoverModels(cfg);           // auto-discover (openai kind only)
      ids = disc ? disc.ids : DEFAULT_MODELS;           // fallback if /v1/models unavailable
    }
    for (const name of ids) {
      if (!existing.has(name)) { models.push({ name, model: name, cloud: true }); existing.add(name); }
    }
  }
}

// GET /api/models — Ollama tags plus configured/discovered OpenAI models. Only
// used if OpenAI is configured WITHOUT Claude (server.js routes /api/models to
// claude.listModels, which also injects OpenAI). Kept for symmetry/standalone.
async function listModels(res) {
  let models = [];
  try {
    const r = await fetch(`${config.ollamaUrl}/api/tags`);
    if (r.ok) models = (await r.json()).models || [];
  } catch {
    models = [];
  }
  await injectModels(models);
  sendJson(res, 200, { models });
}

// --- Ollama -> OpenAI translation -----------------------------------------

// Convert Ollama-shaped messages into OpenAI chat messages. Handles: base64
// images (-> image_url data URIs), and the function-calling round trip
// (assistant.tool_calls -> OpenAI tool_calls with fabricated ids; role:"tool"
// -> tool message carrying the matching tool_call_id by order — the frontend
// always emits tool results in the same order as the calls).
function toOpenAIMessages(ollamaMessages, model) {
  const systemRole = isReasoningModel(model) ? "developer" : "system";
  const out = [];
  let pendingToolCallIds = [];

  for (const m of ollamaMessages || []) {
    const role = m.role;

    if (role === "system") {
      out.push({ role: systemRole, content: m.content || "" });
      continue;
    }

    if (role === "tool") {
      const id = pendingToolCallIds.shift() || ("call_" + Math.random().toString(36).slice(2, 10));
      out.push({ role: "tool", tool_call_id: id, content: String(m.content ?? "") });
      continue;
    }

    if (role === "user") {
      if (Array.isArray(m.images) && m.images.length) {
        const parts = [];
        const text = typeof m.content === "string" ? m.content : "";
        if (text) parts.push({ type: "text", text });
        for (const img of m.images) {
          const data = String(img).replace(/^data:[^;]+;base64,/, "");
          parts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } });
        }
        out.push({ role: "user", content: parts });
      } else {
        out.push({ role: "user", content: typeof m.content === "string" ? m.content : "" });
      }
      continue;
    }

    if (role === "assistant") {
      const msg = { role: "assistant", content: m.content || "" };
      pendingToolCallIds = [];
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        msg.tool_calls = m.tool_calls.map((tc, i) => {
          const fn = tc.function || {};
          const id = "call_" + i + "_" + Math.random().toString(36).slice(2, 8);
          pendingToolCallIds.push(id);
          // OpenAI wants arguments as a JSON STRING (Ollama may hand us an object).
          const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {});
          return { id, type: "function", function: { name: fn.name, arguments: args } };
        });
        // OpenAI rejects an assistant turn with tool_calls AND null content only
        // in some SDKs; an empty string is always safe.
        if (!msg.content) msg.content = "";
      }
      out.push(msg);
      continue;
    }
  }
  return out;
}

function toOpenAITools(ollamaTools) {
  if (!Array.isArray(ollamaTools) || !ollamaTools.length) return undefined;
  return ollamaTools.map((t) => {
    const fn = t.function || t;
    return {
      type: "function",
      function: {
        name: fn.name,
        description: fn.description || "",
        parameters: fn.parameters || { type: "object", properties: {} },
      },
    };
  });
}

// Build the OpenAI request payload shared by proxyChat and complete.
function buildPayload({ model, messages, tools, stream, maxTokens, temperature, thinkEffort, thinkOff }) {
  const reasoning = isReasoningModel(model);
  const payload = { model, messages, stream };
  // ⚙ "Thinking effort" → the o-series/gpt-5 knob of the same idea. Only for reasoning
  // models: a classic chat model 400s on the unknown parameter, and has nothing to spend
  // it on anyway. Absent (the default) leaves the provider's own default in place.
  // reasoning_effort tops out at "high" here — the two levels above it are Claude's
  // vocabulary, so they land on the ceiling this API actually has rather than 400.
  const EFFORT_FOR_OPENAI = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };
  if (reasoning && EFFORT_FOR_OPENAI[thinkEffort]) {
    payload.reasoning_effort = EFFORT_FOR_OPENAI[thinkEffort];
  } else if (reasoning && thinkOff) {
    // A reasoning model has no off switch — the lowest effort is as close as it gets.
    payload.reasoning_effort = "low";
  }
  if (tools) payload.tools = tools;
  if (maxTokens && maxTokens > 0) {
    if (reasoning) payload.max_completion_tokens = maxTokens;
    else payload.max_tokens = maxTokens;
  }
  // Reasoning models reject sampling params outright; forward temperature only
  // for the classic chat models, and only when the caller set one.
  if (!reasoning && typeof temperature === "number") payload.temperature = temperature;
  // Ask for usage on the final streamed chunk (context meter). Without this,
  // streamed responses carry no token counts.
  if (stream) payload.stream_options = { include_usage: true };
  return payload;
}

// Unpack an OpenAI/OpenRouter error into a readable one-line message. OpenRouter
// hides the downstream provider's REAL error inside error.metadata (raw +
// provider_name) behind a generic "Provider returned error" — surface it so the
// user sees why (rate limit, model down, bad param…) instead of the vague top line.
function formatError(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  let msg = err.message || "";
  const meta = err.metadata;
  if (meta && typeof meta === "object") {
    const raw = typeof meta.raw === "string" ? meta.raw : (meta.raw != null ? JSON.stringify(meta.raw) : "");
    const prov = meta.provider_name ? `${meta.provider_name}: ` : "";
    const extra = (prov + raw).trim();
    if (extra && !msg.includes(raw)) msg = msg ? `${msg}（${extra}）` : extra;
  }
  return msg;
}
function extractApiError(text) {
  try { return formatError(JSON.parse(text).error) || text; }
  catch { return text; }
}

// --- Chat proxy ------------------------------------------------------------

async function proxyChat(res, body) {
  const cfg = resolveProvider(body.model);
  if (!cfg) {
    sendJson(res, 400, { error: "OpenAI is not configured." });
    return;
  }

  const messages = toOpenAIMessages(body.messages, body.model);
  const tools = toOpenAITools(body.tools);
  const wantStream = body.stream !== false;
  const numPredict = body.options && body.options.num_predict;
  // No hardcoded default: let OpenAI use the model's own max output cap unless
  // the caller explicitly asked for a limit (avoids exceeding per-model ceilings).
  const maxTokens = numPredict && numPredict > 0 ? numPredict : 0;
  const temperature = body.options && typeof body.options.temperature === "number" ? body.options.temperature : undefined;

  const payload = buildPayload({ model: body.model, messages, tools, stream: wantStream, maxTokens, temperature,
                                thinkEffort: body.thinkEffort, thinkOff: body.think === false });
  // OpenRouter only RETURNS a reasoning model's chain-of-thought when asked — enable it
  // when the user turned on "show thinking". Gated to the OpenRouter provider: DeepSeek-
  // direct returns reasoning_content by default (no flag), and api.openai.com would 400
  // on this unknown param. Harmless/ignored for non-reasoning OpenRouter models.
  if (body.showThinking && cfg.kind === "openrouter") payload.include_reasoning = true;

  const controller = new AbortController();
  let timeoutHandle = null;
  if (body.timeout && body.timeout > 0) {
    const ms = Math.min(600, Math.max(60, body.timeout)) * 1000;
    timeoutHandle = setTimeout(() => controller.abort(), ms);
  }

  let response;
  try {
    response = await fetch(`${apiBase(cfg)}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (error.name === "AbortError") {
      sendJson(res, 504, { error: "Request timed out: OpenAI exceeded the configured response time limit." });
    } else {
      sendJson(res, 502, { error: "Cannot connect to the OpenAI service. Check the base URL and network.", detail: error.message });
    }
    return;
  }

  if (!response.ok) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const text = await response.text();
    sendJson(res, response.status, { error: extractApiError(text) || response.statusText });
    return;
  }

  // Non-streaming: single JSON object in Ollama's shape (tool-calling turns).
  if (!wantStream) {
    let data;
    try { data = await response.json(); } catch (e) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      sendJson(res, 502, { error: "OpenAI returned a response that could not be parsed.", detail: e.message });
      return;
    }
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const choice = (data.choices && data.choices[0]) || {};
    const cm = choice.message || {};
    const message = { role: "assistant", content: cm.content || "" };
    // Reasoning models on OpenAI-compatible providers return their chain-of-thought
    // in a non-standard field (plain OpenAI does NOT): DeepSeek uses
    // `reasoning_content`, OpenRouter uses `reasoning`. Accept either and surface
    // it as `thinking` when the show-thinking toggle is on — the frontend already
    // renders that field (claude.js does the same).
    const reasoningOut = cm.reasoning_content || cm.reasoning;
    if (body.think && reasoningOut) message.thinking = reasoningOut;
    if (Array.isArray(cm.tool_calls) && cm.tool_calls.length) {
      message.tool_calls = cm.tool_calls.map((tc) => {
        const fn = tc.function || {};
        let args = fn.arguments;
        // Ollama's tool loop expects arguments as an OBJECT (claude.js emits one too).
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
        return { function: { name: fn.name, arguments: args || {} } };
      });
    }
    sendJson(res, 200, {
      model: body.model,
      message,
      done: true,
      prompt_eval_count: data.usage?.prompt_tokens || 0,
      eval_count: data.usage?.completion_tokens || 0,
    });
    return;
  }

  // Streaming: translate OpenAI SSE -> Ollama NDJSON (one {message:{content}}
  // per line, final line carries done + token counts for the context meter).
  // Only text deltas are surfaced here; tool-calling turns use stream:false
  // above (the frontend tool loop is non-streaming), matching claude.js.
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
  });

  const writeChunk = (obj) => res.write(JSON.stringify(obj) + "\n");
  const decoder = new TextDecoder();
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    for await (const chunk of response.body) {
      // fetch() yields Uint8Array chunks — TextDecoder handles multibyte
      // boundaries; chunk.toString("utf8") would NOT decode a Uint8Array.
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (!dataStr) continue;
        // `data: [DONE]` is the end marker. Finalize NOW rather than waiting for the
        // upstream socket to close — some providers (notably DeepSeek) send [DONE] but
        // keep the keep-alive connection open, which would otherwise leave `for await`
        // hanging forever, so the client's response never ends and the UI stays stuck
        // on "sending/receiving". Returning here also cancels the upstream stream.
        if (dataStr === "[DONE]") {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          writeChunk({ message: { role: "assistant", content: "" }, done: true, prompt_eval_count: inputTokens, eval_count: outputTokens });
          res.end();
          return;
        }
        let evt;
        try { evt = JSON.parse(dataStr); } catch { continue; }

        // A provider can fail PART-WAY through a stream (common for overloaded
        // free models) — OpenRouter sends `data: {"error":{...}}` mid-stream.
        // Without this it was silently swallowed and the reply just cut off.
        if (evt.error) {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          writeChunk({ error: formatError(evt.error) || "Provider returned error" });
          res.end();
          return;
        }

        // With stream_options.include_usage, the final data chunk has empty
        // choices[] and a usage block.
        if (evt.usage) {
          inputTokens = evt.usage.prompt_tokens || inputTokens;
          outputTokens = evt.usage.completion_tokens || outputTokens;
        }
        const delta = evt.choices && evt.choices[0] && evt.choices[0].delta;
        if (delta) {
          // Reasoning models stream their chain-of-thought before the answer, in a
          // provider-specific field: DeepSeek `reasoning_content`, OpenRouter
          // `reasoning`. Forward either as `thinking` (gated by the toggle).
          const rc = delta.reasoning_content || delta.reasoning;
          if (body.showThinking && rc) {
            writeChunk({ message: { role: "assistant", content: "", thinking: rc }, done: false });
          }
          if (delta.content) {
            writeChunk({ message: { role: "assistant", content: delta.content }, done: false });
          }
        }
      }
    }
    if (timeoutHandle) clearTimeout(timeoutHandle);
    writeChunk({ message: { role: "assistant", content: "" }, done: true, prompt_eval_count: inputTokens, eval_count: outputTokens });
    res.end();
  } catch (error) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (!res.writableEnded) {
      try { writeChunk({ message: { role: "assistant", content: "" }, done: true }); } catch { /* ignore */ }
      res.end();
    }
  }
}

// Non-streaming text completion for INTERNAL server callers (subtitle tidying,
// prompt enhancement) that talk to the chat backend directly and bypass the
// /api/chat router. Takes Ollama-shaped messages, returns the assistant text.
// Throws on error.
async function complete(model, messages, { signal, temperature } = {}) {
  const cfg = resolveProvider(model);
  if (!cfg) throw new Error("OpenAI is not configured");
  const payload = buildPayload({
    model,
    messages: toOpenAIMessages(messages, model),
    tools: undefined,
    stream: false,
    maxTokens: 0,
    temperature,   // buildPayload drops it for reasoning models
  });
  const r = await fetch(`${apiBase(cfg)}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    let msg = txt;
    try { msg = JSON.parse(txt).error?.message || txt; } catch { /* keep raw */ }
    throw new Error(`OpenAI ${r.status}${msg ? ": " + String(msg).slice(0, 200) : ""}`);
  }
  const data = await r.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

// --- Full catalog (for the "browse all models" dialog) ---------------------

// Every online CHAT model from every configured provider, NOT filtered by the
// allowlist — `models[]` curates the dropdown, this powers the browse dialog so a
// model can be picked ad-hoc (routing accepts slashed ids, see resolveProvider).
// Returns [] when nothing is configured / reachable; a failing provider is skipped.
async function listAllModels() {
  const out = [];
  for (const cfg of loadProviders()) {
    // The endpoint host — the honest source label. `kind:"openai"` only means "configured
    // in openai.json", which may well be DeepSeek/xAI/Qwen, so the UI labels by host.
    let host = "";
    try { host = new URL(cfg.baseUrl).host; } catch { host = cfg.baseUrl; }
    let data;
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await fetch(`${apiBase(cfg)}/models`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(to);
      if (!r.ok) continue;
      data = await r.json();
    } catch { clearTimeout(to); continue; }

    for (const m of data.data || []) {
      if (!m.id) continue;
      if (cfg.kind === "openrouter") {
        // OpenRouter ids are slashed (miss PREFIX_RE) — filter on its richer metadata:
        // keep text-OUTPUT models, drop embeddings / pure image+audio generators.
        const arch = m.architecture || {};
        const outMod = arch.output_modalities || (typeof arch.modality === "string" ? [arch.modality.split("->").pop()] : []);
        if (outMod.length && !outMod.some((x) => /text/i.test(x))) continue;
        if (/embed/i.test(m.id)) continue;
        out.push({
          id: m.id,
          provider: "openrouter",
          host,
          name: m.name || m.id,
          contextLength: m.context_length || 0,
          // Strings like "0.0000001" (per token) — the UI decides how to show them.
          pricing: m.pricing ? { prompt: m.pricing.prompt, completion: m.pricing.completion } : null,
          description: String(m.description || "").slice(0, 300),
        });
      } else {
        if (!isChatModelId(m.id)) continue;
        out.push({ id: m.id, provider: "openai", host, name: m.id, contextLength: contextLengthFor(m.id), pricing: null, description: "" });
      }
    }
  }
  return out;
}

// --- Embeddings ------------------------------------------------------------

// The provider that owns this model via an EXPLICIT allowlist entry (never a
// prefix match). Cloud embedding models are always allowlisted (discover's
// isChatModelId filters embeddings out), so this cleanly distinguishes a real
// cloud embedding id (e.g. `qwen/qwen3-embedding-8b`) from a LOCAL Ollama name
// that merely matches a chat prefix (`qwen3-embedding:8b` matches /^qwen/ but is
// NOT allowlisted → stays local).
function allowlistProvider(model) {
  if (!model) return null;
  for (const p of loadProviders()) if (p.models.length && p.models.includes(model)) return p;
  return null;
}

// Route embeddings: true only for an allowlisted cloud model (see above). Callers
// (embed.js) use this to send the batch to /v1/embeddings vs local Ollama.
function isCloudEmbedModel(model) {
  return allowlistProvider(model) != null;
}

// POST <apiBase>/embeddings (OpenAI-compatible; OpenRouter supports it too).
// Returns an array of vectors aligned to `texts`. Throws on error.
async function embed(model, texts) {
  const cfg = allowlistProvider(model);
  if (!cfg) throw new Error("OpenAI is not configured");
  const r = await fetch(`${apiBase(cfg)}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`OpenAI embeddings ${r.status}${txt ? ": " + extractApiError(txt).slice(0, 200) : ""}`);
  }
  const data = await r.json();
  // OpenAI shape: {data:[{embedding, index}]}. Sort by index to guarantee order.
  return (data.data || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0)).map((d) => d.embedding);
}

// Any OpenAI-compatible provider (openai.json / openrouter.json) configured with
// a key? Used to decide whether the "browse all models" entry is meaningful — an
// openrouter.json without models[] surfaces nothing in the dropdown yet still has
// a full catalog to browse, so a dropdown-only check would miss it.
function hasConfiguredProviders() {
  return loadProviders().length > 0;
}

module.exports = { isOpenAIModel, contextLengthFor, listModels, injectModels, proxyChat, complete, isCloudEmbedModel, embed, listAllModels, hasConfiguredProviders };
