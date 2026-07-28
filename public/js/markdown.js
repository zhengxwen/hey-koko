// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Markdown parsing and rendering
import { escapeHtml } from './utils.js';

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
    const src = opts && typeof opts.resolveImage === "function" ? opts.resolveImage(url) : null;
    if (!src) return m;
    const key = `\x00PH${idx++}\x00`;
    placeholders.push(
      `<img class="mdBubbleThumb" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" title="${escapeHtml(alt || url)}" loading="lazy">`
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
    )
    // Auto-link bare URLs (not already inside an href). The text is HTML-escaped
    // above, so a query-string "&" is now "&amp;" — allow that entity to continue
    // the URL (else a link like ...?a=1&b=2 truncates at the first "&"). Other
    // entities (&quot;/&lt;/&gt;) still terminate it, marking attribute/tag edges.
    .replace(
      /(?<!href=&quot;|href=")(https?:\/\/(?:[^\s<&]|&amp;)+)/g,
      '<a href="$1" target="_blank" rel="noreferrer">$1</a>'
    );

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
      closeList();
      continue;
    }

    closeList();
    // Handle hard line breaks: trailing \ or two+ spaces
    const hasHardBreak = /\\$/.test(line) || / {2,}$/.test(line);
    const trimmedLine = line.replace(/\\$/, '').replace(/ {2,}$/, '');
    const rendered = renderInlineMarkdown(trimmedLine, opts);
    // Merge with previous <p> if it ended with <br>
    if (html.length && html[html.length - 1].endsWith("<br></p>")) {
      html[html.length - 1] = html[html.length - 1].slice(0, -4) + rendered + (hasHardBreak ? "<br>" : "") + "</p>";
    } else {
      html.push(`<p>${rendered}${hasHardBreak ? "<br>" : ""}</p>`);
    }
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
  mermaid.run({ nodes });
}

export function highlightCodeBlocks(container) {
  if (typeof hljs === "undefined") return;
  (container || document.querySelector("#messages")).querySelectorAll("pre code:not(.hljs)").forEach((block) => {
    hljs.highlightElement(block);
  });
}