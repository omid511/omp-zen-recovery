// Account-quota wakeups are per conversation, not per shared rotation budget.
const BUFFER_MS = 120_000;
const POLL_MS = 60_000;
const MAX_TIMER_MS = 2_147_000_000;
interface AccountHealth {
  credentialId: number;
  selected?: boolean;
  state: string;
  resetsAt?: number;
}
interface WakeContext {
  model?: { provider: string; id: string; baseUrl?: string };
  sessionManager: { getSessionId(): string; getBranch(): Array<{ type: string; message?: unknown }> };
  modelRegistry: { authStorage: { health: { model(provider: string, options: { modelId: string; sessionId: string; baseUrl?: string; reserveFraction: number; signal: AbortSignal }): Promise<{ accounts: AccountHealth[] }> } } };
  isIdle(): boolean;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  ui?: { notify?(message: string, type: string): void };
}
interface WaitingChat {
  ctx: WakeContext;
  sessionId: string;
  modelId: string;
  timer?: unknown;
  controller?: AbortController;
  wakeAt?: number;
}
function terminalQuota(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  const message = [...messages].reverse().find(value => value && typeof value === "object" && "role" in value && value.role === "assistant");
  if (!message || message.stopReason !== "error" || typeof message.errorMessage !== "string") return false;
  return /usage_limit_reached|the usage limit has been reached|you have hit your chatgpt usage limit/i.test(message.errorMessage);
}
export default function install(pi: any) {
  let waiting: WaitingChat | undefined;
  function cancel() {
    const current = waiting;
    waiting = undefined;
    if (!current) return;
    current.ctx.clearTimer(current.timer);
    current.controller?.abort();
  }
  function valid(current: WaitingChat) {
    return waiting === current && current.ctx.sessionManager.getSessionId() === current.sessionId && current.ctx.model?.provider === "openai-codex" && current.ctx.model.id === current.modelId;
  }
  function notify(current: WaitingChat, text: string) {
    try { current.ctx.ui?.notify?.(text, "info"); } catch { /* UI lifetime must not control wakeup. */ }
  }
  function schedule(current: WaitingChat, at: number) {
    if (!valid(current)) return;
    current.ctx.clearTimer(current.timer);
    current.timer = current.ctx.setTimeout(() => { current.timer = undefined; void inspect(current); }, Math.min(MAX_TIMER_MS, Math.max(0, at - Date.now())));
  }
  async function inspect(current: WaitingChat) {
    if (!valid(current) || current.controller) return;
    if (!current.ctx.isIdle()) { schedule(current, Date.now() + POLL_MS); return; }
    const controller = new AbortController();
    current.controller = controller;
    try {
      const health = await current.ctx.modelRegistry.authStorage.health.model("openai-codex", {
        modelId: current.modelId, sessionId: current.sessionId, baseUrl: current.ctx.model?.baseUrl,
        reserveFraction: 0, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!valid(current)) return;
      // Never borrow another account's reset. Single-account profiles are unambiguous.
      const account = health.accounts.find(value => value.selected) ?? (health.accounts.length === 1 ? health.accounts[0] : undefined);
      if (!account) { schedule(current, Date.now() + POLL_MS); return; }
      if (account.state === "depleted") {
        const reset = account.resetsAt;
        if (typeof reset !== "number" || !Number.isFinite(reset) || reset <= Date.now()) {
          schedule(current, Date.now() + POLL_MS); return;
        }
        const wakeAt = reset + BUFFER_MS;
        if (current.wakeAt !== wakeAt) {
          current.wakeAt = wakeAt;
          notify(current, `Codex quota wakeup armed for ${new Date(wakeAt).toISOString()} (reset + 2 minutes)`);
        }
        schedule(current, wakeAt);
        return;
      }
      if (account.state !== "healthy" && account.state !== "reserve") {
        schedule(current, Date.now() + POLL_MS); return;
      }
      // Even an early healthy report does not bypass the two-minute grace period.
      current.wakeAt ??= Date.now() + BUFFER_MS;
      if (Date.now() < current.wakeAt) { schedule(current, current.wakeAt); return; }
      if (!current.ctx.isIdle() || !valid(current)) { schedule(current, Date.now() + POLL_MS); return; }
      cancel();
      notify(current, "Codex quota reset confirmed; resuming this chat after the two-minute grace period");
      pi.sendUserMessage("continue", { deliverAs: "followUp" });
    } catch {
      if (valid(current)) schedule(current, Date.now() + POLL_MS);
    } finally {
      if (current.controller === controller) current.controller = undefined;
    }
  }
  function arm(ctx: WakeContext, messages: unknown) {
    cancel();
    if (ctx.model?.provider !== "openai-codex" || !terminalQuota(messages)) return;
    const current: WaitingChat = { ctx, sessionId: ctx.sessionManager.getSessionId(), modelId: ctx.model.id };
    waiting = current;
    void inspect(current);
  }
  pi.on("agent_end", (event: { messages?: unknown; willContinue?: boolean }, ctx: WakeContext) => {
    if (event.willContinue) { cancel(); return; }
    arm(ctx, event.messages);
  });
  for (const event of ["agent_start", "before_agent_start", "session_shutdown", "session_branch", "model_select"]) pi.on(event, cancel);
  for (const event of ["session_start", "session_switch"]) pi.on(event, (_event: unknown, ctx: WakeContext) => {
    const messages = ctx.sessionManager.getBranch().filter(entry => entry.type === "message").map(entry => entry.message);
    arm(ctx, messages);
  });
}
