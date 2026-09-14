# X thread draft v2: the experiment log (for TweetTweet review, human clicks Post)

Frame: recursive benchmarking. build, measure, attack the result, fix
mechanically, measure again. failures included on purpose.

1/ (media: demos/out-davinci.png or demos/out-comic.gif)
ran a one day experiment: build a computer-use harness, benchmark it, attack
the result, fix what breaks, benchmark again. recursively, about 40 bench runs
deep. this thread is everything we tried, including the stuff that failed.
all of it is open source now.

2/
round 0, hypothesis: the loop is the bottleneck, not the model. built 4 loop
styles (screenshot, astra style full tree, diffs, diffs + html contract) and
6 DOM-verified tasks, driven by a deterministic policy so anyone can
reproduce keyless.

first result: 92.7% fewer tokens than a screenshot loop. looked too clean.

3/
so we attacked our own number first. found a bug in our own test policy (it
flip flopped under 1-action-per-turn truncation), fixed it, re-ran everything
5 times per cell. 120 runs, 120 passes, near zero variance. final: 91.3%.

lesson: the first benchmark number is always a little wrong.

4/
then adversarial. built a page that swaps "Archive message 3" into "Delete
all messages" 800ms after the agent looks, the way real lists reorder.

blind action batching: clicked delete all, 20 trials of 20.
our hash guard: 0 catastrophes, 20/20 recovered.

5/
scale test: a full a11y tree grows from 2,197 to 92,732 tokens as pages grow.
our diff stays at 38. we also found and printed the caveat ourselves: under a
tight token budget the in-loop win is ~27%, not the headline. it's in the
readme next to the wins.

6/
then we made it draw, as a stress test for the action layer. mona lisa
attempt 1 got smeared: in a headed browser your physical mouse shares the
pointer with the agent and splices into strokes mid flight. real finding.
attempt 2, headless: 4,601 strokes, verified by pixel diff.

starry night v1 came out thin (39% coverage). diagnosis: no underpainting,
watercolor alphas, missing pigments. v2: 78%.

7/ (media: demos/out-starrynight-v2.png + demos/out-painting.png)
color was the honest version of the problem: no context hacking, the agent
clicks the app's own palette buttons between layers. 52 layers, 55 UI clicks,
3,026 strokes.

8/
then live models. plugged a 4B security model from my ollama (not even an
agent model). run 1 rolled dice on every batch: ollama defaults to
temperature 0.8. run 2, deterministic, exposed the real pathologies in the
transcripts:

emitted valid JSON then hallucinated a fake transcript after it. clicked
"Order #4670" and certified it as #4711. never scrolled, because nothing told
it more page existed.

9/
every failure became a mechanism, not a prompt plea:
depth-scan parser that takes the first complete JSON array.
the scrollbar in words, in every observation: "viewing 0-720 of 1880px, 62% below".
a done-review gate that bounces the first done against a fresh observation.

re-benchmarked after each. the signup trap with hidden validation rules now
fails blind and passes with the html-contract reader. same model, same
prompt, reproducibly.

10/
what didn't work, kept in the readme anyway:
council voting (3 proposals, pick best) helps exploration tasks and hurts
precision tasks. opt-in now.
an 8B reasoning model couldn't finish one benchmark cell in 50 minutes. fast
and small beats slow and clever inside a loop.
deep-scroll exploration still fails at 4B. the harness cuts a small model's
costs and catches its lies. it does not plan for it.

11/
where it landed: 91.3% fewer tokens than screenshot loops, 61.2% fewer than
astra style, 0/20 drift catastrophes, a 4B doing real web tasks at 46% lower
live cost, and a paint gallery made of guarded mouse events.

every number re-derives from one command. MIT.
https://github.com/anzal1/fasthands

---
single tweet alternative:

a browser agent painted the mona lisa: 4,601 real mouse strokes, colors
picked from the app's own palette, no vision model anywhere. the harness
behind it cuts computer-use tokens 91% vs screenshot loops, survives DOM
drift 20/20 where blind batching fails 20/20, and carries a 4B local model
through real web tasks. built by recursive benchmarking: measure, break, fix,
measure again. open source, every number reproducible keyless:
https://github.com/anzal1/fasthands

full report artifact (share from the page first):
https://claude.ai/code/artifact/1ab0a89d-2b5e-4c6a-b975-6a0e7a37083a
