# Cloud Models (optional)

Hey-Koko is local-first, but you can optionally add cloud chat models via the **Claude API** or any **OpenAI-compatible API** (OpenAI, DeepSeek, OpenRouter, xAI Grok, Alibaba Qwen, and more). Both are off by default and stay completely hidden until you configure them — messages you send to a cloud model **leave your machine**, unlike the local Ollama models.

## Claude API

Create `~/.hey-koko/claude.json`:

```json
{
  "baseUrl": "https://api.anthropic.com",
  "apiKey": "sk-ant-..."
}
```

- `baseUrl` — the API origin only (no `/v1/messages` suffix). Use
  `https://api.anthropic.com` for the official API, or your own relay URL.
- `apiKey` — your key. **No key → the whole feature stays invisible.**
- `models` *(optional)* — omit it and Hey-Koko **auto-lists** every `claude-*`
  model your key can access (via the Models API). Set it to pin a curated list,
  e.g. `"models": ["claude-opus-4-8", "claude-sonnet-4-6"]` — useful for relays
  that don't expose `/v1/models`, or to keep the dropdown short.

After configuring, **restart the server** and reload the page. Cloud models show
up in the model dropdown badged **☁️**, local Ollama models **💻** — pick one to
switch. The config file is re-read per request, so editing it needs no restart
(but a page reload is needed to refresh the dropdown). `ANTHROPIC_BASE_URL` /
`ANTHROPIC_API_KEY` environment variables override the file.

## OpenAI API

The same mechanism works for the **OpenAI API** (or any OpenAI-compatible
endpoint). It's independent of the Claude config — you can enable either, both,
or neither. Create `~/.hey-koko/openai.json`:

```json
{
  "baseUrl": "https://api.openai.com",
  "apiKey": "sk-..."
}
```

- `baseUrl` — the API origin. A trailing `/v1` is tolerated (handy for relays,
  OpenRouter, local OpenAI-compatible servers). Use `https://api.openai.com` for
  the official API.
- `apiKey` — your key. **No key → the whole feature stays invisible.**
- `models` *(optional)* — omit it and Hey-Koko **auto-lists** the chat models
  your key can access (via `/v1/models`, filtered to text chat models and
  collapsed to one entry per model). Set it to pin a curated list, e.g.
  `"models": ["gpt-5", "gpt-4o"]`.

Cloud models appear badged **☁️** in the dropdown alongside Claude and local
models. `OPENAI_BASE_URL` / `OPENAI_API_KEY` environment variables override the
file. Note: reasoning models (`o1`/`o3`/`o4`/`gpt-5`) drop `temperature` and use
the model's own output cap, per the OpenAI API.

## Other OpenAI-compatible endpoints

They work through the same `openai.json` — just point `baseUrl` at the provider
and list its models.

**DeepSeek** is recognized out of the box (`deepseek-chat`, `deepseek-reasoner`):

```json
{ "baseUrl": "https://api.deepseek.com", "apiKey": "sk-...", "models": ["deepseek-chat", "deepseek-reasoner"] }
```

`deepseek-reasoner`'s chain-of-thought (returned in `reasoning_content`) is shown
in the collapsible thinking UI when show-thinking is enabled.

**OpenRouter** (one key, hundreds of models across providers) also works —
because its model ids are `provider/model` (e.g. `anthropic/claude-3.5-sonnet`),
they don't match the auto-detect prefixes, so you **must list them explicitly**:

```json
{
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "sk-or-...",
  "models": ["anthropic/claude-3.5-sonnet", "deepseek/deepseek-r1", "google/gemini-2.0-flash"]
}
```

Reasoning models routed through OpenRouter return their thinking in a `reasoning`
field (vs DeepSeek's `reasoning_content`); both are surfaced in the thinking UI.

**xAI Grok** is auto-recognized like DeepSeek (`grok-*` needs no allowlist):

```json
{ "baseUrl": "https://api.x.ai/v1", "apiKey": "xai-...", "models": ["grok-4"] }
```

(`models` optional — auto-discovery works too.)

**Alibaba Qwen** (via DashScope compatible-mode) is likewise auto-recognized
(`qwen-*` chat + `qwq-*`/qwen3 reasoning, no allowlist needed):

```json
{ "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1", "apiKey": "sk-...", "models": ["qwen-max"] }
```

Other OpenAI-compatible providers (Kimi, GLM, Groq, Mistral, local vLLM / LM
Studio / llama.cpp) work the same way: point `baseUrl` at the endpoint and list
the models.
