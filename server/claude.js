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
const os = require("os");
const path = require("path");
const config = require("./config");
const { sendJson } = require("./utils");

const CLAUDE_CONFIG_PATH = path.join(os.homedir(), ".hey-koko", "claude.json");
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODELS = ["claude-opus-4-8", "claude-sonnet-4-6"];
const ANTHROPIC_VERSION = "2023-06-01";

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
  const models = Array.isArray(file.models) && file.models.length ? file.models : DEFAULT_MODELS;
  return { apiKey, baseUrl, models };
}

// Is this model name one of the configured Claude models? Drives routing.
function isClaudeModel(model) {
  if (!model) return false;
  const cfg = loadConfig();
  return !!cfg && cfg.models.includes(model);
}

function contextLengthFor(model) {
  return CONTEXT_LENGTHS[model] || 200000;
}

// GET /api/models — Ollama tags plus any configured Claude models appended.
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
    const existing = new Set(models.map((m) => m.name));
    for (const name of cfg.models) {
      if (!existing.has(name)) models.push({ name, model: name });
    }
  }
  sendJson(res, 200, { models });
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
    sendJson(res, 400, { error: "Claude 未配置。" });
    return;
  }

  const { system, messages } = toAnthropicMessages(body.messages);
  const tools = toAnthropicTools(body.tools);
  const wantStream = body.stream !== false;
  // Adaptive thinking only when there are no tools: the frontend drops thinking
  // blocks when it replays the tool-call turn, which would otherwise 400.
  const think = !!body.think && !tools;
  const numPredict = body.options && body.options.num_predict;
  const maxTokens = numPredict && numPredict > 0 ? numPredict : (wantStream ? 32000 : 16000);

  // Note: temperature/top_p are intentionally NOT forwarded — Opus 4.8/4.7
  // reject sampling params outright, so dropping them keeps every model valid.
  const payload = {
    model: body.model,
    max_tokens: maxTokens,
    messages,
    stream: wantStream,
    ...(system ? { system } : {}),
    ...(tools ? { tools } : {}),
    ...(think ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
  };

  const controller = new AbortController();
  let timeoutHandle = null;
  if (body.timeout && body.timeout > 0) {
    const ms = Math.min(600, Math.max(60, body.timeout)) * 1000;
    timeoutHandle = setTimeout(() => controller.abort(), ms);
  }

  let response;
  try {
    response = await fetch(`${cfg.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (error.name === "AbortError") {
      sendJson(res, 504, { error: "请求超时，Claude 响应时间超过设定限制。" });
    } else {
      sendJson(res, 502, { error: "无法连接 Claude 服务。请检查 base URL 与网络。", detail: error.message });
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
      sendJson(res, 502, { error: "Claude 返回了无法解析的响应。", detail: e.message });
      return;
    }
    if (timeoutHandle) clearTimeout(timeoutHandle);
    let content = "";
    let thinking = "";
    const toolCalls = [];
    for (const block of data.content || []) {
      if (block.type === "text") content += block.text || "";
      else if (block.type === "thinking") thinking += block.thinking || "";
      else if (block.type === "tool_use") toolCalls.push({ function: { name: block.name, arguments: block.input || {} } });
    }
    const message = { role: "assistant", content };
    if (thinking) message.thinking = thinking;
    if (toolCalls.length) message.tool_calls = toolCalls;
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

module.exports = { isClaudeModel, contextLengthFor, listModels, proxyChat };
