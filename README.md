# fasthands

**Open-source, model-agnostic computer use.** Same task, fewer tokens, fewer
turns, less wall clock — with any model as the brain.

Computer-use agents today come in two flavors. Anthropic's reference loop
sends a screenshot every turn (~1,366 image tokens at 1280x800) and takes one
action per turn. OpenAI's GPT-6 Astra loop is smarter — accessibility trees
and code actions — but it resends a fresh full tree every turn, it's closed,
and it only runs one company's models. Its own known failure modes are stale
trees and state drift between observing and acting.

fasthands attacks the loop, not the model:

1. **Diff observations.** Full compact interactive tree on turn one, then
   structural diffs only. Stable element refs survive across turns.
2. **Guarded action batching.** The model emits a script of actions per turn.
   Every ref is re-verified against a content hash immediately before firing;
   on drift the batch aborts and the model recovers with a fresh diff — it
   never clicks a stale target.
3. **Any brain.** Plain-fetch adapters for Anthropic, OpenAI, and every
   OpenAI-compatible endpoint (Ollama, Groq, Together, vLLM). Open-weight
   models get the same fast loop.

## xray: the web's hidden instruction manual

Since HTML5, every page has shipped a machine-readable operating contract —
`required`, `pattern`, `min`/`max`, input types, `autocomplete`, form
membership, `href` targets — and a native validation engine
(`checkValidity()`, `ValidityState`) that knows a submit will fail *before you
submit*. Every agent framework ignores all of it and learns form errors the
human way: submit, read the red text, retry, one model round-trip per mistake.

xray reads the contract instead:

- **Rule annotations** in the observation: `e15 · (hidden rule) 8+ chars
  incl. a digit` — including rules invisible on the rendered page.
- **Consequence predictions** before anyone acts: `e20 · → submits form
  (BLOCKED: 2 invalid: e13 required, e15 needs a digit)`.
- **Preflight gate**: the executor refuses to click a submit the browser says
  will fail, and reports the exact violations — recovery costs a replan, not
  a wasted submit-observe-retry loop.

Boosters for small models: **council mode** (parallel proposals scored by
ref-resolvability and guard discipline) and a **reflex cache** (successful
traces replay deterministically behind the same drift guards).

## Benchmarks

<!-- RESULTS -->
Six tasks (form, product search, checkout wizard, settings toggles, infinite
scroll, validation-trap signup), four loop styles, identical oracle policy and
verifiers. 24/24 verified successes.

| style | what it models | turns | observation tokens | success |
|---|---|---:|---:|---|
| screenshot | Anthropic-style loop: image/turn, 1 action/turn | 42 | 57,372 | 6/6 |
| fulltree | Astra-style loop: full a11y tree/turn, batched code actions | 26 | 13,392 | 6/6 |
| **fasthands** | diffs + guarded batching | 26 | **5,854** | 6/6 |
| **fasthands + xray** | + HTML-contract annotations & preflight | **25** | **4,754** | 6/6 |

- **vs the screenshot loop: 91.7% fewer tokens, 40.5% fewer turns.**
- **vs the Astra-style full-tree loop: 64.5% fewer tokens** (xray annotation
  tokens counted against us).
- The signup trap isolates the capability win: hidden validation rules
  (username/password patterns with no visible hint). Screenshot loop: 8 turns.
  Batched loops: 3 turns (fail a submit, read errors, retry). **xray: 2 turns,
  229 tokens — it read the rules from the HTML contract and never wasted a
  submit.**
<!-- /RESULTS -->

Reproducible with **zero API keys**: the default benchmark drives all three
loop styles with a deterministic oracle policy over five local fixture tasks
(form, search, checkout wizard, settings toggles, infinite scroll), so the
numbers isolate loop efficiency from model quality. Screenshot-style image
tokens are simulated at Anthropic's published (w·h)/750 formula. Add
`--provider anthropic --model claude-sonnet-5` (or any OpenAI-compatible
endpoint) to run live.

## Quick start

```bash
npm install && npx playwright install chromium
npm run bench                      # keyless, deterministic
```

Use it as a library:

```ts
import { chromium } from "playwright";
import { createObservationEngine } from "./src/observe/engine.ts";
import { createExecutor } from "./src/act/executor.ts";
import { runAgent } from "./src/agent/loop.ts";
import { createAnthropicProvider } from "./src/providers/anthropic.ts";

const page = await (await chromium.launch()).newPage();
await page.goto("https://example.com");
const engine = createObservationEngine(page);
const result = await runAgent({
  page, engine,
  executor: createExecutor(page, engine),
  brain: createAnthropicProvider("claude-sonnet-5"),
  task: { id: "demo", description: "Find the pricing page and report the cheapest plan." },
  config: { maxTurns: 15, observationBudget: 2000, batching: true, diffing: true },
});
```

## Design notes

See [SPEC.md](SPEC.md). Inspired by the public analysis of Astra's
architecture; built to fix the parts it left open.

MIT.
