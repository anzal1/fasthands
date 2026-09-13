// Dumb static file server for the fixtures/ HTML pages. No frameworks, no
// magic: just maps a handful of routes to files on disk so Playwright can
// navigate to http://localhost:4620/form, /search, /checkout, /settings,
// /list during the benchmark run.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "fixtures");

const ROUTES: Record<string, string> = {
  "/form": "form.html",
  "/search": "search.html",
  "/checkout": "checkout.html",
  "/settings": "settings.html",
  "/list": "list.html",
  "/signup": "signup.html",
  "/noise": "noise.html",
  "/drift": "drift.html",
  "/atelier": "atelier.html",
  "/scene3d": "scene3d.html",
  "/whiteboard": "whiteboard.html",
  "/chart": "chart.html",
};

const THREE_BUILD_DIR = join(__dirname, "..", "..", "node_modules", "three", "build");
// three.module.js (r150+) is a thin wrapper that imports './three.core.js';
// both must be servable from the same origin for the ESM import to resolve
// in-browser with no bundler.
const THREE_FILES = new Set(["/three.module.js", "/three.core.js"]);

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  if (THREE_FILES.has(pathname)) {
    try {
      const js = await readFile(join(THREE_BUILD_DIR, pathname.slice(1)));
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(js);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`error loading ${pathname}: ${(err as Error).message}`);
    }
    return;
  }

  const file = ROUTES[pathname];

  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(`no fixture route for ${pathname}`);
    return;
  }

  try {
    const html = await readFile(join(FIXTURES_DIR, file));
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`error loading fixture "${file}": ${(err as Error).message}`);
  }
}

export function startFixturesServer(port = 4620): Promise<{ close(): void }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`unhandled error: ${(err as Error).message}`);
      });
    });

    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve({
        close() {
          server.close();
        },
      });
    });
  });
}

// Runnable directly: `node --experimental-strip-types src/bench/fixtures-server.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = 4620;
  startFixturesServer(port)
    .then(() => {
      console.log(`fixtures server listening on http://localhost:${port}`);
      console.log(`routes: ${Object.keys(ROUTES).join(", ")}`);
    })
    .catch((err) => {
      console.error("failed to start fixtures server:", err);
      process.exit(1);
    });
}
