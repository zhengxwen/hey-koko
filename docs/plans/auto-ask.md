# Plan: `/ask -a` — Agentic Auto Retrieval

> Status: **P1 + P2 IMPLEMENTED 2026-07-04** (syntax-checked, unit-tested, live e2e
> against the running server passed: plan→retrieve→schema-first notes→comparison-table
> synth). Not yet exercised in the real browser UI end-to-end. §8 refactor done.
> Author: planning session 2026-07-04.
>
> Naming: the flag is **`-a` / `--auto`** — "auto" as in *the model plans its own
> retrieval automatically*. Deliberately NOT called "deep": map-reduce over notes is
> automated breadth, not guaranteed depth of understanding (renamed from an earlier
> `-d/--deep` draft at the user's request — honest naming).
>
> ## Implementation notes (what actually shipped)
>
> All in **`public/js/ask.js`** (front-end orchestration, as planned):
> - `parseAskCommand` gained `-a`/`--auto` and `--dims` (bare `a,b` / quoted `"a, b"` /
>   CJK curly `“a、b”`; separators `, ， 、`). 10/10 parse unit tests pass.
> - `handleAutoAsk(task, tab, scope, insertAt)` — orchestrator, mirrors
>   `handleAskCommand`'s bubble/abort/setGenerating/genMs plumbing.
> - Helpers: `chatOnce` (one /api/chat turn, accumulate stream, surfaces 429 + inline
>   errors like `runLibraryQuery`), `lightParseJson` (front-end lenient JSON), `autoL`
>   (AUTO_PROMPTS × zh/zh-Hant/en), `planQueries`, `retrieveUnion`, `fetchDocText`
>   (reuses `fullDocsContext`), `readDocNote` (schema-first when dims), `notesDetails`
>   (collapsible `<details>` sub-bubble).
> - **Loop:** `AUTO_ROUNDS=3`, `AUTO_MAXDOCS=12`. Round 1 plans queries + decides
>   isCompare/dims; **FAST PATH** (round 1, not compare, all docs fit `num_ctx`) reads
>   everything in one `chatOnce` and returns; otherwise **SLOW PATH** reads each doc into
>   a note and later rounds re-plan from the accumulated notes until `done`/dry/caps.
> - `markdown.js` gained a `<details>`/`<summary>` passthrough (raw HTML is otherwise
>   escaped) so the notes sub-bubble renders.
> - **Live process trace** (added on user request): the bubble shows the run in detail
>   as it happens — each round's **actual queries** (backticked), the chosen comparison
>   dimensions, the **docs found** (clickable `#libsrc` links), and a transient "reading
>   (i/N): title" / "synthesizing" status. `log` = step lines shown live in the body
>   during the gather phase.
> - **Search-process treated like the thinking block** (user request: "put 🔎检索过程 at
>   the top, and don't feed it into the next turn's context"): the final trace is stored
>   in a new message field **`autoProcess`** (NOT in `content`). `renderMessage` renders
>   it as a collapsed `<details>` **above** the answer (same pattern as the thinking /
>   tool-steps blocks). Because `buildMessages` sends only `msg.content`, the trace is
>   automatically excluded from follow-up context. Persisted via the settings whitelist.
>   i18n `auto_trace*`/`auto_processHeader` × 3 langs. (Notes stay a `<details>` in
>   `content` — the user only asked to exclude the process trace.)
> - Dispatch: `chat.js` routes `-a` to `handleAutoAsk` on both send and resend; empty
>   `-a` → `auto_usage`. i18n: `auto_*` keys (planning/dims/searching/reading/synth/
>   notesHeader/usage) × 3 langs; `cmd_ask` mentions `-a`.
>
> **Known limitation:** the LLM-synthesized comparison table can break markdown table
> rendering if a doc *title* contains a literal `|` (e.g. "… | 4K") — the source-list
> links sanitize `|`→`│`, but the model writes the table cells itself. Cosmetic; a
> future prompt tweak could ask the model to avoid raw pipes in cells.

## 1. Goal (what the user asked for)

An enhanced `/ask` mode where, given a free-form task description, the assistant:

1. **derives one or more keywords itself** from the task,
2. **searches the embedding index** with them (one keyword at a time, and/or a merged query),
3. **reads the documents it finds** (full text, not just snippets),
4. **answers according to the task** (summarize / compare / synthesize / …).

In short: *agentic RAG* — the model plans its own retrieval instead of embedding the
raw question once. Triggered by a flag on the existing command: **`/ask -a …`** (also
`--auto`). Plain `/ask` is unchanged. (`-a` is free in the current flag parser: `-n K`
and `-s/--short` are the only existing flags.)

Decisions locked with the user:
- **Iterative, multi-round** loop (not single-shot).
- **Read matched docs in full** (not snippet-only).
- **Trigger via a `/ask` flag** (`-a`/`--auto`), reusing the existing `/ask` plumbing.
- **Intermediate notes are shown to the user** (collapsible sub-bubble, §4.1).
- **Comparison dimensions: three-tier priority + mandatory echo** (§2.2).

## 2. The hard problem: context length

This is the whole difficulty, and the reason "implemented" may still not equal
"satisfying". Reading N documents in full **cannot** all live in one context window —
6 Chinese YouTube transcripts already flirt with a 32k window, and the multi-round
design wants to read *more* than that over time.

**Strategy: never hold all full text in one context. Map-reduce + a notes accumulator.**

- **map (read each doc alone):** each matched doc is read in its *own* LLM call,
  producing a compact, task-relevant note: `{docId, points:[…], quotes:[…]}`. One doc
  per call → inherently bounded. If a single doc is itself too big, batch it by the
  existing section/block structure and fold its batch-notes together.
- **reduce (accumulate):** the main loop carries **only the notes** (~200–400 chars
  each), never full text. 30 docs of notes ≈ 10k chars — it never overflows.
- **synthesis (answer):** task + all notes → streamed answer + sources.

### 2.1 Measure, then choose (self-planning)

Do not blindly map-reduce. Reuse the already-shipped CJK-aware `estimateTokens` +
`getNumCtx` to pick a strategy per round:

```
candidate docs' full text  estimateTokens ≤ (num_ctx − reserve)
    → FAST PATH: read everything in one call (today's default /ask behavior:
      1 call, verbatim text preserved, cheapest & most faithful)

candidate docs' full text  >  budget
    → SLOW PATH: map-reduce note accumulation (read doc-by-doc, no doc-count cap)
```

i.e. **read it all at once when it fits (cheap, faithful); degrade to per-doc notes
only when it doesn't.** *That* is the autonomous context planning — the system picks a
strategy from the measured size, rather than hard-coding one.

### 2.2 Cross-document comparison (schema-first read)

Naive map-reduce is at its **weakest on comparison tasks**: each doc is read in
isolation, so doc A's note extracts metric X while doc B's note skips it (X didn't look
important for B alone). At synthesis time the notes don't align, and the comparison is
only as good as the accidental intersection of what each note happened to record.

Two regimes:

- **Few docs, fits the window (fast path):** today's default `/ask` already handles
  comparison well — all full texts sit in one context, the model compares directly.
  Don't force the slow path when the fast path fits.
- **Many docs (slow path):** add a **schema-first** read:
  1. **Derive the comparison dimensions first** (the "columns of the comparison
     table"), e.g. `{method, dataset, main result, limitations}` for papers.
  2. **Read every doc against the SAME dimensions** — the map step becomes "fill in
     these fields for this doc", producing **aligned** structured notes.
  3. **Synthesize** from aligned notes → a real comparison table / difference
     analysis instead of talking past each other.

**Who defines the dimensions — three-tier priority (decided):**

1. **`--dims` explicit flag** → used verbatim, highest priority. For power users
   and — more importantly — for the *repair loop* (below). Two forms:
   - bare: `--dims 方法,结论` — no spaces inside dims (flag-tokenizer constraint;
     natural for CJK);
   - **quoted: `--dims "main results, compute cost"`** — quotes admit spaces, for
     English multi-word dimensions. Accept straight `"…"` AND curly `“…”` (CJK IMEs
     emit curly quotes; same spirit as accepting `，、` separators).
   Separators inside either form: `,` `，` `、`.
2. **Dimensions already named in the task text** ("对比这几篇的**方法和结论**") → the
   planning prompt must **extract** them, not invent its own.
3. **Genuinely vague task** ("对比一下这几篇") → the LLM invents dimensions itself.

**Mandatory echo (iron rule):** whoever defined them, the dimensions are always shown —
in the pulsing progress bubble during the read ("📊 对比维度：方法 / 数据集 / 结论")
and as the column heads of the final answer's table. This turns "who decides" from a
one-shot gamble into an **iteration loop**: auto-derived dims look wrong → the user
sees the columns instantly → edits the bubble, adds `--dims …`, resends → pinned.
Reuses the existing edit-then-resend mechanic; no new interaction UI.

Explicitly rejected: a mid-run "confirm the dimensions" prompt. It would introduce a
wait-for-input interaction shape `/ask` doesn't have; the resend-repair loop gets ~90%
of the value at ~10% of the UX cost.

Guardrails: clamp dimension count to 2–8 (planner merges beyond that); derived dims
follow the prompt-language setting (no zh/en drift); detecting "is this a comparison
task" is itself LLM-judged — when unsure, fall back to plain (non-schema) notes.

Honest limits: LLM-derived dims can still miss the one the user cares about (the echo +
`--dims` resend is the mitigation, not prevention); aligned notes grow with dimension
count (still ≪ full text).

## 3. The loop (loop-until-dry)

```
seen = ∅            # docIds already read
notes = []          # compact per-doc notes
round = 0
while round < N:                     # N default 3 (⚙-configurable later)
  # (a) PLAN — LLM sees [task + notes-so-far] → JSON {done, queries:[…], dims?, reason}
  plan = llm(planPrompt(task, notes))
  if plan.done or plan.queries is empty: break
  # (b) RETRIEVE — each query embeds & searches independently ("one keyword at a
  #     time"), plus optionally one merged-query pass. Hits union by docId.
  hits = union(retrieve(q) for q in plan.queries)
  fresh = [h for h in hits if h.docId not in seen]
  if not fresh: break              # dry — nothing new surfaced
  # (c) READ — per §2.1 strategy: fast path (batch) or slow path (per-doc notes);
  #     comparison tasks read schema-first against plan.dims (§2.2)
  notes += read(fresh)             # appends {docId, points, quotes} (aligned if dims)
  seen |= {h.docId for h in fresh}
  round += 1
# (d) SYNTHESIZE — task + notes → streamed answer + clickable sources (docs used)
answer = llmStream(synthPrompt(task, notes))
```

Only the **compact notes** cross round boundaries, so the planning context never grows
with round count. `seen` both dedups and prevents infinite loops.

## 4. Reuse vs. new

| Piece | Status |
|---|---|
| `runLibraryQuery` retrieval/full-read/stream/abort, `fullDocsContext`, `estimateTokens`, `getNumCtx`, progress-bubble, `srcLinkMd` source links | ✅ reuse |
| Server `retrieve`, `llmComplete` (3-backend + retry), `parseJsonLoose`, `extractKeywords` | ✅ reuse (server path) |
| Per-doc "read → note" call | new (non-stream `/api/chat`, or server `llmComplete`) |
| Planning call (emit keywords / dims / done as JSON) | new; needs lenient JSON parse |
| `parseAskCommand` gains `-a/--auto` (+ `--dims`); `handleAutoAsk` orchestrator | new |
| Multi-stage progress bubble (🧠 plan → 🔍 search K → 📖 read i/M → ✍️ synth) | new |

**Placement: front-end orchestration** (consistent with today's `/ask`, reuses
abort/stream/progress). The plan/note JSON is simpler than the distill card (no LaTeX),
so a small front-end `parseJsonLoose` (a few dozen lines) suffices. If we'd rather keep
JSON on the server, the fallback is a new `/api/library/auto-ask` NDJSON endpoint that
reuses `llmComplete`/`parseJsonLoose`.

**File layout:** all `/ask` code lives in its own **`public/js/ask.js`** (extracted
from `library.js` — done, see §8). Auto mode lands there too (or in a sibling
`auto-ask.js` that `ask.js` re-exports), keeping `library.js` focused on the
panel/import/CRUD.

### 4.1 Showing intermediate notes to the user (decided)

The per-doc notes are **shown to the user**, not kept internal — as a **collapsible
sub-bubble** under the answer (`<details>`-style, collapsed by default):

```
✍️ <the synthesized answer>
▸ 📓 检索笔记 (M 篇)              ← collapsed by default; click to expand
    📄 doc A — points…            ← clickable #libsrc link to the doc
    📺 doc B — points…
— 来源 —                          ← existing clickable source list
```

- Each note header is a clickable `#libsrc` link (reuse `srcLinkMd`) so the user can
  jump to the doc the note came from — makes the agent's reading auditable.
- Rendered from the accumulated `notes[]`, kept in the same assistant bubble as the
  answer so it survives archive/retrieve like any other message content.
- Live progress still narrates in the pulsing bubble *during* the run (🧠 plan →
  🔍 search → 📖 read i/M → ✍️ synth); the collapsible notes are the *final* record.
- Retained open question: stream notes live as produced, or only reveal the
  collapsible block at the end? Default: reveal at end (simpler, less flicker).

## 5. Guardrails & honest trade-offs

Guardrails:
- round cap N = 3; total-docs-read cap M (e.g. 12); num_ctx budget checked before each
  call; `seen` dedups; if a planning JSON fails to parse, **fall back** to using the raw
  task as a single query (degrades to a plain single-round `-a`).

Honest trade-offs (why this may still not fully satisfy):
- **Map-reduce synthesizes from notes, not from all raw text at once** — it loses some
  cross-document verbatim detail. This is the standard move when content exceeds the
  window, and it fits summarize/overview tasks well, but a task that needs exact
  side-by-side quoting across many docs will feel lossy. (§2.2's schema-first read
  mitigates this for comparisons, but doesn't eliminate it.)
- **Note quality gates answer quality.** A weak note-extraction model produces weak
  notes → weak synthesis. Garbage in, garbage out, one layer removed.
- **Keyword planning is only as good as the planner model.** Poor keywords → poor
  recall; embedding search can't find what was never queried.
- **Cost / rate limits.** Multi-round × per-doc = many LLM calls. **Free cloud models
  hit rate limits immediately** (the 429 the user already saw). This mode effectively
  *requires* a paid or local model; surface a warning when `-a` runs on a `:free` model.
- **Latency.** Several sequential planning+read+synth calls = noticeably slower than
  plain `/ask`. The progress bubble must narrate stages so it doesn't look hung.

## 6. Phasing

1. **P1 (single-round skeleton):** `-a` = plan multiple keywords → multi-query retrieval
   union → strategy-based read → answer. Structure the code with the `while` and round
   cap already in place, but run 1 round. Ship & try.
2. **P2 (open the loop):** wire the planning call's `done`/continue decision; open to N
   rounds + loop-until-dry. Schema-first comparison read + `--dims` (§2.2) lands here
   (it rides on the planning call).
3. **P3 (polish):** staged progress bubble; sources ranked by note contribution; expose
   N / M / per-query topK in the ⚙ `/ask` params modal.

## 7. Open questions (revisit before P2/P3)

- Note format: structured JSON vs. free-form markdown bullet notes? JSON is machine-
  checkable but more fragile to parse; markdown is robust but harder to rank/dedup.
  (Comparison notes are necessarily structured — §2.2 — which leans this toward JSON.)
- Merged-query pass: always run it, or only when per-keyword recall is thin?
- Should `-a` respect the ⚙ full-read budget, or manage its own budget end-to-end?
- ~~Surface intermediate notes to the user?~~ **Decided: yes, collapsible sub-bubble** (§4.1).
- ~~Who defines comparison dimensions?~~ **Decided: three-tier priority + mandatory echo** (§2.2).

## 8. Prerequisite refactor: extract `public/js/ask.js` — ✅ DONE (2026-07-04)

All `/ask` code moved out of `library.js` into `public/js/ask.js`, so `library.js`
stays about the panel/import/CRUD and auto-ask has a focused home.

- **Moved to `ask.js`:** `parseAskCommand`, `handleAskCommand`, `runLibraryQuery`,
  `fullDocsContext`, `fullArchivesContext`, `ASK_I18N`/`askL`, `estimateTokens`,
  `autoFullBudget`/`askTopK`/`askMaxImages`/`askFullBudget`, `FULL_DOC_BUDGET`,
  `srcHref`/`srcLinkMd`/`sourcesMarkdown`/`openLibrarySource`, the local
  `cleanErrorMessage`, and the ⚙ ask-params modal + `#libsrc` click delegation (moved
  out of `initLibrary` into an exported `initAsk()`, called from `main.js`).
- **Stayed in `library.js`:** the panel (`initLibrary`), import/CRUD, `transcriptMark`/
  `cardMark`/`isTranscriptSection`, related-docs, star-map hooks.
- **No import cycle:** `library.js` imports `runLibraryQuery`/`setAskDeps` from
  `ask.js` (one direction). `ask.js` does NOT statically import `library.js` — it gets
  the panel's open-doc/open-panel via injected `setAskDeps({openLibrary, openDoc})` and
  keeps the dynamic `import('./chat.js')` for `renderChat`/`setGenerating`.
- **Shared helpers:** `postJson` moved to `utils.js` (both files import it); `genId`
  uses the existing `utils.js` export; `kindIcon` imports from `mentions.js`.
- **Callers updated:** `chat.js` and `star-map.js` import `parseAskCommand`/
  `handleAskCommand` from `ask.js`; `main.js` calls `initAsk()`.
