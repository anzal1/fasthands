# Competitive research (2026-09, scouted from public sources)

Snapshot of how existing computer-use frameworks observe/act, and what fasthands
takes from each. Full sources at bottom.

| Framework | Observes | Acts | Speed tricks | Weak spot |
|---|---|---|---|---|
| Stagehand v3 | CDP-native hybrid (a11y+DOM+screenshot) | granular act()/locators, batch | element-discovery caching, self-healing selectors, direct CDP (44% faster than v2) | explicit coding, less autonomy |
| browser-use | structured DOM/interactive list | autonomous loop, bulk actions | batching: 74% fewer calls, 41% fewer tokens, 89.1% WebVoyager | high token burn on complex tasks |
| Skyvern | vision-first screenshots | single sequential actions | action-sequence replay cache (10-100x on reruns) | per-screenshot reasoning overhead |
| Anthropic ref loop | screenshots (1000-1800 tok/frame) | batched tool calls w/ failure isolation | prompt caching, coordinate downscaling, periodic screenshot pruning | inherent image-token bloat, 2-5s/action |
| Magnitude | vision-first, local models | mouse/kb via vision | local inference (no cloud RTT) | few published numbers |

Validated bets: a11y/DOM observation, batching, drift-safe execution.
Unclaimed territory fasthands takes: **observation diffing** — no framework
sends deltas; all resend full state every turn.

Roadmap candidates from this research:
- v0.2: action-sequence replay cache (Skyvern-style, 10-100x on repeat tasks)
- v0.2: prompt-cache breakpoints in providers (static system prompt + stable tree prefix)
- v0.3: CDP-direct driver behind the same ObservationEngine interface
- v0.3: optional screenshot-on-demand tool (zoom-then-inspect) for visual-only widgets

Sources: browserbase.com/blog/stagehand-v3, github.com/browser-use/browser-use,
github.com/Skyvern-AI/skyvern, platform.claude.com computer-use docs,
scrapfly.io stagehand-vs-browser-use, leaderboard.steel.dev/webvoyager.
