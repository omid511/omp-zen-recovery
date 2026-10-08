import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadAlarm, saveAlarm, deleteAlarm, scheduleExternal, processStamp } from "../lib/codex-alarm-state.mjs";
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
  hasUI?: boolean;
  sessionManager: {
    getSessionId(): string;
    getBranch(): Array<{ type: string; id?: string; message?: unknown }>;
    getSessionFile?(): string | undefined;
    getLeafId?(): string | null;
  };
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
  token: string;
  sessionFile?: string;
  leafId?: string;
  externalAt?: number;
}
function terminalQuota(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  const message = [...messages].reverse().find(value => value && typeof value === "object" && "role" in value && value.role === "assistant");
  if (!message || message.stopReason !== "error" || typeof message.errorMessage !== "string") return false;
  return /usage_limit_reached|the usage limit has been reached|you have hit your chatgpt usage limit/i.test(message.errorMessage);
}
export default function install(pi: any) {
  let waiting: WaitingChat | undefined;
  function cancel(preserve = false) {
    const current = waiting;
    waiting = undefined;
    if (!current) return;
    current.ctx.clearTimer(current.timer);
    current.controller?.abort();
    if (!preserve && current.sessionFile) deleteAlarm(current.sessionId);
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
    if (current.sessionFile && current.leafId) {
      const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
      const record = {
        version: 1, token: current.token, sessionId: current.sessionId, modelId: current.modelId,
        sessionFile: current.sessionFile, leafId: current.leafId, wakeAt: current.wakeAt, checkAt: at,
        pid: process.pid, processStart: processStamp(process.pid)?.start,
        paneId: current.ctx.hasUI && process.env.HERDR_ENV === "1" && process.env.OMPCODE !== "1" ? process.env.HERDR_PANE_ID : undefined,
        socketPath: process.env.HERDR_SOCKET_PATH, frozenDir: join(agentDir, "frozen"), path: process.env.PATH,
      };
      saveAlarm(record);
      if (record.paneId && current.externalAt !== at) {
        if (scheduleExternal(record)) current.externalAt = at;
        else notify(current, "Codex deadline saved, but external Herdr wakeup scheduling failed");
      }
    }
    current.timer = current.ctx.setTimeout(() => { current.timer = undefined; void inspect(current); }, Math.min(MAX_TIMER_MS, Math.max(0, at - Date.now())));
  }
  async function inspect(current: WaitingChat) {
    if (!valid(current) || current.controller) return;
    if (process.env.OMP_SLEEP_RESUME_SESSION === current.sessionId) {
      // sleep-state rejects input until its exact-branch restoration finishes.
      schedule(current, Math.max(Date.now() + 1000, current.wakeAt ?? 0));
      return;
    }
    if (!current.ctx.isIdle()) { schedule(current, Date.now() + POLL_MS); return; }
    const controller = new AbortController();
    current.controller = controller;
    try {
      const health = await current.ctx.modelRegistry.authStorage.health.model("openai-codex", {
        modelId: current.modelId, sessionId: current.sessionId, baseUrl: current.ctx.model?.baseUrl,
        reserveFraction: 0, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!valid(current)) return;
      // Affinity is optional (e.g. after reopening a conversation). Without a
      // pin, OMP can reselect a usable sibling; waiting for `selected` forever
      // would strand every multi-account chat resumed in a new process.
      let account = health.accounts.find(value => value.selected);
      if (!account) {
        account = health.accounts.find(value => value.state === "healthy" || value.state === "reserve");
        if (!account) {
          for (const candidate of health.accounts) {
            if (candidate.state !== "depleted" || typeof candidate.resetsAt !== "number" || !Number.isFinite(candidate.resetsAt) || candidate.resetsAt <= Date.now()) continue;
            if (!account || candidate.resetsAt < account.resetsAt!) account = candidate;
          }
        }
      }
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
      // Explicit followUp only queues in an idle host; omit it to start a turn.
      pi.sendUserMessage("continue");
    } catch {
      if (valid(current)) schedule(current, Date.now() + POLL_MS);
    } finally {
      if (current.controller === controller) current.controller = undefined;
    }
  }
  function arm(ctx: WakeContext, messages: unknown) {
    const sessionId = ctx.sessionManager.getSessionId();
    const saved = loadAlarm(sessionId);
    cancel(true);
    // omp-pane restores its exact checkpoint through /omp-sleep-resume.
    // Do not inspect a different startup tip before that navigation completes.
    if (process.env.OMP_SLEEP_RESUME_LEAF && ctx.sessionManager.getLeafId?.() !== process.env.OMP_SLEEP_RESUME_LEAF) return;
    if (ctx.model?.provider !== "openai-codex" || !terminalQuota(messages)) { deleteAlarm(sessionId); return; }
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    const branch = ctx.sessionManager.getBranch();
    const savedLeaf = saved && branch.findIndex(entry => entry.id === saved.leafId);
    const restore = saved && saved.sessionFile === sessionFile && saved.modelId === ctx.model.id &&
      savedLeaf >= 0 && !branch.slice(savedLeaf + 1).some(entry => entry.type === "message");
    const current: WaitingChat = {
      ctx, sessionId, modelId: ctx.model.id, token: randomUUID(), sessionFile,
      leafId: restore ? saved.leafId : ctx.sessionManager.getLeafId?.() ?? undefined,
      wakeAt: restore && typeof saved.wakeAt === "number" ? saved.wakeAt : undefined,
    };
    waiting = current;
    schedule(current, current.wakeAt ?? Date.now() + POLL_MS);
    void inspect(current);
  }
  pi.on("agent_end", (event: { messages?: unknown; willContinue?: boolean }, ctx: WakeContext) => {
    if (event.willContinue) { cancel(); return; }
    arm(ctx, event.messages);
  });
  for (const event of ["agent_start", "before_agent_start", "session_branch", "model_select"]) pi.on(event, () => cancel());
  pi.on("session_shutdown", () => cancel(true));
  for (const event of ["session_start", "session_switch", "session_tree"]) pi.on(event, (_event: unknown, ctx: WakeContext) => {
    const messages = ctx.sessionManager.getBranch().filter(entry => entry.type === "message").map(entry => entry.message);
    arm(ctx, messages);
  });
}
