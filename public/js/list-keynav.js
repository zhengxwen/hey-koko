// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Shared keyboard navigation for the archive / library file lists (both render
// the same DOM: .archiveCard rows and .archiveTreeDir folders with a
// .archiveTreeDirHeader + .archiveTreeDirContent).
//
//   ↑ / ↓        move the focus ring through VISIBLE rows (skips collapsed content)
//   →            on a folder: expand; if already expanded: step into the first child
//   ←            on an expanded folder: collapse; otherwise: jump to the parent folder
//   Enter / ␣    activate the row (open a document / toggle a folder)
//
// The list container is focusable (Tab reaches it; clicking it focuses it), and the
// keyboard cursor is a .kbFocus class — re-renders wipe it, which is fine: the next
// arrow key restarts from the active card (or the top). Rows are recomputed on every
// keystroke, so nothing here needs to know when the list re-renders.
export function initListKeyNav(container) {
  if (!container) return;
  container.tabIndex = 0;
  container.classList.add("kbNavList");

  // Visible rows only: collapsed folder content is display:none → offsetParent null.
  const rows = () =>
    [...container.querySelectorAll(".archiveTreeDirHeader, .archiveCard")]
      .filter((el) => el.offsetParent !== null);
  const current = () => container.querySelector(".kbFocus");
  const isHeader = (el) => el && el.classList.contains("archiveTreeDirHeader");
  const dirOf = (header) => header.closest(".archiveTreeDir");

  function setFocus(el) {
    const cur = current();
    if (cur && cur !== el) cur.classList.remove("kbFocus");
    if (el) {
      el.classList.add("kbFocus");
      el.scrollIntoView({ block: "nearest" });
    }
  }

  function move(delta) {
    const list = rows();
    if (!list.length) return;
    const cur = current();
    let i = cur ? list.indexOf(cur) : -1;
    if (i === -1) {
      // no cursor (fresh render) → resume from the highlighted card, else the edge
      const active = container.querySelector(".archiveCard.isActive");
      i = active ? list.indexOf(active) : delta > 0 ? -1 : list.length;
    }
    setFocus(list[Math.min(list.length - 1, Math.max(0, i + delta))]);
  }

  container.addEventListener("keydown", (e) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " "].includes(e.key)) return;
    if (e.target instanceof HTMLInputElement) return;   // let checkboxes keep Space etc.
    e.preventDefault();
    if (e.key === "ArrowDown") return move(1);
    if (e.key === "ArrowUp") return move(-1);
    const cur = current();
    if (!cur) return move(1);   // →/←/Enter with no cursor yet → just focus the first row

    if (e.key === "ArrowRight") {
      if (isHeader(cur)) {
        if (dirOf(cur).classList.contains("isCollapsed")) cur.click();   // expand
        else move(1);                                                    // step inside
      }
      return;
    }
    if (e.key === "ArrowLeft") {
      if (isHeader(cur) && !dirOf(cur).classList.contains("isCollapsed")) {
        cur.click();   // collapse
        return;
      }
      // on a card (or an already-collapsed folder): jump up to the parent folder
      const content = cur.closest(".archiveTreeDirContent");
      const parentHeader = content && content.parentElement.querySelector(":scope > .archiveTreeDirHeader");
      if (parentHeader) setFocus(parentHeader);
      return;
    }
    cur.click();   // Enter / Space → same as clicking the row
  });

  // A mouse click moves the keyboard cursor to that row and keeps the container
  // focused, so arrow keys work immediately afterwards.
  container.addEventListener("click", (e) => {
    const row = e.target.closest(".archiveTreeDirHeader, .archiveCard");
    if (row && container.contains(row)) {
      setFocus(row);
      if (document.activeElement !== container) container.focus({ preventScroll: true });
    }
  });
}
