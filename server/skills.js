// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Prompt-writing skills: a model's OFFICIAL prompt guide, fetched to
// ~/.hey-koko/skills/<name>/ (scripts/fetch-skills.js) and injected into the chat
// by the /skill command so the chat model becomes that video model's prompt-writing
// assistant. The guides are third-party text and never ship in this repository —
// only the manifest of URLs, hashes and model mappings does.
//
// This module is a file server with a resolver, nothing more. The conversational
// wrapper around the guide is built in the browser (i18n lives there); the guide
// itself is handed over verbatim because its whole value is exact field names,
// section order and timing notation — a strong-format spec, not prose to summarize.

const fs = require("fs");
const path = require("path");
const config = require("./config");
const { sendJson, readBody } = require("./utils");

const MANIFEST = require("./skills-manifest.json");
const { labelForId } = require("./model-names");
const SKILLS_DIR = path.join(config.DATA_DIR, "skills");

// A skill counts as installed when its SKILL.md is on disk. Individual missing
// reference files surface later as a compose error naming the file — better than
// hiding the whole skill because one half of it is absent.
function isInstalled(name) {
  try { return fs.statSync(path.join(SKILLS_DIR, name, "SKILL.md")).isFile(); } catch { return false; }
}

// Installed skills with their manifest metadata. Skills present on disk but not in
// the manifest (hand-installed) are listed too — usable via compose only when a
// future manifest entry maps them, but visible so the user can see what landed.
function listSkills() {
  let onDisk = [];
  try {
    onDisk = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch { /* no skills dir → empty list, feature invisible */ }
  const known = new Set(Object.keys(MANIFEST));
  const out = [];
  for (const name of new Set([...onDisk, ...known])) {
    out.push({
      name,
      installed: isInstalled(name),
      models: (MANIFEST[name] && MANIFEST[name].models) || [],
      // The concrete canonical ids (model-names.js vocabulary), so completion and
      // resolution work with ComfyUI unreachable — writing a prompt is exactly the
      // activity that happens BEFORE the render box needs to be up.
      ids: (MANIFEST[name] && MANIFEST[name].ids) || (MANIFEST[name] && MANIFEST[name].models) || [],
      // Human name per id ("ltx2.3-22b" → "LTX-2.3 22B"), from the same table the rest
      // of the app labels models with. Sent alongside because the live ComfyUI
      // catalogue — the other place labels come from — is exactly what /skill must not
      // depend on. An id with no entry falls back to itself inside labelForId.
      labels: Object.fromEntries(((MANIFEST[name] && MANIFEST[name].ids)
        || (MANIFEST[name] && MANIFEST[name].models) || []).map((id) => [id, labelForId(id)])),
      modes: Object.keys((MANIFEST[name] && MANIFEST[name].modes) || {}),
    });
  }
  return out;
}

// Canonical model id (model-names.js) → skill name, by manifest prefix mapping.
// "minimax-h3" matches both minimax-h3-t2v and minimax-h3-r2v.
//
// `excludeModels` carves variants back OUT of a prefix match. Sibling weights under
// one family can want a genuinely different prompt shape: the LTX guide teaches one
// flowing paragraph, which is WRONG for ltx2.3-22b:msr (two sections separated by a
// blank line) and says nothing about :union's depth-driven conditioning. Handing
// those a guide that is 80% right and silent on the part that breaks the render is
// worse than reporting no skill and naming what is installed.
function skillForModel(modelId) {
  const id = String(modelId || "").toLowerCase();
  if (!id) return null;
  for (const [name, def] of Object.entries(MANIFEST)) {
    if ((def.excludeModels || []).some((x) => id === String(x).toLowerCase())) continue;
    for (const prefix of def.models || []) {
      if (id === prefix || id.startsWith(prefix + "-") || id.startsWith(prefix + ":")) return name;
    }
  }
  return null;
}

function readSkillFile(name, rel) {
  // rel comes from the manifest, never from the request — no traversal surface.
  return fs.readFileSync(path.join(SKILLS_DIR, name, rel), "utf8");
}

// Pull one named constant's triple-quoted literal out of a source file. Several vendors
// ship their prompt guidance as a system prompt inside Python (Wan's system_prompt.py,
// Qwen's prompt_utils.py) rather than as a document: the whole FILE is still what gets
// hash-pinned and stored, this only decides which part of it reaches the chat. Without
// it the injection would be a 20 KB module — six prompts in two languages, five of them
// irrelevant to the mode in play.
function sliceSection(text, section, name, rel) {
  // These constants usually sit indented inside a function, and a `\` line continuation
  // between the `=` and the opening quotes is common in both upstreams.
  const re = new RegExp(`^[ \\t]*${section}\\s*=\\s*\\\\?\\s*('''|""")([\\s\\S]*?)\\1`, "gm");
  const hits = [];
  let m;
  while ((m = re.exec(text))) hits.push(m[2]);
  if (!hits.length) {
    throw new Error(`skill "${name}": ${rel} defines no ${section} — upstream renamed or restructured it, so the manifest needs updating (re-fetching will not help)`);
  }
  // Qwen defines SYSTEM_PROMPT once per language in the same file. Picking the first
  // would silently choose a language for the user; refuse and make the manifest name a
  // constant that is unique, the same way an ambiguous -m token is refused rather than guessed.
  if (hits.length > 1) {
    throw new Error(`skill "${name}": ${rel} defines ${section} ${hits.length} times — ambiguous, pin a uniquely named constant`);
  }
  return hits[0].trim();
}

// A mode's content, normalised. A mode may be a single file (H3), several files in order
// (FLUX splits its guidance into rules/*.md), or a named section of one file (Wan, Qwen).
// `file` defaults to SKILL.md, which is what a section-only entry means.
function partsOf(spec) {
  if (!spec) return [];
  return (Array.isArray(spec) ? spec : [spec]).map((x) => (typeof x === "string"
    ? { file: x, section: "" }
    : { file: x.file || "SKILL.md", section: x.section || "" }));
}

// Which mode a model id selects. Manifest-driven: H3's ref guide belongs to the `-r2v`
// weights, FLUX's editing rules to Kontext. First matching rule wins; `base` otherwise.
function pickMode(def, modelId) {
  const modes = def.modes || {};
  const id = String(modelId || "").toLowerCase();
  for (const rule of def.modeRules || []) {
    if (rule.idContains && modes[rule.mode] && id.includes(String(rule.idContains).toLowerCase())) return rule.mode;
  }
  return modes.base ? "base" : (Object.keys(modes)[0] || "");
}

function readPart(name, p) {
  let raw;
  try { raw = readSkillFile(name, p.file); }
  catch { throw new Error(`skill "${name}" is missing ${p.file} — re-run scripts/fetch-skills.js`); }
  return p.section ? sliceSection(raw, p.section, name, p.file) : raw;
}

// POST /api/skills/compose { model, staged: { images, hasVideo } }
//   → { name, mode, text }               guide selected and read
//   → { none: true, installed: [...] }   no skill for that model (or none installed)
//
// Mode: the H3 Ref2VA guide applies when the r2v weights are selected (the model id
// says so — the ref slots only exist there); everything else gets the base guide
// (T2VA/I2VA/FL2VA/L2VA — which of those it is depends on what is staged, and that
// nuance is described to the assistant by the browser's wrapper, not decided here).
async function handleCompose(req, res) {
  try {
    const body = await readBody(req);
    const modelId = String(body.model || "");
    const name = skillForModel(modelId);
    if (!name || !isInstalled(name)) {
      sendJson(res, 200, { none: true, installed: listSkills().filter((s) => s.installed).map((s) => s.name) });
      return;
    }
    const def = MANIFEST[name];
    const mode = pickMode(def, modelId);
    const parts = partsOf((def.modes || {})[mode]);
    let text;
    try {
      if (!parts.length) {
        text = readSkillFile(name, "SKILL.md");
      } else {
        // SKILL.md leads unless the mode already names it — a section-only mode means
        // "inject just this piece of SKILL.md", not "the whole file and then a piece".
        const chunks = parts.some((p) => p.file === "SKILL.md") ? [] : [readSkillFile(name, "SKILL.md")];
        for (const p of parts) chunks.push(readPart(name, p));
        text = chunks.join("\n\n---\n\n");
      }
    } catch (e) {
      sendJson(res, 500, { error: e.message });
      return;
    }
    // The model's trained duration window (manifest fact, mirrors comfy.js lenMin/lenMax
    // — H3: 124–362 frames @24fps on a 17k+5 grid ≈ 5.2–15.1s). Handed to the browser so
    // the prompt-writing wrapper can refuse durations the render would silently clamp:
    // a clamped clip with 30.00s timing notation in its prompt is mis-paced end to end.
    // "image" | "video" — what this guide writes prompts FOR. A manifest fact rather
    // than a lookup in the live catalogue, because /skill has to work with ComfyUI
    // unreachable (writing prompts is what happens before the render box is up). The
    // browser uses it to suggest a separate tab when the user switches media kinds.
    // `sizes` — the --size tokens this model's dispatch line may carry (manifest fact,
    // like duration). Explicit tokens only, no derivation: presets AND raw WxH literals
    // are both legal (H3 lists its native max 1376×768 as a literal — there is no
    // "768p" preset and inventing one just for the wrapper would be a second truth
    // source). An entry is a plain string, or { token, max: true } when that size is
    // the model's stated native maximum — a per-model fact the wrapper turns into a
    // "(native max, landscape/vertical)" label. Explicitly declared, never inferred
    // from the token's shape: a future model may legitimately list a WxH literal that
    // is NOT its max. Absent from the manifest → null → --size never mentioned.
    // `style` — what KIND of guide this is, which decides the wrapper the browser
    // puts around it. "" (default) = strong-format: named fields, section order and
    // timing notation are a spec to obey literally (H3). "prose" = the guide teaches
    // how to write, not a template (LTX asks for one flowing paragraph). Telling a
    // prose guide's reader to honour "field names and section order" invents a
    // structure that does not exist — and a model that takes the guide seriously
    // then has to choose which of the two contradicting instructions to break.
    // `caveats` — per-skill facts that CONTRADICT the guide and must reach the assistant
    // with it. Vendor guides upsell (BFL's editing rules keep recommending FLUX.2 over
    // the FLUX.1 Kontext actually installed) and assume the vendor's cloud API, which
    // this app never calls. English, like every other model-facing string the server owns.
    // `modelNotes` — facts about ONE weight, appended to the skill-wide caveats. A guide
    // describes a family; a specific checkpoint can differ from it in a way the guide
    // cannot know. 10Eros-Max's hybrid fuses the ref2va and fl2va weights, so the
    // reference guide alone describes only half of what it does — and without being
    // told, the assistant treats references as mandatory and invents them. (Those fused
    // builds carry no task segment in their id for the same reason; their mode comes
    // from the build suffix after the colon, so the `-r2v` rule never sees them.)
    const notes = (def.modelNotes || {})[modelId];
    const caveats = [...(def.caveats || []), ...(notes ? [notes] : [])];
    sendJson(res, 200, { name, mode: mode || "", text, duration: def.duration || null, kind: def.kind || "", sizes: def.sizes || null, style: def.style || "", caveats: caveats.length ? caveats : null });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

function handleList(req, res) {
  try { sendJson(res, 200, { skills: listSkills() }); }
  catch (e) { sendJson(res, 500, { error: e.message }); }
}

module.exports = { SKILLS_DIR, listSkills, skillForModel, handleList, handleCompose };
