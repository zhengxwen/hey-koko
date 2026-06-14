// Proactive messages: reminders, daily greeting, and idle nudges.
// A lightweight client-side scheduler checks for due items and asks the
// companion to speak up (in character) via a registered deliver handler.
import { dom, state } from './state.js';
import { dbSaveReminders, dbLoadReminders } from './db.js';
import { getPrompt, t } from './i18n.js';

const PROACTIVE_STATE_KEY = "hk-proactive-state";

let reminders = []; // [{ id, type:"once"|"daily", fireAt, time, text, lastFired }]
let onChange = null;
let deliverFn = null;
let idCounter = 0;

let lastActivity = Date.now();
let lastNudge = 0;
let firing = false;
let timer = null;

function genId() {
  return "r" + Date.now().toString(36) + "-" + (idCounter++).toString(36);
}

function pad(n) { return String(n).padStart(2, "0"); }
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function hhmm(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function loadLocalState() {
  try { return JSON.parse(localStorage.getItem(PROACTIVE_STATE_KEY) || "{}"); }
  catch { return {}; }
}
function saveLocalState(s) {
  localStorage.setItem(PROACTIVE_STATE_KEY, JSON.stringify(s));
}

function persist() {
  dbSaveReminders(reminders).catch((e) => console.error("[proactive] save failed:", e));
  if (onChange) onChange();
}

export function setReminderChangeHandler(fn) { onChange = fn; }
export function setDeliverHandler(fn) { deliverFn = fn; }
export function getReminders() { return reminders; }

/** Mark user activity (resets the idle-nudge countdown). */
export function markActivity() { lastActivity = Date.now(); }

export async function loadReminders() {
  try { reminders = await dbLoadReminders(); }
  catch { reminders = []; }
  return reminders;
}

export function removeReminder(id) {
  const before = reminders.length;
  reminders = reminders.filter((r) => r.id !== id);
  if (reminders.length !== before) persist();
}

/**
 * Parse a /remind command body. Returns { reminder } or { error }.
 * Forms: "30m text" | "2h text" | "18:00 text" | "明天 9:00 text" | "每天 8:00 text"
 */
export function parseRemind(content) {
  const raw = content.replace(/^\/remind\s*/, "").trim();
  if (!raw) return { error: "reminder_usage" };

  let m;
  // Daily recurring: 每天/每日/daily HH:MM text
  if ((m = raw.match(/^(每天|每日|daily)\s+(\d{1,2}):(\d{2})\s+([\s\S]+)/i))) {
    const h = +m[2], min = +m[3];
    if (h > 23 || min > 59) return { error: "reminder_badTime" };
    return { reminder: { id: genId(), type: "daily", time: `${pad(h)}:${pad(min)}`, text: m[4].trim(), lastFired: null } };
  }
  // Tomorrow: 明天/tomorrow HH:MM text
  if ((m = raw.match(/^(明天|tomorrow|tmr)\s+(\d{1,2}):(\d{2})\s+([\s\S]+)/i))) {
    const h = +m[2], min = +m[3];
    if (h > 23 || min > 59) return { error: "reminder_badTime" };
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(h, min, 0, 0);
    return { reminder: { id: genId(), type: "once", fireAt: d.getTime(), text: m[4].trim() } };
  }
  // Relative: N m/min/分/h/小时/时 text
  if ((m = raw.match(/^(\d+)\s*(分钟|分|mins?|m|小时|时|hrs?|h)\s+([\s\S]+)/i))) {
    const n = +m[1];
    const unit = m[2].toLowerCase();
    const isHour = /小时|时|h/.test(unit);
    const ms = n * (isHour ? 3600000 : 60000);
    if (ms <= 0) return { error: "reminder_badTime" };
    return { reminder: { id: genId(), type: "once", fireAt: Date.now() + ms, text: m[3].trim() } };
  }
  // Absolute today: HH:MM text (rolls to tomorrow if already past)
  if ((m = raw.match(/^(\d{1,2}):(\d{2})\s+([\s\S]+)/))) {
    const h = +m[1], min = +m[2];
    if (h > 23 || min > 59) return { error: "reminder_badTime" };
    const d = new Date();
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return { reminder: { id: genId(), type: "once", fireAt: d.getTime(), text: m[3].trim() } };
  }
  return { error: "reminder_usage" };
}

export function addReminder(reminder) {
  reminders.push(reminder);
  persist();
  return reminder;
}

/** Human-readable description of when a reminder fires (for confirmations/UI). */
export function describeReminder(r) {
  if (r.type === "daily") return t("reminder_dailyLabel", { time: r.time });
  const d = new Date(r.fireAt);
  const when = todayStr(d) === todayStr() ? hhmm(d) : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hhmm(d)}`;
  return when;
}

async function fire(instruction) {
  if (!deliverFn) return;
  firing = true;
  try { await deliverFn(instruction); }
  catch (e) { console.error("[proactive] deliver failed:", e); }
  finally { firing = false; }
}

function busy() {
  return firing || state.currentAbortController || state.imageGenAbortController;
}

function check() {
  if (busy()) return;
  const now = Date.now();
  const nowHM = hhmm();
  const today = todayStr();

  // 1) One-off reminders that are due (fire the earliest one, one per tick)
  const due = reminders.filter((r) => r.type === "once" && r.fireAt <= now).sort((a, b) => a.fireAt - b.fireAt);
  if (due.length) {
    const r = due[0];
    reminders = reminders.filter((x) => x.id !== r.id);
    persist();
    fire(getPrompt("proactiveReminder", r.text));
    return;
  }

  // 2) Daily reminders
  for (const r of reminders) {
    if (r.type === "daily" && r.lastFired !== today && nowHM >= r.time) {
      r.lastFired = today;
      persist();
      fire(getPrompt("proactiveReminder", r.text));
      return;
    }
  }

  // 3) Daily greeting (from settings)
  if (dom.dailyGreetingToggle?.checked && dom.dailyGreetingTime?.value) {
    const ls = loadLocalState();
    if (ls.dailyGreetingLastFired !== today && nowHM >= dom.dailyGreetingTime.value) {
      ls.dailyGreetingLastFired = today;
      saveLocalState(ls);
      fire(getPrompt("proactiveDailyGreeting"));
      return;
    }
  }

  // 4) Idle nudge (from settings)
  if (dom.idleNudgeToggle?.checked) {
    const mins = parseInt(dom.idleNudgeMinutes?.value, 10) || 30;
    const gap = mins * 60000;
    if (now - lastActivity >= gap && now - lastNudge >= gap) {
      lastNudge = now;
      fire(getPrompt("proactiveIdleNudge"));
    }
  }
}

export function startScheduler() {
  if (timer) return;
  lastActivity = Date.now();
  lastNudge = Date.now(); // don't nudge until a full idle gap has passed
  // First pass shortly after load catches reminders that came due while closed.
  setTimeout(check, 4000);
  timer = setInterval(check, 30000);
}
