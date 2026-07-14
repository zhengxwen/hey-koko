// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Pure-JS .pptx → per-slide Markdown parser (zero npm deps — a .pptx is a ZIP of XML,
// and Node ships zlib). One slide = one `## Slide N · title` section so the library
// chunker turns each slide into its own block (page = the meaning unit of a deck).
// Speaker notes ride INSIDE their slide's block (a `> 📝 备注：…` quote — the 备注
// marker is kept in Chinese to match the slides distill prompt in library.js). Images
// are NOT extracted here by design (docs/plans/slides-library.md §0.3, Rev1): pictures /
// charts / SmartArt become `[image]` / `[chart]` / `[figure]` placeholders, and visual
// fidelity is P3's whole-slide render. Tables keep their cell text (cheap, lossless-enough).
// Non-text objects leave English placeholders: `[image]` / `[chart]` / `[figure]`.
// parse-file.js falls back to Pandoc if this throws on a malformed/odd deck.
const zlib = require("zlib");

// ---- minimal ZIP reader (central-directory based; stored + deflate only) ----
// Central directory is authoritative: local headers can carry zeroed sizes when the
// data-descriptor flag is set, so we never trust them for sizes.
function unzip(buf) {
  // EOCD (0x06054b50) sits at the tail, before an optional ≤64k comment — scan back.
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no EOCD)");
  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

function readEntryText(zip, name) {
  const e = zip.entries.get(name);
  if (!e) return null;
  const buf = zip.buf;
  const lo = e.localOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) return null;   // bad local header → treat as absent
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.slice(start, start + e.compSize);
  let out;
  if (e.method === 0) out = data;
  else if (e.method === 8) out = zlib.inflateRawSync(data);
  else return null;   // unsupported compression → skip this part (deck still parses)
  return out.toString("utf8");
}

// ---- tiny XML helpers (regex-level — slide XML is shallow and predictable) ----
function decodeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
// All <a:t>…</a:t> runs inside a fragment, concatenated (a run boundary is not a word
// boundary — PowerPoint splits a word across runs on a formatting change).
function runText(xml) {
  const out = [];
  const re = /<a:t>([\s\S]*?)<\/a:t>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(decodeXml(m[1]));
  return out.join("");
}
// A shape's paragraphs → one line each (<a:p> is a bullet / line).
function paragraphs(shapeXml) {
  const lines = [];
  const re = /<a:p>([\s\S]*?)<\/a:p>|<a:p\/>/g;
  let m;
  while ((m = re.exec(shapeXml)) !== null) {
    const txt = m[1] ? runText(m[1]).trim() : "";
    if (txt) lines.push(txt);
  }
  return lines;
}
const isTitlePh = (spXml) => /<p:ph[^>]*\btype="(?:title|ctrTitle)"/.test(spXml);

// ---- one slide's XML → { title, body:[lines], figs:[placeholders] } ----
function parseSlideXml(xml) {
  let title = "";
  const body = [];
  const figs = [];
  // Text shapes.
  const spRe = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let m;
  while ((m = spRe.exec(xml)) !== null) {
    const sp = m[1];
    const lines = paragraphs(sp);
    if (!lines.length) continue;
    if (isTitlePh(sp) && !title) { title = lines.join(" — "); continue; }
    body.push(...lines);
  }
  // Pictures → placeholder (no extraction in P0). English labels by request.
  const picCount = (xml.match(/<p:pic>/g) || []).length;
  for (let i = 0; i < picCount; i++) figs.push("[image]");
  // Graphic frames: table (extract cell text) vs chart / SmartArt (placeholder).
  const gfRe = /<p:graphicFrame>([\s\S]*?)<\/p:graphicFrame>/g;
  while ((m = gfRe.exec(xml)) !== null) {
    const gf = m[1];
    if (/<a:tbl>/.test(gf)) {
      for (const row of tableRows(gf)) body.push(row);
    } else if (/chart/i.test(gf)) {
      figs.push("[chart]");
    } else {
      figs.push("[figure]");
    }
  }
  return { title, body, figs };
}

// <a:tbl> → markdown-ish pipe rows (cell text only; no styling).
function tableRows(xml) {
  const rows = [];
  const trRe = /<a:tr[ >]([\s\S]*?)<\/a:tr>/g;
  let m;
  while ((m = trRe.exec(xml)) !== null) {
    const cells = [];
    const tcRe = /<a:tc[ >]([\s\S]*?)<\/a:tc>/g;
    let c;
    while ((c = tcRe.exec(m[1])) !== null) cells.push(runText(c[1]).replace(/\s+/g, " ").trim());
    if (cells.some(Boolean)) rows.push("| " + cells.join(" | ") + " |");
  }
  return rows;
}

// notesSlide XML → the speaker-notes text (the body placeholder), minus the
// auto slide-number field that notes masters carry.
function parseNotes(xml) {
  if (!xml) return "";
  const spRe = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let m, out = [];
  while ((m = spRe.exec(xml)) !== null) {
    const sp = m[1];
    // The slide-number placeholder (type="sldNum") and the slide-image placeholder
    // carry no real notes — only the body placeholder does.
    if (/<p:ph[^>]*\btype="(?:sldNum|ftr|dt)"/.test(sp)) continue;
    const lines = paragraphs(sp);
    out.push(...lines);
  }
  const txt = out.join(" ").trim();
  // A notes slide with only the page number left → not real notes.
  if (!txt || /^\d+$/.test(txt)) return "";
  return txt;
}

// Slide play order: presentation.xml <p:sldId r:id> → rels → slideN.xml. Falls back
// to numeric filename sort when the rels wiring can't be read.
function slideOrder(zip) {
  const pres = readEntryText(zip, "ppt/presentation.xml");
  const rels = readEntryText(zip, "ppt/_rels/presentation.xml.rels");
  const relMap = new Map();
  if (rels) {
    const re = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g;
    let m;
    while ((m = re.exec(rels)) !== null) relMap.set(m[1], m[2].replace(/^\/?(ppt\/)?/, "ppt/").replace(/^ppt\/ppt\//, "ppt/"));
  }
  const ordered = [];
  if (pres && relMap.size) {
    const re = /<p:sldId\b[^>]*\br:id="([^"]+)"/g;
    let m;
    while ((m = re.exec(pres)) !== null) {
      const tgt = relMap.get(m[1]);
      if (tgt && zip.entries.has(tgt)) ordered.push(tgt);
    }
  }
  if (ordered.length) return ordered;
  // Fallback: every ppt/slides/slideN.xml, numeric-sorted.
  const names = [...zip.entries.keys()].filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  names.sort((a, b) => (parseInt(a.match(/(\d+)/)[1], 10) - parseInt(b.match(/(\d+)/)[1], 10)));
  return names;
}

// slideN.xml → its notesSlide target (via the slide's own rels), or null.
function notesTargetFor(zip, slidePath) {
  const relName = slidePath.replace(/([^/]+)$/, "_rels/$1.rels");
  const rels = readEntryText(zip, relName);
  if (!rels) return null;
  const m = rels.match(/<Relationship\b[^>]*\bTarget="([^"]*notesSlide\d+\.xml)"/);
  if (!m) return null;
  // Target is relative to ppt/slides/ (e.g. "../notesSlides/notesSlide1.xml").
  let tgt = m[1].replace(/^\.\.\//, "ppt/").replace(/^\//, "");
  if (!zip.entries.has(tgt)) tgt = "ppt/notesSlides/" + tgt.split("/").pop();
  return zip.entries.has(tgt) ? tgt : null;
}

// Parse a .pptx buffer → { text: markdown, images: [], slideCount }. Throws on a
// buffer that isn't a readable pptx (caller falls back to Pandoc).
function parsePptx(buf) {
  const zip = unzip(buf);
  const order = slideOrder(zip);
  if (!order.length) throw new Error("no slides found in pptx");
  const parts = [];
  order.forEach((slidePath, i) => {
    const xml = readEntryText(zip, slidePath);
    if (xml == null) return;
    const { title, body, figs } = parseSlideXml(xml);
    const n = i + 1;
    const head = title ? `## Slide ${n} · ${title}` : `## Slide ${n}`;
    const lines = [head, ""];
    // A title-only (section-header) slide would otherwise become an empty, dropped
    // block — echo the title into the body so the chapter marker stays retrievable.
    if (title && !body.length && !figs.length) lines.push(title);
    for (const b of body) lines.push(/^\|.*\|$/.test(b) ? b : `- ${b}`);
    for (const f of figs) lines.push(f);
    // Speaker notes → a quote line folded into this slide's block (context, not a
    // separate chunk — a bare notes block would be retrieval noise on its own).
    const notesPath = notesTargetFor(zip, slidePath);
    const notes = notesPath ? parseNotes(readEntryText(zip, notesPath)) : "";
    if (notes) { lines.push("", `> 📝 备注：${notes}`); }
    parts.push(lines.join("\n"));
  });
  const text = parts.join("\n\n");
  if (!text.trim()) throw new Error("pptx produced no text");
  return { text, images: [], slideCount: order.length };
}

module.exports = { parsePptx };
