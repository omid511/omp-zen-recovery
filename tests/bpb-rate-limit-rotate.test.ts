import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import install from "../extensions/bpb-rate-limit-rotate";

type Timer = { at: number; callback: () => void; repeat?: number };
type RotationResult = { code: number; stdout?: string; stderr?: string };
const envNames = [
  "BPB_ROTATE_STATE_FILE", "BPB_ROTATE_LOCK_FILE", "BPB_ROTATE_EVENT_LOG",
  "BPB_ROTATE_ON_HOURLY", "BPB_ROTATE_ON_RATE_LIMIT", "BPB_ROTATE_RECOVERY", "BPB_ROTATE_RECOVERY_DELAY_MS",
  "BPB_ROTATE_EGRESS_URL", "BPB_ROTATE_EGRESS_POLL_MS", "BPB_ROTATE_MIN_GAP_MS", "BPB_ROTATE_SETTLE_MS", "BPB_ROTATE_MAX_PER_HOUR",
  "BPB_ROTATE_TRANSPORT_RETRY", "BPB_ROTATE_TRANSPORT_DELAY_MS", "BPB_ROTATE_TRANSPORT_MAX", "BPB_ROTATE_TRANSPORT_WINDOW_MS",
];
let dir: string;
let now: number;
let ip: string;
let timers: Set<Timer>;
let savedEnv: Record<string, string | undefined>;
let originalNow: typeof Date.now;
let originalFetch: typeof fetch;
let probeFailure: boolean;
let probeHandler: ((signal?: AbortSignal | null) => Promise<Response>) | undefined;
const rateError = { role: "assistant", provider: "opencode-zen", stopReason: "error", errorStatus: 429, errorMessage: "429 Rate limit exceeded. retry-after-ms=21600000 (type=FreeUsageLimitError)" };

function schedule(callback: () => void, delay = 0, repeat?: number) {
  const timer = { at: now + delay, callback, repeat };
  timers.add(timer);
  return timer;
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function advance(ms: number) {
  const end = now + ms;
  await flush();
  while (true) {
    const next = [...timers].filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    now = next.at;
    if (next.repeat) next.at += next.repeat;
    else timers.delete(next);
    next.callback();
    await flush();
  }
  now = end;
  await flush();
}
function seed(overrides: Record<string, unknown> = {}) {
  fs.writeFileSync(process.env.BPB_ROTATE_STATE_FILE!, JSON.stringify({ lastRotateAt: 0, lastRotationSuccessAt: 0, rateHits: [], transportWindowStart: 0, transportAttempts: 0, quotaHoldUntil: {}, nextHourlyDue: 0, ...overrides }));
}
function session(options: { provider?: string; exec?: () => Promise<RotationResult>; branch?: unknown[] } = {}) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const sent: string[] = [];
  const notices: string[] = [];
  let idle = false;
  const ctx = {
    model: { provider: options.provider ?? "opencode-zen" },
    isIdle: () => idle,
    sessionManager: { getBranch: () => (options.branch ?? []).map(message => ({ type: "message", message })) },
    setTimeout: schedule,
    setInterval: (callback: () => void, ms: number) => schedule(callback, ms, ms),
    clearTimer: (timer: Timer) => timers.delete(timer),
    waitForIdle: async () => { throw new Error("Manual rotation must not wait for core retry"); },
    ui: { notify: (message: string) => notices.push(message), setStatus() {} },
  };
  install({
    on: (name: string, fn: (event: any, ctx: any) => unknown) => handlers.set(name, fn),
    registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => commands.set(name, command),
    sendUserMessage: (text: string) => sent.push(text),
    exec: options.exec ?? (async () => { throw new Error("Unexpected external rotation in recovery fixture"); }),
  });
  const emit = async (name: string, event: unknown = {}) => { await handlers.get(name)?.(event, ctx); await flush(); };
  const start = async () => { idle = false; await emit("agent_start"); await emit("before_agent_start", { prompt: "finish the original task" }); };
  const fail = async (message: Record<string, unknown> = rateError, willContinue = false) => { idle = true; await emit("agent_end", { messages: [message], willContinue }); };
  const command = async (name: string) => { await commands.get(name)!.handler("", ctx); await flush(); };
  return { emit, start, fail, command, sent, notices, setIdle: (value: boolean) => { idle = value; } };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bpb-recovery-test-"));
  now = 1_790_870_000_000;
  ip = "198.51.100.1";
  timers = new Set();
  probeFailure = false;
  probeHandler = undefined;
  savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const values: Record<string, string> = {
    BPB_ROTATE_STATE_FILE: path.join(dir, "state.json"), BPB_ROTATE_LOCK_FILE: path.join(dir, "lock"), BPB_ROTATE_EVENT_LOG: path.join(dir, "events.jsonl"),
    BPB_ROTATE_ON_HOURLY: "false", BPB_ROTATE_ON_RATE_LIMIT: "false", BPB_ROTATE_RECOVERY: "true", BPB_ROTATE_RECOVERY_DELAY_MS: "0",
    BPB_ROTATE_EGRESS_URL: "http://127.0.0.1/fixture-trace", BPB_ROTATE_EGRESS_POLL_MS: "100", BPB_ROTATE_MIN_GAP_MS: "0", BPB_ROTATE_SETTLE_MS: "75000", BPB_ROTATE_MAX_PER_HOUR: "15",
    BPB_ROTATE_TRANSPORT_RETRY: "true", BPB_ROTATE_TRANSPORT_DELAY_MS: "15000", BPB_ROTATE_TRANSPORT_MAX: "3", BPB_ROTATE_TRANSPORT_WINDOW_MS: "600000",
  };
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  originalNow = Date.now;
  Date.now = () => now;
  originalFetch = globalThis.fetch;
  const fixtureFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (probeHandler) return probeHandler(init?.signal);
    if (probeFailure) throw new Error("Trace unavailable");
    return new Response(`h=opencode.ai\nip=${ip}\n`);
  };
  globalThis.fetch = fixtureFetch as typeof fetch;
  seed();
});
afterEach(() => {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  for (const name of envNames) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("external TUN cutover revives a failed original chat once without a rotation marker", async () => {
  const s = session();
  await s.start(); await s.fail(); await advance(300);
  expect(s.sent).toEqual([]);
  ip = "198.51.100.2";
  await advance(100);
  expect(s.sent).toEqual(["continue"]);
  await advance(1000);
  expect(s.sent).toEqual(["continue"]);
});

test("parent and three subagents recover independently on the same egress cutover", async () => {
  const sessions = Array.from({ length: 4 }, () => session());
  for (const s of sessions) { await s.start(); await s.fail(); }
  ip = "198.51.100.2";
  await advance(100);
  expect(sessions.map(s => s.sent)).toEqual([["continue"], ["continue"], ["continue"], ["continue"]]);
});

test("panel success with unchanged provider egress does not prematurely retry", async () => {
  const s = session({ exec: async () => ({ code: 0 }) });
  await s.start(); await s.fail(); await s.command("bpb-rotate"); await advance(100);
  expect(s.sent).toEqual([]);
  ip = "198.51.100.2";
  await advance(100);
  expect(s.sent).toEqual(["continue"]);
});

test("automatic rotation completing after terminal failure checks cutover immediately", async () => {
  process.env.BPB_ROTATE_ON_RATE_LIMIT = "true";
  const { promise: result, resolve: complete } = Promise.withResolvers<RotationResult>();
  const s = session({ exec: () => result });
  await s.start(); await s.emit("message_end", { message: rateError }); await s.fail();
  ip = "198.51.100.2"; complete({ code: 0 });
  await advance(0);
  expect(s.sent).toEqual(["continue"]);
});

test("automatic rotation completing before terminal failure waits for core ownership to end", async () => {
  process.env.BPB_ROTATE_ON_RATE_LIMIT = "true";
  const s = session({ exec: async () => { ip = "198.51.100.2"; return { code: 0 }; } });
  await s.start(); await s.emit("message_end", { message: rateError }); await advance(0);
  expect(s.sent).toEqual([]);
  await s.fail(rateError, true); await advance(100);
  expect(s.sent).toEqual([]);
  await s.fail(); await advance(0);
  expect(s.sent).toEqual(["continue"]);
});

test("manual rotation does not wait for idle or inject into a healthy chat", async () => {
  const s = session({ exec: async () => { ip = "198.51.100.2"; return { code: 0 }; } });
  await s.start(); await s.command("bpb-rotate"); await advance(100);
  expect(s.sent).toEqual([]);
  await s.fail(); await advance(0);
  expect(s.sent).toEqual(["continue"]);
});

for (const event of ["agent_start", "session_shutdown", "session_switch"]) {
  test(`${event} cancels an already queued recovery`, async () => {
    process.env.BPB_ROTATE_RECOVERY_DELAY_MS = "500";
    const s = session();
    await s.start(); await s.fail(); ip = "198.51.100.2"; await advance(100);
    await s.emit(event); await advance(1000);
    expect(s.sent).toEqual([]);
  });
  test(`${event} fences a late egress probe result`, async () => {
    const s = session();
    await s.start();
    const { promise: result, resolve: complete } = Promise.withResolvers<Response>();
    let signal: AbortSignal | null | undefined;
    probeHandler = incoming => { signal = incoming; return result; };
    await s.fail(); await s.emit(event);
    expect(signal?.aborted).toBe(true);
    complete(new Response("ip=198.51.100.2\n"));
    await advance(1000);
    expect(s.sent).toEqual([]);
  });
}

test("failed trace probe recovers on a later observed cutover", async () => {
  const s = session(); await s.start(); probeFailure = true; await s.fail(); await advance(100);
  expect(s.sent).toEqual([]);
  probeFailure = false; ip = "198.51.100.2"; await advance(100);
  expect(s.sent).toEqual(["continue"]);
});

test("unavailable baseline permits only one unverified fresh retry for a known panel success", async () => {
  probeFailure = true;
  const s = session({ exec: async () => ({ code: 0 }) });
  await s.start(); await s.fail(); await s.command("bpb-rotate"); await advance(0);
  expect(s.sent).toEqual(["continue"]);
  await s.start(); await s.fail(); await advance(500);
  expect(s.sent).toEqual(["continue"]);
});

test("healthy terminal messages and aborts cancel failed-chat watchers", async () => {
  for (const stopReason of ["stop", "aborted"]) {
    const s = session(); await s.start(); await s.fail();
    await s.emit("agent_end", { messages: [rateError, { role: "assistant", stopReason }] });
    ip = "198.51.100.2"; await advance(100);
    expect(s.sent).toEqual([]); ip = "198.51.100.1";
  }
});

test("account quotas and non-Zen errors never acquire egress recovery", async () => {
  const nonZen = session({ provider: "openai-codex" }); await nonZen.start(); await nonZen.fail({ ...rateError, provider: "openai-codex" });
  const quota = session(); await quota.start(); await quota.fail({ ...rateError, errorMessage: "429 account quota exhausted" });
  ip = "198.51.100.2"; await advance(1000);
  expect(nonZen.sent).toEqual([]); expect(quota.sent).toEqual([]);
});

test("resuming a failed chat watches its route; healthy resumes never send a continuation", async () => {
  const failed = session({ branch: [rateError] }); failed.setIdle(true); await failed.emit("session_start");
  const healthy = session({ branch: [rateError, { role: "assistant", stopReason: "stop" }] }); healthy.setIdle(true); await healthy.emit("session_start");
  ip = "198.51.100.2"; await advance(100);
  expect(failed.sent).toEqual(["continue"]); expect(healthy.sent).toEqual([]);
});

test("transport retry budget survives extension reinstantiation", async () => {
  const sent: string[][] = [];
  for (let i = 0; i < 4; i++) {
    const s = session(); await s.start();
    await s.fail({ ...rateError, errorStatus: undefined, errorMessage: "The socket connection was closed unexpectedly" });
    await advance(15000); sent.push(s.sent);
  }
  expect(sent).toEqual([["continue"], ["continue"], ["continue"], []]);
});

test("unknown certificate errors retry the failed chat within the persisted transport budget", async () => {
  for (const errorMessage of ["Unknown certificate error", "UNKNOWN_CERTIFICATE_ERROR", "Network error: unknown certificate error", "unknown certificate error"]) {
    const s = session(); await s.start();
    await s.fail({ ...rateError, errorStatus: undefined, errorMessage });
    await advance(15000);
    expect(s.sent).toEqual(errorMessage === "unknown certificate error" ? [] : ["continue"]);
  }
});

test("core-owned certificate retry never receives an extension follow-up", async () => {
  const s = session(); await s.start();
  await s.fail({ ...rateError, errorStatus: undefined, errorMessage: "unknown certificate error" }, true);
  await advance(15000);
  expect(s.sent).toEqual([]);
});

for (const event of ["agent_start", "session_shutdown", "session_switch"]) {
  test(`${event} cancels certificate recovery`, async () => {
    const s = session(); await s.start();
    await s.fail({ ...rateError, errorStatus: undefined, errorMessage: "unknown certificate error" });
    await s.emit(event); await advance(15000);
    expect(s.sent).toEqual([]);
  });
}
