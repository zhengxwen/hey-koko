// Tab management and tag context menu
import { dom, state } from './state.js';
import { PERSONALITY_PRESETS, TAG_COLORS } from './constants.js';
import { saveTabs, saveChat } from './settings.js';
import { stopSpeech } from './speech.js';
import { escapeHtml } from './utils.js';
import { dbLoadTabs, dbLoadActiveTabId, migrateFromLocalStorage } from './db.js';
import { t } from './i18n.js';

// renderChat will be set from main.js to avoid circular dependency
let _renderChat = null;
export function setRenderChat(fn) { _renderChat = fn; }

export function createTab(title, messages = [], personality = null) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    messages,
    tags: [],
    personality: personality || dom.personalitySelect.value || "sweet",
    persona: personality ? (PERSONALITY_PRESETS[personality] || dom.persona.value) : dom.persona.value,
  };
}

export async function loadTabs() {
  // Try loading from IndexedDB first
  try {
    const tabs = await dbLoadTabs();
    if (Array.isArray(tabs) && tabs.length > 0) {
      const activeTabId = await dbLoadActiveTabId();
      return { tabs, activeTabId };
    }
  } catch (e) {
    console.warn("[loadTabs] IndexedDB read failed:", e);
  }

  // Migrate from localStorage if IndexedDB is empty
  try {
    const migrated = await migrateFromLocalStorage();
    if (migrated) {
      if (migrated.tabs) {
        return { tabs: migrated.tabs, activeTabId: migrated.activeTabId || migrated.tabs[0].id };
      }
      if (migrated.legacyMessages) {
        const tab = createTab("聊天 1", migrated.legacyMessages);
        return { tabs: [tab], activeTabId: tab.id };
      }
    }
  } catch (e) {
    console.warn("[loadTabs] Migration failed:", e);
  }

  // Fallback: fresh start
  const tab = createTab("聊天 1", []);
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
  const currentTab = getActiveTab();
  if (currentTab) {
    currentTab.personality = dom.personalitySelect.value;
    currentTab.persona = dom.persona.value;
    currentTab._scrollY = dom.messagesEl.scrollTop;
  }
  state.activeTabId = tabId;
  clearSelectedImage();
  clearSelectedFile();
  const newTab = getActiveTab();
  if (newTab && newTab.personality) {
    dom.personalitySelect.value = newTab.personality;
    dom.persona.value = newTab.persona || PERSONALITY_PRESETS[newTab.personality] || PERSONALITY_PRESETS.sweet;
  }
  saveTabs();
  renderTabs();
  updateLockedState();
  if (_renderChat) _renderChat();
  // Restore scroll position for the new tab
  if (newTab && typeof newTab._scrollY === 'number') {
    dom.messagesEl.scrollTop = newTab._scrollY;
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
  dom.fileInput.value = "";
  dom.previewImage.removeAttribute("src");
  dom.previewImage.hidden = false;
  dom.imagePreview.querySelectorAll(".multiPreviewImg").forEach(el => el.remove());
  dom.imagePreview.hidden = true;
}

export function clearSelectedFile() {
  state.selectedFile = null;
  dom.filePreviewName.textContent = "";
  dom.filePreview.hidden = true;
}

function finishRename(tab, input) {
  const newTitle = input.value.replace(/[\r\n]+/g, ' ').trim();
  if (newTitle && newTitle !== tab.title) {
    tab.title = newTitle;
    saveTabs();
  }
  renderTabs();
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
  if (state.activeTabId === tabId) {
    state.activeTabId = state.tabs[Math.max(0, index - 1)].id;
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
  header.textContent = "管理标签";
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
      badge.title = "点击更换颜色";
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
      removeBtn.title = "移除标签";
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
    quickHeader.textContent = "快捷选择（所有 Tabs）";
    quickSection.appendChild(quickHeader);

    const quickWrap = document.createElement("div");
    quickWrap.className = "tagMenuQuickSelect";

    quickTags.forEach((tg) => {
      const quickBadge = document.createElement("button");
      quickBadge.type = "button";
      quickBadge.className = "tagMenuQuickBadge";
      quickBadge.style.backgroundColor = tg.color;
      quickBadge.textContent = tg.name;
      quickBadge.title = "点击添加到当前标签页";
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
  input.placeholder = "输入标签名...";
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
  addBtn.textContent = "添加";
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
    lockBtn.title = tab.locked ? "取消固定对话" : "固定对话";
    lockBtn.setAttribute("aria-label", tab.locked ? "取消固定对话" : "固定对话");
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
      if (tab.locked) return;
      const input = document.createElement("input");
      input.className = "tabRenameInput";
      input.type = "text";
      input.value = tab.title;
      input.addEventListener("blur", () => finishRename(tab, input));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { input.value = tab.title; input.blur(); }
      });
      input.addEventListener("input", () => {
        if (/[\r\n]/.test(input.value)) input.value = input.value.replace(/[\r\n]+/g, ' ');
      });
      input.addEventListener("click", (e) => e.stopPropagation());
      tabContent.replaceChild(input, title);
      input.focus();
      input.select();
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
      closeButton.title = "关闭这个聊天";
      closeButton.setAttribute("aria-label", "关闭这个聊天");
      closeButton.textContent = "×";
      if (tab.locked || state.tabs.length <= 1) {
        closeButton.disabled = true;
      } else {
        closeButton.addEventListener("click", (event) => {
          event.stopPropagation();
          closeTab(tab.id);
        });
      }
      actionsCol.appendChild(closeButton);
    }

    const tagButton = document.createElement("button");
    tagButton.className = "tabTagBtn";
    tagButton.type = "button";
    tagButton.title = "管理标签";
    tagButton.setAttribute("aria-label", "管理标签");
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

    tabButton.appendChild(actionsCol);

    let clickTimer = null;
    tabButton.addEventListener("click", () => {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clickTimer = null;
        switchTab(tab.id);
        requestAnimationFrame(() => {
          const activeEl = dom.chatTabsEl.querySelector('.chatTab[aria-selected="true"]');
          if (activeEl) activeEl.focus();
        });
      }, 250);
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
