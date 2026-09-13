// Plain-script test (no test runner) for the scene introspector. Spins up a
// tiny static server for fixtures/scene3d.html + node_modules/three, drives
// headless chromium, runs createSceneIntrospector().annotate(), asserts the
// three named crates project to plausible distinct on-screen coordinates,
// then clicks the canvas at the "red crate" projected coordinates and
// asserts #hit reflects the click — proving the projected coords are
// actually clickable, which is the whole point of this module.
//
// Run: node --experimental-strip-types src/canvas/gl.test.ts

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { createSceneIntrospector } from "./gl.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "fixtures");
const THREE_BUILD_DIR = join(__dirname, "..", "..", "node_modules", "three", "build");
const PORT = 4624;

let failures = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`ok: ${msg}`);
  }
}

function startServer(): Promise<{ close(): void }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      (async () => {
        if (pathname === "/" || pathname === "/scene3d") {
          const html = await readFile(join(FIXTURES_DIR, "scene3d.html"));
          res.writeHead(200, { "content-type": "text/html" });
          res.end(html);
          return;
        }
        if (pathname === "/three.module.js" || pathname === "/three.core.js") {
          const js = await readFile(join(THREE_BUILD_DIR, pathname.slice(1)));
          res.writeHead(200, { "content-type": "text/javascript" });
          res.end(js);
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      })().catch((err) => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`error: ${(err as Error).message}`);
      });
    });
    server.once("error", reject);
    server.listen(PORT, () => {
      server.removeListener("error", reject);
      resolve({ close: () => server.close() });
    });
  });
}

async function launchChromium(): Promise<{ browser: Browser; note: string }> {
  try {
    const browser = await chromium.launch();
    return { browser, note: "default launch args" };
  } catch (err) {
    console.log(`default launch failed (${(err as Error).message}), retrying with --use-gl=angle`);
  }
  try {
    const browser = await chromium.launch({ args: ["--use-gl=angle"] });
    return { browser, note: "--use-gl=angle" };
  } catch (err) {
    console.log(`--use-gl=angle failed (${(err as Error).message}), retrying with --enable-unsafe-swiftshader`);
  }
  const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
  return { browser, note: "--enable-unsafe-swiftshader" };
}

async function main(): Promise<void> {
  const server = await startServer();
  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    const launched = await launchChromium();
    browser = launched.browser;
    console.log(`chromium launched (${launched.note})`);

    page = await browser.newPage();
    page.on("pageerror", (err) => console.error("page error:", err.message));

    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector("#hit");
    await page.waitForFunction(() => (window as any).__scene && (window as any).__camera);

    const introspector = createSceneIntrospector(page);
    const result = await introspector.annotate();

    console.log("--- annotate() output ---");
    console.log(result.text);
    console.log("--- end output ---");
    console.log(`approxTokens=${result.approxTokens} count=${result.count}`);

    assert(result.count === 3, `count is 3 (got ${result.count})`);

    const coordRe = /"([^"]+)"\s+\w+\s+#?[0-9a-fA-F]*\s*@\s*\((\d+),(\d+)\)\s+(on-screen|off-screen[^\n]*)/g;
    const found = new Map<string, { x: number; y: number }>();
    let m: RegExpExecArray | null;
    while ((m = coordRe.exec(result.text))) {
      found.set(m[1], { x: Number(m[2]), y: Number(m[3]) });
    }

    for (const name of ["red crate", "blue crate", "green crate"]) {
      assert(found.has(name), `"${name}" appears in output`);
    }

    for (const [name, pos] of found) {
      const plausible = pos.x >= 0 && pos.x <= 640 && pos.y >= 0 && pos.y <= 420;
      assert(plausible, `"${name}" projected coords (${pos.x},${pos.y}) within 640x420 canvas`);
    }

    const positions = Array.from(found.values()).map((p) => `${p.x},${p.y}`);
    const distinct = new Set(positions);
    assert(distinct.size === positions.length, `all ${positions.length} projected positions are distinct`);

    // Click-verification: click at the projected "red crate" coordinates and
    // confirm the raycast actually hits the red crate mesh there.
    const redCrate = found.get("red crate");
    assert(!!redCrate, "red crate has a projected position to click");

    if (redCrate) {
      const canvas = await page.$("#stage");
      assert(!!canvas, "canvas #stage found on page");
      if (canvas) {
        const box = await canvas.boundingBox();
        assert(!!box, "canvas has a bounding box");
        if (box) {
          await page.mouse.click(box.x + redCrate.x, box.y + redCrate.y);
          const hitText = await page.textContent("#hit");
          assert(hitText === "red crate", `clicking projected red crate coords sets #hit to "red crate" (got "${hitText}")`);
        }
      }
    }
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
    server.close();
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log("\nall assertions passed");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
