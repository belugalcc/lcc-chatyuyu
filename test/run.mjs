/**
 * Test runner for lcc-chat.
 *
 * Boots a local Worker with `wrangler dev`, serves /client as static files and
 * runs the suites:
 *
 *   node test/run.mjs            -> API/WebSocket smoke test
 *   node test/run.mjs --browser  -> full browser test (needs playwright-core
 *                                   and a downloaded Chromium)
 *
 * Both servers are torn down when the script exits.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const clientRoot = path.resolve(serverRoot, "../client");

const WORKER_PORT = 8787;
const CLIENT_PORT = 5173;
const withBrowser = process.argv.includes("--browser");

const children = [];

function start(name, command, args, options = {}) {
  const child = spawn(command, args, { cwd: serverRoot, stdio: ["ignore", "pipe", "pipe"], ...options });
  const prefix = `[${name}]`;
  child.stdout.on("data", (chunk) => process.stdout.write(`${prefix} ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`${prefix} ${chunk}`));
  children.push(child);
  return child;
}

function stopAll() {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

process.on("exit", stopAll);
process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  console.log("lcc-chat test runner\n");
  start("worker", "pnpm", ["exec", "wrangler", "dev", "--port", String(WORKER_PORT), "--ip", "127.0.0.1"], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  await waitForHttp(`http://127.0.0.1:${WORKER_PORT}/health`);

  if (withBrowser) {
    start("client", "python3", ["-m", "http.server", String(CLIENT_PORT), "--bind", "127.0.0.1", "--directory", clientRoot]);
    await waitForHttp(`http://127.0.0.1:${CLIENT_PORT}/index.html`);
  }

  const suites = withBrowser ? ["browser.cjs", "smoke.mjs"] : ["smoke.mjs"];

  let failures = 0;
  for (const script of suites) {
    console.log(`\n── test/${script} ──`);
    const exitCode = await run(script);
    if (exitCode !== 0) failures += 1;
  }

  stopAll();
  console.log(failures === 0 ? "\nAll suites passed." : `\n${failures} suite(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

async function run(script, args = []) {
  const child = spawn(process.execPath, [path.join(here, script), ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      LCC_BASE_URL: `http://127.0.0.1:${WORKER_PORT}`,
      // Tests normally point the client at the local Worker; export CLIENT_URL
      // to exercise a different setup (e.g. a forwarded port).
      CLIENT_URL: process.env.CLIENT_URL ?? `http://127.0.0.1:${CLIENT_PORT}/?worker=http://127.0.0.1:${WORKER_PORT}`,
    },
  });
  const [code] = await once(child, "exit");
  return code ?? 1;
}

main().catch((error) => {
  console.error(error);
  stopAll();
  process.exit(1);
});