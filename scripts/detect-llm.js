#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng
"use strict";
// Find the local LLM servers — a standalone CLI that answers "what can hey-koko talk
// to, and where?". Two protocols, because the app speaks both:
//
//   ollama  — the native API (config.ollamaUrl / $OLLAMA_URL)
//   openai  — any OpenAI-compatible server: LM Studio, llama.cpp's llama-server,
//             vLLM, SGLang, LiteLLM… (server/openai.js takes a local baseUrl with
//             no apiKey at all, so finding one is the whole setup step)
//
// Unlike imagine.js this needs NOTHING else running: no hey-koko server, no app. It
// sweeps from THIS machine's network position (every /24 it sits on, plus loopback
// under all its names), and identifies each open port BY PROTOCOL rather than by
// assuming whatever usually sits on it.
//
//   node scripts/detect-llm.js                 sweep this machine's networks
//   node scripts/detect-llm.js --models        ... and list each host's models
//   node scripts/detect-llm.js 192.168.1.25    check one box, no sweep
//   node scripts/detect-llm.js --json          one JSON object per line
//
// Zero dependencies (repo rule): node:http + node:net/os/dns/fs only.

const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const dns = require("node:dns");
const fs = require("node:fs");
const path = require("node:path");

// Where these servers live. The hint is only a GUESS at which software it is — what the
// thing actually speaks is decided by identify(), so an Ollama moved to 8080 is still
// reported as an Ollama.
//
// Only `sweep: true` is probed by default, and the list is deliberately short: every
// extra port multiplies a /24 sweep (254 hosts × N ports), and the long tail is all
// software nobody here runs. The rest stay in the table so `--ports 1337` can still
// say what usually listens there — known, just not swept for.
const PORTS = [
  { port: 11434, hint: "Ollama", sweep: true },
  { port: 1234, hint: "LM Studio", sweep: true },
  { port: 8080, hint: "llama.cpp / LocalAI", sweep: true },
  { port: 8000, hint: "vLLM / SGLang", sweep: true },
  { port: 30000, hint: "SGLang" },
  { port: 5001, hint: "KoboldCpp" },
  // 5000 is text-generation-webui's OpenAI extension — and on macOS also AirPlay
  // Receiver, which answers 403 to everything. Off by default for both reasons.
  { port: 5000, hint: "text-generation-webui" },
  { port: 4000, hint: "LiteLLM" },
  { port: 1337, hint: "Jan" },
];
const DEFAULT_PORTS = PORTS.filter((p) => p.sweep).map((p) => p.port);
const HINT = new Map(PORTS.map((p) => [p.port, p.hint]));

const USAGE = `Find the LLM servers on this machine and on the local network —
Ollama and any OpenAI-compatible server (LM Studio, llama.cpp, vLLM, SGLang, LiteLLM…).

Usage
  detect-llm.js [options] [host|url ...]

With no host given it sweeps: the loopback (127.0.0.1 / localhost / ::1), then every
/24 this machine sits on. Naming hosts explicitly skips the sweep and probes just those
("192.168.1.25", "mac.local:1234", "http://box:11434"); a host given WITHOUT a port is
tried on every default port below.

Ports probed by default
  ${PORTS.filter((p) => p.sweep).map((p) => `${p.port} (${p.hint})`).join("\n  ")}

Known, but only when asked for with --ports
  ${PORTS.filter((p) => !p.sweep).map((p) => `${p.port} (${p.hint})`).join("\n  ")}

Options
      --models             list each host's models, not just the count
      --ports <n[,n...]>   probe these ports instead of the defaults
      --timeout <ms>       per-probe deadline during the sweep (default 2000)
      --no-sweep           only probe $OLLAMA_URL / $OPENAI_BASE_URL / $OLLAMA_HOST
                           (else the loopback), never the LAN
      --json               machine-readable: one JSON object per line on stdout;
                           logs stay on stderr
  -q, --quiet              results only, no progress or hints
  -h, --help               this text

Exit: 0 at least one server found, 1 none found, 2 usage error.`;

// ── argv ─────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const o = { targets: [], ports: DEFAULT_PORTS.slice(), timeout: 2000 };
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
      // --port stays as an alias: one port is the common case.
      case "--port": case "--ports": {
        o.ports = need(i, a).split(",").map((s) => Number(s.trim()));
        i++;
        for (const p of o.ports) if (!(p > 0 && p < 65536)) throw new Error(`${a}: not a port: ${p}`);
        if (!o.ports.length) throw new Error(`${a} needs at least one port`);
        break;
      }
      case "--timeout": o.timeout = Number(need(i, a)); i++; break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
        o.targets.push(a);
    }
  }
  if (!(o.timeout > 0)) throw new Error(`--timeout: expected milliseconds, got ${o.timeout}`);
  return o;
}

// "192.168.1.25" / "box:1234" / "http://box:11434/" -> { url, explicitPort }.
// Without a port there is nothing to default to any more (we probe a whole list),
// so the caller expands such a target across every port.
function parseTarget(target) {
  let s = String(target).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  const u = new URL(s);
  return { host: u.hostname, port: u.port ? Number(u.port) : 0, protocol: u.protocol };
}

const baseUrl = (host, port, protocol) =>
  `${protocol || "http:"}//${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;

// ── HTTP ─────────────────────────────────────────────────────────────────────

// One GET, with a hard deadline.
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

// Is anything listening? A bare TCP connect is what the sweep fans out — far cheaper
// than an HTTP exchange, and on a live host a closed port answers RST immediately, so
// only genuinely dead IPs cost the full timeout. Same own-timer reasoning as above.
function tcpOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const sock = new net.Socket();
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.connect(port, host.replace(/^\[|\]$/g, ""));
  });
}

// What is this thing? Ollama is asked FIRST because it also serves an OpenAI-compatible
// /v1 — probing that first would label every Ollama "openai" and lose the native detail
// (installed models with sizes, what is resident right now).
async function identify(base, timeoutMs) {
  const v = await get(base + "/api/version", timeoutMs);
  if (v && v.status === 200 && v.json && typeof v.json.version === "string") {
    return { kind: "ollama", url: base, version: v.json.version };
  }
  // "/" is the old-Ollama fallback: /api/version predates the versions we care about,
  // but a reverse proxy that swallows unknown paths would still be worth reporting.
  if (v) {
    const root = await get(base + "/", timeoutMs);
    if (root && root.status === 200 && /ollama is running/i.test(root.text)) {
      return { kind: "ollama", url: base, version: "" };
    }
  }
  // OpenAI-compatible: /v1/models is the one endpoint every such server implements,
  // and it is exactly what server/openai.js calls to populate the dropdown.
  const m = await get(base + "/v1/models", timeoutMs);
  if (m && m.status === 200 && m.json && Array.isArray(m.json.data)) {
    return { kind: "openai", url: base, version: "", data: m.json.data };
  }
  // A relay that wants a key is still worth reporting — but ONLY when the refusal is
  // actually about a key. Plenty of unrelated services answer 403 to everything: macOS
  // AirPlay Receiver squats on :5000, and a cluster agent on this very LAN refuses
  // every port with {"code":"loopback-only"}. Reading the reason apart tells the two
  // cases apart; assuming "403 means OpenAI" reported both as LLM servers.
  if (m && (m.status === 401 || m.status === 403) && looksLikeAuthError(m)) {
    return { kind: "openai", url: base, version: "", needsKey: true };
  }
  return null;
}

// Does this refusal name a credential? OpenAI-shaped errors say so in plain words
// ("Incorrect API key provided", type "authentication_error", code "invalid_api_key").
function looksLikeAuthError(resp) {
  if (!resp.json) return false;
  const text = JSON.stringify(resp.json.error ?? resp.json).toLowerCase();
  return /api[-_ ]?key|authoriz|authenticat|bearer|token|unauthorized|credential/.test(text);
}

// Fill in a found server's catalogue. Ollama gets a second round-trip (its native
// endpoints carry sizes and residency, which /v1/models does not); an OpenAI-compatible
// one already answered with everything it is going to say.
async function describe(hit, timeoutMs) {
  if (hit.kind !== "ollama") {
    const data = hit.data || [];
    const models = data
      .map((m) => ({ name: m.id || "", size: 0, parameterSize: "", quantization: "" }))
      .filter((m) => m.name)
      .sort((a, b) => a.name.localeCompare(b.name));
    // owned_by is free-form; the vendor-ish placeholders say nothing, so fall back to
    // "what usually listens on this port" — flagged as a guess by being a port hint.
    const owner = (data.find((m) => m.owned_by) || {}).owned_by || "";
    const flavor = /^(organization[-_]owner|system|openai|local)$/i.test(owner)
      ? (HINT.get(Number(new URL(hit.url).port)) || "")
      : owner;
    const { data: _drop, ...rest } = hit;
    return { ...rest, flavor, models, running: [] };
  }
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
  return { ...hit, flavor: "", models, running };
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

// Bounded fan-out. A /24 across nine ports is >2000 probes; firing them all at once
// exhausts file descriptors long before it saves any time.
async function pool(tasks, limit) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) await tasks[next++]();
  });
  await Promise.all(workers);
}

// Loopback first (so this machine surfaces immediately), then every /24. onFound fires
// the moment a server is identified, so results stream rather than batch.
async function sweep(ports, timeoutMs, onFound, includeSelfIps) {
  const seen = new Set();
  const report = (hit) => { if (!seen.has(hit.url)) { seen.add(hit.url); onFound(hit); } };

  // Three names for ONE machine: probe them together per port and keep the first that
  // answers. A daemon bound solely to ::1 never replies on 127.0.0.1, which is exactly
  // the case where a naive localhost check reports nothing on the box running it.
  await Promise.all(ports.map(async (port) => {
    const hosts = await Promise.all(
      LOOPBACK_HOSTS.map(async (h) => (await tcpOpen(h, port, timeoutMs) ? h : null)),
    );
    const host = hosts.find(Boolean);
    if (!host) return;
    const hit = await identify(baseUrl(host, port), Math.max(timeoutMs, 5000));
    if (hit) report(hit);
  }));

  const selfIps = new Set(localIPv4s());
  const subnets = [...new Set([...selfIps].map((ip) => ip.split(".").slice(0, 3).join(".")))];
  const tasks = [];
  for (const subnet of subnets) {
    for (let i = 1; i <= 254; i++) {
      const ip = `${subnet}.${i}`;
      // Our own addresses are already covered by the loopback probe — unless that came
      // back empty, in which case a server may be bound to the LAN address only.
      if (!includeSelfIps && selfIps.has(ip)) continue;
      for (const port of ports) {
        tasks.push(async () => {
          if (!(await tcpOpen(ip, port, timeoutMs))) return;
          const hit = await identify(baseUrl(ip, port), Math.max(timeoutMs, 5000));
          if (hit) report(hit);
        });
      }
    }
  }
  await pool(tasks, 256);
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
  if (rec.flavor) bits.push(rec.flavor);
  if (rec.needsKey) bits.push("needs an API key");
  else bits.push(rec.models.length === 1 ? "1 model" : `${rec.models.length} models`);
  if (rec.running.length) bits.push(`loaded: ${rec.running.map((m) => m.name).join(", ")}`);
  if (rec.hostname) bits.push(`(${rec.hostname})`);
  process.stdout.write(`  ${rec.url.padEnd(28)}${rec.kind.padEnd(8)}${bits.join("  ")}\n`);
  if (opts.models) {
    for (const m of rec.models) {
      const detail = [m.parameterSize, m.quantization].filter(Boolean).join(" ");
      const size = m.size ? gib(m.size).padStart(8) : "";
      // An OpenAI endpoint reports neither size nor quantization, so trim rather than
      // leave every line trailing the columns it had nothing to put in.
      process.stdout.write(`      ${`${m.name.padEnd(34)}${size}  ${detail}`.trimEnd()}\n`);
    }
  }
}

// How to point the app at what we found. The two backends are configured in completely
// different places, so each kind gets its own line — and only the kinds actually found.
function printHints(found) {
  const ollama = found.find((r) => r.kind === "ollama" && r.models.length) || found.find((r) => r.kind === "ollama");
  const openai = found.find((r) => r.kind === "openai" && !r.needsKey) || found.find((r) => r.kind === "openai");
  const out = ["\npoint hey-koko at one with:\n"];
  if (ollama) out.push(`  ollama   OLLAMA_URL=${ollama.url} npm start\n`);
  if (openai) {
    out.push(`  openai   OPENAI_BASE_URL=${openai.url} npm start\n`);
    // Telling someone "no apiKey needed" about the one endpoint that just answered 401
    // is worse than saying nothing: they would follow it and get a silent empty dropdown.
    out.push(openai.needsKey
      ? `           plus OPENAI_API_KEY=… — this one refused without a key\n`
      : `           (or "baseUrl" in ~/.hey-koko/openai.json — a local endpoint needs no apiKey)\n`);
  }
  process.stderr.write(out.join(""));
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
    // The catalogue call is generous: a host that answered the probe is up, and asking
    // it for a 60-model list over Wi-Fi legitimately takes longer than the discovery ping.
    const [rec, hostname] = await Promise.all([
      describe(hit, Math.max(cli.timeout, 5000)),
      hostnameFor(hit.url),
    ]);
    const full = { ...rec, hostname };
    found.push(full);
    if (cli.json) process.stdout.write(JSON.stringify(full) + "\n");
    else printHuman(full, cli);
  })());

  const probeOne = async (url) => {
    const hit = await identify(url, Math.max(cli.timeout, 5000));
    if (hit) emit(hit);
    return !!hit;
  };

  if (cli.targets.length) {
    let urls;
    try {
      urls = [];
      for (const t of cli.targets) {
        const { host, port, protocol } = parseTarget(t);
        // A host named without a port gets the whole port list — the user knows WHICH
        // machine, not which of nine servers it happens to be running.
        for (const p of (port ? [port] : cli.ports)) urls.push(baseUrl(host, p, protocol));
      }
    } catch (e) { process.stderr.write(`bad host: ${e.message}\n`); return 2; }
    log(`probing ${urls.length} endpoint${urls.length > 1 ? "s" : ""}…\n`);
    const hits = await Promise.all(urls.map(probeOne));
    if (!cli.json && !hits.some(Boolean)) {
      for (const u of urls) process.stderr.write(`  ${u.padEnd(28)}no answer\n`);
    }
  } else if (cli.noSweep) {
    // The addresses the app itself would use, checked and nothing more.
    const envs = [process.env.OLLAMA_URL, process.env.OPENAI_BASE_URL, process.env.OLLAMA_HOST]
      .filter(Boolean);
    const urls = (envs.length ? envs : [`127.0.0.1:${cli.ports[0]}`]).map((e) => {
      const { host, port, protocol } = parseTarget(e);
      return baseUrl(host, port || cli.ports[0], protocol);
    });
    log(`probing ${urls.join(", ")}…\n`);
    await Promise.all(urls.map(probeOne));
  } else {
    log(`scanning for LLM servers (ports ${cli.ports.join(", ")}) from this machine…\n`);
    await sweep(cli.ports, cli.timeout, emit, false);
    // Nothing anywhere? One more pass that does not assume the loopback speaks for this
    // machine — some setups bind the LAN address only (OLLAMA_HOST=0.0.0.0 gone wrong).
    if (!found.length && !pending.length) await sweep(cli.ports, cli.timeout, emit, true);
  }
  await Promise.all(pending);

  if (!found.length) {
    process.stderr.write("no LLM server found\n");
    const bin = ollamaBinary();
    if (bin && !cli.quiet) {
      process.stderr.write(`ollama is installed (${bin}) but not answering — start it with: ollama serve\n`);
    } else if (!cli.quiet) {
      process.stderr.write("install Ollama (https://ollama.com/download), or start an OpenAI-compatible server\n");
    }
    return 1;
  }
  if (!cli.quiet && !cli.json) printHints(found);
  return 0;
}

// Piping into `head` closes stdout early; that is a normal way to use this, not a
// crash ("Error: write EPIPE" with a stack trace is not an answer to `| head -5`).
process.stdout.on("error", (e) => { if (e && e.code === "EPIPE") process.exit(0); });

main().then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(`${(e && e.stack) || e}\n`);
  process.exitCode = 2;
});
