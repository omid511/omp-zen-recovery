import { afterEach, beforeEach, expect, test } from "bun:test";
import install from "../extensions/codex-reset-wakeup";
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
  let deferred: Promise<{ accounts: any[] }> | undefined;
  let signal: AbortSignal | undefined;
  const notices: string[] = [];
  const ctx = {
    get model() { return { provider, id: "gpt-5.6", baseUrl: "https://chatgpt.com/backend-api/codex" }; },
    isIdle: () => idle,
    sessionManager: { getSessionId: () => id, getBranch: () => [{ type: "message", message: error }] },
    modelRegistry: { authStorage: { health: { async model(_provider: string, options: any) {
      expect(options.sessionId).toBe(id); expect(options.modelId).toBe("gpt-5.6");
      signal = options.signal;
      if (deferred) return deferred;
      return { accounts: [{ credentialId: 1, selected: true, state: unknown ? "unknown" : healthy || now >= reset ? "healthy" : "depleted", resetsAt: reset }, ...(extraAccounts ? [{ credentialId: 2, state: "depleted", resetsAt: reset + 9999999 }] : [])] };
    } } } },
    setTimeout(callback: () => void, ms: number) { const timer = { at: now + ms, callback }; timers.add(timer); return timer; },
    clearTimer(timer: Timer) { timers.delete(timer); },
    ui: { notify(text: string) { notices.push(text); } },
  };
  install({ on(name: string, callback: any) { handlers.set(name, callback); }, sendUserMessage(text: string) { sent.push(text); } });
  async function emit(name: string, event: unknown = {}) { handlers.get(name)?.(event, ctx); await flush(); }
  return { emit, sent, notices, fail: () => emit("agent_end", { messages: [error] }), reset: (value: number) => { reset = value; }, unknown: (value: boolean) => { unknown = value; }, healthy: () => { healthy = true; }, busy: () => { idle = false; }, provider: (value: string) => { provider = value; }, extra: () => { extraAccounts = true; }, defer: (value: Promise<{ accounts: any[] }>) => { deferred = value; }, signal: () => signal };
}
beforeEach(() => { now = 1791377000000; originalNow = Date.now; Date.now = () => now; timers = new Set(); });
afterEach(() => { Date.now = originalNow; });

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
