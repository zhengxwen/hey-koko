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
const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_MODELS = ["gpt-5", "gpt-4o"];

// Architectural context window per model (for /api/model-info — OpenAI's
// /v1/models does NOT report a context length, unlike Anthropic, so we read
// these instead). Prefix-matched longest-first in contextLengthFor().
const CONTEXT_LENGTHS = {
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
};

// Reasoning-family models (o-series + gpt-5) behave differently: max_completion_tokens
// instead of max_tokens, no temperature/top_p, and a "developer" system role.
function isReasoningModel(model) {
  return /^(o1|o3|o4|gpt-5)/i.test(model || "");
}

// Read ~/.hey-koko/openai.json, apply env overrides. Returns null when no API
// key is available (the whole feature stays invisible in that case).
function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(OPENAI_CONFIG_PATH, "utf8"));
  } catch {
    file = {};
  }
  const apiKey = process.env.OPENAI_API_KEY || file.apiKey || "";
  if (!apiKey) return null;
  let baseUrl = (process.env.OPENAI_BASE_URL || file.baseUrl || DEFAULT_BASE_URL).trim();
  baseUrl = baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = "https://" + baseUrl;
  // Tolerate a baseUrl that already ends in /v1 (common for OpenAI-compatible
  // relays) — apiBase() below normalizes it so we never double up the segment.
  const models = Array.isArray(file.models) ? file.models : [];
  return { apiKey, baseUrl, models };
}

// The /v1 prefix. Callers append "/chat/completions" or "/models".
function apiBase(cfg) {
  return /\/v1$/i.test(cfg.baseUrl) ? cfg.baseUrl : cfg.baseUrl + "/v1";
}

// Cache of auto-discovered chat model ids, so we don't hit /v1/models on every
// /api/models poll. 5-minute TTL.
let _discovered = { ts: 0, ids: null };
const DISCOVER_TTL_MS = 5 * 60 * 1000;

// OpenAI's /v1/models lists EVERYTHING (embeddings, tts, whisper, dall-e, moderation,
// dated snapshots…). Keep only chat-capable text models and drop the noise.
function isChatModelId(id) {
  if (!/^(gpt-|o1|o3|o4|chatgpt-)/i.test(id)) return false;
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
  if (_discovered.ids && now - _discovered.ts < DISCOVER_TTL_MS) return _discovered;
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
    _discovered = { ts: now, ids: denoiseModelIds(rawIds) };
    return _discovered;
  } catch {
    clearTimeout(to);
    return null;
  }
}

// Is this model name an OpenAI model? Drives /api/chat routing — must be fast and
// network-free (called per message). Manual allowlist wins; otherwise fall back
// to a prefix match on the known OpenAI families.
function isOpenAIModel(model) {
  if (!model) return false;
  const cfg = loadConfig();
  if (!cfg) return false;
  if (cfg.models.length) return cfg.models.includes(model);
  return /^(gpt-|o1|o3|o4|chatgpt-)/i.test(model);
}

function contextLengthFor(model) {
  const keys = Object.keys(CONTEXT_LENGTHS).sort((a, b) => b.length - a.length);
  for (const k of keys) if (model && model.toLowerCase().startsWith(k)) return CONTEXT_LENGTHS[k];
  return 128000;
}

// Append configured/discovered OpenAI models to an existing model list (mutates
// it in place). Called by claude.listModels so /api/models carries both clouds.
// cloud:true lets the frontend badge these (☁️) apart from local Ollama models.
async function injectModels(models) {
  const cfg = loadConfig();
  if (!cfg) return;
  let ids;
  if (cfg.models.length) {
    ids = cfg.models;                                   // manual allowlist
  } else {
    const disc = await discoverModels(cfg);             // auto-discover
    ids = disc ? disc.ids : DEFAULT_MODELS;             // fallback if /v1/models unavailable
  }
  const existing = new Set(models.map((m) => m.name));
  for (const name of ids) {
    if (!existing.has(name)) models.push({ name, model: name, cloud: true });
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
function buildPayload({ model, messages, tools, stream, maxTokens, temperature }) {
  const reasoning = isReasoningModel(model);
  const payload = { model, messages, stream };
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

// --- Chat proxy ------------------------------------------------------------

async function proxyChat(res, body) {
  const cfg = loadConfig();
  if (!cfg) {
    sendJson(res, 400, { error: "OpenAI 未配置。" });
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

  const payload = buildPayload({ model: body.model, messages, tools, stream: wantStream, maxTokens, temperature });

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
      sendJson(res, 504, { error: "请求超时，OpenAI 响应时间超过设定限制。" });
    } else {
      sendJson(res, 502, { error: "无法连接 OpenAI 服务。请检查 base URL 与网络。", detail: error.message });
    }
    return;
  }

  if (!response.ok) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const text = await response.text();
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch { /* keep raw */ }
    sendJson(res, response.status, { error: msg || response.statusText });
    return;
  }

  // Non-streaming: single JSON object in Ollama's shape (tool-calling turns).
  if (!wantStream) {
    let data;
    try { data = await response.json(); } catch (e) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      sendJson(res, 502, { error: "OpenAI 返回了无法解析的响应。", detail: e.message });
      return;
    }
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const choice = (data.choices && data.choices[0]) || {};
    const cm = choice.message || {};
    const message = { role: "assistant", content: cm.content || "" };
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
        if (!dataStr || dataStr === "[DONE]") continue;
        let evt;
        try { evt = JSON.parse(dataStr); } catch { continue; }

        // With stream_options.include_usage, the final data chunk has empty
        // choices[] and a usage block.
        if (evt.usage) {
          inputTokens = evt.usage.prompt_tokens || inputTokens;
          outputTokens = evt.usage.completion_tokens || outputTokens;
        }
        const delta = evt.choices && evt.choices[0] && evt.choices[0].delta;
        if (delta && delta.content) {
          writeChunk({ message: { role: "assistant", content: delta.content }, done: false });
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
  const cfg = loadConfig();
  if (!cfg) throw new Error("OpenAI 未配置");
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

module.exports = { isOpenAIModel, contextLengthFor, listModels, injectModels, proxyChat, complete };
