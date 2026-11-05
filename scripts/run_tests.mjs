#!/usr/bin/env node
/**
 * Play every test conversation against the PUBLISHED agent and record transcripts.
 *
 * Each (test, trial) gets a fresh browser context and a fresh agent session
 * (?agent_session_id=...), then sends the scripted parent turns through the
 * page's own client (window.container.messagesStore.sendMessageForQuery) — the
 * same WebSocket path a real visitor's typed message takes.
 *
 * Usage:
 *   node scripts/run_tests.mjs --url https://1zw06csmzbmj.run.agentplace.io/ \
 *     --version v1 --trials 3 --out results/v1/transcripts.jsonl [--only T01,T02] [--concurrency 3]
 *
 * Output: JSONL, one line per (test, trial) — the input format of scripts/judge.py.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TURN_TIMEOUT_MS = 180_000;
const READY_TIMEOUT_MS = 60_000;
const ATTEMPTS = 2;
// Errors rendered to the parent in the chat (seen in the v1 baseline on T12).
const AGENT_ERROR_PATTERN = "could not be displayed";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    version: { type: "string" },
    out: { type: "string" },
    trials: { type: "string", default: "1" },
    only: { type: "string" },
    concurrency: { type: "string", default: "3" },
  },
});
for (const required of ["url", "version", "out"]) {
  if (!args[required]) throw new Error(`--${required} is required`);
}

/** Turn the agent's rendered components into one plain transcript string. */
function renderReply(items) {
  const text = [];
  const components = [];
  const sources = [];
  for (const item of items) {
    if (item.componentName === "Sources") {
      for (const s of item.props?.sources ?? []) sources.push(s.url);
      components.push("Sources");
      continue;
    }
    if (item.componentName) components.push(item.componentName);
    const body = item.fallbackMarkdown || item.fallbackText || (typeof item.content === "string" ? item.content : "");
    if (body) text.push(body.replace(/!\[([^\]]*)\]\([^)]*\)/g, "[image: $1]").trim());
  }
  return { agent: text.join("\n\n"), components, sources };
}

async function runConversation(browser, test, trial) {
  const sessionId = `eval-${args.version}-${test.id}-t${trial}-${randomUUID().slice(0, 8)}`;
  const url = new URL(args.url);
  url.searchParams.set("agent_session_id", sessionId);

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(TURN_TIMEOUT_MS);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    // Wait for the client to boot and the automatic welcome message to finish.
    await page.waitForFunction(
      () => {
        const ms = window.container?.messagesStore;
        return ms && !ms.userRequestPending && ms.contents.some((c) => c.role !== "user");
      },
      null,
      { timeout: READY_TIMEOUT_MS },
    );

    const turns = [];
    for (const message of test.turns) {
      const started = Date.now();
      const { items, firstContentMs } = await page.evaluate(async ({ instruction, agentErrorPattern }) => {
        const ms = window.container.messagesStore;
        const sentAt = performance.now();
        const { responseId, done } = await ms.sendMessageForQuery({ instruction });
        // Time until the parent first sees any reply text on screen.
        let firstContentMs = null;
        const visible = () => ms.contents.some((c) => c.responseId === responseId && c.role !== "user" && !c.hidden
          && (c.fallbackText || c.fallbackMarkdown || (typeof c.content === "string" && c.content)));
        const poll = setInterval(() => {
          if (firstContentMs === null && visible()) firstContentMs = Math.round(performance.now() - sentAt);
        }, 50);
        try {
          await done;
        } catch (err) {
          // An error the agent shows the parent is the agent's reply, not a harness failure.
          if (new RegExp(agentErrorPattern).test(err.message)) {
            return { items: [{ content: `[Agent error shown to the parent: "${err.message}"]` }], firstContentMs: null };
          }
          throw err;
        } finally {
          clearInterval(poll);
        }
        firstContentMs ??= Math.round(performance.now() - sentAt);
        const items = ms.contents
          .filter((c) => c.responseId === responseId && c.role !== "user" && !c.hidden)
          .map((c) => ({
            componentName: c.componentName,
            props: c.componentName === "Sources" ? c.props : undefined,
            fallbackMarkdown: c.fallbackMarkdown,
            fallbackText: c.fallbackText,
            content: typeof c.content === "string" ? c.content : undefined,
          }));
        return { items, firstContentMs };
      }, { instruction: message, agentErrorPattern: AGENT_ERROR_PATTERN });
      const reply = renderReply(items);
      if (!reply.agent) throw new Error(`empty reply to: ${message}`);
      turns.push({ user: message, ...reply, first_content_ms: firstContentMs, latency_ms: Date.now() - started });
    }
    return { version: args.version, test_id: test.id, trial, session_id: sessionId, turns };
  } finally {
    await context.close();
  }
}

async function main() {
  const spec = JSON.parse(readFileSync(join(ROOT, "tests", "test-set.json"), "utf8"));
  const only = args.only ? new Set(args.only.split(",")) : null;
  const tests = spec.tests.filter((t) => !only || only.has(t.id));
  if (only && tests.length !== only.size) throw new Error(`unknown test ids in --only: ${args.only}`);

  const jobs = [];
  for (let trial = 1; trial <= Number(args.trials); trial++) {
    for (const test of tests) jobs.push({ test, trial });
  }

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const results = [];
  const failures = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const { test, trial } = jobs[next++];
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
          results.push(await runConversation(browser, test, trial));
          console.log(`ok   ${test.id} trial ${trial}`);
          break;
        } catch (err) {
          console.error(`fail ${test.id} trial ${trial} attempt ${attempt}: ${err.message.split("\n")[0]}`);
          if (attempt === ATTEMPTS) failures.push(`${test.id}#${trial}`);
        }
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));
  } finally {
    await browser.close();
  }

  results.sort((a, b) => a.test_id.localeCompare(b.test_id) || a.trial - b.trial);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`wrote ${results.length}/${jobs.length} transcripts -> ${args.out}`);
  if (failures.length) {
    console.error(`FAILED conversations (rerun with --only): ${failures.join(", ")}`);
    process.exit(1);
  }
}

await main();
