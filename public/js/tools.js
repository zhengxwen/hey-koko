// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Tool definitions + executors for the agentic (tool-calling) chat loop.
// The model decides when to call these; we run them locally and feed back results.
import { dom, state } from './state.js';
import { getPrompt, getPromptLanguage } from './i18n.js';
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
      name: "fetch_url",
      description: "Fetch a web page by its URL and return its main text (title, publish date, article body). Use when the user gives a link or asks about a specific URL, or to read a web_search result in full. For a YouTube link it returns the video's title, channel, date, tags and description, but no transcript. For a page open in the user's co-browsing Chrome, prefer read_chrome_page.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "the full http(s) URL" } },
        required: ["url"],
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
      name: "search_library",
      description: "Search the user's personal knowledge library (imported documents, papers, YouTube transcripts, notes) by meaning. Use when the user asks about content they've saved/imported, or refers to '我库里…', 'my library', 'that doc/paper/video about…'. Returns relevant passages with their source titles.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "what to look up in the library" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_chrome_tabs",
      description: "List the tabs open in the user's co-browsing Chrome (the shared browser hey-koko can read). Use to locate a tab when the user refers to a page that is not the one they are currently viewing.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_chrome_page",
      description: "Read the main content of a page open in the user's co-browsing Chrome. Use when the user asks about 'this page', '当前网页/这个页面', or any tab they have open. Returns the page title, URL, extracted article text, and any text the user has selected on the page. With no arguments it reads the tab the user is currently looking at.",
      parameters: {
        type: "object",
        properties: {
          tab: { type: "string", description: "optional: a tab number from list_chrome_tabs, or a URL/title substring; omit to read the active tab" },
        },
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
  return (dom.embedModelSelect?.value || "").trim() || "qwen3-embedding:8b";
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

// Same /api/fetch-url extraction as /url (site handler → trafilatura → JS heuristic), in
// plain mode: a YouTube link is described from its page metadata (title, channel,
// description…) instead of running the transcript pipeline (yt-dlp / Whisper is far too
// slow for a tool call). Images are dropped.
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)[\w-]{11}/;
const FETCH_URL_MAX_CHARS = 20000;

async function fetchUrl(url) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return "Need a full http(s) URL.";
  try {
    const res = await fetch("/api/fetch-url", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: u, language: getPromptLanguage(), plain: true }),
    });
    const data = await res.json();
    if (!res.ok || data.type === "error") return "Failed to fetch the page: " + (data.content || data.detail || data.error || res.status);
    if (data.type === "unsupported") return data.content;
    let text = String(data.content || "").trim();
    if (!text) return `# ${data.title || u}\n${u}\n\n(no extractable text on this page)`;
    const truncated = text.length > FETCH_URL_MAX_CHARS;
    if (truncated) text = text.slice(0, FETCH_URL_MAX_CHARS);
    const ytNote = YOUTUBE_RE.test(u) ? "\n\n[Video metadata only — no transcript. If the user wants what's said in the video, suggest /url with this link.]" : "";
    return `# ${data.title || u}\n${u}${data.publishedAt ? `\nPublished: ${data.publishedAt}` : ""}\n\n${text}${truncated ? "\n\n[content truncated]" : ""}${ytNote}`;
  } catch (e) { return "Failed to fetch the page: " + e.message; }
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

// Raw semantic retrieval over the knowledge library — the same /api/library/retrieve
// that /ask builds on, NOT the /ask command itself: we hand the model raw passages and
// let the OUTER agentic loop iterate (re-query) if it needs more, rather than nesting a
// second answer-generation or agentic pass inside the tool.
async function searchLibrary(query) {
  try {
    const res = await fetch("/api/library/retrieve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, model: embedModel(), topK: 5 }),
    });
    const data = await res.json();
    if (data.error) return "Library search failed: " + data.error;
    const hits = (data.hits || []).slice(0, 5);
    if (!hits.length) return "No relevant documents in the knowledge library.";
    return hits.map((h, i) => {
      const snip = String(h.content || "").replace(/\s+/g, " ").slice(0, 300);
      return `${i + 1}. [${h.title}${h.section ? " · " + h.section : ""}] ${snip}`;
    }).join("\n\n");
  } catch (e) { return "Library search failed: " + e.message; }
}

// Co-browsing tools — thin wrappers over the server's CDP bridge (server/cdp.js).
// Failures come back as instructive strings so the model can tell the user how to
// start the shared browser instead of just apologizing.
async function listChromeTabs() {
  try {
    const res = await fetch("/api/browser/tabs");
    const data = await res.json();
    if (data.error === "unreachable") return data.hint;
    if (data.error) return "Browser bridge failed: " + data.error;
    const tabs = data.tabs || [];
    if (!tabs.length) return "The co-browsing Chrome is running but has no web page tabs open.";
    return tabs.map((t) => `${t.index}. ${t.active ? "▶ " : ""}${t.title || "(untitled)"}\n(${t.url})`).join("\n");
  } catch (e) { return "Browser bridge failed: " + e.message; }
}

async function readChromePage(tab) {
  try {
    const res = await fetch("/api/browser/read", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tab: tab || "" }),
    });
    const data = await res.json();
    if (data.error === "unreachable") return data.hint;
    if (data.error === "no_tabs") return "The co-browsing Chrome is running but has no web page tabs open.";
    if (data.error === "tab_not_found") return "No tab matched that. Open tabs:\n" + (data.tabs || []).join("\n");
    if (data.error) return "Failed to read the page: " + data.error;
    let out = `# ${data.title}\n${data.url}\n\n${data.text || "(no extractable text on this page)"}`;
    if (data.selection) out = `Text the user has SELECTED on the page (likely what they're asking about):\n"""\n${data.selection}\n"""\n\n` + out;
    if (data.truncated) out += "\n\n[content truncated]";
    return out;
  } catch (e) { return "Browser bridge failed: " + e.message; }
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
    case "fetch_url": return await fetchUrl(args.url);
    case "recall_memory": return await recallMemory(args.query || "");
    case "search_library": return await searchLibrary(args.query || "");
    case "list_chrome_tabs": return await listChromeTabs();
    case "read_chrome_page": return await readChromePage(args.tab || "");
    case "set_reminder": return setReminder(args.when, args.text);
    case "remember_fact": return rememberFact(args.fact);
    default: return `Unknown tool: ${name}`;
  }
}

export function getToolLabel(name, args) {
  const a = args || {};
  if (name === "web_search") return `web_search("${a.query || ""}")`;
  if (name === "fetch_url") return `fetch_url("${a.url || ""}")`;
  if (name === "recall_memory") return `recall_memory("${a.query || ""}")`;
  if (name === "search_library") return `search_library("${a.query || ""}")`;
  if (name === "calculate") return `calculate(${a.expression || ""})`;
  if (name === "get_datetime") return "get_datetime()";
  if (name === "list_chrome_tabs") return "list_chrome_tabs()";
  if (name === "read_chrome_page") return `read_chrome_page(${a.tab ? `"${a.tab}"` : ""})`;
  if (name === "set_reminder") return `set_reminder("${a.when || ""}", "${a.text || ""}")`;
  if (name === "remember_fact") return `remember_fact("${a.fact || ""}")`;
  return name;
}

// How the tools dialog (tools-dialog.js) groups them. Reads vs. writes is the split
// that matters to the user: the "actions" group changes their data (reminders, memory).
export const TOOL_GROUPS = [
  { key: "basic", tools: ["get_datetime", "calculate"] },
  { key: "web", tools: ["web_search", "fetch_url", "list_chrome_tabs", "read_chrome_page"] },
  { key: "knowledge", tools: ["recall_memory", "search_library"] },
  { key: "actions", tools: ["set_reminder", "remember_fact"] },
];

// Per-tool opt-out, persisted as the DISABLED names (settings.js `disabledTools`) so a
// tool added later starts enabled. Independent of the master tool-use toggle.
export function isToolEnabled(name) {
  return !state.disabledTools.includes(name);
}

export function setToolEnabled(name, on) {
  const rest = state.disabledTools.filter((n) => n !== name);
  state.disabledTools = on ? rest : [...rest, name];
}

// The tool set actually offered to the model: TOOL_SCHEMAS minus the disabled ones.
export function activeToolSchemas() {
  return TOOL_SCHEMAS.filter((t) => isToolEnabled(t.function.name));
}

// Whether a reply should go through the agent loop: the master toggle is on AND at
// least one tool survives the per-tool opt-outs (an empty tools array is pointless).
export function toolsActive() {
  return !!dom.toolsToggle?.checked && activeToolSchemas().length > 0;
}

// System-prompt hint listing only the tools actually offered — naming a tool the
// model can't call invites hallucinated calls to it.
export function toolsSystemHint() {
  const list = activeToolSchemas().map((t) => getPrompt("toolHint_" + t.function.name));
  return getPrompt("toolsSystem", list);
}
