# X thread draft (for TweetTweet review, human clicks Post)

1/
everyone benchmarks computer use by asking how smart the model is. wrong knob.
the loop is the bottleneck. I built fasthands, an open source harness that cuts
observation tokens 91% vs a screenshot loop and 61% vs an Astra style full-tree
loop, same tasks, same brain, any model.

2/
the trick was hiding in plain sight for 15 years. HTML ships machine readable
form rules (required, pattern, min/max) and a native validation engine,
checkValidity(). every agent framework ignores it and learns form errors by
failing a submit. one model round trip per mistake.

fasthands reads the contract first:
e2 · (hidden rule) 8+ chars incl. a digit
e6 · → submits form (BLOCKED: 2 invalid)

3/
the drift trap. a page swaps "Archive message 3" into "Delete all messages"
800ms after the agent observes, the way real lists reorder and ads inject.

unguarded batching: 20/20 trials clicked delete all.
fasthands hash guard: 0/20 catastrophes, 20/20 recovered.

this is the exact failure mode OpenAI's Astra writeup admits is open.

4/
scale. a full a11y tree grows from 2,197 to 92,732 tokens as the page grows
from 50 to 2,000 elements. a fasthands diff after a state change stays at 38.
flat. raw HTML dumps hit 141k. screenshots stay cheap but they are blind to
everything below the fold.

5/
receipts, because benchmark posts are usually vibes:
- 120 runs, 5 repetitions per cell, variance reported
- success judged by the DOM, not by the agent's claim
- reproducible with zero API keys, deterministic oracle policy
- limitations section included, xray costs tokens on pages without forms and
  the in-loop diff win under a tight budget is ~27%, not the headline number

full report: <artifact link>
repo: <github link once pushed>

6/
built with a team of subagents in one afternoon. cheap model did the grunt
work, the expensive ones wrote the engine. MIT licensed. works with Claude,
GPT, and any OpenAI compatible endpoint including local models on Ollama.
