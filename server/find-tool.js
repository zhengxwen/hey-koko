// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// The one place that locates external command-line tools (ffmpeg, pandoc, yt-dlp, …).
//
// Search order: PATH, then the caller's `candidates` — install locations a tool is known
// to use but that are not normally on PATH (LibreOffice.app's bundle, ~/.officecli/bin,
// a whisper.cpp build dir). There is deliberately no generic list of "common dirs": both
// launchers already put Homebrew and ~/.local/bin on PATH (AppMain.swift, start.command),
// and tests simulate a missing tool by starting the server with a stripped PATH — a
// hidden fallback to /opt/homebrew/bin would make that impossible.
//
// PATH is scanned in-process (a few stat calls) instead of spawning `which`/`where`.
// Requires nothing from this app, so config.js can use it without a require cycle.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const isWin = process.platform === "win32";

function isExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (!isWin) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// Windows resolves `ffmpeg` to `ffmpeg.exe` (etc.) through PATHEXT, like `where` does.
function nameVariants(name) {
  if (!isWin || path.extname(name)) return [name];
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return exts.map((e) => name + e.toLowerCase());
}

function scanPath(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  for (const dir of dirs) {
    for (const n of nameVariants(name)) {
      const full = path.join(dir, n);
      if (isExecutable(full)) return full;
    }
  }
  return null;
}

// name → absolute path. Only hits are cached: a miss costs a handful of stat calls, and
// not caching it means a tool installed while the server runs is picked up without a
// restart.
const _found = new Map();

// Absolute path of `name`, or null. Synchronous.
function findTool(name, { candidates = [] } = {}) {
  const hit = _found.get(name);
  if (hit && isExecutable(hit)) return hit;
  const p = scanPath(name) || candidates.find((c) => c && isExecutable(c)) || null;
  if (p) _found.set(name, p); else _found.delete(name);
  return p;
}

// Like findTool, but also RUNS the tool once (`args`, default --version) and only
// returns the path if that works — a binary that exists but cannot execute (wrong arch,
// broken dylib, a Python launcher whose venv is gone) is the same as absent. Exit code
// must be 0 unless `anyExit` (for tools whose version flag exits non-zero). Concurrent
// callers share one probe; a success is cached for the life of the process, a failure
// is not (so installing the tool fixes it without a restart). Keyed by name, so every
// caller of one tool must pass the same args. Never rejects.
const _probes = new Map(); // name → Promise<string|null>
function checkTool(name, { args = ["--version"], candidates, timeoutMs = 15000, anyExit = false } = {}) {
  if (_probes.has(name)) return _probes.get(name);
  const probe = new Promise((resolve) => {
    const bin = findTool(name, { candidates });
    if (!bin) return resolve(null);
    let proc, timer, settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok ? bin : null);
    };
    try { proc = spawn(bin, args, { stdio: "ignore", windowsHide: true }); } catch { return finish(false); }
    timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } finish(false); }, timeoutMs);
    proc.on("error", () => finish(false));
    proc.on("close", (code) => finish(anyExit || code === 0));
  });
  _probes.set(name, probe);
  probe.then((p) => { if (!p) _probes.delete(name); });
  return probe;
}

module.exports = { findTool, checkTool };
