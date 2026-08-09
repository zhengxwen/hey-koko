// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// "@mention" autocomplete for the /ask command: typing "@" inside "/ask …" pops a
// list of library docs to scope the query to (→ "/ask @docId1 @docId2 question").
// Modeled on the slash-command popup (commands.js); reuses its .commandPopup styles.
import { dom, state } from './state.js';
import { escapeHtml } from './utils.js';
import { t } from './i18n.js';
import { TOOL_CMD_ALIASES } from './tool-cmd.js';
// The "/imagine -m …" completion reads the same model index the flag resolves against.
// Safe direction: ollama.js never reaches mentions.js.
import { matchModels, splitModelToken } from './ollama.js';
// The named --size values, so the popup offers exactly what the flag accepts.
import { SIZE_PRESETS } from './constants.js';

const KIND_ICON = { paper: "📄", slides: "📊", blog: "🌐", video: "📺", doc: "📝", chat: "💬", other: "📎" };
export const kindIcon = (k) => KIND_ICON[k] || "📎";

let _docs = [];       // cached library index entries {docId,title,docKind,…}  (for "@")
let _archives = [];   // cached archive index entries {filename,title,firstTimestamp,…} (for "#")

// Feed the cache directly (e.g. from the library panel's own list fetch, no extra round-trip).
export function setMentionDocs(docs) { if (Array.isArray(docs)) _docs = docs; }
export function setMentionArchives(archives) { if (Array.isArray(archives)) _archives = archives; }

// Human-readable full name for a docId: the source filename (file:/url: stripped),
// else the title, else the docId itself. Used to label the /ask "searching…" bubble.
export function mentionDocName(docId) {
  const d = _docs.find((x) => x.docId === docId);
  if (!d) return docId;
  return (d.source || "").replace(/^(file|url):/, "") || d.title || docId;
}
// Kind icon for a docId (📺 for a YouTube video, 📄 for a paper, …) — same lookup.
export function mentionDocIcon(docId) {
  const d = _docs.find((x) => x.docId === docId);
  return kindIcon(d && d.docKind);
}

// Human-readable name for an archive filename: its conversation title, else the
// bare filename. Used to label the "/ask #archive …" searching bubble.
export function mentionArchiveName(filename) {
  const a = _archives.find((x) => x.filename === filename);
  return (a && a.title) || filename;
}

// Refresh the doc list (cheap local POST). Called on init and after library changes.
export async function loadMentionDocs() {
  try {
    const r = await fetch("/api/library/list", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const j = await r.json();
    if (Array.isArray(j.docs)) _docs = j.docs;
  } catch { /* keep the previous list */ }
}

// Installed prompt-writing skills (for "/skill -m" completion): name + the model-id
// prefixes each maps to. Lazily primed the first time the popup opens.
let _skills = [];
let _skillsLoaded = false;      // true only once the fetch has SETTLED — while it is
let _skillsPromise = null;      // in flight the popup shows "…", not a false "none"
function loadMentionSkills() {
  if (!_skillsPromise) {
    _skillsPromise = (async () => {
      try {
        const r = await fetch("/api/skills");
        const j = await r.json();
        _skills = (j.skills || []).filter((s) => s.installed);
      } catch { /* server down → empty, hint says none */ }
      _skillsLoaded = true;
    })();
  }
  return _skillsPromise;
}
// Does this canonical model id have a guide? Same prefix rule as server skillForModel.
function skillNameForModelId(id) {
  for (const s of _skills) {
    for (const p of s.models || []) {
      if (id === p || id.startsWith(p + "-") || id.startsWith(p + ":")) return s.name;
    }
  }
  return null;
}

// Refresh the conversation-archive list (for "#" mentions). Called on init and
// lazily when a "#" popup first opens; cheap GET returning per-archive metadata.
export async function loadMentionArchives() {
  try {
    const r = await fetch("/api/archives");
    const j = await r.json();
    if (Array.isArray(j.archives)) _archives = j.archives;
  } catch { /* keep the previous list */ }
}

// If the cursor sits inside an "@partial" (library docs) or "#partial" (conversation
// archives) token within an "/ask …" line — or an "@partial" (tool alias) within a
// "/tool …" line, or the argument of "-m"/"--model" or "--size" within an "/imagine …"
// line — return { sigil, partial, start, mode } (start = index where the replacement
// begins, mode = "ask" | "tool" | "model" | "size"); otherwise null.
export function mentionContext(input) {
  if (!input) return null;
  const val = input.value;
  const isAsk = /^\/ask(\s|$)/.test(val);
  const isTool = /^\/tool(\s|$)/.test(val);
  const isImagine = /^\/imagine(\s|$)/.test(val);
  const isSkill = /^\/skill(\s|$)/.test(val);
  if ((!isAsk && !isTool && !isImagine && !isSkill) || val.includes("\n")) return null;
  const cursor = input.selectionStart;
  const before = val.slice(0, cursor);
  if (isImagine || isSkill) {
    // A flag's ARGUMENT. Unlike the @/# tokens these carry no sigil, so the replacement
    // starts at the token itself (start is not backed up by one).
    const mm = before.match(/(?:^|\s)(?:-m|--model)\s+(\S*)$/);
    // /skill gets its own mode: same catalogue machinery, but filtered to models that
    // actually have a prompt-writing guide — the popup must not offer a model the
    // command would then refuse.
    if (mm) return { sigil: "", partial: mm[1], start: cursor - mm[1].length, mode: isSkill ? "skillmodel" : "model" };
    if (isSkill) return null;
    // "--size" only — "-s" is the short form of "--second" (a duration), so completing it
    // with resolutions would offer values the flag would reject.
    const sm = before.match(/(?:^|\s)--size\s+(\S*)$/);
    if (sm) return { sigil: "", partial: sm[1], start: cursor - sm[1].length, mode: "size" };
    return null;
  }
  const m = before.match(/(?:^|\s)([@#])(\S*)$/);   // '@'/'#' preceded by start/space, no space to cursor
  if (!m) return null;
  if (isTool && m[1] === "#") return null;          // /tool has no archive scope
  return { sigil: m[1], partial: m[2], start: cursor - m[2].length - 1, mode: isTool ? "tool" : "ask" };
}

function setMentionActive(index) {
  const items = dom.mentionPopup.querySelectorAll(".commandItem");
  items.forEach((el, i) => el.classList.toggle("isActive", i === index));
  state.mentionActiveIndex = index;
  // The list scrolls now, so the highlight can sit outside the visible box. "nearest"
  // moves the minimum amount — it doesn't yank an already-visible row to the middle.
  items[index]?.scrollIntoView({ block: "nearest" });
}

// Distinct sub-folders (with every ancestor) any doc lives in — for "@folder/" scope.
function mentionFolders() {
  const set = new Set();
  for (const d of _docs) {
    const f = d.folder || "";
    if (!f) continue;
    const parts = f.split("/");
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join("/"));
  }
  return [...set].sort();
}
function folderDocCount(folder) {
  return _docs.filter((d) => { const df = d.folder || ""; return df === folder || df.startsWith(folder + "/"); }).length;
}

// Strip an archive filename down to a compact label (drop leading dirs' extension):
// "sub/nt_20260630_120000.json.zst" → "nt_20260630_120000".
function archiveShort(filename) {
  return String(filename).replace(/\.json(\.gz|\.zst)?$/, "");
}

export function showMentionPopup(filter, sigil = "@", mode = "ask") {
  const f = (filter || "").toLowerCase();
  let items;
  // A non-selectable note under the rows. Only the size popup uses one: its list is the
  // NAMED sizes, but --size also takes a literal WxH, and nothing on screen said so.
  let hint = "";
  if (mode === "size") {
    // "/imagine --size …": the NAMED sizes. A raw WxH is always allowed too, but there is
    // nothing to complete about it — the hint below says so instead. The description
    // carries the pixel count because that is what decides how long the render takes,
    // which is the whole reason to reach for a smaller preset.
    items = Object.entries(SIZE_PRESETS)
      .filter(([name]) => !f || name.toLowerCase().includes(f))
      .map(([name, dims]) => {
        const [w, h] = dims.split("x").map(Number);
        const mp = (w * h) / 1e6;
        return {
          // Filled glyphs, not the hollow ▭/▯ pair: at this size the hollow portrait one
          // renders as a hairline and reads as a missing character rather than a shape.
          sigil: "", token: name, icon: w > h ? "▬" : w < h ? "▮" : "◼",
          name,
          desc: `${w}×${h} · ${mp < 1 ? mp.toFixed(2) : mp.toFixed(1)} MP`,
        };
      });
    hint = t("mention_sizeCustom");
  } else if (mode === "model") {
    // "/imagine -m …": complete a canonical model id, or — once an "@" is typed — the
    // precision tiers that model actually ships. Rows come from matchModels, the same
    // function the flag resolves with, so the popup can never offer something the flag
    // would then reject.
    const { id, tier } = splitModelToken(filter);
    if (String(filter).includes("@")) {
      const exact = (state.comfyModelIndex || []).find((m) => m.id === id);
      items = ((exact && exact.tiers) || [])
        .filter((x) => !tier || x.startsWith(tier))
        .map((x) => ({ sigil: "", token: `${id}@${x}`, icon: "🎚", name: `${id}@${x}`, desc: t("comfy_tierInstalled") }));
    } else {
      // NOT capped: a bare "-m " is a request to see the whole catalogue, and the point
      // of the popup is to teach the id vocabulary. The list scrolls (.commandPopup has
      // a max-height) and arrow-keys keep the active row in view.
      items = matchModels(id).map((m) => ({
        // The capability dots are emoji: index [0] would cut a surrogate pair in half and
        // render "◆". Spread first so the unit taken is a whole code point.
        sigil: "", token: m.id, icon: [...(m.dots || "")][0] || "🎬",
        // The id leads: it is the vocabulary being taught, and what actually gets typed.
        name: m.id + (m.ready ? "" : " ⚠️"),
        desc: m.label,
      }));
    }
  } else if (mode === "skillmodel") {
    // "/skill -m …": only models that HAVE a prompt-writing guide. Offering the full
    // catalogue would complete ids the command must then refuse — the popup and the
    // command speak from the same map (server skillForModel ↔ skillNameForModelId).
    if (!_skillsLoaded) {
      // Lazy prime — and REPAINT when it lands. "Ready by next keystroke" (the archive
      // pattern) is wrong here: "-m " ends in a space, so there routinely IS no next
      // keystroke — the user stops and reads, and what they would read is a stale
      // "no skills installed" hint sitting over a perfectly installed skill.
      loadMentionSkills().then(() => {
        const ctx = mentionContext(dom.messageInput);
        if (ctx && ctx.mode === "skillmodel") showMentionPopup(ctx.partial, ctx.sigil, ctx.mode);
      });
    }
    const { id } = splitModelToken(filter);
    // Two sources, live one preferred per skill: the ComfyUI catalogue (richer labels,
    // ready flags) when it is loaded, else the skill's own canonical ids from the
    // manifest. Prompt writing happens BEFORE a render — it must not require the
    // render box to be reachable (its IP wanders, and it may simply be off).
    const rows = [];
    const seen = new Set();
    for (const s of _skills) {
      const live = matchModels(id).filter((m) => s.models.some(
        (p) => m.id === p || m.id.startsWith(p + "-") || m.id.startsWith(p + ":")));
      const cands = live.length
        ? live.map((m) => ({ id: m.id, name: m.id + (m.ready ? "" : " ⚠️"), desc: `${m.label} · ${s.name}` }))
        : (s.ids || s.models)
            .filter((x) => !id || x.startsWith(id) || x.includes(id))
            .map((x) => ({ id: x, name: x, desc: s.name }));
      for (const c of cands) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        rows.push({ sigil: "", token: c.id, icon: "📖", name: c.name, desc: c.desc });
      }
    }
    items = rows;
    if (!items.length) {
      // Three empty states, told apart honestly: still fetching ("…"), fetched and
      // nothing installed, or installed but nothing matches what was typed.
      hint = !_skillsLoaded ? "…" : t(_skills.length ? "mention_skillNoMatch" : "mention_skillNone");
    }
  } else if (mode === "tool") {
    // "/tool @…" → the fixed tool-alias list (tool-cmd.js), not library docs.
    items = TOOL_CMD_ALIASES
      .filter((a) => !f || a.alias.startsWith(f))
      .map((a) => ({ sigil: "@", token: a.alias, icon: a.icon, name: "@" + a.alias, desc: t(a.descKey) }));
  } else if (sigil === "#") {
    // "#archive" → scope /ask to whole conversation archives (💬, insert "#filename").
    if (!_archives.length) loadMentionArchives();   // lazy prime; ready by next keystroke
    items = _archives
      .filter((a) => !f || (a.filename || "").toLowerCase().includes(f) || (a.title || "").toLowerCase().includes(f))
      .slice(0, 10)
      .map((a) => ({ sigil: "#", token: a.filename, icon: "💬", name: a.title || a.filename, desc: archiveShort(a.filename) }));
  } else {
    // "@…": folders (📁, insert "@folder/") first, then docs (📄, insert "@docId").
    const folders = mentionFolders()
      .filter((fl) => !f || fl.toLowerCase().includes(f))
      .slice(0, 6)
      .map((fl) => ({ sigil: "@", token: fl + "/", icon: "📁", name: fl + "/", desc: `📄 ${folderDocCount(fl)}` }));
    const docs = _docs
      .filter((d) => !f || (d.docId || "").toLowerCase().includes(f) || (d.title || "").toLowerCase().includes(f))
      .slice(0, 8)
      .map((d) => ({ sigil: "@", token: d.docId, icon: kindIcon(d.docKind), name: d.title || d.docId, desc: `@${d.docId}` }));
    items = [...folders, ...docs];
  }
  // The hint alone is enough to keep the popup open — and a filter matching NO preset is
  // exactly when the user is already typing a custom size and most needs to see it.
  if (!items.length && !hint) { hideMentionPopup(); return; }
  dom.mentionPopup.innerHTML = "";
  state.mentionActiveIndex = 0;
  items.forEach((it, i) => {
    const el = document.createElement("div");
    el.className = "commandItem" + (i === 0 ? " isActive" : "");
    el.dataset.index = i;
    el.dataset.token = it.token;
    el.dataset.sigil = it.sigil;
    el.innerHTML =
      `<span class="commandItem-name">${it.icon} ${escapeHtml(it.name)}</span>` +
      `<span class="commandItem-desc">${escapeHtml(it.desc)}</span>`;
    el.addEventListener("click", () => { state.mentionActiveIndex = i; selectActiveMention(); });
    el.addEventListener("mouseenter", () => setMentionActive(i));
    dom.mentionPopup.appendChild(el);
  });
  // Not a .commandItem on purpose: setMentionActive / moveMentionSelection walk that
  // class, so a hint built from it would become an arrow-key stop that inserts nothing.
  if (hint) {
    const h = document.createElement("div");
    h.className = "commandPopupHint";
    h.textContent = hint;
    dom.mentionPopup.appendChild(h);
  }
  dom.mentionPopup.hidden = false;
}

export function hideMentionPopup() {
  dom.mentionPopup.hidden = true;
  dom.mentionPopup.innerHTML = "";
}

export function moveMentionSelection(dir) {
  const items = dom.mentionPopup.querySelectorAll(".commandItem");
  if (!items.length) return;
  let next = (state.mentionActiveIndex || 0) + dir;
  if (next < 0) next = items.length - 1;
  if (next >= items.length) next = 0;
  setMentionActive(next);
}

// Replace the "@partial"/"#partial" at the cursor with "<sigil><token> "
// (token = docId / "folder/" for @, or an archive filename for #).
export function selectActiveMention() {
  const items = dom.mentionPopup.querySelectorAll(".commandItem");
  const active = items[state.mentionActiveIndex || 0];
  const input = dom.messageInput;
  const ctx = mentionContext(input);
  if (!active || !ctx) { hideMentionPopup(); return; }
  const token = active.dataset.token;
  // `??`, not `||`: the model rows carry an EMPTY sigil (-m's argument has none), and an
  // empty string is falsy — `|| "@"` inserted a stray "@" in front of every model id.
  const sigil = active.dataset.sigil ?? "@";
  const val = input.value;
  const cursor = input.selectionStart;
  input.value = val.slice(0, ctx.start) + `${sigil}${token} ` + val.slice(cursor);
  // Just past "<sigil>token ". The sigil is one char for @/#, but EMPTY for the model
  // mode (-m's argument carries none), so its length has to be measured, not assumed.
  const pos = ctx.start + sigil.length + token.length + 1;
  input.setSelectionRange(pos, pos);
  hideMentionPopup();
  input.focus();
}

export function isMentionPopupOpen() {
  return dom.mentionPopup && !dom.mentionPopup.hidden;
}
