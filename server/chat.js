// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const config = require("./config");
const { sendJson, readBody } = require("./utils");

async function proxyOllamaChat(req, res, preBody) {
  let bodyModel = "";
  let timedOut = false;
  let sawFirstByte = false;
  try {
    const body = preBody || await readBody(req);
    bodyModel = body.model || "";
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    console.log(`${ts} [chat] model=${body.model || '?'}, messages=${(body.messages || []).length}`);

    const reqTimeout = body.timeout;
    const { timeout: _discard, thinkEffort, ...chatBody } = body;
    // ⚙ "Thinking effort": Ollama expresses it through `think` itself, which takes either
    // a boolean or a level ("low"/"medium"/"high") on models that HAVE levels (gpt-oss,
    // DeepSeek-V3.1). A level also implies thinking is on, so it overrides the boolean
    // the browser sends for "show me the reasoning" — the two questions are separate on
    // our side and one field on Ollama's.
    if (thinkEffort === "low" || thinkEffort === "medium" || thinkEffort === "high") {
      chatBody.think = thinkEffort;
    }
    // Tool-calling turns are sent with stream:false (more reliable); honor it.
    const wantStream = chatBody.stream !== false;
    const controller = new AbortController();
    // The ⚙ field offers up to 3600s, so honour up to 3600 — the old ceiling of 600
    // silently overrode anything larger the user had typed.
    const timeoutMs = reqTimeout && reqTimeout > 0
      ? Math.min(3600, Math.max(60, reqTimeout)) * 1000
      : 0;
    let timeoutHandle = null;
    // IDLE timeout, not a total-duration cap: a reply that is still arriving token by
    // token is working, and killing it at N seconds truncates it mid-sentence for no
    // reason (a 30B on a slow box takes minutes to say something long). The clock is
    // restarted on every chunk, so it only fires when the model has gone quiet — which
    // is the thing worth giving up on. A stream:false turn gets no chunks before the
    // end, so for those it stays exactly the hard cap it always was.
    //
    // Waiting for the FIRST byte runs on the same budget, deliberately: one number the
    // user set, meaning the same thing in both places. It does cover a different kind of
    // wait — loading 30GB of weights, or sitting in Ollama's queue behind another
    // client's whole answer (it serves one at a time) — so if a request dies having
    // produced nothing at all, that budget is what to raise.
    const armTimeout = (ms) => {
      if (!ms) return;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
    };
    armTimeout(timeoutMs);

    const ask = (payload) => fetch(`${config.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, stream: wantStream }),
      signal: controller.signal,
    });
    let response = await ask(chatBody);
    // A model that thinks but has no LEVELS rejects the string outright. The user asked
    // for more thinking, not for an error, so fall back to plain thinking-on once —
    // silently, because there is nothing for them to fix.
    if (!response.ok && response.status === 400 && typeof chatBody.think === "string") {
      const why = await response.text().catch(() => "");
      console.log(`[chat] thinking level "${chatBody.think}" refused (${why.trim().slice(0, 120)}) — retrying with think:true`);
      response = await ask({ ...chatBody, think: true });
    }

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
      sawFirstByte = true;
      armTimeout(timeoutMs);      // still talking — start the quiet-clock over
      res.write(chunk);
    }
    if (timeoutHandle) clearTimeout(timeoutHandle);
    res.end();
  } catch (error) {
    if (res.headersSent) {
      // The reply was already streaming, so there is no error response left to send —
      // and just closing the socket is exactly how a cut-off answer used to reach the
      // user looking like a complete one. Sign off with a final NDJSON line saying why
      // it stopped, in the same shape Ollama's own done-line has, so the browser can
      // say "this was cut" instead of quietly keeping half an answer.
      const reason = error.name === "AbortError" ? (timedOut ? "timeout" : "aborted") : "error";
      try {
        res.write(`\n${JSON.stringify({ model: bodyModel, done: true, done_reason: reason, message: { role: "assistant", content: "" } })}\n`);
      } catch { /* socket already gone — nothing to say it to */ }
      res.end();
      return;
    }
    if (error.name === "AbortError") {
      sendJson(res, 504, {
        error: sawFirstByte
          ? "Request timed out: the model stopped responding partway through."
          : "Request timed out: nothing came back at all. Ollama may still be loading the model, or be busy with another request.",
      });
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