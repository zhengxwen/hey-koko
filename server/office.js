// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Office readers for the /tool command (macOS, AppleScript): the LIVE state of
// Microsoft Word / PowerPoint / Outlook — the open, possibly-unsaved document,
// the cursor's selection, the slide being edited, the mail being read — which no
// file-level parser (pptx.js / MinerU / pandoc) can see. Read-only.
//
// Word/PowerPoint ship full AppleScript dictionaries. Outlook only in its LEGACY
// mode — "New Outlook" dropped scripting, surfaced here as an "unsupported" error.
// PowerPoint's AppleScript *export* is unreliable on recent macOS (render-slides.js
// learned this the hard way), so the @ppt slide image is a WINDOW SCREENSHOT
// (System Events window rect + `screencapture -R`) — best-effort: it needs the
// one-time Accessibility + Screen Recording grants, and any failure degrades to
// text-only. First automation of each app also pops a one-time permission prompt.

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const config = require("./config");
const { sendJson, readBody } = require("./utils");
const { optimizeImage } = require("./url-fetch");

// Field separator inside AppleScript return values (character id 30 = RS); Excel's
// grid additionally separates ROWS with US (31), cells with tab.
const RS = String.fromCharCode(30);
const US = String.fromCharCode(31);

const APPS = {
  word: "Microsoft Word",
  ppt: "Microsoft PowerPoint",
  outlook: "Microsoft Outlook",
  excel: "Microsoft Excel",
};

// Office hands back CR (and CRLF) line endings — normalize so the markdown bubble
// renders paragraphs instead of one run-on line.
function normalizeText(s) {
  return String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function runOsa(script, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || "osascript failed").trim()));
      else resolve(stdout.replace(/\n$/, ""));
    });
  });
}

// Our scripts signal structured failures as `error "no_doc"` etc; osascript wraps
// them like `execution error: no_doc (-2700)`. Recover the bare token when present.
function errToken(e) {
  const m = String(e && e.message || "").match(/\b(not_running|no_doc|no_selection)\b/);
  return m ? m[1] : "";
}

// `tell application "X"` LAUNCHES X when it isn't running — every script must gate
// on `is running` first (and Node gates on the .app existing, because merely
// COMPILING a reference to an absent app pops a "Where is X?" chooser dialog).
function appInstalled(appName) {
  return fs.existsSync(`/Applications/${appName}.app`);
}
const RUNNING_GATE = (appName) => `if not (application "${appName}" is running) then error "not_running"\n`;

// ---- Word: active document text + the cursor's selection ----

async function readWord(selectionOnly) {
  const docText = selectionOnly ? 'set docText to ""' : "set docText to content of text object of d";
  const out = await runOsa(
    RUNNING_GATE(APPS.word) +
    `set rs to character id 30
tell application "Microsoft Word"
	if (count of documents) is 0 then error "no_doc"
	-- "active document" is missing value while Word is in the BACKGROUND, which is
	-- the normal case here (the user is in the browser) — fall back to document 1.
	set d to missing value
	try
		set d to active document
	end try
	if d is missing value then set d to document 1
	-- Word with NO document open still reports one phantom document (0 windows,
	-- missing-value content) — that is "no document", not a broken read.
	if (count of windows) is 0 then error "no_doc"
	set docName to name of d
	if docName is missing value then error "no_doc"
	set selText to ""
	try
		set selText to content of text object of selection
	end try
	if selText is missing value then set selText to ""
	set docText to ""
	${docText}
	if docText is missing value then set docText to ""
	return docName & rs & selText & rs & docText
end tell`);
  const [title, selection, text] = out.split(RS);
  return { app: "word", title: title || "", selection: normalizeText(selection), text: normalizeText(text) };
}

// ---- PowerPoint: the slide being edited (shape text + speaker notes) + window shot ----

async function readPpt() {
  const out = await runOsa(
    RUNNING_GATE(APPS.ppt) +
    `set rs to character id 30
tell application "Microsoft PowerPoint"
	if (count of presentations) is 0 then error "no_doc"
	-- Same background caveat as Word: "active presentation" goes missing when the app
	-- isn't frontmost. Slide index likewise falls back to the first slide.
	set p to missing value
	try
		set p to active presentation
	end try
	if p is missing value then set p to presentation 1
	set sl to missing value
	try
		set sl to slide of view of document window 1
	end try
	if sl is missing value then set sl to slide 1 of p
	set idx to slide index of sl
	set n to count of slides of p
	set txt to ""
	repeat with sh in (get shapes of sl)
		try
			if has text frame of sh then
				set tr to content of text range of text frame of sh
				if tr is not missing value then set txt to txt & tr & linefeed
			end if
		end try
	end repeat
	set notesTxt to ""
	try
		repeat with sh in (get shapes of notes page of sl)
			try
				if has text frame of sh then
					set tr to content of text range of text frame of sh
					if tr is not missing value then set notesTxt to notesTxt & tr & linefeed
			end if
			end try
		end repeat
	end try
	return (name of p) & rs & (idx as string) & rs & (n as string) & rs & txt & rs & notesTxt
end tell`);
  const [title, idx, n, text, notes] = out.split(RS);
  // The notes page also carries the slide-number placeholder ("1"), which is noise —
  // drop lines that are just a number.
  const notesText = normalizeText(notes).split("\n").filter((l) => !/^\s*\d+\s*$/.test(l)).join("\n").trim();
  return {
    app: "ppt", title: title || "",
    slideIndex: Number(idx) || 0, slideCount: Number(n) || 0,
    text: normalizeText(text), notes: notesText,
  };
}

// Screenshot of the PowerPoint slide area: front the app, capture its window,
// then crop to the slide content region (removing toolbar, sidebar, status bar).
// Best-effort — returns null on any failure (missing TCC grants included).
async function capturePptWindow() {
  const tmp = path.join(os.tmpdir(), `hk_ppt_shot_${Date.now()}.jpg`);
  const tmpCrop = path.join(os.tmpdir(), `hk_ppt_crop_${Date.now()}.jpg`);
  try {
    // Get window rect AND slide aspect ratio in one go.
    const out = await runOsa(
      RUNNING_GATE(APPS.ppt) +
      `set rs to character id 30
tell application "Microsoft PowerPoint"
	set sw to 960
	set sh to 540
	try
		set sw to slide width of page setup of active presentation
	end try
	try
		set sh to slide height of page setup of active presentation
	end try
end tell
tell application "System Events"
	set prevApp to name of first process whose frontmost is true
	set frontmost of process "Microsoft PowerPoint" to true
	delay 0.4
	set w to front window of process "Microsoft PowerPoint"
	set {px, py} to position of w
	set {pw, ph} to size of w
end tell
return prevApp & rs & px & rs & py & rs & pw & rs & ph & rs & sw & rs & sh`, 15000);
    const [prevApp, x, y, w, h, sw, sh] = out.split(RS);
    await new Promise((resolve, reject) => {
      execFile("screencapture", ["-x", "-t", "jpg", "-R", `${x},${y},${w},${h}`, tmp], { timeout: 10000 },
        (err) => err ? reject(err) : resolve());
    });
    // Give the user their previous app back.
    if (prevApp && prevApp !== "Microsoft PowerPoint") {
      runOsa(`tell application "System Events" to set frontmost of process "${prevApp.replace(/"/g, '\\"')}" to true`, 5000).catch(() => { /* best-effort */ });
    }
    if (!fs.existsSync(tmp)) return null;
    const rawBuf = fs.readFileSync(tmp);
    if (!rawBuf.length) return null;

    // Crop to the slide content area. In Normal view the chrome occupies:
    // - top: toolbar + info bar + ruler (~15% of window height)
    // - left: slide navigator panel (~15% of window width)
    // - bottom: status bar + notes placeholder (~10% of window height)
    // After removing chrome, fit the largest centered rect matching the slide AR.
    let finalBuf = rawBuf;
    try {
      const imgW = Number(w) * 2;  // Retina 2x
      const imgH = Number(h) * 2;
      const slideAR = (Number(sw) || 960) / (Number(sh) || 540);
      // Estimated content area (pixels in the captured image)
      const cropTop = Math.round(imgH * 0.18);
      const cropLeft = Math.round(imgW * 0.18);
      const cropBottom = Math.round(imgH * 0.07);
      const contentW = imgW - cropLeft;
      const contentH = imgH - cropTop - cropBottom;
      // Fit slide AR into content area (centered)
      let fitW, fitH;
      if (contentW / contentH > slideAR) {
        fitH = contentH;
        fitW = Math.round(contentH * slideAR);
      } else {
        fitW = contentW;
        fitH = Math.round(contentW / slideAR);
      }
      const offX = cropLeft + Math.round((contentW - fitW) / 2);
      const offY = cropTop + Math.round((contentH - fitH) / 2);
      // Use sips to crop
      fs.copyFileSync(tmp, tmpCrop);
      const { execFileSync } = require("child_process");
      execFileSync("sips", ["--cropToHeightWidth", String(fitH), String(fitW), "--cropOffset", String(offY), String(offX), tmpCrop], { timeout: 5000, stdio: "ignore" });
      const cropped = fs.readFileSync(tmpCrop);
      if (cropped.length > 1000) finalBuf = cropped;
    } catch { /* crop failed — use full window capture */ }

    try {
      const o = await optimizeImage(finalBuf, "image/jpeg");
      return { image: o.buf.toString("base64"), imageMime: o.ct };
    } catch { return { image: finalBuf.toString("base64"), imageMime: "image/jpeg" }; }
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpCrop); } catch { /* ignore */ }
  }
}

// ---- Excel: the active sheet's used range, or just the selected cells ----

// AppleScript gives us the grid as rows of tab-separated cells (unit separator between
// rows) — turn that into a markdown table so the model reads it as structured data.
// The first row becomes the header: spreadsheets almost always lead with one, and a
// header-less table still renders fine (row 1 just sits in the header slot).
function gridToMarkdown(raw) {
  const rows = String(raw || "").split(US).map((r) => r.split("\t"));
  const clean = rows.filter((r) => r.some((c) => String(c).trim() !== ""));
  if (!clean.length) return "";
  const width = Math.max(...clean.map((r) => r.length));
  const cell = (v) => String(v == null ? "" : v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  const pad = (r) => Array.from({ length: width }, (_, i) => cell(r[i]));
  const out = [`| ${pad(clean[0]).join(" | ")} |`, `| ${Array(width).fill("---").join(" | ")} |`];
  for (const r of clean.slice(1)) out.push(`| ${pad(r).join(" | ")} |`);
  return out.join("\n");
}

// selectionOnly: read just the selected cells. Otherwise the sheet's used range,
// capped at MAX_CELLS so a 100k-row sheet can't blow up the context — the cap keeps
// the TOP-LEFT block (headers + first rows), which is what makes a table legible.
const EXCEL_MAX_ROWS = 200, EXCEL_MAX_COLS = 40;

async function readExcel(selectionOnly) {
  const out = await runOsa(
    RUNNING_GATE(APPS.excel) +
    `set rs to character id 30
set us to character id 31
-- Excel's dictionary defines its own "tab" (a sheet tab), shadowing AppleScript's tab
-- constant inside the tell block — the literal word would end up in the output.
set tb to character id 9
tell application "Microsoft Excel"
	if (count of workbooks) is 0 then error "no_doc"
	-- Same background caveat as Word/PowerPoint: the "active" objects go missing
	-- when the app isn't frontmost, so fall back to the first workbook/sheet.
	set wb to missing value
	try
		set wb to active workbook
	end try
	if wb is missing value then set wb to workbook 1
	set sh to missing value
	try
		set sh to active sheet of wb
	end try
	if sh is missing value then set sh to sheet 1 of wb
	set rng to missing value
	${selectionOnly ? `try
		set rng to selection
	end try
	if rng is missing value then error "no_selection"
	-- A single clicked cell is not a real selection to reason about.
	if (count of cells of rng) is 1 then error "no_selection"` : `try
		set rng to used range of sh
	end try
	if rng is missing value then error "no_doc"`}
	set rowCount to count of rows of rng
	set colCount to count of columns of rng
	set rMax to rowCount
	if rMax > ${EXCEL_MAX_ROWS} then set rMax to ${EXCEL_MAX_ROWS}
	set cMax to colCount
	if cMax > ${EXCEL_MAX_COLS} then set cMax to ${EXCEL_MAX_COLS}
	set grid to ""
	repeat with i from 1 to rMax
		set rowTxt to ""
		repeat with j from 1 to cMax
			set v to ""
			try
				set v to string value of (cell j of row i of rng)
			end try
			if v is missing value then set v to ""
			if j is 1 then
				set rowTxt to v
			else
				set rowTxt to rowTxt & tb & v
			end if
		end repeat
		if i is 1 then
			set grid to rowTxt
		else
			set grid to grid & us & rowTxt
		end if
	end repeat
	set rngAddr to ""
	try
		set rngAddr to get address of rng
	end try
	return (name of wb) & rs & (name of sh) & rs & rngAddr & rs & (rowCount as string) & rs & (colCount as string) & rs & grid
end tell`, 60000);
  const [book, sheet, address, rowCount, colCount, grid] = out.split(RS);
  const rows = Number(rowCount) || 0, cols = Number(colCount) || 0;
  return {
    app: "excel", title: book || "", sheet: sheet || "", address: (address || "").replace(/\$/g, ""),
    rows, cols, table: gridToMarkdown(grid),
    // Tell the frontend the grid was clipped so it can say so rather than silently lying.
    clipped: rows > EXCEL_MAX_ROWS || cols > EXCEL_MAX_COLS,
    shownRows: Math.min(rows, EXCEL_MAX_ROWS), shownCols: Math.min(cols, EXCEL_MAX_COLS),
  };
}

// ---- Outlook (legacy scripting): the message(s) selected in the reading pane ----

// Email-image policy (size floors, MIME allow-list, naming, remote download) is shared
// with the dropped-.eml path via server/mail-images.js — see the note there.
const { IMG_MIME_RE, IMG_EXT_SET, IMG_MIN_BYTES, mimeToExt, imageName, fetchRemoteImages } = require("./mail-images");
const IMG_MAX_COUNT = Infinity;

async function readOutlook() {
  const out = await runOsa(
    RUNNING_GATE(APPS.outlook) +
    `set rs to character id 30
tell application "Microsoft Outlook"
	set sel to {}
	try
		set sel to selected objects
	on error
		set sel to selection
	end try
	if sel is missing value then set sel to {}
	if (count of sel) is 0 then error "no_selection"
	set m to item 1 of sel
	set subj to ""
	try
		set subj to subject of m
	end try
	set sndr to ""
	try
		set sndr to (address of sender of m)
	end try
	try
		set sndr to (name of sender of m) & " <" & sndr & ">"
	end try
	-- Exchange accounts often leave sender properties empty; fall back to the raw
	-- From: header which is always populated.
	if sndr is "" or sndr is " <>" then
		try
			set hdr to headers of m
			set paras to paragraphs of hdr
			repeat with p in paras
				if p starts with "From:" then
					set sndr to text 7 thru -1 of p
					exit repeat
				end if
			end repeat
		end try
	end if
	set dt to ""
	try
		set dt to (time received of m) as string
	end try
	set bodyTxt to ""
	try
		set bodyTxt to plain text content of m
	end try
	set rcpts to ""
	try
		set toList to to recipients of m
		repeat with r in toList
			set rAddr to ""
			try
				set rAddr to address of email address of r
			end try
			set rName to ""
			try
				set rName to name of r
			end try
			if rName is not "" then
				set rcpts to rcpts & rName & " <" & rAddr & ">, "
			else if rAddr is not "" then
				set rcpts to rcpts & rAddr & ", "
			end if
		end repeat
	end try
	-- Exchange accounts leave recipient properties empty; fall back to To: header.
	if rcpts is "" then
		try
			set hdr to headers of m
			set paras to paragraphs of hdr
			repeat with p in paras
				if p starts with "To:" then
					set rcpts to text 5 thru -1 of p
					exit repeat
				end if
			end repeat
		end try
	end if
	return subj & rs & sndr & rs & dt & rs & bodyTxt & rs & rcpts
end tell`);
  const [subject, from, date, text, toRaw] = out.split(RS);
  const to = (toRaw || "").replace(/,\s*$/, "").trim();
  const result = { app: "outlook", subject: subject || "", from: from || "", to: to || "", date: date || "", text: normalizeText(text) };

  // ---- image extraction + HTML-based text (best-effort) ----
  try {
    const extracted = await extractOutlookImages();
    if (extracted.images.length) {
      result.images = extracted.images;
      result.imageNames = extracted.imageNames;
    }
    if (extracted.text) result.text = normalizeText(extracted.text);
    else {
      // No images found but still convert HTML to preserve hyperlinks.
      const html = await readOutlookHtml();
      if (html) {
        const converted = htmlToAnnotatedText(html, new Map(), []);
        if (converted) result.text = normalizeText(converted);
      }
    }
  } catch { /* silent degrade to text-only */ }
  return result;
}

// Read the HTML body of the selected Outlook message (shared helper for annotation).
async function readOutlookHtml() {
  return runOsa(
    RUNNING_GATE(APPS.outlook) +
    `tell application "Microsoft Outlook"
	set sel to {}
	try
		set sel to selected objects
	on error
		set sel to selection
	end try
	if sel is missing value or (count of sel) is 0 then return ""
	set m to item 1 of sel
	set h to ""
	try
		set h to content of m
	end try
	return h
end tell`, 15000);
}

// Convert HTML email body to plain text, inserting [📷 N](ImageN.ext) markers
// where extracted images appeared. `imageKeys` is a Map<identifier, 1-based-index>
// (URL for remote images, attachment filename for cid: inlines).
// `imageNames` is an optional array of uniform filenames parallel to images.
function htmlToAnnotatedText(html, imageKeys, imageNames) {
  let h = html;
  h = h.replace(/<!--[\s\S]*?-->/g, "");
  h = h.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  h = h.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  // Replace <img> of extracted images with position markers; drop the rest.
  h = h.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = (tag.match(/\bsrc\s*=\s*"([^"]+)"/i) || [])[1] || "";
    const alt = (tag.match(/\balt\s*=\s*"([^"]+)"/i) || [])[1] || "";
    for (const [key, idx] of imageKeys) {
      const fname = imageNames ? (imageNames[idx - 1] || "") : "";
      if (src === key || alt === key) return `\n![📷 ${idx}](${fname})\n`;
      // cid: inline images — match by filename stem in the cid URL
      if (src.startsWith("cid:") && key.includes(".")) {
        const stem = key.replace(/\.[^.]+$/, "");
        if (src.toLowerCase().includes(stem.toLowerCase())) return `\n![📷 ${idx}](${fname})\n`;
      }
    }
    return "";
  });
  h = h.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|section|article|header|footer)>/gi, "\n");
  h = h.replace(/<(br|hr)\b[^>]*\/?>/gi, "\n");
  h = h.replace(/<\/td>/gi, "  ");
  // Convert <a href="URL">text</a> to markdown links before stripping tags.
  h = h.replace(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    if (!href || !text) return text || "";
    if (/^(mailto:|javascript:|#)/i.test(href)) return text;
    if (text === href || text === href.replace(/^https?:\/\//, "")) return href;
    return `[${text}](${href})`;
  });
  h = h.replace(/<[^>]+>/g, "");
  h = h.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#0*39;/g, "'")
    .replace(/&#\d+;/g, "").replace(/&\w+;/g, " ");
  h = h.replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  return h;
}

// Extract images from the selected message. Returns { images: [{base64,mime}], text?: string }.
// `text` is the body annotated with [📷 N]() markers when images were found.
// Tries attachments first (covers both explicit attachments and cid: inlines),
// then falls back to downloading remote <img src="https://..."> from the HTML body.
async function extractOutlookImages() {
  // ---- Path 1: image attachments ----
  const { images: fromAtt, names: attNames } = await extractFromAttachments();
  if (fromAtt.length) {
    // Generate uniform filenames: Image1.jpg, Image2.png, etc.
    const imageNames = fromAtt.map((im, i) => imageName(i + 1, im.mime));
    let text = null;
    try {
      const html = await readOutlookHtml();
      if (html && attNames.length) {
        const keys = new Map();
        attNames.forEach((name, i) => keys.set(name, i + 1));
        text = htmlToAnnotatedText(html, keys, imageNames);
      }
    } catch { /* annotation is best-effort */ }
    return { images: fromAtt, imageNames, text };
  }

  // ---- Path 2: remote images in HTML body (newsletter-style emails) ----
  return extractFromHtmlBody();
}

// Path 1: save image attachments from the selected message.
// Returns { images: [{base64,mime}], names: string[] } (names parallel to images,
// used to locate each image in the HTML for position markers).
async function extractFromAttachments() {
  const tmpDir = path.join(os.tmpdir(), `hk_outlook_img_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const saved = [];
  const savedNames = [];
  try {
    const infoOut = await runOsa(
      RUNNING_GATE(APPS.outlook) +
      `set rs to character id 30
set lf to character id 10
tell application "Microsoft Outlook"
	set sel to {}
	try
		set sel to selected objects
	on error
		set sel to selection
	end try
	if sel is missing value or (count of sel) is 0 then return ""
	set m to item 1 of sel
	set attList to attachments of m
	if (count of attList) is 0 then return ""
	set info to ""
	repeat with att in attList
		set attName to name of att
		set attSize to file size of att
		set info to info & attName & rs & (attSize as string) & lf
	end repeat
	return info
end tell`, 30000);
    if (!infoOut || !infoOut.trim()) return { images: [], names: [] };

    const lines = infoOut.trim().split("\n");
    const candidates = [];
    for (const line of lines) {
      const [attName, attSizeStr] = line.split(RS);
      if (!attName) continue;
      const ext = (attName.match(/\.([^.]+)$/) || [])[1] || "";
      if (!IMG_EXT_SET.has(ext.toLowerCase())) continue;
      const attSize = parseInt(attSizeStr, 10) || 0;
      if (attSize > 0 && attSize < IMG_MIN_BYTES) continue;
      candidates.push({ name: attName, size: attSize, index: candidates.length + 1 });
      if (candidates.length >= IMG_MAX_COUNT + 4) break;
    }
    if (!candidates.length) return { images: [], names: [] };

    for (const c of candidates) {
      if (saved.length >= IMG_MAX_COUNT) break;
      const safeName = c.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const outPath = path.join(tmpDir, `${c.index}_${safeName}`);
      try {
        await runOsa(
          RUNNING_GATE(APPS.outlook) +
          `tell application "Microsoft Outlook"
	set sel to {}
	try
		set sel to selected objects
	on error
		set sel to selection
	end try
	if sel is missing value or (count of sel) is 0 then return ""
	set m to item 1 of sel
	set attList to attachments of m
	repeat with att in attList
		if name of att is "${c.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" then
			save att in POSIX file "${outPath}"
			return "ok"
		end if
	end repeat
	return ""
end tell`, 30000);
        if (!fs.existsSync(outPath)) continue;
        const buf = fs.readFileSync(outPath);
        if (buf.length < IMG_MIN_BYTES) continue;

        const ext = (c.name.match(/\.([^.]+)$/) || [])[1] || "jpg";
        const extLower = ext.toLowerCase();
        let mime = "image/jpeg";
        if (extLower === "png") mime = "image/png";
        else if (extLower === "gif") mime = "image/gif";
        else if (extLower === "webp") mime = "image/webp";
        else if (extLower === "heic") mime = "image/heic";

        try {
          const o = await optimizeImage(buf, mime);
          saved.push({ base64: o.buf.toString("base64"), mime: o.ct });
        } catch {
          if (buf.length < 5 * 1024 * 1024) {
            saved.push({ base64: buf.toString("base64"), mime });
          }
        }
        savedNames.push(c.name);
      } catch { /* single attachment failure — continue */ }
    }
  } catch { /* bulk failure — return whatever we got */ }
  finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { images: saved, names: savedNames };
}

// Path 2: download remote images referenced in the HTML body.
// Returns { images: [{base64,mime}], text?: string } with annotated body text.
async function extractFromHtmlBody() {
  let html = "";
  try { html = await readOutlookHtml(); } catch { return { images: [], text: null }; }
  if (!html) return { images: [], text: null };

  const imgRe = /<img\b[^>]*>/gi;
  const srcRe = /\bsrc\s*=\s*"([^"]+)"/i;
  const widthRe = /\bwidth\s*=\s*"?(\d+)"?/i;
  const heightRe = /\bheight\s*=\s*"?(\d+)"?/i;

  const urls = [];
  const seen = new Set();
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const sm = srcRe.exec(tag);
    if (!sm) continue;
    const url = sm[1];
    if (!url.startsWith("https://") && !url.startsWith("http://")) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const wm = widthRe.exec(tag), hm = heightRe.exec(tag);
    const w = wm ? parseInt(wm[1], 10) : 999;
    const h = hm ? parseInt(hm[1], 10) : 999;
    if (w < 80 || h < 80) continue;
    urls.push(url);
    if (urls.length >= IMG_MAX_COUNT + 4) break;
  }
  if (!urls.length) return { images: [], text: null };

  // Shared downloader: same filters, shrinking and ordering the .eml path uses.
  const fetched = (await fetchRemoteImages(urls)).slice(0, IMG_MAX_COUNT);
  const saved = fetched.map(({ base64, mime }) => ({ base64, mime }));
  const savedUrls = fetched.map((f) => f.url);
  // Annotate the HTML body with image position markers (uniform image_01.png names).
  const imageNames = saved.map((im, i) => imageName(i + 1, im.mime));
  let text = null;
  if (saved.length) {
    try {
      const keys = new Map();
      savedUrls.forEach((url, i) => keys.set(url, i + 1));
      text = htmlToAnnotatedText(html, keys, imageNames);
    } catch { /* annotation failure — return images without annotated text */ }
  }
  return { images: saved, imageNames, text };
}

// ---- Clipboard ----

// Read the clipboard: text via `pbpaste`, and when there is no text, an image (macOS
// stores copied screenshots as TIFF/PNG on the pasteboard — AppleScript writes it out
// as PNG). Whatever the user just copied, from any app, with no per-app integration.
async function readClipboard() {
  const text = await new Promise((resolve) => {
    execFile("pbpaste", [], { timeout: 10000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : stdout));
  });
  if (text.trim()) return { app: "clip", text: normalizeText(text) };

  const tmp = path.join(os.tmpdir(), `hk_clip_${Date.now()}.png`);
  try {
    await runOsa(
      `set f to (POSIX file "${tmp}")
set d to (the clipboard as «class PNGf»)
set fh to open for access f with write permission
set eof fh to 0
write d to fh
close access fh`, 15000);
    const buf = fs.readFileSync(tmp);
    if (!buf.length) return { app: "clip", text: "" };
    let image = buf.toString("base64"), imageMime = "image/png";
    try {
      const o = await optimizeImage(buf, "image/png");
      image = o.buf.toString("base64"); imageMime = o.ct;
    } catch { /* keep the raw PNG */ }
    return { app: "clip", text: "", image, imageMime };
  } catch {
    return { app: "clip", text: "" };   // neither text nor image on the pasteboard
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ---- request handler ----

// POST /api/office/read { app: "word"|"ppt"|"outlook"|"excel", selectionOnly? }
async function officeRead(req, res) {
  if (process.platform !== "darwin") { sendJson(res, 200, { error: "unsupported_platform" }); return; }
  let body = {};
  try { body = await readBody(req); } catch { /* treat as empty */ }
  const app = String(body.app || "");
  // The clipboard is not an app: no install/running gate, no AppleScript app terminology.
  if (app === "clip") {
    try {
      const data = await readClipboard();
      if (!data.text && !data.image) { sendJson(res, 200, { error: "clip_empty" }); return; }
      sendJson(res, 200, data);
    } catch (e) { sendJson(res, 200, { error: e.message || "clipboard read failed" }); }
    return;
  }
  const appName = APPS[app];
  if (!appName) { sendJson(res, 200, { error: "unknown app" }); return; }
  if (!appInstalled(appName)) { sendJson(res, 200, { error: "not_installed", app: appName }); return; }

  try {
    let data;
    if (app === "word") data = await readWord(body.selectionOnly === true);
    else if (app === "excel") data = await readExcel(body.selectionOnly === true);
    else if (app === "ppt") {
      data = await readPpt();
      const shot = await capturePptWindow();
      if (shot) Object.assign(data, shot);
    } else data = await readOutlook();
    if (data.text && data.text.length > 20000) { data.text = data.text.slice(0, 20000); data.truncated = true; }
    sendJson(res, 200, data);
  } catch (e) {
    const token = errToken(e);
    if (token) { sendJson(res, 200, { error: token, app: appName }); return; }
    // Anything else from Outlook is most likely "New Outlook" (no scripting).
    if (app === "outlook") { sendJson(res, 200, { error: "unsupported", app: appName, detail: e.message }); return; }
    sendJson(res, 200, { error: e.message || "read failed", app: appName });
  }
}

module.exports = { officeRead };
