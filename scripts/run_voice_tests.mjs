#!/usr/bin/env node
/**
 * Speak each voice test to the PUBLISHED agent and record what it says back.
 *
 * Each (test, trial) gets its own Chrome whose fake microphone plays a WAV built
 * with macOS `say` (voice Daniel): lead silence, utterance, long gap, next
 * utterance, tail silence. The runner clicks "Speak" and logs the voice
 * data-channel events (live captions of both sides) with timestamps, then splits
 * them into turns and measures how fast and how long the agent speaks.
 *
 * Requires macOS `say` and ffmpeg.
 * Usage:
 *   node scripts/run_voice_tests.mjs --url https://1zw06csmzbmj.run.agentplace.io/ \
 *     --version v3 --trials 2 --out results/voice/v3/transcripts.jsonl [--only V01,V02] [--concurrency 3]
 *
 * Output: JSONL, one line per (test, trial), readable by scripts/judge.py --tests tests/voice-set.json.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VOICE = "Daniel";
const LEAD_S = 12;        // lets the spoken greeting finish before the parent talks
const GAP_S = 40;         // room for a full answer before the next utterance
const TAIL_S = 40;
const SETTLE_MS = 8_000;  // extra wait after the audio file ends
const USER_GAP_MS = 3_000;    // caption gaps longer than this split parent utterances
const SEGMENT_GAP_MS = 1_200; // caption gaps longer than this split agent segments
const FILLER = /\b(let me (check|look|see|find)|one moment|just a (sec|second|moment)|give me a (sec|second|moment)|hang on)\b/i;
const ATTEMPTS = 2;

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

/** Build the fake-microphone WAV for a test; returns [path, durationSeconds]. */
function synthesise(dir, turns) {
  const parts = [];
  turns.forEach((text, i) => {
    const aiff = join(dir, `u${i}.aiff`);
    execFileSync("say", ["-v", VOICE, "-o", aiff, text]);
    parts.push(aiff);
  });
  const inputs = [];
  const labels = [];
  const silence = (seconds) => {
    inputs.push("-f", "lavfi", "-t", String(seconds), "-i", "anullsrc=r=48000:cl=mono");
    labels.push(`[${labels.length}:a]`);
  };
  silence(LEAD_S);
  parts.forEach((aiff, i) => {
    inputs.push("-i", aiff);
    labels.push(`[${labels.length}:a]`);
    silence(i < parts.length - 1 ? GAP_S : TAIL_S);
  });
  const wav = join(dir, "mic.wav");
  const filter = labels.map((l, i) => `${l}aresample=48000,aformat=channel_layouts=mono[s${i}]`).join(";")
    + ";" + labels.map((_, i) => `[s${i}]`).join("") + `concat=n=${labels.length}:v=0:a=1[out]`;
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[out]", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
  const duration = Number(execFileSync("ffprobe", ["-loglevel", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav]).toString());
  return [wav, duration];
}

/** Group caption deltas whose gaps are shorter than gapMs. */
function cluster(events, gapMs) {
  const groups = [];
  for (const e of events) {
    const last = groups.at(-1);
    if (last && e.t - last.end <= gapMs) {
      last.end = e.t;
      last.text += e.text;
    } else {
      groups.push({ start: e.t, end: e.t, text: e.text });
    }
  }
  return groups.map((g) => ({ ...g, text: g.text.replace(/\s+/g, " ").trim() }));
}

const words = (s) => (s.match(/[\p{L}\p{N}'’£%-]+/gu) ?? []).length;

/** Split the logged captions into the greeting and one agent turn per parent utterance. */
function toTurns(events, scripted) {
  const heard = cluster(events.filter((e) => e.speaker === "user"), USER_GAP_MS);
  if (heard.length !== scripted.length) {
    throw new Error(`heard ${heard.length} parent utterances, expected ${scripted.length}: ${JSON.stringify(heard.map((h) => h.text))}`);
  }
  const spoken = events.filter((e) => e.speaker === "agent");
  const greeting = cluster(spoken.filter((e) => e.t < heard[0].start), SEGMENT_GAP_MS).map((s) => s.text).join(" ");
  const turns = heard.map((u, i) => {
    const until = heard[i + 1]?.start ?? Infinity;
    const segments = cluster(spoken.filter((e) => e.t > u.start && e.t < until), SEGMENT_GAP_MS);
    if (!segments.length) throw new Error(`no spoken reply to: ${scripted[i]}`);
    const filler = segments.length > 1 && FILLER.test(segments[0].text) && words(segments[0].text) <= 12;
    const answer = filler ? segments.slice(1) : segments;
    return {
      user: scripted[i],
      heard: u.text,
      agent: segments.map((s) => s.text).join(" "),
      filler: filler ? segments[0].text : null,
      first_word_ms: segments[0].start - u.end,
      answer_start_ms: answer[0].start - u.end,
      speaking_ms: answer.at(-1).end - answer[0].start,
      answer_words: words(answer.map((s) => s.text).join(" ")),
    };
  });
  return { greeting, turns };
}

/** Injected into the page: log voice captions with timestamps. */
function instrument() {
  window.__vlog = [];
  const speakers = {
    "session.input_transcript.delta": "user",
    "conversation.item.input_audio_transcription.delta": "user",
    "session.output_transcript.delta": "agent",
    "response.output_audio_transcript.delta": "agent",
  };
  const log = (raw) => {
    if (typeof raw !== "string") return;
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (typeof d.delta !== "string") return;
    const speaker = d.type === "voice.transcript" ? (d.speaker === "user" ? "user" : "agent") : speakers[d.type];
    if (speaker) window.__vlog.push({ t: Math.round(performance.now()), speaker, text: d.delta });
  };
  const WS = window.WebSocket;
  window.WebSocket = class extends WS {
    constructor(url, protocols) {
      super(url, protocols);
      if (String(url).includes("/voice")) this.addEventListener("message", (ev) => log(ev.data));
    }
  };
  const PC = window.RTCPeerConnection;
  if (PC) {
    window.RTCPeerConnection = class extends PC {
      constructor(...a) {
        super(...a);
        this.addEventListener("datachannel", (ev) => ev.channel.addEventListener("message", (m) => log(m.data)));
      }
      createDataChannel(...a) {
        const channel = super.createDataChannel(...a);
        channel.addEventListener("message", (m) => log(m.data));
        return channel;
      }
    };
  }
}

async function runConversation(test, trial) {
  const dir = mkdtempSync(join(tmpdir(), "voice-"));
  const sessionId = `voice-${args.version}-${test.id}-t${trial}-${randomUUID().slice(0, 8)}`;
  const url = new URL(args.url);
  url.searchParams.set("agent_session_id", sessionId);
  try {
    const [wav, duration] = synthesise(dir, test.turns);
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${wav}%noloop`, "--autoplay-policy=no-user-gesture-required"],
    });
    try {
      const context = await browser.newContext({ permissions: ["microphone"] });
      await context.addInitScript(instrument);
      const page = await context.newPage();
      await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => {
        const ms = window.container?.messagesStore;
        return ms && !ms.userRequestPending && ms.contents.some((c) => c.role !== "user");
      }, null, { timeout: 60_000 });
      await page.getByRole("button", { name: /speak/i }).first().click();
      await page.waitForTimeout(duration * 1000 + SETTLE_MS);
      const events = await page.evaluate(() => window.__vlog);
      const { greeting, turns } = toTurns(events, test.turns);
      return { version: args.version, test_id: test.id, trial, session_id: sessionId, greeting, turns };
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const spec = JSON.parse(readFileSync(join(ROOT, "tests", "voice-set.json"), "utf8"));
  const only = args.only ? new Set(args.only.split(",")) : null;
  const tests = spec.tests.filter((t) => !only || only.has(t.id));
  if (only && tests.length !== only.size) throw new Error(`unknown test ids in --only: ${args.only}`);

  const jobs = [];
  for (let trial = 1; trial <= Number(args.trials); trial++) {
    for (const test of tests) jobs.push({ test, trial });
  }
  const results = [];
  const failures = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const { test, trial } = jobs[next++];
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
          results.push(await runConversation(test, trial));
          console.log(`ok   ${test.id} trial ${trial}`);
          break;
        } catch (err) {
          console.error(`fail ${test.id} trial ${trial} attempt ${attempt}: ${err.message.split("\n")[0]}`);
          if (attempt === ATTEMPTS) failures.push(`${test.id}#${trial}`);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));

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
