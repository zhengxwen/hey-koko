// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Same-browser duplicate-tab guard. Two hey-koko tabs share one IndexedDB but do
// NOT sync in memory — the last debounced save silently overwrites the other
// tab's chats. There is no safe merge, so all we can do is warn loudly in BOTH
// tabs. Detection is a BroadcastChannel ping/pong: a starting tab says "hello",
// every listener replies "alive", and whoever hears either side knows there are
// ≥2 tabs. When a tab closes it says "bye"; survivors re-probe and drop the
// banner if nobody answers. (Private windows have their own storage partition —
// the channel doesn't cross it, which matches: they don't share IndexedDB.)
import { t } from './i18n.js';

const CHANNEL = "heykoko-tab-guard";

export function initTabGuard() {
  if (typeof BroadcastChannel === "undefined") return;   // very old WebKit — skip
  const bc = new BroadcastChannel(CHANNEL);
  const myId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let banner = null;
  let probeTimer = null;

  const showBanner = () => {
    if (banner) return;
    banner = document.createElement("div");
    banner.className = "tabGuardBanner";
    const text = document.createElement("span");
    text.textContent = t("tabGuard_warning");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tabGuardClose";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    close.addEventListener("click", hideBanner);
    banner.append(text, close);
    document.body.appendChild(banner);
  };
  const hideBanner = () => { if (banner) { banner.remove(); banner = null; } };

  bc.onmessage = (e) => {
    const { type, from } = (e && e.data) || {};
    if (!type || from === myId) return;
    if (type === "hello") {
      bc.postMessage({ type: "alive", from: myId });   // answer the prober…
      showBanner();                                    // …and we now know there are ≥2 tabs
    } else if (type === "alive") {
      if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
      showBanner();
    } else if (type === "bye") {
      // A tab closed — re-probe. If nobody answers within 1s we're alone again.
      if (probeTimer) clearTimeout(probeTimer);
      probeTimer = setTimeout(() => { probeTimer = null; hideBanner(); }, 1000);
      bc.postMessage({ type: "hello", from: myId });
    }
  };

  bc.postMessage({ type: "hello", from: myId });
  window.addEventListener("pagehide", () => {
    try { bc.postMessage({ type: "bye", from: myId }); } catch { /* channel may be gone */ }
  });
}
