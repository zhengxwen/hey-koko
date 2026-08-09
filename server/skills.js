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
      modes: Object.keys((MANIFEST[name] && MANIFEST[name].modes) || {}),
    });
  }
  return out;
}

// Canonical model id (model-names.js) → skill name, by manifest prefix mapping.
// "minimax-h3" matches both minimax-h3-t2v and minimax-h3-r2v.
function skillForModel(modelId) {
  const id = String(modelId || "").toLowerCase();
  if (!id) return null;
  for (const [name, def] of Object.entries(MANIFEST)) {
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
    const modes = def.modes || {};
    const useRef = /-r2v\b/.test(modelId) && modes.ref;
    const mode = useRef ? "ref" : (modes.base ? "base" : Object.keys(modes)[0]);
    const refFile = modes[mode];
    let text = readSkillFile(name, "SKILL.md");
    if (refFile) {
      try {
        text += `\n\n---\n\n${readSkillFile(name, refFile)}`;
      } catch {
        sendJson(res, 500, { error: `skill "${name}" is missing ${refFile} — re-run scripts/fetch-skills.js` });
        return;
      }
    }
    // The model's trained duration window (manifest fact, mirrors comfy.js lenMin/lenMax
    // — H3: 124–362 frames @24fps on a 17k+5 grid ≈ 5.2–15.1s). Handed to the browser so
    // the prompt-writing wrapper can refuse durations the render would silently clamp:
    // a clamped clip with 30.00s timing notation in its prompt is mis-paced end to end.
    sendJson(res, 200, { name, mode: mode || "", text, duration: def.duration || null });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

function handleList(req, res) {
  try { sendJson(res, 200, { skills: listSkills() }); }
  catch (e) { sendJson(res, 500, { error: e.message }); }
}

module.exports = { SKILLS_DIR, listSkills, skillForModel, handleList, handleCompose };
