// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Archive and retrieve functionality
import { dom, state } from './state.js';
import { escapeHtml, mediaFilename } from './utils.js';
import { markdownToHtml } from './markdown.js';
import { applyHighlights } from './highlight.js';
import { saveTabs } from './settings.js';
import { getActiveTab, createTab, closeTab, switchTab, renderTabs } from './tabs.js';
import { t } from './i18n.js';
import { tabActiveJobCount, cancelTabJobs } from './bg-jobs.js';   // Option B: warn + cancel jobs on archive

// Set by initArchive — lets the star map's inspector jump straight into an archived
// conversation's read-only preview (open overlay + select + preview in one call).
let _openArchived = null;
export function openArchivedChat(filename) { if (_openArchived) _openArchived(filename); }
// Open the archive overlay itself (list view) — the star map swaps to it when its
// source toggle flips to "archive", so leaving the map lands in the matching panel.
let _openArchivePanel = null;
export function openArchivePanel() { if (_openArchivePanel) _openArchivePanel(); }

export function initArchive() {
  const archiveOverlay = document.querySelector("#archiveOverlay");
  const archiveList = document.querySelector("#archiveList");
  const archivePreview = document.querySelector("#archivePreview");
  const archivePreviewContent = document.querySelector("#archivePreviewContent");
  const archivePreviewTitle = document.querySelector("#archivePreviewTitle");
  const archiveSearch = document.querySelector("#archiveSearch");
  const archiveSortBtn = document.querySelector("#archiveSortBtn");
  const archiveTagBar = document.querySelector("#archiveTagBar");
  const archiveRestoreBtn = document.querySelector("#archiveRestoreBtn");
  const archiveMoveBtn = document.querySelector("#archiveMoveBtn");
  const archiveDeleteBtn = document.querySelector("#archiveDeleteBtn");
  const archiveSelectAllCheckbox = document.querySelector("#archiveSelectAll");
  const archiveSelectedCount = document.querySelector("#archiveSelectedCount");
  const archivePreviewEmpty = document.querySelector("#archivePreviewEmpty");
  const archiveDirHint = document.querySelector("#archiveDirHint");
  const archiveSemanticBtn = document.querySelector("#archiveSemanticBtn");
  const archiveIndexBtn = document.querySelector("#archiveIndexBtn");

  const embedModel = () => (dom.embedModelSelect?.value || "").trim() || "qwen3-embedding:8b";

  fetch("/api/archives/dir").then(r => r.json()).then(d => {
    if (d.dir) archiveDirHint.textContent = t("archive_dirHint", { dir: d.dir });
  }).catch(() => {});

  // Lightbox support for archive preview images
  archivePreviewContent.addEventListener("dblclick", (e) => {
    const img = e.target.closest(".messageImage, .generatedImage");
    if (!img || !state.openLightbox) return;
    e.stopPropagation();
    const allImgs = Array.from(archivePreviewContent.querySelectorAll(".messageImage, .generatedImage"));
    state.openLightbox(img.src, allImgs.map(i => i.src), allImgs.map(i => i.dataset.filename || ""));
  });

  let archivesData = [];
  let sortNewestFirst = true;
  let activeTagFilter = null;
  let selectedArchives = new Set();
  let activePreviewFilename = null;
  let semanticMode = false;
  let semanticScores = null; // Map<filename, score> when a semantic search is active

  const archiveChatBtn = document.querySelector("#archiveChat");

  // Archive current conversation
  archiveChatBtn.addEventListener("click", async () => {
    const tab = getActiveTab();
    if (tab.locked) {
      alert(t("archive_locked"));
      return;
    }
    if (!tab.messages || tab.messages.length === 0) {
      alert(t("archive_empty"));
      return;
    }
    // Special library tab: "archive" writes the (edited) chunk bubbles back to the
    // library doc instead of archiving the conversation. Tab is kept open.
    if (tab.libraryDocId) {
      // Write-back can be slow (re-embedding edited chunks, esp. a cold 8b model),
      // so always show progress + a guaranteed result alert. The import is INSIDE
      // the try so a module-load failure surfaces instead of failing silently.
      const prevLabel = archiveChatBtn.textContent;
      archiveChatBtn.disabled = true;
      archiveChatBtn.textContent = t("lib_saving");
      try {
        const { writeTabToLibrary } = await import('./library.js');
        const r = await writeTabToLibrary(tab);
        if (r && r.ok) alert(t("lib_writtenBack"));
        else alert(t("lib_writeBackFail") + (r && r.error ? "：" + r.error : ""));
      } catch (e) {
        alert(t("lib_writeBackFail") + "：" + (e && e.message ? e.message : e));
      } finally {
        archiveChatBtn.disabled = false;
        archiveChatBtn.textContent = prevLabel;
      }
      return;
    }
    // Active background tasks would be lost (archive doesn't keep videos) → confirm + cancel.
    const nActive = tabActiveJobCount(tab.id);
    if (nActive > 0) {
      if (!confirm(t("bg_closeActiveJobs", { n: nActive }))) return;
      cancelTabJobs(tab.id);
    }

    const exportMessages = tab.messages.map((msg) => {
      const m = { role: msg.role };
      if (msg.timestamp) {
        const d = new Date(msg.timestamp);
        const pad = (n) => String(n).padStart(2, "0");
        m.timestamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      }
      m.content = msg.content;
      if (msg.folded) m.folded = true;
      if (msg.displayImages) m.displayImages = msg.displayImages;
      if (msg.contextImages) m.contextImages = msg.contextImages;
      if (msg.imageNames) m.imageNames = msg.imageNames;
      if (msg.generatedImages) m.generatedImages = msg.generatedImages;
      if (msg.generatedThumbnails) m.generatedThumbnails = msg.generatedThumbnails;
      // Archive the video poster thumbnails, not the (heavy) videos themselves.
      if (msg.generatedVideoThumbnails) m.generatedVideoThumbnails = msg.generatedVideoThumbnails.filter(Boolean);
      if (msg.isCompactSummary) m.isCompactSummary = true;
      if (msg.isFilePreview) m.isFilePreview = true;
      if (msg.translation) m.translation = msg.translation;
      // User text highlights / annotations — round-trip so retrieval restores them.
      if (msg.highlights && msg.highlights.length) m.highlights = msg.highlights;
      return m;
    });

    const data = {
      title: tab.title,
      userName: dom.userName.value,
      personality: tab.personality,
      persona: tab.persona,
      tags: tab.tags || [],
      messages: exportMessages,
    };
    // 取档而来的对话：归档时更新原存档文件，避免堆积重复副本。
    if (tab.sourceArchive) data.sourceArchive = tab.sourceArchive;

    try {
      const res = await fetch("/api/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok) {
        alert(result.error || "存档失败");
        return;
      }

      if (state.tabs.length > 1) {
        closeTab(tab.id);
      } else {
        tab.messages = [];
        tab.title = "聊天 1";
        tab.tags = [];
        saveTabs();
        renderTabs();
        const { renderChat } = await import('./chat.js');
        renderChat();
      }
    } catch (e) {
      alert("存档失败：" + e.message);
    }
  });

  // Retrieve
  document.querySelector("#retrieveChat").addEventListener("click", () => {
    // Dismiss the star map first — it sits ABOVE the panels, so without this the
    // archive would open invisibly beneath it (same pattern as the library button).
    document.dispatchEvent(new CustomEvent("heykoko:closeStarMap"));
    openArchiveOverlay();
  });

  async function openArchiveOverlay() {
    // Mutually exclusive with the library panel (same z-index full-area overlays;
    // the library sits LATER in the DOM and would cover us if left open).
    document.querySelector("#libraryOverlay")?.classList.remove("isOpen");
    archiveOverlay.classList.add("isOpen");
    archivePreview.classList.remove("isOpen");
    archivePreviewEmpty.style.display = "";
    selectedArchives.clear();
    activeTagFilter = null;
    activePreviewFilename = null;
    archiveSearch.value = "";
    semanticMode = false;
    semanticScores = null;
    archiveSemanticBtn.classList.remove("isActive");
    archiveSearch.placeholder = t("archive_searchPlaceholder");
    archiveIndexBtn.style.display = "none";
    archiveSelectAllCheckbox.checked = false;
    archiveChatBtn.disabled = true;
    updateSelectionUI();

    try {
      const res = await fetch("/api/archives");
      const data = await res.json();
      archivesData = data.archives || [];
    } catch {
      archivesData = [];
    }

    renderArchiveTagBar();
    renderArchiveList();
  }

  document.querySelector("#archiveCloseBtn").addEventListener("click", () => {
    archiveOverlay.classList.remove("isOpen");
    archiveChatBtn.disabled = false;
  });

  archiveSortBtn.addEventListener("click", () => {
    sortNewestFirst = !sortNewestFirst;
    archiveSortBtn.textContent = sortNewestFirst ? "新→旧" : "目录/文件";
    renderArchiveList();
  });

  const archiveExpandAllBtn = document.querySelector("#archiveExpandAllBtn");
  let allExpanded = false;
  archiveExpandAllBtn.addEventListener("click", () => {
    allExpanded = !allExpanded;
    const dirs = archiveList.querySelectorAll(".archiveTreeDir");
    dirs.forEach(dir => {
      if (allExpanded) {
        dir.classList.remove("isCollapsed");
        dir.querySelector(".archiveTreeDirArrow").textContent = "▼";
      } else {
        dir.classList.add("isCollapsed");
        dir.querySelector(".archiveTreeDirArrow").textContent = "▶";
      }
    });
    archiveExpandAllBtn.textContent = allExpanded ? "收起" : "展开";
  });

  archiveSearch.addEventListener("input", () => {
    if (semanticMode) {
      // Wait for Enter to run the (model-backed) semantic search; clearing resets.
      if (!archiveSearch.value.trim()) { semanticScores = null; renderArchiveList(); }
      return;
    }
    renderArchiveList();
  });
  archiveSearch.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && semanticMode) { e.preventDefault(); runSemanticSearch(); }
  });

  archiveSemanticBtn.addEventListener("click", () => {
    semanticMode = !semanticMode;
    semanticScores = null;
    archiveSemanticBtn.classList.toggle("isActive", semanticMode);
    archiveSearch.placeholder = semanticMode ? t("archive_semanticHint") : t("archive_searchPlaceholder");
    archiveIndexBtn.style.display = semanticMode ? "" : "none";
    if (semanticMode) archiveSearch.focus();
    renderArchiveList();
  });

  archiveIndexBtn.addEventListener("click", () => buildIndex());

  // Build / refresh the embedding index, showing progress on the button.
  async function buildIndex() {
    const orig = t("archive_index");
    archiveIndexBtn.disabled = true;
    try {
      const res = await fetch("/api/archives/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: embedModel() }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result = { ok: true };
      const handle = (line) => {
        if (!line.trim()) return;
        let m; try { m = JSON.parse(line); } catch { return; }
        if (m.status === "start" || m.status === "progress") {
          archiveIndexBtn.textContent = t("archive_indexing", { done: m.done || 0, total: m.todo });
        } else if (m.status === "done") {
          result = { ok: true, indexed: m.indexed };
        } else if (m.status === "error") {
          result = { ok: false, message: m.message };
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop() || "";
        for (const l of lines) handle(l);
      }
      if (buffer.trim()) handle(buffer);
      archiveIndexBtn.textContent = orig;
      archiveIndexBtn.disabled = false;
      return result;
    } catch (e) {
      archiveIndexBtn.textContent = orig;
      archiveIndexBtn.disabled = false;
      return { ok: false, message: e.message };
    }
  }

  async function postSearch(query) {
    const res = await fetch("/api/archives/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, model: embedModel() }),
    });
    return res.json();
  }

  async function runSemanticSearch() {
    const query = archiveSearch.value.trim();
    if (!query) { semanticScores = null; renderArchiveList(); return; }
    archiveList.innerHTML = `<div class="archiveEmpty">${t("archive_searching")}</div>`;
    try {
      let data = await postSearch(query);
      if (data.needsIndex) {
        archiveList.innerHTML = `<div class="archiveEmpty">${t("archive_indexFirst")}</div>`;
        const r = await buildIndex();
        if (!r.ok) { archiveList.innerHTML = `<div class="archiveEmpty">${t("archive_searchErr", { error: r.message || "" })}</div>`; return; }
        data = await postSearch(query);
      }
      if (data.error) { archiveList.innerHTML = `<div class="archiveEmpty">${t("archive_searchErr", { error: data.error })}</div>`; return; }
      semanticScores = new Map((data.results || []).map(r => [r.file, r.score]));
      renderArchiveList();
    } catch (e) {
      archiveList.innerHTML = `<div class="archiveEmpty">${t("archive_searchErr", { error: e.message })}</div>`;
    }
  }

  archiveSelectAllCheckbox.addEventListener("change", () => {
    const filtered = getFilteredArchives();
    if (archiveSelectAllCheckbox.checked) {
      filtered.forEach(a => selectedArchives.add(a.filename));
    } else {
      selectedArchives.clear();
    }
    renderArchiveList();
    updateSelectionUI();
  });

  function getFilteredArchives() {
    let list = [...archivesData];
    if (activeTagFilter) {
      list = list.filter(a => (a.tags || []).some(t => t.name === activeTagFilter));
    }
    // Semantic results: keep only scored archives, ordered by relevance.
    if (semanticMode && semanticScores) {
      list = list.filter(a => semanticScores.has(a.filename));
      list.sort((a, b) => (semanticScores.get(b.filename) || 0) - (semanticScores.get(a.filename) || 0));
      return list;
    }
    const query = archiveSearch.value.trim().toLowerCase();
    if (query) {
      list = list.filter(a => {
        const titleMatch = (a.title || "").toLowerCase().includes(query);
        const previewMatch = (a.preview || []).some(p => (p.content || "").toLowerCase().includes(query));
        const tagMatch = (a.tags || []).some(t => t.name.toLowerCase().includes(query));
        return titleMatch || previewMatch || tagMatch;
      });
    }
    list.sort((a, b) => {
      return (a.filename || "").localeCompare(b.filename || "");
    });
    return list;
  }

  function parseArchiveTimestamp(ts) {
    if (!ts) return 0;
    if (typeof ts === "number") return ts;
    return new Date(ts.replace(" ", "T")).getTime() || 0;
  }

  function renderArchiveTagBar() {
    const allTags = new Map();
    archivesData.forEach(a => {
      (a.tags || []).forEach(t => {
        if (!allTags.has(t.name)) allTags.set(t.name, t.color || "#e0e0e0");
      });
    });
    archiveTagBar.innerHTML = "";
    allTags.forEach((color, name) => {
      const chip = document.createElement("span");
      chip.className = "archiveTagChip" + (activeTagFilter === name ? " isActive" : "");
      chip.textContent = name;
      chip.style.background = color || "#e0e0e0";
      chip.addEventListener("click", () => {
        activeTagFilter = activeTagFilter === name ? null : name;
        renderArchiveTagBar();
        renderArchiveList();
      });
      archiveTagBar.appendChild(chip);
    });
  }

  // Build one archive card element (shared by tree + flat semantic views).
  function createArchiveCard(archive, depth) {
    const card = document.createElement("div");
    const isActive = activePreviewFilename === archive.filename;
    card.className = "archiveCard" + (selectedArchives.has(archive.filename) ? " isSelected" : "") + (isActive ? " isActive" : "");
    card.dataset.filename = archive.filename;
    card.style.paddingLeft = (depth * 16 + 8) + "px";

    const tagsHtml = (archive.tags || []).map(t =>
      `<span class="archiveCardTag" style="background:${t.color || "#e0e0e0"}">${escapeHtml(t.name)}</span>`
    ).join("");

    const baseName = archive.filename.split("/").pop();
    const firstUserMsg = (archive.preview || []).find(p => p.role === "user");
    const previewText = firstUserMsg ? firstUserMsg.content.slice(0, 60) : "";
    const score = semanticScores && semanticScores.has(archive.filename)
      ? `<span class="archiveCardScore">${Math.round(semanticScores.get(archive.filename) * 100)}%</span>` : "";

    card.innerHTML = `
      <input type="checkbox" class="archiveCardCheckbox" ${selectedArchives.has(archive.filename) ? "checked" : ""} />
      <div class="archiveCardInfo">
        <div class="archiveCardTitle">${score}${escapeHtml(archive.title)}</div>
        <div class="archiveCardMeta">
          <span>${escapeHtml(baseName)}</span>
          <span>(${archive.messageCount}条消息)</span>
          ${tagsHtml}
        </div>
        ${previewText ? `<div class="archiveCardPreview">${escapeHtml(previewText)}</div>` : ""}
      </div>
    `;

    const checkbox = card.querySelector(".archiveCardCheckbox");
    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
      if (checkbox.checked) selectedArchives.add(archive.filename);
      else selectedArchives.delete(archive.filename);
      card.classList.toggle("isSelected", checkbox.checked);
      updateSelectionUI();
    });

    card.addEventListener("click", (e) => {
      if (e.target === checkbox) return;
      activePreviewFilename = archive.filename;
      archiveList.querySelectorAll(".archiveCard").forEach(c => c.classList.remove("isActive"));
      card.classList.add("isActive");
      openArchivePreview(archive.filename);
    });

    return card;
  }

  function renderArchiveList() {
    const filtered = getFilteredArchives();
    archiveList.innerHTML = "";

    if (filtered.length === 0) {
      archiveList.innerHTML = `<div class="archiveEmpty">${archivesData.length === 0 ? "暂无存档对话" : "没有匹配的结果"}</div>`;
      return;
    }

    // Semantic results: flat list in relevance order (skip the directory tree).
    if (semanticMode && semanticScores) {
      filtered.forEach(archive => archiveList.appendChild(createArchiveCard(archive, 0)));
      return;
    }

    // Build tree structure from flat file list
    function buildTree(archives) {
      const root = { dirs: {}, files: [] };
      archives.forEach(archive => {
        const parts = archive.filename.split("/");
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
          const dir = parts[i];
          if (!node.dirs[dir]) node.dirs[dir] = { dirs: {}, files: [] };
          node = node.dirs[dir];
        }
        node.files.push(archive);
      });
      return root;
    }

    function renderTreeNode(node, container, depth) {
      // Render subdirectories first
      const dirNames = Object.keys(node.dirs).sort();
      dirNames.forEach(dirName => {
        const dirEl = document.createElement("div");
        dirEl.className = "archiveTreeDir isCollapsed";

        const dirHeader = document.createElement("div");
        dirHeader.className = "archiveTreeDirHeader";
        dirHeader.style.paddingLeft = (depth * 16 + 8) + "px";
        dirHeader.innerHTML = `<span class="archiveTreeDirArrow">▶</span><span class="archiveTreeDirIcon">📁</span><span class="archiveTreeDirName">${escapeHtml(dirName)}</span>`;

        const dirContent = document.createElement("div");
        dirContent.className = "archiveTreeDirContent";

        dirHeader.addEventListener("click", () => {
          const collapsed = dirEl.classList.toggle("isCollapsed");
          dirHeader.querySelector(".archiveTreeDirArrow").textContent = collapsed ? "▶" : "▼";
        });

        dirEl.appendChild(dirHeader);
        dirEl.appendChild(dirContent);
        container.appendChild(dirEl);

        renderTreeNode(node.dirs[dirName], dirContent, depth + 1);
      });

      // Render files
      node.files.forEach(archive => {
        container.appendChild(createArchiveCard(archive, depth));
      });
    }

    const tree = buildTree(filtered);
    renderTreeNode(tree, archiveList, 0);
  }

  function formatArchiveDate(ts) {
    const d = typeof ts === "number" ? new Date(ts) : new Date(ts.replace(" ", "T"));
    if (isNaN(d.getTime())) return ts;
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function updateSelectionUI() {
    const count = selectedArchives.size;
    archiveSelectedCount.textContent = count > 0 ? `已选 ${count} 个` : "";
    archiveRestoreBtn.disabled = count === 0;
    archiveMoveBtn.disabled = count === 0;
    archiveDeleteBtn.disabled = count === 0;
  }

  _openArchivePanel = openArchiveOverlay;
  _openArchived = async (filename) => {
    await openArchiveOverlay();
    activePreviewFilename = filename;
    renderArchiveList();   // re-render so the card shows as active
    openArchivePreview(filename);
  };

  async function openArchivePreview(filename) {
    try {
      const res = await fetch("/api/archives/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filenames: [filename] }),
      });
      const data = await res.json();
      const result = data.results && data.results[0];
      if (!result || result.error) {
        alert(result ? result.error : "加载失败");
        return;
      }

      const conv = result.data;
      archivePreviewTitle.textContent = conv.title || "未命名对话";
      archivePreviewContent.innerHTML = "";

      (conv.messages || []).forEach(msg => {
        const div = document.createElement("div");
        div.className = `archivePreviewMsg ${msg.role}${msg.folded ? " folded" : ""}`;

        let imageHtml = "";
        // New archives store displayImages/contextImages; the legacy fallbacks
        // (previewImages/previewImage/images) keep older archives rendering.
        const previews = (msg.displayImages && msg.displayImages.length > 0)
          ? msg.displayImages
          : (msg.previewImages && msg.previewImages.length > 0)
            ? msg.previewImages
            : msg.previewImage
              ? [msg.previewImage]
              : ((msg.contextImages || msg.images)?.length ? (msg.contextImages || msg.images) : null);
        if (previews) {
          const imgs = previews.map((p, i) => {
            const src = p.startsWith("data:") ? p : `data:image/jpeg;base64,${p}`;
            const fn = mediaFilename(null, msg.timestamp, "image", "jpg", i, previews.length);
            return `<img class="messageImage" data-filename="${escapeHtml(fn)}" src="${src}" alt="图片" />`;
          }).join("");
          // Multiple images share the equal-height flex row (same as live chat).
          imageHtml = previews.length > 1 ? `<div class="messageImages">${imgs}</div>` : imgs;
        }

        const genImgs = msg.generatedImages && msg.generatedImages.length > 0
          ? msg.generatedImages
          : msg.generatedThumbnails && msg.generatedThumbnails.length > 0
            ? msg.generatedThumbnails
            : msg.generatedVideoThumbnails && msg.generatedVideoThumbnails.length > 0
              ? msg.generatedVideoThumbnails.filter(Boolean)
              : (msg.isFilePreview && (msg.contextImages || msg.images)?.length)
                ? (msg.contextImages || msg.images).map(img => img.startsWith("data:") ? img : `data:${img.startsWith("/9j/") ? "image/jpeg" : "image/png"};base64,${img}`)
                : null;
        let genImageHtml = "";
        if (genImgs && genImgs.length > 0) {
          const items = genImgs.map((img, i) => {
            if (!img || img.length < 100) return "";
            let src, ext = "png";
            if (img.startsWith("data:")) { src = img; ext = /jpe?g/.test(img.slice(0, 20)) ? "jpg" : "png"; }
            else if (img.startsWith("http")) src = img;
            else {
              const isJpg = img.startsWith("/9j/");
              src = `data:${isJpg ? "image/jpeg" : "image/png"};base64,${img}`;
              ext = isJpg ? "jpg" : "png";
            }
            const fn = mediaFilename(null, msg.timestamp, "image", ext, i, genImgs.length);
            return `<img class="generatedImage" data-filename="${escapeHtml(fn)}" src="${src}" alt="AI 生成的图片" />`;
          }).join("");
          if (items) genImageHtml = `<div class="imageGrid">${items}</div>`;
        }

        let contentHtml;
        if (msg.role === "assistant") {
          contentHtml = `<div class="markdownBody archiveMsgBody">${markdownToHtml(msg.content || "")}</div>`;
        } else {
          contentHtml = `<div class="archiveMsgBody">${escapeHtml(msg.content || "")}</div>`;
        }

        let tsHtml = "";
        if (msg.timestamp) {
          tsHtml = `<div class="archivePreviewTimestamp">${typeof msg.timestamp === "string" ? msg.timestamp : formatArchiveDate(msg.timestamp)}</div>`;
        }

        div.innerHTML = tsHtml + imageHtml + contentHtml + genImageHtml;

        // Re-apply the message's highlights/notes to the read-only preview.
        if (msg.highlights && msg.highlights.length) {
          const bodyEl = div.querySelector(".archiveMsgBody");
          if (bodyEl) applyHighlights(bodyEl, msg.highlights);
        }

        if (msg.translation) {
          const row = document.createElement("div");
          row.className = "message-row";
          div.classList.add("message-row-left");
          row.appendChild(div);
          const transDiv = document.createElement("div");
          transDiv.className = `archivePreviewMsg ${msg.role} message-row-right translation-bubble`;
          const transContent = msg.role === "assistant"
            ? `<div class="markdownBody">${markdownToHtml(msg.translation)}</div>`
            : `<div>${escapeHtml(msg.translation)}</div>`;
          transDiv.innerHTML = `<div class="archivePreviewTimestamp">翻译</div>` + transContent;
          row.appendChild(transDiv);
          archivePreviewContent.appendChild(row);
        } else {
          archivePreviewContent.appendChild(div);
        }
      });

      archivePreviewContent.querySelectorAll("pre code").forEach(block => {
        if (window.hljs) hljs.highlightElement(block);
      });

      archivePreviewContent.querySelectorAll("pre.mermaid").forEach((el, i) => {
        const code = el.textContent;
        const id = `archive-mermaid-${i}`;
        try {
          mermaid.render(id, code).then(({ svg }) => { el.innerHTML = svg; });
        } catch {}
      });

      archivePreviewEmpty.style.display = "none";
      archivePreview.classList.add("isOpen");
    } catch (e) {
      alert("加载预览失败：" + e.message);
    }
  }

  archiveRestoreBtn.addEventListener("click", async () => {
    if (selectedArchives.size === 0) return;
    try {
      const filenames = [...selectedArchives];
      const res = await fetch("/api/archives/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filenames }),
      });
      const data = await res.json();

      (data.results || []).forEach(result => {
        if (result.error) return;
        const conv = result.data;
        const messages = (conv.messages || []).map(msg => {
          const m = { ...msg };
          if (typeof m.timestamp === "string") {
            m.timestamp = new Date(m.timestamp.replace(" ", "T")).getTime();
          }
          return m;
        });
        const tab = createTab(conv.title || "恢复的对话", messages, conv.personality || null);
        if (conv.persona) tab.persona = conv.persona;
        if (conv.tags) tab.tags = conv.tags;
        // 方案3：记下来源存档，再次归档时更新原文件而非新建（saveTabs 会持久化此字段）。
        tab.sourceArchive = result.filename;
        state.tabs.unshift(tab);
      });

      // 取档只复制一份到标签页，存档文件始终保留（不再删除）。
      // 如需删除存档，请使用"删除"按钮。

      switchTab(state.tabs[0].id);
      archiveOverlay.classList.remove("isOpen");
      archiveChatBtn.disabled = false;
    } catch (e) {
      alert("恢复失败：" + e.message);
    }
  });

  archiveDeleteBtn.addEventListener("click", async () => {
    if (selectedArchives.size === 0) return;
    if (!confirm(`确定删除 ${selectedArchives.size} 个存档对话吗？此操作不可恢复。`)) return;
    try {
      const res = await fetch("/api/archives", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filenames: [...selectedArchives] }),
      });
      await res.json();
      selectedArchives.clear();
      archiveSelectAllCheckbox.checked = false;
      updateSelectionUI();

      const listRes = await fetch("/api/archives");
      const listData = await listRes.json();
      archivesData = listData.archives || [];
      renderArchiveTagBar();
      renderArchiveList();
    } catch (e) {
      alert("删除失败：" + e.message);
    }
  });

  // Move button with directory popup
  archiveMoveBtn.addEventListener("click", async () => {
    if (selectedArchives.size === 0) return;
    try {
      const dirsRes = await fetch("/api/archives/dirs");
      const dirsData = await dirsRes.json();
      const dirs = dirsData.dirs || [""];

      // Remove existing popup
      document.querySelectorAll(".archiveMovePopup").forEach(el => el.remove());

      // Create popup
      const popup = document.createElement("div");
      popup.className = "archiveMovePopup";

      const title = document.createElement("div");
      title.className = "archiveMovePopupTitle";
      title.textContent = "选择目标目录";
      popup.appendChild(title);

      const list = document.createElement("div");
      list.className = "archiveMovePopupList";

      // "新建目录" option
      const newDirItem = document.createElement("div");
      newDirItem.className = "archiveMovePopupItem archiveMovePopupNewDir";
      newDirItem.textContent = "+ 新建目录";
      newDirItem.addEventListener("click", () => {
        const dirName = prompt("输入新目录名（支持子目录，如 2024/June）：");
        if (!dirName || !dirName.trim()) return;
        const trimmed = dirName.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        if (!trimmed) return;
        if (dirs.includes(trimmed)) {
          alert("目录已存在：" + trimmed);
          return;
        }
        popup.remove();
        (async () => {
          try {
            const moveRes = await fetch("/api/archives/move", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ filenames: [...selectedArchives], targetDir: trimmed }),
            });
            const moveData = await moveRes.json();
            if (moveData.errors && moveData.errors.length > 0) {
              alert("部分文件移动失败：" + moveData.errors.map(e => e.filename).join(", "));
            }
            selectedArchives.clear();
            archiveSelectAllCheckbox.checked = false;
            updateSelectionUI();
            const listRes2 = await fetch("/api/archives");
            const listData2 = await listRes2.json();
            archivesData = listData2.archives || [];
            renderArchiveTagBar();
            renderArchiveList();
          } catch (e) {
            alert("移动失败：" + e.message);
          }
        })();
      });
      list.appendChild(newDirItem);

      dirs.forEach(dir => {
        const item = document.createElement("div");
        item.className = "archiveMovePopupItem";
        item.textContent = dir === "" ? "/ (根目录)" : dir;
        item.addEventListener("click", async () => {
          popup.remove();
          try {
            const moveRes = await fetch("/api/archives/move", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ filenames: [...selectedArchives], targetDir: dir }),
            });
            const moveData = await moveRes.json();
            if (moveData.errors && moveData.errors.length > 0) {
              alert("部分文件移动失败：" + moveData.errors.map(e => e.filename).join(", "));
            }
            selectedArchives.clear();
            archiveSelectAllCheckbox.checked = false;
            updateSelectionUI();

            const listRes2 = await fetch("/api/archives");
            const listData2 = await listRes2.json();
            archivesData = listData2.archives || [];
            renderArchiveTagBar();
            renderArchiveList();
          } catch (e) {
            alert("移动失败：" + e.message);
          }
        });
        list.appendChild(item);
      });

      popup.appendChild(list);

      // Position popup near the button
      archiveMoveBtn.style.position = "relative";
      archiveMoveBtn.parentElement.style.position = "relative";
      popup.style.position = "absolute";
      popup.style.bottom = "100%";
      popup.style.left = archiveMoveBtn.offsetLeft + "px";
      archiveMoveBtn.parentElement.appendChild(popup);

      // Close popup on outside click
      function closePopup(e) {
        if (!popup.contains(e.target) && e.target !== archiveMoveBtn) {
          popup.remove();
          document.removeEventListener("mousedown", closePopup);
        }
      }
      setTimeout(() => document.addEventListener("mousedown", closePopup), 0);
    } catch (e) {
      alert("获取目录列表失败：" + e.message);
    }
  });

  // Draggable divider
  const archiveDivider = document.querySelector("#archiveDivider");
  const archiveBody = archiveDivider.parentElement;
  let isDraggingDivider = false;

  archiveDivider.addEventListener("mousedown", (e) => {
    e.preventDefault();
    isDraggingDivider = true;
    archiveDivider.classList.add("isDragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDraggingDivider) return;
    const rect = archiveBody.getBoundingClientRect();
    const offset = e.clientX - rect.left;
    const minLeft = 200;
    const maxLeft = rect.width - 200;
    const clamped = Math.max(minLeft, Math.min(maxLeft, offset));
    archiveBody.style.gridTemplateColumns = `${clamped}px 6px minmax(0, 1fr)`;
  });

  document.addEventListener("mouseup", () => {
    if (!isDraggingDivider) return;
    isDraggingDivider = false;
    archiveDivider.classList.remove("isDragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}