// IndexedDB persistence layer for tabs/chat data
import { TABS_KEY, ACTIVE_TAB_KEY, CHAT_KEY } from './constants.js';

const DB_NAME = "local-ai-companion-db";
const DB_VERSION = 1;

let dbPromise = null;

const OPEN_TIMEOUT_MS = 5000;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      // indexedDB.open can throw synchronously (e.g. disabled storage)
      finish(reject, err);
      return;
    }

    // A corrupted or locked IndexedDB can leave open() hanging forever without
    // firing onsuccess/onerror. Time out so callers can fall back instead of
    // blocking app startup indefinitely.
    const timer = setTimeout(() => {
      finish(reject, new Error("IndexedDB open timed out"));
    }, OPEN_TIMEOUT_MS);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("tabs")) {
        db.createObjectStore("tabs", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
    };
    request.onsuccess = (e) => {
      clearTimeout(timer);
      finish(resolve, e.target.result);
    };
    request.onerror = (e) => {
      clearTimeout(timer);
      finish(reject, e.target.error);
    };
    // Another tab holds an older-version connection; don't hang waiting on it.
    request.onblocked = () => {
      clearTimeout(timer);
      finish(reject, new Error("IndexedDB open blocked by another connection"));
    };
  });
  // Don't cache a rejected promise — let the next caller retry a fresh open.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

// Delete the whole database so it can be recreated fresh. Used to recover from
// a corrupted IndexedDB that won't open. Drops the cached connection first so a
// stale handle doesn't block the delete. Resolves even on blocked/timeout — the
// goal is best-effort recovery, not a guarantee.
export function dbDeleteDatabase() {
  dbPromise = null;
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };

    let request;
    try {
      request = indexedDB.deleteDatabase(DB_NAME);
    } catch (err) {
      console.warn("[dbDeleteDatabase] delete threw:", err);
      done();
      return;
    }

    const timer = setTimeout(done, OPEN_TIMEOUT_MS);
    request.onsuccess = () => { clearTimeout(timer); done(); };
    request.onerror = () => { clearTimeout(timer); done(); };
    request.onblocked = () => { clearTimeout(timer); done(); };
  });
}

// Save all tabs + activeTabId to IndexedDB
export async function dbSaveTabs(tabs, activeTabId) {
  const db = await openDB();
  const tx = db.transaction(["tabs", "meta"], "readwrite");
  const tabStore = tx.objectStore("tabs");
  const metaStore = tx.objectStore("meta");

  // Clear existing tabs and write fresh (preserve order via _order field)
  tabStore.clear();
  for (let i = 0; i < tabs.length; i++) {
    tabStore.put({ ...tabs[i], _order: i });
  }
  metaStore.put(activeTabId, "activeTabId");

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// Load all tabs from IndexedDB (sorted by _order to preserve position)
export async function dbLoadTabs() {
  const db = await openDB();
  const tx = db.transaction("tabs", "readonly");
  const store = tx.objectStore("tabs");
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const tabs = request.result;
      tabs.sort((a, b) => (a._order ?? 0) - (b._order ?? 0));
      tabs.forEach((t) => delete t._order);
      resolve(tabs);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

// Load activeTabId from IndexedDB
export async function dbLoadActiveTabId() {
  const db = await openDB();
  const tx = db.transaction("meta", "readonly");
  const store = tx.objectStore("meta");
  return new Promise((resolve, reject) => {
    const request = store.get("activeTabId");
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = (e) => reject(e.target.error);
  });
}

// Save long-term memories (stored as a single array in the meta store)
export async function dbSaveMemories(memories) {
  const db = await openDB();
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put(memories, "memories");
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// Load long-term memories
export async function dbLoadMemories() {
  const db = await openDB();
  const tx = db.transaction("meta", "readonly");
  const store = tx.objectStore("meta");
  return new Promise((resolve, reject) => {
    const request = store.get("memories");
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = (e) => reject(e.target.error);
  });
}

// Save reminders (single array in the meta store)
export async function dbSaveReminders(reminders) {
  const db = await openDB();
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put(reminders, "reminders");
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// Load reminders
export async function dbLoadReminders() {
  const db = await openDB();
  const tx = db.transaction("meta", "readonly");
  const store = tx.objectStore("meta");
  return new Promise((resolve, reject) => {
    const request = store.get("reminders");
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = (e) => reject(e.target.error);
  });
}

// Migrate existing localStorage data into IndexedDB (one-time)
export async function migrateFromLocalStorage() {
  const raw = localStorage.getItem(TABS_KEY);
  if (!raw) {
    // Check legacy CHAT_KEY
    const oldChat = localStorage.getItem(CHAT_KEY);
    if (oldChat) {
      const messages = JSON.parse(oldChat);
      if (Array.isArray(messages) && messages.length > 0) {
        return { tabs: null, legacyMessages: messages };
      }
    }
    return null;
  }

  const tabs = JSON.parse(raw);
  if (!Array.isArray(tabs) || tabs.length === 0) return null;

  const activeTabId = localStorage.getItem(ACTIVE_TAB_KEY) || tabs[0].id;

  // Write to IndexedDB
  await dbSaveTabs(tabs, activeTabId);

  // Clear from localStorage
  localStorage.removeItem(TABS_KEY);
  localStorage.removeItem(ACTIVE_TAB_KEY);
  localStorage.removeItem(CHAT_KEY);

  return { tabs, activeTabId };
}
