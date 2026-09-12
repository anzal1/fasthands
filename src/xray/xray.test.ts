// Plain smoke script (no test framework) for the xray capability layer.
// Launches real headless chromium via playwright, stamps data-fh-ref
// attributes by hand (the observe engine isn't in play here), and checks
// annotate()/preflight() against the browser's own validation engine.
//
// Run with:
//   export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"
//   cd /Users/anzalhussainabidi/personal/fasthands
//   node --experimental-strip-types src/xray/xray.test.ts
//
// Exits 0 on all pass, 1 on any failure.

import { chromium } from "playwright";
import { createXray } from "./xray.ts";

let failures = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok:   ${message}`);
  }
}

const FORM_HTML = `<!doctype html>
<html>
<body>
<form id="signup">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required data-fh-ref="e1" />

  <label for="password">Password</label>
  <input id="password" name="password" type="password" pattern="(?=.*\\d).{8,}" data-fh-ref="e2" />

  <label for="username">Username</label>
  <input id="username" name="username" type="text" pattern="[a-z0-9_]{5,15}" minlength="5" data-fh-ref="e3" />

  <label for="birthdate">Birthdate</label>
  <input id="birthdate" name="birthdate" type="date" min="1900-01-01" max="2020-01-01" data-fh-ref="e4" />

  <label for="terms">I agree to the terms</label>
  <input id="terms" name="terms" type="checkbox" required data-fh-ref="e5" />

  <button type="submit" data-fh-ref="e6">Sign up</button>
  <button type="reset" data-fh-ref="e7">Clear</button>
</form>

<a href="/pricing" data-fh-ref="e8">See pricing</a>

<button role="switch" aria-checked="false" data-fh-ref="e9">Dark mode</button>
</body>
</html>`;

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(FORM_HTML);

  const xray = createXray(page);
  const allRefs = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"];

  // ---------- 1. initial state: empty form ----------

  const initial = await xray.annotate(allRefs);
  console.log("\n--- initial annotate() ---\n" + initial.text + "\n");

  const passwordLine = initial.text.split("\n").find((l) => l.startsWith("e2 "));
  assert(
    passwordLine !== undefined && passwordLine.includes("(hidden rule)"),
    "annotate: password's pattern rule (no title/hint) is marked (hidden rule)",
  );
  assert(
    passwordLine !== undefined && passwordLine.includes("8+ chars incl. a digit"),
    "annotate: password's pattern is humanized to '8+ chars incl. a digit'",
  );

  const submitLine = initial.text.split("\n").find((l) => l.startsWith("e6 "));
  assert(
    submitLine !== undefined && /BLOCKED: \d+ invalid/.test(submitLine),
    "annotate: submit button reports BLOCKED with an invalid count on an empty form",
  );

  const linkLine = initial.text.split("\n").find((l) => l.startsWith("e8 "));
  assert(
    linkLine !== undefined && linkLine.includes("→ navigates to /pricing"),
    "annotate: link reports '→ navigates to /pricing'",
  );

  assert(initial.approxTokens === Math.ceil(initial.text.length / 4), "annotate: approxTokens matches ceil(len/4)");
  assert(initial.count > 0, "annotate: count reflects number of emitted lines");

  // ---------- 2. fill valid values ----------

  await page.fill('[data-fh-ref="e1"]', "person@example.com");
  await page.fill('[data-fh-ref="e2"]', "abcdefg1");
  await page.fill('[data-fh-ref="e3"]', "valid_user");
  await page.fill('[data-fh-ref="e4"]', "2000-01-01");
  await page.check('[data-fh-ref="e5"]');

  const afterFill = await xray.annotate(allRefs);
  const submitLineAfterFill = afterFill.text.split("\n").find((l) => l.startsWith("e6 "));
  assert(
    submitLineAfterFill !== undefined && submitLineAfterFill.includes("form currently valid"),
    "annotate: submit button reports 'form currently valid' once every field is filled correctly",
  );

  const preflightValid = await xray.preflight("e6");
  assert(preflightValid.length === 0, "preflight: returns [] when the form is valid");

  // ---------- 3. break the username field ----------

  await page.fill('[data-fh-ref="e3"]', "abc");
  const preflightInvalid = await xray.preflight("e6");
  const usernameViolation = preflightInvalid.find((v) => v.ref === "e3");
  assert(
    usernameViolation !== undefined,
    "preflight: reports a violation pointing at e3 after breaking the username field",
  );
  assert(
    usernameViolation !== undefined && (usernameViolation.rule === "patternMismatch" || usernameViolation.rule === "tooShort"),
    `preflight: violation rule is patternMismatch or tooShort (got ${usernameViolation?.rule})`,
  );
  assert(
    usernameViolation !== undefined && usernameViolation.message.length > 0,
    "preflight: violation carries a non-empty native validationMessage",
  );

  await browser.close();

  if (failures > 0) {
    console.error(`\n${failures} xray check(s) failed.`);
    process.exit(1);
  } else {
    console.log("\nall xray checks passed.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("xray test threw:", err);
  process.exit(1);
});
