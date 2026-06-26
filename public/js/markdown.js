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

export function renderInlineMarkdown(value) {
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
    // Auto-link bare URLs (not already inside an href)
    .replace(
      /(?<!href=&quot;|href=")(https?:\/\/[^\s<&]+)/g,
      '<a href="$1" target="_blank" rel="noreferrer">$1</a>'
    );

  // Restore placeholders
  for (let i = 0; i < placeholders.length; i++) {
    result = result.replace(`\x00PH${i}\x00`, placeholders[i]);
  }
  return result;
}

export function markdownToHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeLines = [];
  let inMathBlock = false;
  let mathLines = [];
  let listType = null;
  let inTable = false;
  let tableRows = [];
  let inHtmlTable = false;
  let htmlTableLines = [];
  let inQuote = false;
  let quoteLines = [];

  function closeList() {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = null;
  }

  function closeQuote() {
    if (!inQuote) return;
    // Render the quote's inner markdown recursively so multi-paragraph quotes,
    // bold, lists, etc. (and blank `>` separator lines) all work.
    html.push(`<blockquote>${markdownToHtml(quoteLines.join("\n"))}</blockquote>`);
    quoteLines = [];
    inQuote = false;
  }

  function closeCodeBlock() {
    if (codeBlockLang === "mermaid") {
      html.push(`<pre class="mermaid">${escapeHtml(codeLines.join("\n"))}</pre>`);
    } else {
      const langClass = codeBlockLang ? ` class="language-${escapeHtml(codeBlockLang)}"` : "";
      html.push(`<pre><code${langClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
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
        html.push(`<p>${renderInlineMarkdown(row)}</p>`);
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
      tableHtml += `<th${align}>${renderInlineMarkdown(headerCells[i])}\n</th>`;
    }
    tableHtml += "</tr></thead><tbody>";

    for (let r = 2; r < tableRows.length; r++) {
      const cells = parseTableCells(tableRows[r]);
      tableHtml += "<tr>";
      for (let i = 0; i < headerCells.length; i++) {
        const align = aligns[i] ? ` style="text-align:${aligns[i]}"` : "";
        tableHtml += `<td${align}>${renderInlineMarkdown(cells[i] || "")}\n</td>`;
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

    const singleLineMath = line.trim().match(/^\$\$(.+)\$\$$/);
    if (singleLineMath && !inMathBlock) {
      closeList();
      html.push(mathHtml(singleLineMath[1], true, true));
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

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length + 2;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const listItem = line.match(/^\s*[-*+]\s+(.+)$/);
    if (listItem) {
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      const checkboxMatch = listItem[1].match(/^\[([ xX])\]\s*(.*)/);
      if (checkboxMatch) {
        const checked = checkboxMatch[1] !== " " ? " checked disabled" : " disabled";
        html.push(`<li class="task-list-item"><input type="checkbox"${checked}> ${renderInlineMarkdown(checkboxMatch[2])}</li>`);
      } else {
        html.push(`<li>${renderInlineMarkdown(listItem[1])}</li>`);
      }
      continue;
    }

    const orderedItem = line.match(/^\s*\d+\.\s+(.+)$/);
    if (orderedItem) {
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${renderInlineMarkdown(orderedItem[1])}</li>`);
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
    const rendered = renderInlineMarkdown(trimmedLine);
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