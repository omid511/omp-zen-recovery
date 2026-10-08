import { afterEach, beforeEach, expect, test } from "bun:test";
import install from "../extensions/codex-reset-wakeup";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAlarm } from "../lib/codex-alarm-state.mjs";
let stateDir: string;
let previousStateDir: string | undefined;
let previousResume: Record<string, string | undefined>;
type Timer = { at: number; callback: () => void };
let now: number;
let originalNow: typeof Date.now;
let timers: Set<Timer>;
const error = { role: "assistant", stopReason: "error", errorMessage: "Codex error event: The usage limit has been reached (code=usage_limit_reached)" };
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
async function advance(ms: number) {
  const end = now + ms;
  await flush();
  while (true) {
    const timer = [...timers].filter(value => value.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!timer) break;
    now = timer.at; timers.delete(timer); timer.callback(); await flush();
  }
  now = end; await flush();
}
function chat(id = "parent") {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const sent: string[] = [];
  let reset = now + 300_000;
  let unknown = false;
  let healthy = false;
  let idle = true;
  let provider = "openai-codex";
  let extraAccounts = false;
  let selected = true;
  let sessionFile: string | undefined;
  let leafId = "failure";
  let deferred: Promise<{ accounts: any[] }> | undefined;
  let signal: AbortSignal | undefined;
  const notices: string[] = [];
  const ctx = {
    get model() { return { provider, id: "gpt-5.6", baseUrl: "https://chatgpt.com/backend-api/codex" }; },
    isIdle: () => idle,
    sessionManager: { getSessionId: () => id, getBranch: () => [{ type: "message", id: leafId, message: error }], getSessionFile: () => sessionFile, getLeafId: () => leafId },
    modelRegistry: { authStorage: { health: { async model(_provider: string, options: any) {
      expect(options.sessionId).toBe(id); expect(options.modelId).toBe("gpt-5.6");
      signal = options.signal;
      if (deferred) return deferred;
      return { accounts: [{ credentialId: 1, selected, state: unknown ? "unknown" : healthy || now >= reset ? "healthy" : "depleted", resetsAt: reset }, ...(extraAccounts ? [{ credentialId: 2, state: "depleted", resetsAt: reset + 9999999 }] : [])] };
    } } } },
    setTimeout(callback: () => void, ms: number) { const timer = { at: now + ms, callback }; timers.add(timer); return timer; },
    clearTimer(timer: Timer) { timers.delete(timer); },
    ui: { notify(text: string) { notices.push(text); } },
  };
  install({ on(name: string, callback: any) { handlers.set(name, callback); }, sendUserMessage(text: string) { sent.push(text); } });
  async function emit(name: string, event: unknown = {}) { handlers.get(name)?.(event, ctx); await flush(); }
  function unpin() { selected = false; }
  return { emit, sent, notices, unpin, persistent: () => { sessionFile = join(stateDir, id + ".jsonl"); }, branch: (leaf: string) => { leafId = leaf; }, fail: () => emit("agent_end", { messages: [error] }), reset: (value: number) => { reset = value; }, unknown: (value: boolean) => { unknown = value; }, healthy: () => { healthy = true; }, busy: () => { idle = false; }, provider: (value: string) => { provider = value; }, extra: () => { extraAccounts = true; }, defer: (value: Promise<{ accounts: any[] }>) => { deferred = value; }, signal: () => signal };
}
beforeEach(() => {
  now = 1791377000000; originalNow = Date.now; Date.now = () => now; timers = new Set();
  stateDir = mkdtempSync(join(tmpdir(), "codex-durable-test-")); previousStateDir = process.env.CODEX_WAKEUP_STATE_DIR;
  process.env.CODEX_WAKEUP_STATE_DIR = stateDir;
  previousResume = { OMP_SLEEP_RESUME_SESSION: process.env.OMP_SLEEP_RESUME_SESSION, OMP_SLEEP_RESUME_LEAF: process.env.OMP_SLEEP_RESUME_LEAF };
  delete process.env.OMP_SLEEP_RESUME_SESSION; delete process.env.OMP_SLEEP_RESUME_LEAF;
});
afterEach(() => {
  Date.now = originalNow; rmSync(stateDir, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.CODEX_WAKEUP_STATE_DIR; else process.env.CODEX_WAKEUP_STATE_DIR = previousStateDir;
  for (const [key, value] of Object.entries(previousResume)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("every failed chat wakes once at its selected account reset plus exactly two minutes", async () => {
  const parent = chat("parent"); const child = chat("child"); parent.extra();
  await parent.fail(); await child.fail();
  await advance(419999); expect(parent.sent).toEqual([]); expect(child.sent).toEqual([]);
  await advance(1); expect(parent.sent).toEqual(["continue"]); expect(child.sent).toEqual(["continue"]);
  await advance(600000); expect(parent.sent).toEqual(["continue"]);
});
test("another exhausted window postpones wakeup to its own reset plus grace", async () => {
  const s = chat(); await s.fail(); await advance(300000);
  s.reset(now + 600000); await advance(120000); expect(s.sent).toEqual([]);
  await advance(599999); expect(s.sent).toEqual([]); await advance(1); expect(s.sent).toEqual(["continue"]);
});
test("unknown usage or probe failure never fabricates a reset or resumes prematurely", async () => {
  const s = chat(); s.unknown(true); await s.fail(); await advance(900000); expect(s.sent).toEqual([]);
  s.unknown(false); s.reset(now + 300000); await advance(60000);
  await advance(359999); expect(s.sent).toEqual([]); await advance(1); expect(s.sent).toEqual(["continue"]);
});
for (const event of ["agent_start", "before_agent_start", "session_shutdown", "session_branch", "model_select"]) {
  test(`${event} cancels quota wakeup`, async () => { const s = chat(); await s.fail(); await s.emit(event); await advance(500000); expect(s.sent).toEqual([]); });
  test(`${event} aborts and fences a late quota response`, async () => {
    const pending = Promise.withResolvers<{ accounts: any[] }>();
    const s = chat(); s.defer(pending.promise); await s.fail(); await s.emit(event);
    expect(s.signal()?.aborted).toBe(true);
    pending.resolve({ accounts: [{ credentialId: 1, selected: true, state: "healthy" }] });
    await advance(500000); expect(s.sent).toEqual([]);
  });
}
test("core continuation and successful terminal turn cancel quota wakeups", async () => {
  const s = chat(); await s.fail(); await s.emit("agent_end", { messages: [error], willContinue: true }); await advance(500000); expect(s.sent).toEqual([]);
  await s.fail(); await s.emit("agent_end", { messages: [error, { role: "assistant", stopReason: "stop" }] }); await advance(500000); expect(s.sent).toEqual([]);
});
test("resumed failed chat rearms; switching to a healthy chat cancels", async () => {
  const s = chat(); await s.emit("session_start"); await advance(420000); expect(s.sent).toEqual(["continue"]);
  const other = chat("other"); await other.fail(); other.provider("opencode-zen"); await other.emit("session_switch"); await advance(500000); expect(other.sent).toEqual([]);
});
test("an early healthy account still waits for the armed reset grace period", async () => {
  const s = chat(); await s.fail(); s.healthy(); await advance(419999); expect(s.sent).toEqual([]); await advance(1); expect(s.sent).toEqual(["continue"]);
});

test("a reopened failed chat with multiple unpinned accounts wakes after the first available reset", async () => {
  const s = chat(); s.extra(); s.unpin(); await s.emit("session_start");
  await advance(419999); expect(s.sent).toEqual([]);
  await advance(1); expect(s.sent).toEqual(["continue"]);
});
test("losing account affinity while an alarm waits does not strand the failed chat", async () => {
  const s = chat(); s.extra(); await s.fail(); s.unpin();
  await advance(420000); expect(s.sent).toEqual(["continue"]);
});

test("shutdown preserves the original reset deadline and re-entry does not add another grace period", async () => {
  const s = chat(); s.persistent(); await s.fail();
  const deadline = now + 420000;
  await advance(300000); await s.emit("session_shutdown");
  expect(loadAlarm("parent")?.wakeAt).toBe(deadline);
  const resumed = chat(); resumed.persistent(); resumed.healthy(); await resumed.emit("session_start");
  await advance(119999); expect(resumed.sent).toEqual([]);
  await advance(1); expect(resumed.sent).toEqual(["continue"]);
  expect(loadAlarm("parent")).toBeUndefined();
});
test("an overdue persisted alarm revives immediately on re-entry once quota is healthy", async () => {
  const s = chat(); s.persistent(); await s.fail(); await s.emit("session_shutdown");
  await advance(900000);
  const resumed = chat(); resumed.persistent(); resumed.healthy(); await resumed.emit("session_start");
  expect(resumed.sent).toEqual(["continue"]);
});
test("a new user turn cancels the durable alarm so restart cannot revive it", async () => {
  const s = chat(); s.persistent(); await s.fail(); await s.emit("before_agent_start");
  expect(loadAlarm("parent")).toBeUndefined();
});
test("re-entry on a different branch cannot inherit the saved deadline", async () => {
  const s = chat(); s.persistent(); await s.fail(); await s.emit("session_shutdown"); await advance(900000);
  const resumed = chat(); resumed.persistent(); resumed.branch("other-failure"); resumed.healthy(); await resumed.emit("session_start");
  expect(resumed.sent).toEqual([]);
  await advance(120000); expect(resumed.sent).toEqual(["continue"]);
});

test("an overdue alarm waits until omp-pane's exact branch restoration finishes", async () => {
  const s = chat(); s.persistent(); await s.fail();
  process.env.OMP_SLEEP_RESUME_SESSION = "parent";
  await advance(420000); expect(s.sent).toEqual([]);
  delete process.env.OMP_SLEEP_RESUME_SESSION;
  await advance(1000); expect(s.sent).toEqual(["continue"]);
});
