// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// A generation "sink" is the destination for a generation run's progress + final
// message. It lets the SAME generator code (generateImage / generateVideo /
// generateSpeech) drive either:
//   - the live foreground bubble (foregroundSink, here), or
//   - a background job's placeholder + jobs drawer (makeBgSink, in bg-jobs.js).
//
// The two impls share this method shape. Generators must route ALL of these
// concerns through the sink and never touch state.pendingGen / setGenerating /
// state.imageGenAbortController directly — that's what keeps foreground behavior
// byte-for-byte identical while a background run quietly goes elsewhere.
import { state } from './state.js';
import {
  pendingGenStart, pendingGenSetLabel, pendingGenSetEnhanced, pendingGenAddImage,
  pendingGenSetProgress, pendingGenSetPreview, pendingGenSetEta,
  pendingGenSetSeg, pendingGenSetIndeterminate, pendingGenClear,
} from './pending-gen.js';

// Foreground sink: drives the live state.pendingGen bubble exactly as before, and
// owns the global image-gen AbortController + the send-button lock. Caller passes
// in its injected deps (setGenerating / renderChat / saveChat / getTab) to avoid
// circular imports through chat.js.
export function foregroundSink({ tabId, insertIndex, setGenerating, renderChat, saveChat, getTab }) {
  const controller = new AbortController();
  state.imageGenAbortController = controller;
  const rerender = () => { if (state.activeTabId === tabId && renderChat) renderChat(); };
  return {
    background: false,
    signal: controller.signal,
    tabId,
    lock(on) { if (setGenerating) setGenerating(on); },
    // Whether a pending bubble for this tab is already up (enhance step started it).
    started() { return !!(state.pendingGen && state.pendingGen.tabId === tabId); },
    start(kind, label) { pendingGenStart({ tabId, kind, label, insertIndex }); },
    label(l) { pendingGenSetLabel(tabId, l); },
    enhanced(h) { pendingGenSetEnhanced(tabId, h); },
    addImage(s) { pendingGenAddImage(tabId, s); },
    progress(v, m) { pendingGenSetProgress(tabId, v, m); },
    preview(s) { pendingGenSetPreview(tabId, s); },
    eta(x) { pendingGenSetEta(tabId, x); },
    seg(x) { pendingGenSetSeg(tabId, x); },
    indeterminate(b) { pendingGenSetIndeterminate(tabId, b); },
    clearBubble() { pendingGenClear(tabId); },
    // Insert the result/error message at insertIndex (or append), persist + render.
    place(msg) {
      const tab = getTab(tabId);
      if (!tab) return;
      if (insertIndex >= 0 && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, msg);
      else tab.messages.push(msg);
      saveChat();
      rerender();
    },
    // Re-persist + render after mutating an already-placed message (batch updates).
    commit() { saveChat(); rerender(); },
    done() {},  // foreground: clearBubble() already removes the live bubble
    cleanup() {
      if (setGenerating) setGenerating(false);
      if (state.imageGenAbortController === controller) state.imageGenAbortController = null;
    },
  };
}