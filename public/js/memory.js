// Long-term memory: durable facts about the user, injected into every
// conversation's system prompt so the companion remembers across chats.
import { dbSaveMemories, dbLoadMemories } from './db.js';

let memories = []; // [{ id, text, ts }]
let onChange = null;
let idCounter = 0;

function genId() {
  return "m" + Date.now().toString(36) + "-" + (idCounter++).toString(36);
}

function persist() {
  dbSaveMemories(memories).catch((e) => console.error("[memory] save failed:", e));
  if (onChange) onChange();
}

/** Register a callback fired whenever memories change (e.g. to re-render UI). */
export function setMemoryChangeHandler(fn) {
  onChange = fn;
}

/** Load memories from storage into module state. Call once at startup. */
export async function loadMemories() {
  try {
    memories = await dbLoadMemories();
  } catch {
    memories = [];
  }
  return memories;
}

export function getMemories() {
  return memories;
}

/** Add a fact. Ignores empty / exact-duplicate text. Returns the entry or null. */
export function addMemory(text) {
  const clean = (text || "").trim();
  if (!clean) return null;
  if (memories.some((m) => m.text === clean)) return null;
  const mem = { id: genId(), text: clean, ts: Date.now() };
  memories.push(mem);
  persist();
  return mem;
}

export function updateMemory(id, text) {
  const m = memories.find((x) => x.id === id);
  if (!m) return;
  const clean = (text || "").trim();
  if (!clean) {
    removeMemory(id);
    return;
  }
  m.text = clean;
  persist();
}

export function removeMemory(id) {
  const before = memories.length;
  memories = memories.filter((x) => x.id !== id);
  if (memories.length !== before) persist();
}

export function clearMemories() {
  if (!memories.length) return;
  memories = [];
  persist();
}

/**
 * Build the block appended to the system prompt, or "" when empty.
 * `header` is supplied by the caller in the active prompt language.
 */
export function getMemoryPromptBlock(header) {
  if (!memories.length) return "";
  const lines = memories.map((m) => `- ${m.text}`).join("\n");
  return `\n\n${header}\n${lines}`;
}
