# fasthands — architecture spec (v0.1)

Open-source, model-agnostic computer use. The bet: the loop, not the model, is
where most computer-use latency and token burn lives. We beat the two dominant
loop designs on tokens/task, turns/task, and wall clock:

- **Anthropic-style screenshot loop**: screenshot every turn (~1365 image
  tokens at 1280x800), one action per turn.
- **Astra-style full-tree loop** (OpenAI GPT-6): a11y tree every turn, code
  actions, but a *fresh full tree each turn* and known failure modes of stale
  trees and state drift between observe and act.

## The three edges

1. **Diff observations** (`src/observe/`). Full compact interactive tree on
   turn 1, then structural diffs only. Stable refs via role+name+position
   hashing. Viewport-first truncation under a token budget.
2. **Guarded action batching** (`src/act/`). Model emits a JSON script of
   actions per turn. Executor re-resolves every ref immediately before acting
   and aborts on hash mismatch (drift) instead of firing blind. Batch depth
   turns 8 model round-trips into 2-3.
3. **Any model** (`src/providers/`). Plain-fetch adapters: Anthropic Messages,
   OpenAI Responses, OpenAI-compatible (Ollama/Groq/Together/vLLM). Same loop,
   any brain — including open-weight models.

## Module ownership

| Dir | Owner | Contents |
|---|---|---|
| `src/types.ts` | tech lead | frozen contract — do not edit |
| `src/observe/` | core eng | `engine.ts` ObservationEngine impl (snapshot, hash, diff, serialize, resolve) |
| `src/act/` + `src/agent/` + `src/providers/` | systems eng | executor, loop, adapters, oracle policy plumbing |
| `src/bench/` | bench eng | `run.ts`, `fixtures-server.ts` wiring, metrics, 3 loop styles |
| `fixtures/` | scaffolder | 5 static-ish HTML fixture pages per contract at bottom of types.ts |

## Benchmark design (keyless-first)

`npm run bench` runs every task under all 3 loop styles with the **oracle
policy** (deterministic, replays a competent model's decisions per loop style)
so results are reproducible with zero API keys. Screenshot-style image tokens
are simulated at (1280*800)/750 ≈ 1366/turn. Live mode (`--provider anthropic
--model ...`) uses real models when keys exist.

Fairness rules: the oracle gives every style the same competence — the
screenshot baseline takes the known-minimum single actions per turn; fulltree
gets batching too (Astra batches) but full-tree observations and no drift
guards; fasthands gets batching + diffs + guards. Tasks and success verifiers
are identical across styles.

## v0.2 — the capability layer (xray)

Speed is table stakes; xray makes the model *better*, not just cheaper.
Hidden-in-plain-sight bet: HTML is a self-describing API. Browsers have
shipped a declarative form contract and a native validation engine
(`checkValidity`, `ValidityState`) since HTML5, and no agent framework reads
them — they all learn form errors by submitting and observing, one model
round-trip per mistake.

| Piece | What it does | Why it boosts capability |
|---|---|---|
| Contract extraction (`src/xray/contract.ts`) | Annotate inputs with required/pattern/type/min/max/autocomplete rules in the observation | model fills correctly on the first attempt |
| Consequence prediction (`src/xray/consequence.ts`) | Annotate actionables with predicted outcomes: "→ submits form (2 required empty)", "→ navigates /pricing", "→ toggles e14" | harness pre-computes outcomes; weak models act strong |
| Validity preflight (executor hook) | After fills / before submit-clicks, run the browser's own validation; return structured violations in BatchResult | error recovery costs 0 extra turns |
| Council mode (`src/agent/council.ts`) | After 2 stalled turns, sample 3 proposals in parallel, score by ref-resolvability + guard satisfaction, take the winner | lifts small open-weight models |
| Reflex cache (`src/agent/reflex.ts`) | Persist successful action traces keyed by (origin, task hash); replay with drift guards, fall back to the model on abort | repeat tasks approach 0 tokens |

Benchmark addition: fixture `/signup` is a validation trap (email pattern,
password rules, date format, terms checkbox gated). Styles without xray burn
a failed-submit recovery turn; `fasthands+xray` completes without one.

## Runtime

Node 24 (`--experimental-strip-types`, no build step), Playwright chromium,
fixtures on http://localhost:4620. No SDKs, no frameworks in fixtures.
