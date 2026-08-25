// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Markdown parsing and rendering
import { escapeHtml } from './utils.js';
import { t } from './i18n.js';
import { dom, state } from './state.js';   // leaf module — safe here; used by the ```imagine button

function renderMath(math, displayMode) {
  if (typeof katex === "undefined") return `<code>${escapeHtml(math)}</code>`;
  try {
    return katex.renderToString(math, { throwOnError: false, displayMode });
  } catch {
    return `<code>${escapeHtml(math)}</code>`;
  }
}

// Wrap rendered math so the TTS layer can speak a description of it: the raw
// LaTeX is stashed in data-tts-tex (speech.js turns it into spoken text and
// highlights the whole formula as one unit). block=true → display math on its
// own line (its own sentence); false → inline (stays within the sentence).
function mathHtml(rawTex, displayMode, block) {
  const tag = block ? "div" : "span";
  const cls = block ? "katex-block tts-math" : "tts-math";
  return `<${tag} class="${cls}" data-tts-tex="${escapeHtml(rawTex)}">${renderMath(rawTex, displayMode)}</${tag}>`;
}

export function renderInlineMarkdown(value, opts) {
  const placeholders = [];
  let idx = 0;

  // Protect inline code first
  value = value.replace(/`([^`]+)`/g, (_, code) => {
    const key = `\x00PH${idx++}\x00`;
    placeholders.push(`<code>${escapeHtml(code)}</code>`);
    return key;
  });

  // Backslash escapes: \X → literal X, hidden from all markdown parsing below.
  // Runs AFTER code protection (so backslashes inside code stay literal) but
  // BEFORE math/emphasis/link parsing (so e.g. \$ can't trigger KaTeX). The set
  // excludes [ ] ( ) ` — those belong to links, code spans, and the \[…\] / \(…\)
  // math delimiters, so they can't double as literal-bracket escapes.
  value = value.replace(/\\([\\$*_#+\-.!~|{}])/g, (_, ch) => {
    const key = `\x00PH${idx++}\x00`;
    placeholders.push(escapeHtml(ch));
    return key;
  });

  // Protect display math $$...$$ (inline occurrence)
  value = value.replace(/\$\$([^$]+?)\$\$/g, (_, math) => {
    const key = `\x00PH${idx++}\x00`;
    placeholders.push(mathHtml(math, true, false));
    return key;
  });

  // Protect inline math $...$ (not $$)
  value = value.replace(/(?<!\$)\$(?!\$)([^$\n]+?)(?<!\$)\$(?!\$)/g, (_, math) => {
    const key = `\x00PH${idx++}\x00`;
    placeholders.push(mathHtml(math, false, false));
    return key;
  });

  // Protect LaTeX-delimiter math: \[...\] display, \(...\) inline
  value = value.replace(/\\\[([\s\S]+?)\\\]/g, (_, math) => {
    const key = `\x00PH${idx++}\x00`;
    placeholders.push(mathHtml(math, true, false));
    return key;
  });
  value = value.replace(/\\\(([\s\S]+?)\\\)/g, (_, math) => {
    const key = `\x00PH${idx++}\x00`;
    placeholders.push(mathHtml(math, false, false));
    return key;
  });

  // Image ![alt](url): render an inline thumbnail ONLY when a resolver maps the
  // url to a same-bubble image; otherwise leave the literal text untouched (it
  // falls through to normal escaping → "正常显示文字 ![]()").
  value = value.replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, (m, alt, url) => {
    const r = opts && typeof opts.resolveImage === "function" ? opts.resolveImage(url) : null;
    if (!r) return m;
    const src = typeof r === "string" ? r : r.src;
    if (!src) return m;
    const full = (r && typeof r === "object" && r.full) ? r.full : src;
    const key = `\x00PH${idx++}\x00`;
    placeholders.push(
      `<img class="mdBubbleThumb" src="${escapeHtml(src)}" data-full-src="${escapeHtml(full)}" ` +
      `alt="${escapeHtml(alt)}" title="${escapeHtml(alt || url)}" loading="lazy">`
    );
    return key;
  });

  // Now escape and apply other inline formatting
  let result = escapeHtml(value)
    .replace(/&lt;br\s*\/?\s*&gt;/gi, "<br>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
    )
    .replace(
      /\[([^\]]+)\]\((mailto:[^\s)]+)\)/g,
      '<a href="$2">$1</a>'
    )
    // In-page hash links (e.g. the /ask sources "#libsrc=…" refs) — inert as
    // navigation, handled by delegated click handlers.
    .replace(
      /\[([^\]]+)\]\((#[^\s)]+)\)/g,
      '<a href="$2">$1</a>'
    );

  // Protect the anchors just generated so the bare-URL auto-linker below can't
  // re-wrap a URL nested inside an href value — e.g. tracking links shaped like
  // https://track/?url=https://real/… would otherwise get a stray inner <a> that
  // breaks the outer tag.
  const anchors = [];
  result = result.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (m) => {
    anchors.push(m);
    return `\x00A${anchors.length - 1}\x00`;
  });

  // Auto-link bare URLs (not already inside an href). The text is HTML-escaped
  // above, so a query-string "&" is now "&amp;" — allow that entity to continue
  // the URL (else a link like ...?a=1&b=2 truncates at the first "&"). Other
  // entities (&quot;/&lt;/&gt;) still terminate it, marking attribute/tag edges.
  // \x00 is excluded so a URL adjacent to an anchor placeholder can't swallow it.
  result = result.replace(
    /(?<!href=&quot;|href=")(https?:\/\/(?:[^\s<&\x00]|&amp;)+)/g,
    '<a href="$1" target="_blank" rel="noreferrer">$1</a>'
  );

  // Restore protected anchors.
  result = result.replace(/\x00A(\d+)\x00/g, (_, i) => anchors[Number(i)]);

  // Restore placeholders
  for (let i = 0; i < placeholders.length; i++) {
    result = result.replace(`\x00PH${i}\x00`, placeholders[i]);
  }
  return result;
}

// Sanitize an ```svg block before inlining it (LLM output → innerHTML). Strips
// the SVG XSS vectors: <script>/<foreignObject>, inline on* handlers, and
// javascript: URLs. Mirrors sanitizeHtmlTable's defense-in-depth approach.
function sanitizeSvg(svg) {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/<\/?(?:script|foreignObject)\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, "")
    .replace(/((?:xlink:)?href)\s*=\s*("|')?\s*javascript:[^"'>]*\2?/gi, "");
}

export function markdownToHtml(markdown, opts) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeLines = [];
  let inMathBlock = false;
  let mathLines = [];
  let listStack = []; // nested lists: each level = { tag: "ul"|"ol", indent }
  let inTable = false;
  let tableRows = [];
  let inHtmlTable = false;
  let htmlTableLines = [];
  let inQuote = false;
  let quoteLines = [];
  let paraOpen = false; // a text paragraph is currently accumulating consecutive lines

  function closeList() {
    while (listStack.length) {
      const lvl = listStack.pop();
      html.push(`</li></${lvl.tag}>`);
    }
  }

  function closeQuote() {
    if (!inQuote) return;
    // Render the quote's inner markdown recursively so multi-paragraph quotes,
    // bold, lists, etc. (and blank `>` separator lines) all work.
    html.push(`<blockquote>${markdownToHtml(quoteLines.join("\n"), opts)}</blockquote>`);
    quoteLines = [];
    inQuote = false;
  }

  function closeCodeBlock() {
    const code = codeLines.join("\n");
    if (codeBlockLang === "mermaid") {
      html.push(`<pre class="mermaid">${escapeHtml(code)}</pre>`);
    } else if (codeBlockLang === "svg" && /<svg[\s>]/i.test(code)) {
      // Render the SVG inline (sanitized) instead of showing its source.
      html.push(`<div class="svg-block">${sanitizeSvg(code)}</div>`);
    } else {
      const langClass = codeBlockLang ? ` class="language-${escapeHtml(codeBlockLang)}"` : "";
      html.push(`<pre><code${langClass}>${escapeHtml(code)}</code></pre>`);
    }
    codeLines = [];
    codeBlockLang = "";
    inCodeBlock = false;
  }

  function closeMathBlock() {
    const math = mathLines.join("\n");
    html.push(mathHtml(math, true, true));
    mathLines = [];
    inMathBlock = false;
  }

  function parseTableCells(row) {
    let cells = row.split("|");
    if (cells[0].trim() === "") cells.shift();
    if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
    return cells.map((c) => c.trim());
  }

  function sanitizeHtmlTable(html) {
    const allowed = /^\/?(table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col|br)$/i;
    return html.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (tag, name) => {
      if (!allowed.test(name)) return escapeHtml(tag);
      // Strip event handlers and javascript: urls
      return tag.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '')
               .replace(/\s+href\s*=\s*["']?\s*javascript:[^"'>]*/gi, '');
    });
  }

  function closeHtmlTable() {
    html.push(sanitizeHtmlTable(htmlTableLines.join("\n")));
    htmlTableLines = [];
    inHtmlTable = false;
  }

  function closeTable() {
    if (tableRows.length < 2) {
      for (const row of tableRows) {
        html.push(`<p>${renderInlineMarkdown(row, opts)}</p>`);
      }
      tableRows = [];
      inTable = false;
      return;
    }

    const sepCells = parseTableCells(tableRows[1]);
    const aligns = sepCells.map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      return null;
    });

    const headerCells = parseTableCells(tableRows[0]);
    let tableHtml = "<table><thead><tr>";
    for (let i = 0; i < headerCells.length; i++) {
      const align = aligns[i] ? ` style="text-align:${aligns[i]}"` : "";
      tableHtml += `<th${align}>${renderInlineMarkdown(headerCells[i], opts)}\n</th>`;
    }
    tableHtml += "</tr></thead><tbody>";

    for (let r = 2; r < tableRows.length; r++) {
      const cells = parseTableCells(tableRows[r]);
      tableHtml += "<tr>";
      for (let i = 0; i < headerCells.length; i++) {
        const align = aligns[i] ? ` style="text-align:${aligns[i]}"` : "";
        tableHtml += `<td${align}>${renderInlineMarkdown(cells[i] || "", opts)}\n</td>`;
      }
      tableHtml += "</tr>";
    }
    tableHtml += "</tbody></table>";
    html.push(tableHtml);

    tableRows = [];
    inTable = false;
  }

  for (const line of lines) {
    // Was a text paragraph left open by the previous line? Reset now; only the
    // paragraph branch below re-opens it, so any block/blank line (all of which
    // `continue`) leaves it closed → the next text line starts a fresh <p>.
    const contPara = paraOpen;
    paraOpen = false;

    // A blockquote ends as soon as a non-quote line appears.
    if (inQuote && !/^\s*>/.test(line)) closeQuote();

    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        closeCodeBlock();
      } else {
        closeList();
        inCodeBlock = true;
        codeBlockLang = line.trim().slice(3).trim().toLowerCase();
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // HTML table passthrough
    if (inHtmlTable) {
      htmlTableLines.push(line);
      if (/<\/table\s*>/i.test(line)) closeHtmlTable();
      continue;
    }
    if (/^\s*<table[\s>]/i.test(line)) {
      closeList();
      inHtmlTable = true;
      htmlTableLines = [line];
      if (/<\/table\s*>/i.test(line)) closeHtmlTable();
      continue;
    }

    // <details>/<summary> passthrough for collapsible blocks (e.g. the /ask -a
    // retrieval-notes sub-bubble). Only these two tags are let through raw; the body
    // lines between them keep rendering as normal markdown. <summary>…</summary>'s
    // inner text is rendered inline so links/emphasis inside it still work.
    const detailsOpen = line.trim().match(/^<details(\s+open)?\s*>$/i);
    if (detailsOpen) { closeList(); if (inTable) closeTable(); html.push(`<details${detailsOpen[1] ? " open" : ""}>`); continue; }
    if (/^<\/details>\s*$/i.test(line.trim())) { closeList(); html.push("</details>"); continue; }
    const summaryLine = line.trim().match(/^<summary>([\s\S]*?)<\/summary>$/i);
    if (summaryLine) { closeList(); html.push(`<summary>${renderInlineMarkdown(summaryLine[1], opts)}</summary>`); continue; }

    if (line.trim() === "$$") {
      if (inMathBlock) {
        closeMathBlock();
      } else {
        closeList();
        inMathBlock = true;
        mathLines = [];
      }
      continue;
    }

    const singleLineMath = line.trim().match(/^\$\$(.+)\$\$$/) || line.trim().match(/^\\\[(.+)\\\]$/);
    if (singleLineMath && !inMathBlock) {
      closeList();
      html.push(mathHtml(singleLineMath[1], true, true));
      continue;
    }

    // LaTeX display-math block delimiters on their own lines: \[ … \]
    if (line.trim() === "\\[" && !inMathBlock) {
      closeList();
      inMathBlock = true;
      mathLines = [];
      continue;
    }
    if (line.trim() === "\\]" && inMathBlock) {
      closeMathBlock();
      continue;
    }

    if (inMathBlock) {
      mathLines.push(line);
      continue;
    }

    // Blockquote: accumulate consecutive `>` lines (including empty `>`); claimed
    // before tables/lists so `>` is unambiguous. Rendered when the quote closes.
    if (/^\s*>/.test(line)) {
      closeList();
      if (inTable) closeTable();
      if (!inQuote) { inQuote = true; quoteLines = []; }
      quoteLines.push(line.replace(/^\s*>\s?/, ""));
      continue;
    }

    const isTableRow = /^\|.+\|$/.test(line.trim()) || /^.+\|.+/.test(line.trim()) && line.includes("|");
    const isSeparator = /^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(line.trim());

    if (inTable) {
      if (isTableRow || isSeparator) {
        tableRows.push(line.trim());
        continue;
      } else {
        closeTable();
      }
    } else if (isTableRow && !isSeparator) {
      closeList();
      inTable = true;
      tableRows = [line.trim()];
      continue;
    }

    // Horizontal rule: ---, ***, ___
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      closeList();
      html.push("<hr>");
      continue;
    }

    // Headings #..###### (standard markdown allows up to 6 hashes). Level maps
    // #→h3 … and is capped at h6, so ####/#####/###### all render as h6 rather
    // than leaving the literal "####" in the text (which the read-aloud DOM would
    // otherwise speak, and which shows raw in the bubble).
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(6, heading[1].length + 2);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2], opts)}</h${level}>`);
      continue;
    }

    // List item (nested by leading indent). <li> is left open so a deeper list
    // can be nested inside it; closed lazily on the next sibling / dedent / close.
    const listItem = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      if (inTable) closeTable();
      const indent = listItem[1].replace(/\t/g, "    ").length;
      const tag = /\d/.test(listItem[2]) ? "ol" : "ul";
      const content = listItem[3];

      // Dedent: close any deeper levels than this item.
      while (listStack.length && indent < listStack[listStack.length - 1].indent) {
        const lvl = listStack.pop();
        html.push(`</li></${lvl.tag}>`);
      }

      const top = listStack[listStack.length - 1];
      if (top && indent === top.indent) {
        if (top.tag !== tag) {            // same level but list type switched
          html.push(`</li></${top.tag}>`);
          listStack.pop();
          html.push(`<${tag}>`);
          listStack.push({ tag, indent });
        } else {
          html.push("</li>");             // sibling: close previous item
        }
      } else {                            // deeper (or first) level: open a list
        html.push(`<${tag}>`);
        listStack.push({ tag, indent });
      }

      const checkboxMatch = tag === "ul" && content.match(/^\[([ xX])\]\s*(.*)/);
      if (checkboxMatch) {
        const checked = checkboxMatch[1] !== " " ? " checked disabled" : " disabled";
        html.push(`<li class="task-list-item"><input type="checkbox"${checked}> ${renderInlineMarkdown(checkboxMatch[2], opts)}`);
      } else {
        html.push(`<li>${renderInlineMarkdown(content, opts)}`);
      }
      continue;
    }

    if (!line.trim()) {
      // A blank line does NOT end a list (CommonMark): items separated by blanks
      // stay in the same <ol>/<ul> so numbering keeps counting 1, 2, 3, … A real
      // non-list line (paragraph/heading/…) closes the list via its own closeList(),
      // and any open list is closed at end-of-input.
      continue;
    }

    closeList();
    // Consecutive non-blank lines join into ONE <p>, separated by <br> (tight
    // line spacing); a blank line above breaks the paragraph so the next line
    // opens a NEW <p> that carries the paragraph margin. Trailing \ or 2+ spaces
    // are stripped — the line break already becomes the <br> that joins lines.
    const rendered = renderInlineMarkdown(line.replace(/\\$/, "").replace(/ {2,}$/, ""), opts);
    if (contPara && html.length && html[html.length - 1].endsWith("</p>")) {
      const cur = html[html.length - 1];
      html[html.length - 1] = cur.slice(0, -4) + "<br>" + rendered + "</p>";
    } else {
      html.push(`<p>${rendered}</p>`);
    }
    paraOpen = true;
  }

  if (inCodeBlock) closeCodeBlock();
  if (inMathBlock) closeMathBlock();
  if (inHtmlTable) closeHtmlTable();
  if (inTable) closeTable();
  if (inQuote) closeQuote();
  closeList();
  return html.join("");
}

export function renderMermaidDiagrams(container) {
  if (typeof mermaid === "undefined") return;
  const nodes = (container || document.querySelector("#messages")).querySelectorAll("pre.mermaid:not([data-processed])");
  if (nodes.length === 0) return;
  // mermaid.run() replaces the <pre>'s content with the rendered SVG, destroying the
  // diagram source — stash it first so the copy button can still offer it.
  nodes.forEach((n) => { if (!n.dataset.src) n.dataset.src = n.textContent; });
  mermaid.run({ nodes });
}

// --- Copy button for code / svg / mermaid blocks ------------------------------
// Each block gets a floating button that copies the SOURCE that produced it: the
// code text, the SVG markup, or the mermaid definition.
//
// The button lives in a WRAPPER beside the block rather than inside it, because both
// mermaid (innerHTML → SVG) and hljs rewrite a block's contents and would otherwise
// wipe it out. Text is read at CLICK time for the same reason.
function attachCopyButton(el, getText) {
  if (el.parentElement?.classList.contains("mdBlockWrap")) return;   // already wrapped
  const wrap = document.createElement("div");
  wrap.className = "mdBlockWrap";
  el.parentNode.insertBefore(wrap, el);
  wrap.appendChild(el);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mdCopyBtn";
  btn.title = t("md_copyBlock");
  btn.setAttribute("aria-label", t("md_copyBlock"));
  btn.textContent = "📋";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const text = (getText() || "").replace(/\s+$/, "");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API can be unavailable/denied — fall back to a scratch textarea.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
    }
    btn.textContent = "✓";
    btn.classList.add("isCopied");
    btn.title = t("md_copied");
    setTimeout(() => {
      btn.textContent = "📋";
      btn.classList.remove("isCopied");
      btn.title = t("md_copyBlock");
    }, 1200);
  });
  wrap.appendChild(btn);
}

// A code block that IS a render command. Two signals, either suffices — the fence tag
// ```imagine (what the /skill wrapper instructs), or a first line starting with
// "/imagine" (the fallback for a model that wrote the command but forgot the tag).
// This is the DETERMINISTIC half of the prompt-workshop handoff: whatever the LLM did
// or did not do with its instructions, a block that looks like a dispatchable command
// gets a real button. ▶ RUNS it — the prompt was already reviewed across the whole
// workshop conversation, so a second confirmation step in the composer is just friction.
// The copy chip next to it is the route for anyone who wants to edit before running.
function isImagineBlock(pre) {
  const code = pre.querySelector("code");
  if (!code) return false;
  if (/\blanguage-imagine\b/.test(code.className)) return true;
  return /^\/imagine(\s|$)/.test((code.textContent || "").trimStart());
}

function attachImagineButton(pre) {
  const wrap = pre.parentElement?.classList.contains("mdBlockWrap") ? pre.parentElement : null;
  if (!wrap || wrap.querySelector(".mdImagineBtn")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mdImagineBtn";
  btn.title = t("md_toImagine");
  btn.setAttribute("aria-label", t("md_toImagine"));
  btn.textContent = "▶";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const code = pre.querySelector("code");
    const raw = ((code ? code.textContent : pre.textContent) || "").trim();
    if (!raw || !dom.messageInput || !dom.chatForm) return;
    // Running is gated on the block ACTUALLY being a command: it must open with
    // "/imagine". A ```imagine block whose dispatch line the model forgot is only a
    // prompt body — no model or duration can be invented for it — so it gets the bare
    // prefix and goes to the composer for the user to complete, never straight to a GPU.
    const isCommand = /^\/imagine(\s|$)/.test(raw);
    const text = isCommand ? raw : `/imagine\n${raw}`;
    // Likewise while a stream or generation is running: the send button IS the stop
    // button then, so submitting would abort that instead of dispatching.
    const busy = !!(state.currentAbortController || state.imageGenAbortController);
    if (!isCommand || busy) {
      dom.messageInput.value = text;
      dom.messageInput.focus();
      dom.messageInput.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    // Dispatch through the composer's own submit path rather than calling the
    // generator directly: staged reference images/clips, parse errors and the
    // background queue then behave exactly as if the user had typed the command.
    // The submit handler reads and clears the field synchronously (before its first
    // await), so the user's unsent draft can be put straight back afterwards.
    const draft = dom.messageInput.value;
    dom.messageInput.value = text;
    // The prompt is already on screen in the block right above, so the command bubble
    // this send creates is a receipt, not new content — sendMessage folds it (collapsed
    // + out of context) on seeing this one-shot flag.
    state.foldNextCommandBubble = true;
    // …and it belongs to THIS draft: the receipt is inserted right under this bubble,
    // replacing the one a previous press of this same ▶ left there. renderChat stamps
    // the stable id on every bubble, which is what survives edits/deletions above.
    state.dispatchFromMsgId = btn.closest("[data-msg-id]")?.dataset.msgId || null;
    dom.chatForm.requestSubmit();
    // sendMessage consumes the flag synchronously (the submit handler has no await
    // before it), so this only disarms the case where the handler bailed out early —
    // a stale flag must never fold the user's next hand-typed command.
    state.foldNextCommandBubble = false;
    state.dispatchFromMsgId = null;
    dom.messageInput.value = draft;
    dom.messageInput.dispatchEvent(new Event("input", { bubbles: true }));  // autosize + button state
    btn.textContent = "✓";
    setTimeout(() => { btn.textContent = "▶"; }, 1200);
  });
  wrap.appendChild(btn);
}

// An ```officecli block: an officecli batch script for the document /doc has open —
// the fence is named for the tool whose schema the JSON is, not for the command. Same deal as
// ```imagine — the block is a proposal until ▶ is pressed — but the dispatch differs.
// /imagine goes back through the composer so staged attachments behave identically;
// an ```officecli block has nothing to stage, and pushing raw JSON into the message input
// would leave the user staring at a blob. So ▶ calls the applier directly.
function isOfficeBlock(pre) {
  const code = pre.querySelector("code");
  if (!code) return false;
  if (/\blanguage-officecli\b/.test(code.className)) return true;
  // Fallback for a model that wrote the script but tagged the fence ```json (or not at
  // all) — the same discipline as isImagineBlock: a block that IS a dispatchable command
  // gets a real button whatever the model did with its instructions. Cheap to check: it
  // has to parse AND carry a non-empty commands array.
  const text = (code.textContent || "").trim();
  if (!text.startsWith("{") || !text.includes('"commands"')) return false;
  try {
    const obj = JSON.parse(text);
    return !!obj && Array.isArray(obj.commands) && obj.commands.length > 0;
  } catch { return false; }
}

function attachOfficeButton(pre) {
  const wrap = pre.parentElement?.classList.contains("mdBlockWrap") ? pre.parentElement : null;
  if (!wrap || wrap.querySelector(".mdImagineBtn")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mdImagineBtn";
  btn.title = t("md_toOffice");
  btn.setAttribute("aria-label", t("md_toOffice"));
  btn.textContent = "▶";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    // While a stream or a render is running, applying would race the reply that is still
    // writing this very block — same guard the ```imagine button uses.
    if (state.currentAbortController || state.imageGenAbortController) return;
    const code = pre.querySelector("code");
    const raw = ((code ? code.textContent : pre.textContent) || "").trim();
    if (!raw) return;
    btn.disabled = true;
    try {
      const { runOfficeBlock } = await import('./office-doc.js');
      await runOfficeBlock(raw);
      btn.textContent = "✓";
      setTimeout(() => { btn.textContent = "▶"; }, 1200);
    } finally { btn.disabled = false; }
  });
  wrap.appendChild(btn);
}

export function addBlockCopyButtons(container) {
  const root = container || document.querySelector("#messages");
  if (!root) return;
  // Mermaid: prefer the stashed source; before mermaid runs (or when it is absent)
  // the <pre> still holds the definition as text.
  root.querySelectorAll("pre.mermaid").forEach((el) => {
    attachCopyButton(el, () => el.dataset.src || el.textContent);
  });
  // Inline SVG figures — copy the markup that is actually on screen.
  root.querySelectorAll("div.svg-block").forEach((el) => {
    attachCopyButton(el, () => el.querySelector("svg")?.outerHTML || el.innerHTML);
  });
  // Plain fenced code. `pre.mermaid` is excluded above by :not().
  root.querySelectorAll("pre:not(.mermaid)").forEach((el) => {
    attachCopyButton(el, () => el.querySelector("code")?.textContent ?? el.textContent);
    // Dispatchable render commands additionally get the ▶ fill-the-composer button —
    // after attachCopyButton, which builds the .mdBlockWrap the button hangs off.
    if (isImagineBlock(el)) attachImagineButton(el);
    else if (isOfficeBlock(el)) attachOfficeButton(el);
  });
  // Blockquotes — copy the quoted text (as rendered, without the > markers).
  // Only the outermost quote gets a button; nested quotes are covered by it.
  root.querySelectorAll("blockquote").forEach((el) => {
    if (el.parentElement?.closest("blockquote")) return;
    attachCopyButton(el, () => el.innerText || el.textContent);
  });
}

export function highlightCodeBlocks(container) {
  if (typeof hljs === "undefined") return;
  (container || document.querySelector("#messages")).querySelectorAll("pre code:not(.hljs)").forEach((block) => {
    hljs.highlightElement(block);
  });
}