// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Tab management and tag context menu
import { dom, state } from './state.js';
import { TAG_COLORS } from './constants.js';
import { saveTabs, saveChat, syncPersonaEditable } from './settings.js';
import { resolvePersonaText } from './presets.js';
import { stopSpeech } from './speech.js';
import { dbLoadTabs, dbLoadActiveTabId, migrateFromLocalStorage, dbDeleteDatabase } from './db.js';
import { genId } from './utils.js';
import { t } from './i18n.js';
import { tabActiveJobCount, cancelTabJobs } from './bg-jobs.js';   // Option B: warn + cancel jobs on delete

// Give every persisted message a stable `id` so the background-jobs queue can
// re-locate a placeholder after inserts/deletes shift array indices. Cheap,
// idempotent, and harmless to messages that already have one.
// Migrate a single stored message from the legacy image field names to the two
// semantic fields used throughout the app:
//   images            → contextImages     (full-res, sent to the model)
//   previewImages /   → displayImages     (thumbnails, shown in the bubble only)
//   previewImage
//   imageDisplayNames → imageNames        (per-image original filenames)
// Idempotent: messages already using the new names are left untouched.
export function migrateImageFields(m) {
  if (!m) return;
  if (m.images && !m.contextImages) m.contextImages = m.images;
  delete m.images;
  if (!m.displayImages) {
    if (m.previewImages?.length) m.displayImages = m.previewImages;
    else if (m.previewImage) m.displayImages = [m.previewImage];
  }
  delete m.previewImages;
  delete m.previewImage;
  if (m.imageDisplayNames && !m.imageNames) m.imageNames = m.imageDisplayNames;
  delete m.imageDisplayNames;
  migrateVideoFields(m);
}

// Legacy single-video bubbles stored scalar videoMime/videoName/videoWidth/videoHeight
// alongside the array forms. Fold any scalar up into a per-clip array (so a batch of
// clips is uniform) and drop the scalar — videoMimes/videoNames/videoWidths/videoHeights
// are now the single source of truth. No-op on bubbles without video.
export function migrateVideoFields(m) {
  if (!m || !(m.generatedVideos && m.generatedVideos.length)) return;
  const n = m.generatedVideos.length;
  const fold = (arrKey, scalarKey) => {
    if (!Array.isArray(m[arrKey]) && m[scalarKey] != null) m[arrKey] = Array.from({ length: n }, () => m[scalarKey]);
    delete m[scalarKey];
  };
  fold("videoMimes", "videoMime");
  fold("videoNames", "videoName");
  fold("videoWidths", "videoWidth");
  fold("videoHeights", "videoHeight");
}

function backfillMessageIds(tabs) {
  for (const tab of tabs) {
    if (!Array.isArray(tab.messages)) continue;
    for (const m of tab.messages) {
      if (m && !m.id) m.id = genId();
      migrateImageFields(m);
    }
  }
  return tabs;
}

// renderChat will be set from main.js to avoid circular dependency
let _renderChat = null;
export function setRenderChat(fn) { _renderChat = fn; }

let _renderAttachments = null;
export function setRenderAttachments(fn) { _renderAttachments = fn; }

// Staged compose-area attachments (image/file/video) are global in `state`, not
// per-tab, so switching tabs would otherwise wipe them. Keep a session-only,
// per-tab snapshot here so each tab carries its own pending attachments while you
// switch around. Deliberately NOT persisted to IndexedDB — these hold File
// objects and heavy base64, and should not survive a reload.
const tabAttachments = new Map();

export function createTab(title, messages = [], personality = null) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    messages,
    tags: [],
    personality: personality || dom.personalitySelect.value || "sweet",
    persona: personality ? (resolvePersonaText(personality) || dom.persona.value) : dom.persona.value,
  };
}

export async function loadTabs() {
  // Try loading from IndexedDB first
  try {
    const tabs = await dbLoadTabs();
    if (Array.isArray(tabs) && tabs.length > 0) {
      const activeTabId = await dbLoadActiveTabId();
      return { tabs: backfillMessageIds(tabs), activeTabId };
    }
  } catch (e) {
    console.warn("[loadTabs] IndexedDB read failed:", e);
    // The local database appears corrupted. Offer to wipe and rebuild it so the
    // app can start, instead of failing to open. Message is English by request.
    const ok = window.confirm(
      "Hey-Koko's local database is corrupted and can't be opened.\n\n" +
      "Click OK to delete it and start fresh. Your saved chats, tabs, and " +
      "memories will be lost (this cannot be undone).\n\n" +
      "Click Cancel to keep the data and try again later — but the app may not load."
    );
    if (ok) {
      await dbDeleteDatabase();
    }
  }

  // Migrate from localStorage if IndexedDB is empty
  try {
    const migrated = await migrateFromLocalStorage();
    if (migrated) {
      if (migrated.tabs) {
        return { tabs: backfillMessageIds(migrated.tabs), activeTabId: migrated.activeTabId || migrated.tabs[0].id };
      }
      if (migrated.legacyMessages) {
        const tab = createTab(`${t("tab_newChat")} 1`, migrated.legacyMessages);
        return { tabs: backfillMessageIds([tab]), activeTabId: tab.id };
      }
    }
  } catch (e) {
    console.warn("[loadTabs] Migration failed:", e);
  }

  // Fallback: fresh start
  const tab = createTab(`${t("tab_newChat")} 1`, []);
  return { tabs: [tab], activeTabId: tab.id };
}

export function getActiveTab() {
  return state.tabs.find((tab) => tab.id === state.activeTabId) || state.tabs[0];
}

export function getTab(tabId) {
  return state.tabs.find((tab) => tab.id === tabId);
}

export function switchTab(tabId) {
  if (!getTab(tabId)) return;
  if (tabId === state.activeTabId) return;
  stopSpeech();
  // Pause any playing chat video before leaving this tab. renderChat() rebuilds
  // messagesEl and destroys the elements anyway, but pause first so audio stops
  // immediately (heavy tabs defer the re-render behind a double-rAF).
  dom.messagesEl.querySelectorAll("video").forEach((v) => { if (!v.paused) v.pause(); });
  const currentTab = getActiveTab();
  if (currentTab) {
    currentTab.personality = dom.personalitySelect.value;
    currentTab.persona = dom.persona.value;
    currentTab._scrollY = dom.messagesEl.scrollTop;
    // Stash the in-progress input draft so it follows this tab.
    currentTab.draft = dom.messageInput.value;
    // Stash this tab's staged attachments (session-only) so they survive the switch.
    tabAttachments.set(currentTab.id, {
      selectedImage: state.selectedImage,
      selectedFile: state.selectedFile,
      selectedVideo: state.selectedVideo,
      selectedAudio: state.selectedAudio,
      animateMaskPoint: state.animateMaskPoint,
    });
  }
  state.activeTabId = tabId;
  clearSelectedImage();
  clearSelectedFile();
  clearSelectedVideo();
  clearSelectedAudio();
  const newTab = getActiveTab();
  // Restore the new tab's staged attachments (empty if it had none).
  const att = tabAttachments.get(tabId);
  state.selectedImage = (att && att.selectedImage) || null;
  state.selectedFile = (att && att.selectedFile) || null;
  state.selectedVideo = (att && att.selectedVideo) || null;
  state.selectedAudio = (att && att.selectedAudio) || null;
  state.animateMaskPoint = (att && att.animateMaskPoint) || null;
  if (_renderAttachments) _renderAttachments();
  if (newTab && newTab.personality) {
    dom.personalitySelect.value = newTab.personality;
    dom.persona.value = newTab.persona || resolvePersonaText(newTab.personality);
  }
  syncPersonaEditable();
  // Restore the new tab's saved draft (empty if it has none).
  dom.messageInput.value = (newTab && newTab.draft) || "";
  saveTabs();
  renderTabs();
  updateLockedState();
  const restoreScroll = () => {
    if (newTab && typeof newTab._scrollY === 'number') dom.messagesEl.scrollTop = newTab._scrollY;
  };
  // Switching to a heavy tab (videos, or a long history) means a blocking re-render
  // that briefly freezes the UI. Show the loading overlay and let it PAINT (double
  // rAF) before the render runs, so it doesn't look stuck. Light tabs render fast
  // enough that the overlay would only flicker, so skip it for them.
  const heavy = !!(newTab && Array.isArray(newTab.messages) && (
    newTab.messages.length > 60 ||
    newTab.messages.some((m) => m && Array.isArray(m.generatedVideos) && m.generatedVideos.length)
  ));
  const loadEl = heavy ? document.querySelector("#chatLoading") : null;
  if (loadEl) {
    loadEl.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (_renderChat) _renderChat();
      restoreScroll();
      loadEl.hidden = true;
    }));
  } else {
    if (_renderChat) _renderChat();
    restoreScroll();
  }
}

function updateLockedState() {
  const tab = getActiveTab();
  const locked = !!(tab && tab.locked);
  dom.messageInput.disabled = locked;
  dom.messageInput.placeholder = locked ? t("input_lockedPlaceholder") : t("input_placeholder");
  dom.sendButton.disabled = locked;
  dom.fileInput.disabled = locked;
  dom.chatForm.classList.toggle("isLocked", locked);
}

export { updateLockedState };

export function clearSelectedImage() {
  state.selectedImage = null;
  state.animateMaskPoint = null; // the Replace target point belonged to the old source
  dom.fileInput.value = "";
  dom.previewImage.removeAttribute("src");
  dom.previewImage.hidden = true;
  dom.imagePreview.querySelectorAll(".previewThumb, .multiPreviewImg").forEach(el => el.remove());
  dom.imagePreview.hidden = true;
  // Drop the image-editing hint placeholder once no image is staged.
  const tab = getActiveTab();
  dom.messageInput.placeholder = tab && tab.locked ? t("input_lockedPlaceholder") : t("input_placeholder");
}

export function clearSelectedFile() {
  state.selectedFile = null;
  dom.filePreviewName.textContent = "";
  dom.filePreview.hidden = true;
}

export function clearSelectedVideo() {
  state.selectedVideo = null;
  state.animateMaskPoint = null; // the Replace target point belonged to the old source
  if (dom.videoPreviewName) dom.videoPreviewName.textContent = "";
  if (dom.videoPreview) dom.videoPreview.hidden = true;
}

export function clearSelectedAudio() {
  state.selectedAudio = null;
  if (dom.audioPreviewName) dom.audioPreviewName.textContent = "";
  if (dom.audioPreview) dom.audioPreview.hidden = true;
}

function finishRename(tab, input) {
  const newTitle = input.value.replace(/[\r\n]+/g, ' ').trim();
  if (newTitle && newTitle !== tab.title) {
    tab.title = newTitle;
    saveTabs();
  }
  renderTabs();
}

// Turn a tab's title into an inline rename input. Shared by the title dblclick
// and the rename button. Always targets the LIVE title node so a late re-render
// can't drop the input into detached DOM.
function startTabRename(tab) {
  if (tab.locked) return;
  const liveTitle = dom.chatTabsEl.querySelector(`.chatTab[data-tab-id="${tab.id}"] .tabTitle`);
  if (!liveTitle || !liveTitle.isConnected) return;
  const targetContent = liveTitle.parentElement;
  if (!targetContent) return;
  const input = document.createElement("input");
  input.className = "tabRenameInput";
  input.type = "text";
  input.value = tab.title;
  // Size the field to the name's length so the tab grows to fit it instead of
  // collapsing to the input's default ~20-char width (which shrinks long tabs).
  input.size = Math.min(Math.max((tab.title || "").length + 1, 12), 60);
  input.addEventListener("blur", () => finishRename(tab, input));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.value = tab.title; input.blur(); }
  });
  input.addEventListener("input", () => {
    if (/[\r\n]/.test(input.value)) input.value = input.value.replace(/[\r\n]+/g, ' ');
    input.size = Math.min(Math.max(input.value.length + 1, 12), 60);
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  targetContent.replaceChild(input, liveTitle);
  input.focus();
  input.select();
}

export function addChatTab() {
  const tab = createTab(`${t("tab_newChat")} ${state.tabs.length + 1}`, [], dom.personalitySelect.value);
  state.tabs.unshift(tab);
  switchTab(tab.id);
}

function closeTab(tabId) {
  if (state.tabs.length <= 1) return;
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return;
  if (state.tabs[index].locked) return;
  state.tabs.splice(index, 1);
  tabAttachments.delete(tabId);
  if (state.activeTabId === tabId) {
    state.activeTabId = state.tabs[Math.max(0, index - 1)].id;
    // The closed tab's attachments were live in the global state — swap in the
    // newly-active tab's stashed attachments so they don't bleed across.
    clearSelectedImage();
    clearSelectedFile();
    clearSelectedVideo();
    clearSelectedAudio();
    const att = tabAttachments.get(state.activeTabId);
    state.selectedImage = (att && att.selectedImage) || null;
    state.selectedFile = (att && att.selectedFile) || null;
    state.selectedVideo = (att && att.selectedVideo) || null;
    state.selectedAudio = (att && att.selectedAudio) || null;
    state.animateMaskPoint = (att && att.animateMaskPoint) || null;
    if (_renderAttachments) _renderAttachments();
  }
  saveTabs();
  renderTabs();
  if (_renderChat) _renderChat();
}

export { closeTab };

// Tag context menu
function showTagContextMenu(event, tab) {
  removeTagContextMenu();
  const menu = document.createElement("div");
  menu.className = "tagContextMenu";
  const btnRect = event.currentTarget.getBoundingClientRect();
  menu.style.left = `${btnRect.left}px`;
  menu.style.top = `${btnRect.bottom + 4}px`;

  const header = document.createElement("div");
  header.className = "tagMenuHeader";
  header.textContent = t("lib_tagManageTitle");
  menu.appendChild(header);

  if (tab.tags && tab.tags.length > 0) {
    const existingSection = document.createElement("div");
    existingSection.className = "tagMenuSection";
    tab.tags.forEach((tag, idx) => {
      const row = document.createElement("div");
      row.className = "tagMenuItem";
      const badge = document.createElement("span");
      badge.className = "tagMenuBadge";
      badge.style.backgroundColor = tag.color;
      badge.textContent = tag.name;
      badge.style.cursor = "pointer";
      badge.title = t("tabs_clickChangeColor");
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        const existing = row.parentElement.querySelector(".tagItemColors");
        if (existing) { existing.remove(); return; }
        existingSection.querySelectorAll(".tagItemColors").forEach((el) => el.remove());
        const picker = document.createElement("div");
        picker.className = "tagItemColors";
        TAG_COLORS.forEach((c) => {
          const dot = document.createElement("span");
          dot.className = `tagColorDot${c === tag.color ? " isSelected" : ""}`;
          dot.style.backgroundColor = c;
          dot.addEventListener("click", (ev) => {
            ev.stopPropagation();
            tag.color = c;
            badge.style.backgroundColor = c;
            saveTabs();
            renderTabs();
            picker.remove();
          });
          picker.appendChild(dot);
        });
        row.after(picker);
      });
      row.appendChild(badge);

      const removeBtn = document.createElement("button");
      removeBtn.className = "tagMenuRemove";
      removeBtn.textContent = "×";
      removeBtn.title = t("tabs_removeTag");
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        tab.tags.splice(idx, 1);
        saveTabs();
        renderTabs();
        removeTagContextMenu();
      });
      row.appendChild(removeBtn);
      existingSection.appendChild(row);
    });
    menu.appendChild(existingSection);
  }

  // Quick pick tags from all tabs (deduplicated by name+color)
  const allTagMap = new Map();
  state.tabs.forEach((t) => {
    (t.tags || []).forEach((tg) => {
      const name = (tg?.name || "").trim();
      const color = tg?.color || TAG_COLORS[0];
      if (!name) return;
      const key = `${name}__${color}`;
      if (!allTagMap.has(key)) allTagMap.set(key, { name, color });
    });
  });

  const existingKeys = new Set((tab.tags || []).map((tg) => `${(tg?.name || "").trim()}__${tg?.color || TAG_COLORS[0]}`));
  const quickTags = [...allTagMap.values()].filter((tg) => !existingKeys.has(`${tg.name}__${tg.color}`));

  if (quickTags.length > 0) {
    const quickSection = document.createElement("div");
    quickSection.className = "tagMenuSection";

    const quickHeader = document.createElement("div");
    quickHeader.className = "tagMenuSubHeader";
    quickHeader.textContent = t("tabs_quickSelectAll");
    quickSection.appendChild(quickHeader);

    const quickWrap = document.createElement("div");
    quickWrap.className = "tagMenuQuickSelect";

    quickTags.forEach((tg) => {
      const quickBadge = document.createElement("button");
      quickBadge.type = "button";
      quickBadge.className = "tagMenuQuickBadge";
      quickBadge.style.backgroundColor = tg.color;
      quickBadge.textContent = tg.name;
      quickBadge.title = t("tabs_clickAddToTab");
      quickBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!tab.tags) tab.tags = [];
        const exists = tab.tags.some((x) => (x?.name || "").trim() === tg.name && (x?.color || TAG_COLORS[0]) === tg.color);
        if (exists) return;
        tab.tags.push({ name: tg.name, color: tg.color });
        saveTabs();
        renderTabs();
        removeTagContextMenu();
      });
      quickWrap.appendChild(quickBadge);
    });

    quickSection.appendChild(quickWrap);
    menu.appendChild(quickSection);
  }

  const addSection = document.createElement("div");
  addSection.className = "tagMenuAdd";

  const input = document.createElement("input");
  input.className = "tagMenuInput";
  input.type = "text";
  input.placeholder = t("tabs_tagNamePlaceholder");
  input.maxLength = 12;

  const colorPicker = document.createElement("div");
  colorPicker.className = "tagMenuColors";
  let selectedColor = TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)];
  TAG_COLORS.forEach((color) => {
    const dot = document.createElement("span");
    dot.className = `tagColorDot${color === selectedColor ? " isSelected" : ""}`;
    dot.style.backgroundColor = color;
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      selectedColor = color;
      colorPicker.querySelectorAll(".tagColorDot").forEach((d) => d.classList.remove("isSelected"));
      dot.classList.add("isSelected");
    });
    colorPicker.appendChild(dot);
  });

  const addBtn = document.createElement("button");
  addBtn.className = "tagMenuAddBtn";
  addBtn.textContent = t("tabs_addTag");
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const name = input.value.trim();
    if (!name) return;
    if (!tab.tags) tab.tags = [];
    tab.tags.push({ name, color: selectedColor });
    saveTabs();
    renderTabs();
    removeTagContextMenu();
  });

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); addBtn.click(); }
    if (e.key === "Escape") removeTagContextMenu();
  });

  addSection.appendChild(input);
  addSection.appendChild(colorPicker);
  addSection.appendChild(addBtn);
  menu.appendChild(addSection);

  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

  setTimeout(() => input.focus(), 50);

  function onClickOutside(ev) {
    if (!menu.contains(ev.target)) {
      removeTagContextMenu();
      document.removeEventListener("mousedown", onClickOutside);
    }
  }
  document.addEventListener("mousedown", onClickOutside);
}

function removeTagContextMenu() {
  document.querySelectorAll(".tagContextMenu").forEach((el) => el.remove());
}

export function renderTabs() {
  dom.chatTabsEl.innerHTML = "";

  state.tabs.forEach((tab, index) => {
    const tabButton = document.createElement("div");
    tabButton.className = `chatTab${tab.id === state.activeTabId ? " isActive" : ""}`;
    tabButton.role = "tab";
    tabButton.tabIndex = 0;
    tabButton.setAttribute("aria-selected", tab.id === state.activeTabId ? "true" : "false");
    tabButton.title = tab.title;
    tabButton.draggable = true;
    tabButton.dataset.index = index;
    tabButton.dataset.tabId = tab.id;

    tabButton.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
      tabButton.classList.add("isDragging");
    });
    tabButton.addEventListener("dragend", () => {
      tabButton.classList.remove("isDragging");
      document.querySelectorAll(".chatTab.dragOver").forEach((el) => el.classList.remove("dragOver"));
    });
    tabButton.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      tabButton.classList.add("dragOver");
    });
    tabButton.addEventListener("dragleave", () => {
      tabButton.classList.remove("dragOver");
    });
    tabButton.addEventListener("drop", (e) => {
      e.preventDefault();
      tabButton.classList.remove("dragOver");
      const fromIndex = Number(e.dataTransfer.getData("text/plain"));
      const toIndex = index;
      if (fromIndex === toIndex) return;
      const [moved] = state.tabs.splice(fromIndex, 1);
      state.tabs.splice(toIndex, 0, moved);
      saveTabs();
      renderTabs();
    });

    // Lock icon (top-left corner)
    const lockBtn = document.createElement("button");
    lockBtn.className = `tabLockBtn${tab.locked ? " isLocked" : ""}`;
    lockBtn.type = "button";
    lockBtn.title = tab.locked ? t("tabs_unpin") : t("tabs_pin");
    lockBtn.setAttribute("aria-label", tab.locked ? t("tabs_unpin") : t("tabs_pin"));
    lockBtn.textContent = "📌";
    lockBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      tab.locked = !tab.locked;
      saveTabs();
      renderTabs();
      updateLockedState();
    });
    tabButton.appendChild(lockBtn);

    if (tab.locked) tabButton.classList.add("isLocked");

    const tabContent = document.createElement("div");
    tabContent.className = "tabContent";

    const title = document.createElement("span");
    title.className = "tabTitle";
    title.textContent = tab.title;
    title.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      startTabRename(tab);
    });
    tabContent.appendChild(title);

    if (tab.tags && tab.tags.length > 0) {
      const tagsRow = document.createElement("div");
      tagsRow.className = "tabTags";
      tab.tags.forEach((tag, tagIdx) => {
        const tagEl = document.createElement("span");
        tagEl.className = "tabTag";
        tagEl.style.backgroundColor = tag.color || "#e0e0e0";
        tagEl.textContent = tag.name;
        tagEl.draggable = true;
        tagEl.dataset.tagIndex = tagIdx;

        tagEl.addEventListener("dragstart", (e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("application/x-tag-drag", JSON.stringify({ tabId: tab.id, tagIdx }));
          tagEl.classList.add("isDragging");
        });
        tagEl.addEventListener("dragend", (e) => {
          e.stopPropagation();
          tagEl.classList.remove("isDragging");
          tagsRow.querySelectorAll(".tabTag.dragOver").forEach((el) => el.classList.remove("dragOver"));
        });
        tagEl.addEventListener("dragover", (e) => {
          if (!e.dataTransfer.types.includes("application/x-tag-drag")) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          tagEl.classList.add("dragOver");
        });
        tagEl.addEventListener("dragleave", (e) => {
          e.stopPropagation();
          tagEl.classList.remove("dragOver");
        });
        tagEl.addEventListener("drop", (e) => {
          e.preventDefault();
          e.stopPropagation();
          tagEl.classList.remove("dragOver");
          const data = JSON.parse(e.dataTransfer.getData("application/x-tag-drag"));
          if (data.tabId !== tab.id) return;
          const fromIdx = data.tagIdx;
          const toIdx = tagIdx;
          if (fromIdx === toIdx) return;
          const [moved] = tab.tags.splice(fromIdx, 1);
          tab.tags.splice(toIdx, 0, moved);
          saveTabs();
          renderTabs();
        });

        tagsRow.appendChild(tagEl);
      });
      tabContent.appendChild(tagsRow);
    }

    tabButton.appendChild(tabContent);

    const actionsCol = document.createElement("div");
    actionsCol.className = "tabActions";

    {
      const closeButton = document.createElement("button");
      closeButton.className = "closeTab";
      closeButton.type = "button";
      closeButton.title = t("tabs_closeChat");
      closeButton.setAttribute("aria-label", t("tabs_closeChat"));
      closeButton.textContent = "×";
      if (tab.locked || state.tabs.length <= 1) {
        closeButton.disabled = true;
      } else {
        closeButton.addEventListener("click", (event) => {
          event.stopPropagation();
          const nActive = tabActiveJobCount(tab.id);
          if (nActive > 0) {
            if (!confirm(t("bg_closeActiveJobs", { n: nActive }))) return;
            cancelTabJobs(tab.id);
            closeTab(tab.id);
          } else if (confirm(t("confirm_closeTab", { title: tab.title }))) {
            closeTab(tab.id);
          }
        });
      }
      actionsCol.appendChild(closeButton);
    }

    const renameButton = document.createElement("button");
    renameButton.className = "tabRenameBtn";
    renameButton.type = "button";
    renameButton.title = t("tabs_renameChat");
    renameButton.setAttribute("aria-label", t("tabs_renameChat"));
    renameButton.textContent = "✎";
    if (tab.locked) {
      renameButton.disabled = true;
    } else {
      renameButton.addEventListener("click", (event) => {
        event.stopPropagation();
        startTabRename(tab);
      });
    }

    const tagButton = document.createElement("button");
    tagButton.className = "tabTagBtn";
    tagButton.type = "button";
    tagButton.title = t("lib_tagManageTitle");
    tagButton.setAttribute("aria-label", t("lib_tagManageTitle"));
    tagButton.textContent = "🏷";
    if (tab.locked) {
      tagButton.disabled = true;
    } else {
      tagButton.addEventListener("click", (event) => {
        event.stopPropagation();
        showTagContextMenu(event, tab);
      });
    }
    actionsCol.appendChild(tagButton);

    // Rename sits below the tag button, same column.
    actionsCol.appendChild(renameButton);

    tabButton.appendChild(actionsCol);

    let clickTimer = null;
    tabButton.addEventListener("click", (event) => {
      // The 2nd click of a double-click (used to rename) must NOT switch tabs:
      // switching to a video-heavy tab forces a costly chat re-render that froze
      // the UI and rebuilt the strip out from under the rename input. Bail the
      // moment a multi-click is detected so a double-click only ever renames.
      if (event.detail > 1) {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        return;
      }
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clickTimer = null;
        switchTab(tab.id);
        requestAnimationFrame(() => {
          const activeEl = dom.chatTabsEl.querySelector('.chatTab[aria-selected="true"]');
          if (activeEl) activeEl.focus();
        });
      }, 320);
    });
    tabButton.addEventListener("dblclick", () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    });
    tabButton.addEventListener("keydown", (event) => {
      if (!tabButton.contains(event.target)) return;
      if (event.target.classList.contains("tabRenameInput")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        switchTab(tab.id);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const currentIndex = state.tabs.findIndex((item) => item.id === tab.id);
        if (currentIndex < 0 || state.tabs.length < 2) return;
        const offset = event.key === "ArrowLeft" ? -1 : 1;
        const nextIndex = (currentIndex + offset + state.tabs.length) % state.tabs.length;
        const nextTab = state.tabs[nextIndex];
        if (!nextTab) return;
        switchTab(nextTab.id);
        requestAnimationFrame(() => {
          const activeEl = dom.chatTabsEl.querySelector('.chatTab[aria-selected="true"]');
          if (activeEl) activeEl.focus();
        });
      }
    });
    dom.chatTabsEl.appendChild(tabButton);
  });
}