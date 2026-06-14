// Context / token usage meter
// Shows how full the model's context window is after each reply, so the
// user knows when to run /compact. Token counts come straight from Ollama's
// final stream chunk (prompt_eval_count / eval_count) — no estimation.
import { dom } from './state.js';
import { getActiveTab } from './tabs.js';
import { t } from './i18n.js';

// Cache the architectural max context length per model (from /api/model-info)
const modelMaxCtxCache = new Map();

const DEFAULT_NUM_CTX = 32768;

/** Configured context window (num_ctx) the app sends to Ollama. */
export function getNumCtx() {
  const v = parseInt(dom.numCtxSelect?.value, 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_NUM_CTX;
}

/** Format a token count compactly: 1234 -> "1.2k". */
function fmt(n) {
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")) + "k";
  }
  return String(n);
}

/**
 * Look up a model's max context length and clamp the num_ctx <option>s so the
 * user can't pick a window larger than the model supports.
 */
export async function refreshModelMaxContext(model) {
  if (!model) return;
  if (!modelMaxCtxCache.has(model)) {
    try {
      const res = await fetch("/api/model-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const data = await res.json();
      modelMaxCtxCache.set(model, data.contextLength || null);
    } catch {
      modelMaxCtxCache.set(model, null);
    }
  }
  const max = modelMaxCtxCache.get(model);
  if (dom.numCtxSelect && max) {
    const prev = parseInt(dom.numCtxSelect.value, 10) || DEFAULT_NUM_CTX;
    // Build the option ladder up to the model's real architectural max.
    const ladder = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
    const values = ladder.filter((v) => v <= max);
    if (!values.includes(max)) values.push(max); // expose the exact model max
    dom.numCtxSelect.innerHTML = "";
    for (const v of values) {
      const opt = document.createElement("option");
      opt.value = String(v);
      opt.textContent = v >= 1024 ? `${v} (${Math.round(v / 1024)}K)` : String(v);
      dom.numCtxSelect.appendChild(opt);
    }
    // Keep the previous choice if still valid, else fall to the nearest smaller one.
    const valid = values.includes(prev) ? prev : (values.filter((v) => v <= prev).pop() || values[0]);
    dom.numCtxSelect.value = String(valid);
  }
  renderContextMeter();
}

/** Record real token usage from a completed reply onto the tab. */
export function recordContextUsage(tab, promptTokens, evalTokens, tokensPerSec) {
  if (!tab) return;
  if (promptTokens) tab.ctxPromptTokens = promptTokens;
  if (evalTokens) tab.ctxEvalTokens = evalTokens;
  if (tokensPerSec) tab.ctxTokensPerSec = tokensPerSec;
}

/** Render the meter from the active tab's stored usage. */
export function renderContextMeter() {
  if (!dom.contextMeter) return;
  const tab = getActiveTab();
  const prompt = tab?.ctxPromptTokens || 0;
  const gen = tab?.ctxEvalTokens || 0;
  // Current context ≈ what the last prompt sent + what the model just generated,
  // which is roughly the base of the next turn.
  const used = prompt + gen;
  const total = getNumCtx();

  // Always show the current context window next to the usage.
  if (dom.numCtxDisplay) dom.numCtxDisplay.textContent = fmt(total);

  if (!used) {
    dom.contextMeterFill.style.width = "0%";
    dom.contextMeter.classList.remove("isWarn", "isFull");
    dom.contextMeterText.textContent = t("ctx_meterEmpty");
    dom.contextMeter.title = "";
    return;
  }

  const pct = Math.min(100, Math.round((used / total) * 100));
  dom.contextMeterFill.style.width = pct + "%";
  dom.contextMeter.classList.toggle("isWarn", pct >= 75 && pct < 90);
  dom.contextMeter.classList.toggle("isFull", pct >= 90);
  dom.contextMeterText.textContent = t("ctx_meter", { used: fmt(used), total: fmt(total), pct });
  dom.contextMeter.title = t("ctx_meterTooltip", {
    prompt,
    gen,
    speed: tab?.ctxTokensPerSec ? tab.ctxTokensPerSec.toFixed(1) : "—",
    total,
  });
}
