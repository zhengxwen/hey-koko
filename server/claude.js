// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Hidden cloud feature: proxy the local chat protocol to the Claude API.
//
// The frontend speaks Ollama's chat shape everywhere (messages[] in, NDJSON
// chunks out, {message:{content}} per line, tool_calls for function calling).
// This module makes Claude look like just another entry in the model dropdown:
//   - listModels()  merges Claude model names into /api/models (only when a key
//                   is configured), so selecting one routes here.
//   - proxyChat()   translates Ollama<->Anthropic and re-emits the exact NDJSON
//                   (streaming) or single-JSON (stream:false) shape the frontend
//                   already consumes — so no frontend change is needed.
//
// Config lives OUTSIDE the repo, in ~/.hey-koko/claude.json:
//   { "baseUrl": "https://...", "apiKey": "sk-ant-...", "models": ["claude-opus-4-8"] }
// baseUrl is the origin only (no /v1/messages suffix). Env vars override the
// file: ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY. No key -> feature stays hidden.
// The file is re-read per request, so edits take effect without a restart.

const fs = require("fs");
const path = require("path");
const config = require("./config");
const { sendJson, describeFetchError } = require("./utils");

const CLAUDE_CONFIG_PATH = path.join(config.DATA_DIR, "claude.json");
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODELS = ["claude-opus-4-8", "claude-sonnet-4-6"];
const ANTHROPIC_VERSION = "2023-06-01";

// Which model ids belong to the Claude family. Normally `claude-*` (incl. claude-fable-5),
// but a relay may surface a Claude model under a bare family name (fable-*/mythos-*) — accept
// those too so Fable/Mythos models still list AND route. denoiseModelIds already knows these
// families. Kept in sync across discover / routing / browse.
const CLAUDE_RE = /^(claude|fable|mythos)/i;

// Architectural context window per model (for /api/model-info — Claude has no
// Ollama-style /api/show, so the context meter reads these instead).
const CONTEXT_LENGTHS = {
  "claude-fable-5": 1000000,
  "claude-opus-4-8": 1000000,
  "claude-opus-4-7": 1000000,
  "claude-opus-4-6": 1000000,
  "claude-sonnet-4-6": 1000000,
  "claude-haiku-4-5": 200000,
};

// Read ~/.hey-koko/claude.json, apply env overrides. Returns null when no API
// key is available (the whole feature stays invisible in that case).
function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CLAUDE_CONFIG_PATH, "utf8"));
  } catch {
    file = {};
  }
  const apiKey = process.env.ANTHROPIC_API_KEY || file.apiKey || "";
  if (!apiKey) return null;
  let baseUrl = (process.env.ANTHROPIC_BASE_URL || file.baseUrl || DEFAULT_BASE_URL).trim();
  baseUrl = baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = "https://" + baseUrl;
  // models[] is OPTIONAL: present → manual allowlist; empty/absent → auto-discover
  // via the Models API (see discoverModels).
  const models = Array.isArray(file.models) ? file.models : [];
  return { apiKey, baseUrl, models };
}

// Cache of auto-discovered Claude model ids + their real context windows, so we
// don't hit /v1/models on every /api/models poll. 5-minute TTL.
let _discovered = { ts: 0, ids: null, ctx: {} };
const DISCOVER_TTL_MS = 5 * 60 * 1000;

// Compare two version tuples (e.g. [4,8] vs [4,6]) numerically, left to right.
function cmpVer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Built-in denoise for AUTO mode (manual models[] bypasses this): keep only the
// newest version PER FAMILY (opus/sonnet/haiku/fable/mythos), preferring the
// undated alias over a dated snapshot. A flat "min version" floor can't work —
// families sit at different current versions (opus 4.8, sonnet 4.6, haiku 4.5) —
// so newest-per-family is what keeps each family's current model and drops the
// rest. Unrecognized families are kept as-is (fail open). Never fabricates an id:
// the date is stripped only to COMPARE versions; the original id string is emitted.
function denoiseModelIds(ids) {
  const passthrough = [];
  const best = new Map(); // family -> { id, ver, dated }
  for (const id of ids) {
    const fam = (id.match(/opus|sonnet|haiku|fable|mythos/i) || [null])[0];
    if (!fam) { passthrough.push(id); continue; }
    const stripped = id.replace(/-\d{8}\b/, "").replace(/@.*$/, ""); // drop date for comparison only
    const ver = (stripped.match(/\d+/g) || []).map(Number);
    const dated = id !== stripped;
    const key = fam.toLowerCase();
    const cur = best.get(key);
    const c = cur ? cmpVer(ver, cur.ver) : 1;
    // Higher version wins; on a tie prefer the undated alias.
    if (!cur || c > 0 || (c === 0 && cur.dated && !dated)) best.set(key, { id, ver, dated });
  }
  return [...passthrough, ...[...best.values()].map((v) => v.id)];
}

// GET <baseUrl>/v1/models → claude-* ids + max_input_tokens. Returns null on any
// failure (relay doesn't implement it, network error, empty) so callers fall back.
async function discoverModels(cfg) {
  const now = Date.now();
  if (_discovered.ids && now - _discovered.ts < DISCOVER_TTL_MS) return _discovered;
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`${cfg.baseUrl}/v1/models?limit=1000`, {
      headers: { "x-api-key": cfg.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      signal: controller.signal,
    });
    clearTimeout(to);
    if (!r.ok) return null;
    const data = await r.json();
    const rawIds = [];
    const ctx = {};
    for (const m of data.data || []) {
      if (!m.id || !CLAUDE_RE.test(m.id)) continue;
      rawIds.push(m.id);
      if (m.max_input_tokens) ctx[m.id] = m.max_input_tokens;
    }
    if (!rawIds.length) return null;
    const ids = denoiseModelIds(rawIds); // newest-per-family; manual models[] never reaches here
    _discovered = { ts: now, ids, ctx };
    return _discovered;
  } catch {
    clearTimeout(to);
    return null;
  }
}

// Is this model name a Claude model? Drives /api/chat routing — must be fast and
// network-free (called per message). Manual allowlist wins; in auto mode any
// claude-* id routes to the cloud (we only ever surface claude-* names).
function isClaudeModel(model) {
  if (!model) return false;
  const cfg = loadConfig();
  if (!cfg) return false;
  // Manual allowlist wins, but a `claude-*` id ALWAYS routes here even when it isn't
  // listed — so ad-hoc picks from the "browse all models" dialog work. Safe: we only
  // ever surface claude-* names, OpenRouter's `anthropic/claude-…` starts with
  // "anthropic/" (not "claude") so it never collides, and this check runs first.
  if (cfg.models.includes(model)) return true;
  return CLAUDE_RE.test(model);
}

function contextLengthFor(model) {
  if (_discovered.ctx && _discovered.ctx[model]) return _discovered.ctx[model];
  return CONTEXT_LENGTHS[model] || 200000;
}

// GET /api/models — Ollama tags plus configured/discovered Claude models appended.
async function listModels(res) {
  let models = [];
  try {
    const r = await fetch(`${config.ollamaUrl}/api/tags`);
    if (r.ok) models = (await r.json()).models || [];
  } catch {
    models = [];
  }
  const cfg = loadConfig();
  if (cfg) {
    let claudeIds;
    if (cfg.models.length) {
      claudeIds = cfg.models;                       // manual allowlist
    } else {
      const disc = await discoverModels(cfg);       // auto-discover
      claudeIds = disc ? disc.ids : DEFAULT_MODELS; // fallback if /v1/models unavailable
    }
    const existing = new Set(models.map((m) => m.name));
    for (const name of claudeIds) {
      // cloud:true lets the frontend badge these (☁️) apart from local models.
      if (!existing.has(name)) models.push({ name, model: name, cloud: true });
    }
  }
  // Sibling cloud provider: append any configured OpenAI models too, so a single
  // /api/models poll carries both clouds (no-op if OpenAI isn't configured).
  let openaiConfigured = false;
  try { const oa = require("./openai"); await oa.injectModels(models); openaiConfigured = oa.hasConfiguredProviders(); } catch { /* openai optional */ }
  // cloudConfigured: any cloud backend has a key (Claude, or an OpenAI-compatible
  // provider). Drives whether the "browse all models" entry appears — hidden for
  // pure-local users. Reflects config presence, not whether models surfaced above.
  const cloudConfigured = !!cfg || openaiConfigured;
  sendJson(res, 200, { models, cloudConfigured });
}

// --- Ollama -> Anthropic translation --------------------------------------

function sniffImageMime(b64) {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

// Convert Ollama-shaped messages into Anthropic {system, messages}.
// Handles: system extraction, base64 images, and the function-calling round
// trip (assistant.tool_calls -> tool_use blocks; role:"tool" -> tool_result
// blocks matched to the preceding tool_use ids by order — the frontend always
// emits tool results in the same order as the calls).
function toAnthropicMessages(ollamaMessages) {
  let system = "";
  const out = [];
  let pendingToolUseIds = [];
  let toolResults = [];

  const flushToolResults = () => {
    if (toolResults.length) {
      out.push({ role: "user", content: toolResults });
      toolResults = [];
    }
  };

  for (const m of ollamaMessages || []) {
    const role = m.role;

    if (role === "system") {
      system += (system ? "\n\n" : "") + (m.content || "");
      continue;
    }

    if (role === "tool") {
      const id = pendingToolUseIds.shift() || ("toolu_" + Math.random().toString(36).slice(2, 10));
      toolResults.push({ type: "tool_result", tool_use_id: id, content: String(m.content ?? "") });
      continue;
    }

    flushToolResults();

    if (role === "user") {
      const blocks = [];
      if (Array.isArray(m.images)) {
        for (const img of m.images) {
          const data = String(img).replace(/^data:[^;]+;base64,/, "");
          blocks.push({ type: "image", source: { type: "base64", media_type: sniffImageMime(data), data } });
        }
      }
      const text = typeof m.content === "string" ? m.content : "";
      if (text) blocks.push({ type: "text", text });
      if (!blocks.length) blocks.push({ type: "text", text: " " });
      out.push({ role: "user", content: blocks });
    } else if (role === "assistant") {
      const blocks = [];
      // Reinject preserved Claude thinking blocks FIRST, verbatim — Anthropic
      // requires thinking before text/tool_use and rejects a tool_use turn whose
      // thinking block is missing or modified. (Only present on replayed tool turns.)
      if (Array.isArray(m.thinking_blocks)) for (const tb of m.thinking_blocks) blocks.push(tb);
      if (m.content) blocks.push({ type: "text", text: m.content });
      pendingToolUseIds = [];
      if (Array.isArray(m.tool_calls)) {
        for (let i = 0; i < m.tool_calls.length; i++) {
          const fn = m.tool_calls[i].function || {};
          const id = "toolu_" + i + "_" + Math.random().toString(36).slice(2, 8);
          pendingToolUseIds.push(id);
          let input = fn.arguments;
          if (typeof input === "string") {
            try { input = JSON.parse(input); } catch { input = {}; }
          }
          blocks.push({ type: "tool_use", id, name: fn.name, input: input || {} });
        }
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    }
  }
  flushToolResults();

  // Anthropic wants alternating roles; merge accidental same-role runs.
  const merged = [];
  for (const msg of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) last.content = last.content.concat(msg.content);
    else merged.push({ role: msg.role, content: msg.content.slice() });
  }
  return { system, messages: merged };
}

function toAnthropicTools(ollamaTools) {
  if (!Array.isArray(ollamaTools) || !ollamaTools.length) return undefined;
  return ollamaTools.map((t) => {
    const fn = t.function || t;
    return {
      name: fn.name,
      description: fn.description || "",
      input_schema: fn.parameters || { type: "object", properties: {} },
    };
  });
}

// --- Chat proxy ------------------------------------------------------------

async function proxyChat(res, body) {
  const cfg = loadConfig();
  if (!cfg) {
    sendJson(res, 400, { error: "Claude is not configured." });
    return;
  }

  const { system, messages } = toAnthropicMessages(body.messages);
  const tools = toAnthropicTools(body.tools);
  const wantStream = body.stream !== false;
  // Adaptive thinking is ALWAYS on. Rationale: Opus 4.8 with thinking OFF tends to
  // leak analytical reasoning into the visible reply, which reads cold and verbose
  // for a companion chat — turning it on keeps replies direct and in-character.
  // Tool turns are safe now too: the non-streaming path returns the raw thinking
  // blocks as `message.thinking_blocks`, the frontend tool loop echoes them back on
  // the replayed assistant turn, and toAnthropicMessages reinjects them verbatim
  // before the tool_use (Anthropic 400s if a tool_use turn is replayed without its
  // thinking block, and rejects modified blocks).
  const think = true;
  // Reveal the (summarized) reasoning only when the user enabled "show thinking";
  // otherwise the model still thinks but the reasoning is omitted from the stream.
  // This is a VIEW setting and nothing else — `think` carries the separate question of
  // whether to think at all, which on this backend is answered above (always yes).
  const thinkingDisplay = body.showThinking ? "summarized" : "omitted";
  const numPredict = body.options && body.options.num_predict;
  const maxTokens = numPredict && numPredict > 0 ? numPredict : (wantStream ? 32000 : 16000);

  // Note: temperature/top_p are intentionally NOT forwarded — Opus 4.8/4.7
  // reject sampling params outright, so dropping them keeps every model valid.
  // ⚙ "Thinking effort". Anthropic spells it output_config.effort — a sibling of
  // adaptive thinking, not a replacement for it: thinking stays on, this says how deep.
  // Left off, the API's own default (high) applies. The two top levels are newer than
  // some models, so a 400 falls back to no effort at all rather than to a level the
  // caller did not ask for.
  const effort = ["low", "medium", "high", "xhigh", "max"].includes(body.thinkEffort)
    ? body.thinkEffort
    // ⚙ "Thinking off" lands on the lowest effort rather than thinking: {type:"disabled"}.
    // Disabling it here is not the cheap version of thinking less: Opus writes its
    // reasoning into the visible reply instead, sometimes writes a tool call as plain
    // text (so the call never runs), and our tool turns depend on replaying thinking
    // blocks verbatim. Lowest effort buys the same speed without any of that.
    : (body.think === false ? "low" : "");
  const payload = {
    model: body.model,
    max_tokens: maxTokens,
    messages,
    stream: wantStream,
    ...(system ? { system } : {}),
    ...(tools ? { tools } : {}),
    ...(think ? { thinking: { type: "adaptive", display: thinkingDisplay } } : {}),
    ...(effort ? { output_config: { effort } } : {}),
  };

  const controller = new AbortController();
  let timeoutHandle = null;
  if (body.timeout && body.timeout > 0) {
    const ms = Math.min(600, Math.max(60, body.timeout)) * 1000;
    timeoutHandle = setTimeout(() => controller.abort(), ms);
  }

  const ask = (p) => fetch(`${cfg.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(p),
    signal: controller.signal,
  });

  let response;
  try {
    response = await ask(payload);
    // A model older than the level asked for rejects it outright. The user asked for
    // more thinking, not for an error, so drop the level once and let the model's own
    // default stand — logged, because nothing on their side needs fixing.
    if (!response.ok && response.status === 400 && effort) {
      const why = await response.text().catch(() => "");
      console.log(`[claude] effort "${effort}" refused (${why.trim().slice(0, 120)}) — retrying without it`);
      const { output_config: _drop, ...noEffort } = payload;
      response = await ask(noEffort);
    }
  } catch (error) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (error.name === "AbortError") {
      sendJson(res, 504, { error: "Request timed out: Claude exceeded the configured response time limit." });
    } else {
      sendJson(res, 502, { error: await describeFetchError(error, `${cfg.baseUrl}/v1/messages`, "the Claude service"), detail: error.message });
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
      sendJson(res, 502, { error: "Claude returned a response that could not be parsed.", detail: e.message });
      return;
    }
    if (timeoutHandle) clearTimeout(timeoutHandle);
    let content = "";
    let thinking = "";
    const toolCalls = [];
    const thinkingBlocks = []; // RAW Anthropic thinking blocks (incl. signature) for replay
    for (const block of data.content || []) {
      if (block.type === "text") content += block.text || "";
      else if (block.type === "thinking") { thinking += block.thinking || ""; thinkingBlocks.push(block); }
      else if (block.type === "redacted_thinking") { thinkingBlocks.push(block); }
      else if (block.type === "tool_use") toolCalls.push({ function: { name: block.name, arguments: block.input || {} } });
    }
    const message = { role: "assistant", content };
    if (thinking) message.thinking = thinking;
    if (toolCalls.length) message.tool_calls = toolCalls;
    // Only matters on tool turns: the frontend echoes this back so we can reinject
    // the thinking blocks verbatim before the tool_use on the next iteration.
    if (thinkingBlocks.length && toolCalls.length) message.thinking_blocks = thinkingBlocks;
    sendJson(res, 200, {
      model: body.model,
      message,
      done: true,
      prompt_eval_count: data.usage?.input_tokens || 0,
      eval_count: data.usage?.output_tokens || 0,
    });
    return;
  }

  // Streaming: translate Anthropic SSE -> Ollama NDJSON (one {message:{content}}
  // per line, final line carries done + token counts for the context meter).
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
        let evt;
        try { evt = JSON.parse(dataStr); } catch { continue; }

        if (evt.type === "message_start") {
          inputTokens = evt.message?.usage?.input_tokens || 0;
        } else if (evt.type === "content_block_delta") {
          const d = evt.delta || {};
          if (d.type === "text_delta" && d.text) {
            writeChunk({ message: { role: "assistant", content: d.text }, done: false });
          } else if (d.type === "thinking_delta" && d.thinking) {
            writeChunk({ message: { role: "assistant", content: "", thinking: d.thinking }, done: false });
          }
        } else if (evt.type === "message_delta") {
          if (evt.usage?.output_tokens) outputTokens = evt.usage.output_tokens;
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
// Throws on error. temperature is intentionally dropped (Opus 4.8/4.7 reject it).
async function complete(model, messages, { signal } = {}) {
  const cfg = loadConfig();
  if (!cfg) throw new Error("Claude is not configured");
  const { system, messages: anthMessages } = toAnthropicMessages(messages);
  const payload = {
    model,
    max_tokens: 16000,
    messages: anthMessages,
    ...(system ? { system } : {}),
  };
  const r = await fetch(`${cfg.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    let msg = txt;
    try { msg = JSON.parse(txt).error?.message || txt; } catch { /* keep raw */ }
    throw new Error(`Claude ${r.status}${msg ? ": " + String(msg).slice(0, 200) : ""}`);
  }
  const data = await r.json();
  let text = "";
  for (const b of data.content || []) if (b.type === "text") text += b.text || "";
  return text;
}

// Full Claude catalog for the "browse all models" dialog — every claude-* id the key
// can list (NOT denoised, unlike discoverModels which trims to newest-per-family), with
// the endpoint host + context window. Returns [] when unconfigured / unreachable.
async function listAllModels() {
  const cfg = loadConfig();
  if (!cfg) return [];
  let host = "";
  try { host = new URL(cfg.baseUrl).host; } catch { host = cfg.baseUrl; }
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(`${cfg.baseUrl}/v1/models?limit=1000`, {
      headers: { "x-api-key": cfg.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      signal: controller.signal,
    });
    clearTimeout(to);
    if (!r.ok) return [];
    const data = await r.json();
    const out = [];
    for (const m of data.data || []) {
      if (!m.id || !CLAUDE_RE.test(m.id)) continue;
      out.push({
        id: m.id,
        provider: "claude",
        host,
        name: m.display_name || m.id,
        contextLength: m.max_input_tokens || contextLengthFor(m.id),  // Anthropic omits it; map fallback
        pricing: null,  // the Models API doesn't expose pricing
        description: "",
      });
    }
    return out;
  } catch { clearTimeout(to); return []; }
}

module.exports = { isClaudeModel, contextLengthFor, listModels, proxyChat, complete, listAllModels };
