// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const config = require("./config");
const { sendJson, readBody } = require("./utils");

async function proxyOllamaChat(req, res, preBody) {
  try {
    const body = preBody || await readBody(req);
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    console.log(`${ts} [chat] model=${body.model || '?'}, messages=${(body.messages || []).length}`);

    const reqTimeout = body.timeout;
    const { timeout: _discard, ...chatBody } = body;
    // Tool-calling turns are sent with stream:false (more reliable); honor it.
    const wantStream = chatBody.stream !== false;
    const controller = new AbortController();
    let timeoutHandle = null;
    if (reqTimeout && reqTimeout > 0) {
      const timeoutMs = Math.min(600, Math.max(60, reqTimeout)) * 1000;
      timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    }

    const response = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...chatBody, stream: wantStream }),
      signal: controller.signal,
    });

    if (!response.ok) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const text = await response.text();
      sendJson(res, response.status, { error: text || response.statusText });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    });

    for await (const chunk of response.body) {
      res.write(chunk);
    }
    if (timeoutHandle) clearTimeout(timeoutHandle);
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error.name === "AbortError") {
      sendJson(res, 504, { error: "Request timed out: the model exceeded the configured response time limit." });
    } else {
      sendJson(res, 500, {
        error: "Cannot connect to local Ollama. Make sure Ollama is running and the model has been downloaded.",
        detail: error.message,
      });
    }
  }
}

async function proxyOllamaShow(req, res, preBody) {
  try {
    const body = preBody || await readBody(req);
    if (!body.model) {
      sendJson(res, 400, { error: "model required" });
      return;
    }
    const response = await fetch(`${config.ollamaUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: body.model }),
    });
    if (!response.ok) {
      sendJson(res, response.status, { error: response.statusText });
      return;
    }
    const data = await response.json();
    // Extract the architectural context length from model_info (key ends with .context_length)
    let contextLength = null;
    const info = data.model_info || {};
    for (const key of Object.keys(info)) {
      if (key.endsWith(".context_length")) {
        contextLength = info[key];
        break;
      }
    }
    sendJson(res, 200, { contextLength });
  } catch (error) {
    sendJson(res, 200, { contextLength: null });
  }
}

async function proxyOllamaTags(res) {
  try {
    const response = await fetch(`${config.ollamaUrl}/api/tags`);
    if (!response.ok) {
      sendJson(res, response.status, { models: [] });
      return;
    }

    sendJson(res, 200, await response.json());
  } catch {
    sendJson(res, 200, { models: [] });
  }
}

module.exports = { proxyOllamaChat, proxyOllamaTags, proxyOllamaShow };