// Drag-to-resize divider between the settings panel and the chat area.
//
// The panel width lives in a CSS variable (--panel-w) on .shell. Dragging the
// gutter narrower than COLLAPSE_AT snaps the panel shut (.panelCollapsed);
// clicking the gutter while collapsed reopens it to the last width. Width is
// otherwise clamped to [MIN_W, MAX_W]. State is session-only — nothing persisted.

const MIN_W = 240;      // narrowest the panel may be dragged before...
const COLLAPSE_AT = 180; // ...dragging past here snaps it closed
const MAX_W = 520;
const DEFAULT_W = 320;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function initPanelResize() {
  const shell = document.querySelector(".shell");
  const resizer = document.querySelector("#panelResizer");
  if (!shell || !resizer) return;

  let savedWidth = DEFAULT_W; // last non-collapsed width, restored on reopen
  let collapsed = false;

  function applyWidth(px) {
    savedWidth = clamp(px, MIN_W, MAX_W);
    shell.style.setProperty("--panel-w", `${savedWidth}px`);
  }

  function setCollapsed(next) {
    collapsed = next;
    shell.classList.toggle("panelCollapsed", collapsed);
  }

  // Initial paint.
  applyWidth(savedWidth);

  let dragging = false;
  let moved = false;

  // Panel spans from the shell's left padding edge to the pointer.
  function widthFromEvent(e) {
    const rect = shell.getBoundingClientRect();
    const padLeft = parseFloat(getComputedStyle(shell).paddingLeft) || 0;
    return e.clientX - rect.left - padLeft;
  }

  function onMove(e) {
    if (!dragging) return;
    moved = true;
    const width = widthFromEvent(e);
    if (width < COLLAPSE_AT) {
      // Show the snap-shut state live while dragging.
      shell.classList.add("panelCollapsed");
    } else {
      shell.classList.remove("panelCollapsed");
      applyWidth(width);
    }
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("isDragging");
    document.body.classList.remove("isResizingPanel");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);

    if (!moved) {
      // A click (no drag): toggle collapse.
      setCollapsed(!collapsed);
      return;
    }
    setCollapsed(widthFromEvent(e) < COLLAPSE_AT);
  }

  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    moved = false;
    resizer.classList.add("isDragging");
    document.body.classList.add("isResizingPanel");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  // Double-click resets to the default width.
  resizer.addEventListener("dblclick", () => {
    applyWidth(DEFAULT_W);
    setCollapsed(false);
  });
}
