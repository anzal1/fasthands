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
scroll, validation-trap signup), four loop styles, 5 repetitions each,
identical oracle policy and DOM-verified success conditions. 120/120 passes.

| style | what it models | turns | observation tokens | success |
|---|---|---:|---:|---|
| screenshot | Anthropic-style loop: image/turn, 1 action/turn | 210 | 286,860 | 30/30 |
| fulltree | Astra-style loop: full a11y tree/turn, batched code actions | 130 | 63,984 | 30/30 |
| **fasthands** | diffs + guarded batching | 127 | **24,817** | 30/30 |
| **fasthands + xray** | + HTML-contract annotations & preflight | **125** | 29,250 | 30/30 |

- **vs the screenshot loop: 91.3% fewer tokens, 39.5% fewer turns.**
- **vs the Astra-style full-tree loop: 61.2% fewer tokens** (diff engine alone;
  xray annotation tokens counted where used).
- The signup trap isolates the capability win: hidden validation rules
  (username/password patterns with no visible hint). Screenshot loop: 8 turns.
  Batched loops: 3 turns (fail a submit, read errors, retry). **xray: 2 turns,
  229 tokens — it read the rules from the HTML contract and never wasted a
  submit.**
<!-- /RESULTS -->

Aggregated over **5 repetitions per cell (120 runs, 120/120 verified
successes, near-zero variance)**. Reproducible with **zero API keys**: the
benchmark drives all four loop styles with a deterministic oracle policy over
local fixture tasks, so the numbers isolate loop efficiency from model
quality. Screenshot-style image tokens use Anthropic's published (w·h)/750
formula. Add `--provider anthropic --model claude-sonnet-5` (or any
OpenAI-compatible endpoint) to run live.

**Honest trade-off, reported as measured:** xray annotations are not free. On
tasks without forms they cost extra (xray total 29,250 tokens vs plain
fasthands 24,817 across the suite); they pay for themselves only where hidden
contracts exist. Use `xray` when forms are in play.

## Live: a 4B local model as the brain

The keyless numbers isolate the loop; these are real-model runs — CyberSecQwen-4B
(a *security*-tuned Qwen3, not an agent model) on Ollama, temperature 0,
done-review gate on:

| style | success | live obs tokens | note |
|---|---|---:|---|
| fulltree (Astra-style) | 2/6 | 6,567 | |
| **fasthands** | 3/6 | **3,548 (-46%)** | |
| **fasthands + xray** | 3/6 | 6,221 | wins the info-bound tasks |

The clean result: **the signup validation trap fails without xray and passes
with it, reproducibly** — same model, same prompt; the only difference is the
harness reading the HTML contract into the observation. Every booster in the
loop was built from a real failure in this model's transcripts: the
scrollbar-in-words header (it never scrolled — nothing said more page
existed), the done-review gate (it clicked "Order #4670" and certified it as
#4711), temperature 0 (Ollama's 0.8 default made it dice-roll batches), and a
depth-scan action parser (it emitted valid JSON, then hallucinated fake
transcript after it).

Honest boundaries, measured: council mode (parallel proposal voting) helps
exploration-bound tasks and *hurts* precision-bound ones, so it's opt-in
(`--council 3` with `FH_TEMPERATURE=0.7`); and the multi-step exploration
task (find an order three scrolls deep) stays failed at 4B — the harness
slashes a small model's costs and catches its lies, but does not plan for it.

```bash
FH_SYSTEM_SUFFIX="/no_think" npm run bench -- --provider compat \
  --model <your-ollama-model> --base-url http://localhost:11434/v1 --review
```

## The drift trap: 0% vs 100% catastrophe

The failure mode Astra's authors themselves admit — state drift between
observing and acting — reproduced deterministically. A page swaps an "Archive
message 3" button into "Delete all messages" 800ms after load, *in place*, the
way real lists reorder and ads inject. The agent observed before the swap and
acts after it.

| arm | trials | catastrophes | safe aborts | recovered |
|---|---:|---:|---:|---:|
| unguarded batch (fires blind on stale refs) | 20 | **20 (100%)** | 0 | 0 |
| fasthands guarded batch | 20 | **0 (0%)** | 20 | **20 (100%)** |

The guard is a content hash re-checked at click time: the mutated node no
longer matches what the model saw, the batch aborts, the fresh observation
finds the real button. Reproduce: `node --experimental-strip-types
src/bench/drift-test.ts`.

## Scale: where baselines drown

Per-observation cost on a parametric page with N distractor elements
(measured, chars/4 for all text strategies, real screenshot dimensions for
images):

| N elements | raw HTML dump | screenshot | full a11y tree (uncapped) | **fasthands diff** |
|---:|---:|---:|---:|---:|
| 50 | 5,333 | 1,366 | 2,197 | **38** |
| 200 | 15,642 | 1,366 | 8,962 | **38** |
| 500 | 36,533 | 1,366 | 22,791 | **38** |
| 1,000 | 71,513 | 1,366 | 46,000 | **39** |
| 2,000 | 141,910 | 1,366 | 92,732 | **39** |

The full tree grows ~42x across this range; the diff after a state change
stays flat at 38-39 tokens. The screenshot is flat too — but it's flat because
it's blind: viewport-only, it never sees any of it. Caveats we found and
report plainly: under a tight 2,000-token budget the engine's viewport-first
truncation flattens the in-loop cost for *both* tree styles (the in-loop diff
advantage measures ~27% and does not grow with N on this fixture); the
dramatic scaling gap above is per-observation, uncapped. Reproduce: `node
--experimental-strip-types src/bench/scale-test.ts`.

## Methodology and limitations (read before citing)

- **The oracle is not a model.** All headline numbers use a deterministic
  scripted policy so every loop style gets identical competence and anyone can
  reproduce them with no API keys. They measure *loop cost*, not model
  intelligence. Live mode (`--provider ...`) exists for end-to-end runs.
- **Fixtures are synthetic and local.** Deterministic by design so the
  benchmark can't flake its way to a good number. We make no claim about
  WebVoyager/OSWorld-style end-task success rates against other frameworks.
- **The "screenshot" baseline models the loop shape** (one action per turn,
  (w·h)/750 image tokens per turn), not Anthropic's actual production harness,
  which adds prompt caching and history pruning.
- **Token unit:** chars/4 for every text strategy, identically, so ratios are
  apples-to-apples; image tokens use Anthropic's published formula.
- **Competitor figures** (browser-use's 41% batching savings, Stagehand v3's
  44%, Skyvern's replay cache) are cited from their own publications in
  [docs/competitive-research.md](docs/competitive-research.md), not reproduced
  here.

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
