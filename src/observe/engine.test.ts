// fasthands — src/observe/engine.test.ts
//
// Plain script (no test framework). Launches chromium headless, exercises
// createObservationEngine() against two synthetic data: URL pages:
//   1. a form + button page — checks full observe, resolve+click, resolve+
//      fill, then a second observe that comes back as a diff mentioning the
//      changed nodes.
//   2. a page with 200 offscreen links — checks budget truncation.
//
// Exit code 0 on pass, 1 (with a message) on fail.

import { chromium } from "playwright";
import { createObservationEngine } from "./engine.ts";

function fail(msg: string): never {
  console.error("FAIL:", msg);
  process.exit(1);
}

function findByName(node: any, name: string): any | null {
  if (node.name === name) return node;
  for (const c of node.children || []) {
    const hit = findByName(c, name);
    if (hit) return hit;
  }
  return null;
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  // ---- Part 1: form + button, full -> resolve/click/fill -> diff ----
  {
    const page = await browser.newPage();
    const html = `<!doctype html><html><head><title>Test Form</title></head><body>
      <h1>Sign up</h1>
      <form>
        <label for="email">Email</label>
        <input id="email" type="text" value="" />
        <button id="go" onclick="document.getElementById('go').disabled=true;">Submit</button>
      </form>
    </body></html>`;
    await page.setContent(html);

    const engine = createObservationEngine(page);

    const obs1 = await engine.observe();
    if (obs1.kind !== "full") fail(`expected first observe() to be "full", got "${obs1.kind}"`);
    if (!obs1.text.includes("Submit")) fail(`full observation text missing "Submit" button:\n${obs1.text}`);

    const btnNode = findByName(obs1.snapshot.tree, "Submit");
    if (!btnNode) fail("could not find button node named 'Submit' in snapshot tree");
    const emailNode = findByName(obs1.snapshot.tree, "Email");
    if (!emailNode) fail("could not find textbox node named 'Email' in snapshot tree");

    const resolvedBtn = await engine.resolve(btnNode.ref);
    if (!resolvedBtn) fail(`resolve(${btnNode.ref}) returned null`);
    if (!resolvedBtn.stillMatches) fail(`resolve(${btnNode.ref}) stillMatches should be true right after observe()`);

    await (resolvedBtn.handle as any).click();

    const resolvedEmail = await engine.resolve(emailNode.ref);
    if (!resolvedEmail) fail(`resolve(${emailNode.ref}) returned null`);
    await (resolvedEmail.handle as any).fill("hello@example.com");

    const obs2 = await engine.observe();
    if (obs2.kind !== "diff") fail(`expected second observe() to be "diff", got "${obs2.kind}"\n${obs2.text}`);
    const mentionsButtonChange = obs2.text.includes("disabled");
    const mentionsEmailChange = obs2.text.includes("hello@example.com");
    if (!mentionsButtonChange) fail(`diff text does not mention the changed button:\n${obs2.text}`);
    if (!mentionsEmailChange) fail(`diff text does not mention the changed email value:\n${obs2.text}`);
    if (!obs2.text.includes("changed")) fail(`diff text missing a "~ changed:" section:\n${obs2.text}`);

    console.log("PASS: part 1 (full -> resolve/click/fill -> diff)");
    await page.close();
  }

  // ---- Part 2: budget truncation on 200 offscreen links ----
  {
    const page = await browser.newPage();
    const links = Array.from({ length: 200 }, (_, i) => `<div><a href="#">Link ${i}</a></div>`).join("\n");
    const html = `<!doctype html><html><head><title>Big List</title></head><body>
      <h1>Links</h1>
      ${links}
    </body></html>`;
    await page.setContent(html);

    const engine = createObservationEngine(page);
    const budget = 400;
    const obs = await engine.observe(budget);
    if (obs.kind !== "full") fail(`expected budget-page observe() to be "full", got "${obs.kind}"`);
    if (obs.approxTokens > budget) {
      fail(`budget truncation did not bring approxTokens (${obs.approxTokens}) under budget (${budget})`);
    }
    if (obs.text.includes("Link 199")) {
      fail(`expected far-offscreen links to be pruned from budgeted text, but "Link 199" is present`);
    }
    if (!obs.text.includes("Link 0")) {
      fail(`expected the first (in-viewport) link "Link 0" to survive budget truncation`);
    }

    console.log(`PASS: part 2 (budget truncation: ${obs.approxTokens} tokens <= ${budget})`);
    await page.close();
  }

  await browser.close();
  console.log("ALL TESTS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL: unexpected error");
  console.error(err);
  process.exit(1);
});
