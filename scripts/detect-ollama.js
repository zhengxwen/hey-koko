#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng
"use strict";
// Find Ollama — a standalone CLI that answers "is Ollama running, and where?".
//
// Unlike imagine.js this one needs NOTHING else running: no hey-koko server, no app.
// It sweeps from THIS machine's network position (every /24 it sits on, plus loopback
// under all its names), confirms each hit is really Ollama, and reports the version,
// the installed models and whatever is loaded right now.
//
//   node scripts/detect-ollama.js                 sweep this machine's networks
//   node scripts/detect-ollama.js --models        ... and list each host's models
//   node scripts/detect-ollama.js 192.168.1.25    check one box, no sweep
//   node scripts/detect-ollama.js --json          one JSON object per line
//
// Zero dependencies (repo rule): node:http + node:net/os/dns/fs only.

const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const dns = require("node:dns");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PORT = 11434;

const USAGE = `Find Ollama on this machine and on the local network.

Usage
  detect-ollama.js [options] [host|url ...]

With no host given it sweeps: the loopback (127.0.0.1 / localhost / ::1), then every
/24 this machine sits on. Naming hosts explicitly skips the sweep and probes just those
("192.168.1.25", "mac.local:11434", "http://box:11434").

Options
      --models             list each host's installed models, not just the count
      --port <n>           port to probe (default ${DEFAULT_PORT})
      --timeout <ms>       per-host probe deadline during the sweep (default 2000)
      --no-sweep           only probe $OLLAMA_URL / $OLLAMA_HOST (or loopback), never the LAN
      --json               machine-readable: one JSON object per line on stdout;
                           logs stay on stderr
  -q, --quiet              results only, no progress or hints
  -h, --help               this text

Exit: 0 at least one Ollama found, 1 none found, 2 usage error.`;

// ── argv ─────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const o = { targets: [], port: DEFAULT_PORT, timeout: 2000 };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h": case "--help": o.help = true; break;
      case "--models": o.models = true; break;
      case "--json": o.json = true; break;
      case "-q": case "--quiet": o.quiet = true; break;
      case "--no-sweep": o.noSweep = true; break;
      case "--port": o.port = Number(need(i, a)); i++; break;
      case "--timeout": o.timeout = Number(need(i, a)); i++; break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
        o.targets.push(a);
    }
  }
  if (!(o.port > 0 && o.port < 65536)) throw new Error(`--port: not a port: ${o.port}`);
  if (!(o.timeout > 0)) throw new Error(`--timeout: expected milliseconds, got ${o.timeout}`);
  return o;
}

// "192.168.1.25" / "box:11434" / "http://box:11434/" -> a normalised base URL.
function toUrl(target, port) {
  let s = String(target).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  const u = new URL(s);
  if (!u.port) u.port = String(port);
  return `${u.protocol}//${u.host}`;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

// One GET, with a hard deadline. node:http rather than fetch so a sweep of 254 hosts
// gets a real per-request timeout (and no undici socket bookkeeping in the way).
//
// The deadline is our OWN timer, not req.setTimeout: that one is a SOCKET inactivity
// timeout and is only armed once the socket is connected, so an IP nothing answers at
// — the overwhelming majority of a /24 — would sit in connect() until the OS gives up
// (~75 s on macOS), turning a 5-second sweep into a 2.5-minute one.
function get(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    let u;
    try { u = new URL(url); } catch { return finish(null); }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({
      method: "GET",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      // A fresh socket per probe: keep-alive pooling would serialise the sweep.
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        finish({ status: res.statusCode, text, json });
      });
      res.on("error", () => finish(null));
    });
    timer = setTimeout(() => { req.destroy(); finish(null); }, timeoutMs);
    req.on("error", () => finish(null));
    req.end();
  });
}

// Is there an Ollama at this base URL? /api/version is the cheap, unambiguous answer;
// the "/" fallback covers builds old enough to predate it, and keeps a proxy that
// swallows unknown paths from being reported as a miss.
async function probe(base, timeoutMs) {
  const v = await get(base + "/api/version", timeoutMs);
  if (v && v.status === 200 && v.json && typeof v.json.version === "string") {
    return { url: base, version: v.json.version };
  }
  if (v) {
    const root = await get(base + "/", timeoutMs);
    if (root && root.status === 200 && /ollama is running/i.test(root.text)) {
      return { url: base, version: "" };
    }
  }
  return null;
}

// What a found host actually has: installed models and whatever is resident right now.
// Both are best-effort — an Ollama behind an auth proxy still counts as found.
async function describe(hit, timeoutMs) {
  const [tags, ps] = await Promise.all([
    get(hit.url + "/api/tags", timeoutMs),
    get(hit.url + "/api/ps", timeoutMs),
  ]);
  const models = (tags && tags.json && Array.isArray(tags.json.models) ? tags.json.models : [])
    .map((m) => ({
      name: m.name || m.model || "",
      size: Number(m.size) || 0,
      parameterSize: (m.details && m.details.parameter_size) || "",
      quantization: (m.details && m.details.quantization_level) || "",
      modified: m.modified_at || "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const running = (ps && ps.json && Array.isArray(ps.json.models) ? ps.json.models : [])
    .map((m) => ({ name: m.name || m.model || "", expiresAt: m.expires_at || "" }));
  return { ...hit, models, running };
}

// ── the network this machine sits on ─────────────────────────────────────────

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

function localIPv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

// Reverse-resolve for display only: "192.168.1.25" -> "dgx-spark.local". getnameinfo
// (not dns.reverse) so /etc/hosts and mDNS are consulted; "" when there is no name.
function hostnameFor(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return Promise.resolve(""); }
  if (!net.isIP(host)) return Promise.resolve("");
  if (host === "::1" || /^127\./.test(host)) return Promise.resolve(os.hostname());
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(""), 1500);
    dns.lookupService(host, 0, (err, name) => {
      clearTimeout(timer);
      let n = !err && name && name !== host ? name.replace(/\.$/, "") : "";
      if (/^localhost(\.localdomain)?$/i.test(n)) n = os.hostname();
      finish(n);
    });
  });
}

// Bounded fan-out. A /24 is 254 probes and a machine may sit on several networks;
// firing them all at once exhausts file descriptors long before it saves any time.
async function pool(tasks, limit) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) await tasks[next++]();
  });
  await Promise.all(workers);
}

// Loopback first (so the local machine surfaces immediately), then every /24.
// onFound fires the moment a host answers, so results stream rather than batch.
async function sweep(port, timeoutMs, onFound, includeSelfIps) {
  const seen = new Set();
  const report = (hit) => { if (!seen.has(hit.url)) { seen.add(hit.url); onFound(hit); } };

  // Three names for ONE service: probe them together, report only the first that
  // answers. A daemon bound solely to ::1 never replies on 127.0.0.1, which is exactly
  // the case where a naive localhost check reports nothing on the machine running it.
  const loopback = (await Promise.all(
    LOOPBACK_HOSTS.map((h) => probe(`http://${h}:${port}`, timeoutMs)),
  )).find(Boolean);
  if (loopback) report(loopback);

  const selfIps = new Set(localIPv4s());
  const subnets = [...new Set([...selfIps].map((ip) => ip.split(".").slice(0, 3).join(".")))];
  const tasks = [];
  for (const subnet of subnets) {
    for (let i = 1; i <= 254; i++) {
      const ip = `${subnet}.${i}`;
      // Our own addresses are already covered by the loopback probe — unless that came
      // back empty, in which case Ollama may be bound to the LAN address only.
      if (!includeSelfIps && selfIps.has(ip)) continue;
      tasks.push(async () => {
        const hit = await probe(`http://${ip}:${port}`, timeoutMs);
        if (hit) report(hit);
      });
    }
  }
  await pool(tasks, 128);
  return [...seen];
}

// ── "installed but not running" ──────────────────────────────────────────────

// Walk PATH ourselves rather than shelling out to which/where: no child process, and
// it works the same on Windows. Only used to turn "nothing found" into a useful hint.
function ollamaBinary() {
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE").split(";").filter(Boolean)
    : [""];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  // Homebrew and the macOS app bundle are not always on a non-interactive PATH.
  dirs.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin",
            "/Applications/Ollama.app/Contents/Resources");
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, "ollama" + ext.toLowerCase());
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return "";
}

// ── output ───────────────────────────────────────────────────────────────────

const gib = (bytes) => `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;

function printHuman(rec, opts) {
  const bits = [];
  if (rec.version) bits.push(`v${rec.version}`);
  bits.push(rec.models.length === 1 ? "1 model" : `${rec.models.length} models`);
  if (rec.running.length) bits.push(`loaded: ${rec.running.map((m) => m.name).join(", ")}`);
  if (rec.hostname) bits.push(`(${rec.hostname})`);
  process.stdout.write(`  ${rec.url.padEnd(30)}${bits.join("  ")}\n`);
  if (opts.models) {
    for (const m of rec.models) {
      const detail = [m.parameterSize, m.quantization].filter(Boolean).join(" ");
      process.stdout.write(`      ${m.name.padEnd(34)}${gib(m.size).padStart(8)}  ${detail}\n`);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  let cli;
  try { cli = parseArgv(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`${e.message}\n\n${USAGE}\n`); return 2; }
  if (cli.help) { process.stdout.write(`${USAGE}\n`); return 0; }

  const log = (s) => { if (!cli.quiet && !cli.json) process.stderr.write(s); };
  const found = [];
  const pending = [];
  const emit = (hit) => pending.push((async () => {
    // The detail probe is generous: a host that answered the sweep is up, and asking it
    // for a 60-model list over Wi-Fi legitimately takes longer than the discovery ping.
    const [rec, hostname] = await Promise.all([
      describe(hit, Math.max(cli.timeout, 5000)),
      hostnameFor(hit.url),
    ]);
    const full = { kind: "ollama", ...rec, hostname };
    found.push(full);
    if (cli.json) process.stdout.write(JSON.stringify(full) + "\n");
    else printHuman(full, cli);
  })());

  if (cli.targets.length) {
    let urls;
    try { urls = cli.targets.map((t) => toUrl(t, cli.port)); }
    catch (e) { process.stderr.write(`bad host: ${e.message}\n`); return 2; }
    log(`probing ${urls.length} host${urls.length > 1 ? "s" : ""}…\n`);
    await Promise.all(urls.map(async (u) => {
      const hit = await probe(u, Math.max(cli.timeout, 5000));
      if (hit) emit(hit);
      else if (!cli.json) process.stderr.write(`  ${u.padEnd(30)}no answer\n`);
    }));
  } else if (cli.noSweep) {
    // The address the app itself would use, checked and nothing more.
    const env = process.env.OLLAMA_URL || process.env.OLLAMA_HOST || `127.0.0.1:${cli.port}`;
    const url = toUrl(env, cli.port);
    log(`probing ${url}…\n`);
    const hit = await probe(url, Math.max(cli.timeout, 5000));
    if (hit) emit(hit);
  } else {
    log(`scanning for Ollama (port ${cli.port}) from this machine…\n`);
    await sweep(cli.port, cli.timeout, emit, false);
    // Nothing anywhere? One more pass that does not assume the loopback speaks for this
    // machine — some setups bind the LAN address only (OLLAMA_HOST=0.0.0.0 gone wrong).
    if (!found.length && !pending.length) await sweep(cli.port, cli.timeout, emit, true);
  }
  await Promise.all(pending);

  if (!found.length) {
    process.stderr.write("no Ollama found\n");
    const bin = ollamaBinary();
    if (bin && !cli.quiet) {
      process.stderr.write(`ollama is installed (${bin}) but not answering — start it with: ollama serve\n`);
    } else if (!cli.quiet) {
      process.stderr.write("install it from https://ollama.com/download\n");
    }
    return 1;
  }
  if (!cli.quiet && !cli.json) {
    const best = found.find((r) => r.models.length) || found[0];
    process.stderr.write(`\npoint hey-koko at one with:  OLLAMA_URL=${best.url} npm start\n`);
  }
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(`${(e && e.stack) || e}\n`);
  process.exitCode = 2;
});
