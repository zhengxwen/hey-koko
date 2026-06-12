// Command autocomplete popup
import { dom, state } from './state.js';
import { getLocalizedCommands } from './i18n.js';

export function showCommandPopup(filter) {
  const filtered = getLocalizedCommands().filter(c => c.name.startsWith(filter));
  if (filtered.length === 0) { hideCommandPopup(); return; }
  dom.commandPopup.innerHTML = "";
  state.commandActiveIndex = 0;
  filtered.forEach((cmd, i) => {
    const item = document.createElement("div");
    item.className = "commandItem" + (i === 0 ? " isActive" : "");
    item.dataset.index = i;
    item.innerHTML = `<span class="commandItem-name">${cmd.name}</span><span class="commandItem-desc">${cmd.desc}</span>`;
    item.addEventListener("click", () => {
      state.commandActiveIndex = i;
      selectActiveCommand();
    });
    item.addEventListener("mouseenter", () => {
      setCommandActive(i);
    });
    dom.commandPopup.appendChild(item);
  });
  dom.commandPopup.hidden = false;
}

export function hideCommandPopup() {
  dom.commandPopup.hidden = true;
  dom.commandPopup.innerHTML = "";
}

function setCommandActive(index) {
  const items = dom.commandPopup.querySelectorAll(".commandItem");
  items.forEach((el, i) => el.classList.toggle("isActive", i === index));
  state.commandActiveIndex = index;
}

export function moveCommandSelection(dir) {
  const items = dom.commandPopup.querySelectorAll(".commandItem");
  if (!items.length) return;
  let next = state.commandActiveIndex + dir;
  if (next < 0) next = items.length - 1;
  if (next >= items.length) next = 0;
  setCommandActive(next);
}

export function selectActiveCommand() {
  const items = dom.commandPopup.querySelectorAll(".commandItem");
  const active = items[state.commandActiveIndex];
  if (!active) { hideCommandPopup(); return; }
  const name = active.querySelector(".commandItem-name").textContent;
  dom.messageInput.value = name + " ";
  hideCommandPopup();
  dom.messageInput.focus();
}
