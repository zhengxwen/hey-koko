// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Tool definitions + executors for the agentic (tool-calling) chat loop.
// The model decides when to call these; we run them locally and feed back results.
import { dom } from './state.js';
import { parseRemind, addReminder, describeReminder } from './proactive.js';
import { addMemory } from './memory.js';

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "get_datetime",
      description: "Get the current local date, time and weekday. Use whenever the user asks about 'now', today, the current date or time.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description: "Evaluate an arithmetic expression like '23*47+9'. Use for any math instead of computing it yourself.",
      parameters: {
        type: "object",
        properties: { expression: { type: "string", description: "arithmetic using numbers and + - * / ( ) % ." } },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web (DuckDuckGo) for current or time-sensitive information: news, weather, prices, latest versions, recent events.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "the search query" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_memory",
      description: "Search the user's past archived conversations by meaning. Use when the user refers to something discussed before (e.g. '我们之前聊过…', 'you mentioned…', 'last time…').",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "what to recall" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reminder",
      description: "Schedule a reminder for the user. Use when they ask to be reminded of something at a time.",
      parameters: {
        type: "object",
        properties: {
          when: { type: "string", description: "time spec: relative like '30m' or '2h'; absolute 'HH:MM' (e.g. '18:00'); tomorrow '明天 9:00'; or daily '每天 8:00'" },
          text: { type: "string", description: "what to remind them about" },
        },
        required: ["when", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember_fact",
      description: "Save a durable fact about the user to long-term memory. Use when the user shares a stable preference/detail or asks you to remember something.",
      parameters: {
        type: "object",
        properties: { fact: { type: "string", description: "the fact, in third person (e.g. 'The user enjoys birdwatching')" } },
        required: ["fact"],
      },
    },
  },
];

function embedModel() {
  return (dom.embedModelSelect?.value || "").trim() || "qwen3-embedding:0.6b";
}

function getDatetime() {
  return new Date().toLocaleString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function calculate(expr) {
  const e = String(expr || "").trim();
  if (!e || !/^[\d\s+\-*/().%]+$/.test(e)) return "Error: only numbers and + - * / ( ) % . are allowed.";
  try {
    const val = Function('"use strict"; return (' + e + ");")();
    return Number.isFinite(val) ? String(val) : "Error: not a finite number.";
  } catch { return "Error: invalid expression."; }
}

async function webSearch(query) {
  try {
    const res = await fetch("/api/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (data.error === "captcha") return "Web search is rate-limited right now; try again later.";
    const results = data.results || [];
    if (!results.length) return "No results found.";
    return results.slice(0, 5).map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\n(${r.url})`).join("\n\n");
  } catch (e) { return "Search failed: " + e.message; }
}

async function recallMemory(query) {
  try {
    const res = await fetch("/api/archives/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, model: embedModel() }),
    });
    const data = await res.json();
    if (data.needsIndex) return "No archive index yet — ask the user to build it in 档案浏览 → 语义.";
    const results = (data.results || []).filter((r) => r.score > 0.15).slice(0, 3);
    if (!results.length) return "Nothing relevant found in past conversations.";
    return results.map((r, i) => `${i + 1}. [${r.title}] ${r.snippet}`).join("\n\n");
  } catch (e) { return "Recall failed: " + e.message; }
}

function setReminder(when, text) {
  const w = String(when || "").trim()
    .replace(/(\d+)\s*(?:minutes?|mins?)\b/i, "$1m")
    .replace(/(\d+)\s*(?:hours?|hrs?)\b/i, "$1h");
  const t = String(text || "").trim();
  if (!w || !t) return "Need both a time and what to remind about.";
  const parsed = parseRemind(`/remind ${w} ${t}`);
  if (parsed.error) return "Couldn't parse the time. Use forms like 30m, 2h, 18:00, 明天 9:00, or 每天 8:00.";
  addReminder(parsed.reminder);
  return `Reminder set for ${describeReminder(parsed.reminder)}: ${parsed.reminder.text}`;
}

function rememberFact(fact) {
  const f = String(fact || "").trim();
  if (!f) return "Empty fact, nothing saved.";
  return addMemory(f) ? `Saved to long-term memory: ${f}` : "Already remembered something equivalent.";
}

export async function executeTool(name, args) {
  args = args || {};
  switch (name) {
    case "get_datetime": return getDatetime();
    case "calculate": return calculate(args.expression);
    case "web_search": return await webSearch(args.query || "");
    case "recall_memory": return await recallMemory(args.query || "");
    case "set_reminder": return setReminder(args.when, args.text);
    case "remember_fact": return rememberFact(args.fact);
    default: return `Unknown tool: ${name}`;
  }
}

export function getToolLabel(name, args) {
  const a = args || {};
  if (name === "web_search") return `web_search("${a.query || ""}")`;
  if (name === "recall_memory") return `recall_memory("${a.query || ""}")`;
  if (name === "calculate") return `calculate(${a.expression || ""})`;
  if (name === "get_datetime") return "get_datetime()";
  if (name === "set_reminder") return `set_reminder("${a.when || ""}", "${a.text || ""}")`;
  if (name === "remember_fact") return `remember_fact("${a.fact || ""}")`;
  return name;
}