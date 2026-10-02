/**
 * BPB rate-limit rotation extension.
 *
 * - Rotates the BPB panel exit node via bpb-rotate.py when the provider
 *   reports HTTP 429 / rate-limit errors.
 * - Revives terminal Zen 429 turns after provider-host egress changes, including
 *   external TUN rotations. Fresh probes observe cutover, not panel settings.
 * - Preemptive hourly rotation (env-gated) on a schedule shared across all
 *   sessions, anchored to the last successful rotation.
 * - Manual `/bpb-rotate` command + `/bpb-rotate-status`.
 *
 * Design notes:
 * - NEVER calls ctx.abort(): OMP auto-retry owns the retry. We rotate in the
 *   background so the next attempt leaves via a fresh IP.
 * - Rotations share a lock and budget across sessions/processes. Recovery is
 *   conversation-local: a subagent cannot consume its parent's continuation.
 * - File lock (+ in-memory flag) prevents concurrent rotations. Stale locks
 *   (>5min, beyond the worst-case exec hold) are reclaimed.
 * - Configurable min gap + max-per-hour prevent IP exhaustion.
 * - Hourly timer uses ctx.setInterval (auto-cleared on session_shutdown).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isIP } from "node:net";

const SCRIPT_DEFAULT = "bpb-rotate";
const LOCK_DEFAULT = path.join(os.homedir(), ".config", "bpb-rotate", "rotate.lock");
const STATE_DEFAULT = path.join(os.homedir(), ".config", "bpb-rotate", "omp-extension-state.json");
const HOUR_MS = 60 * 60 * 1000;
/** After a failed hourly rotation, another session retries this soon. */
const HOURLY_FAIL_DELAY_MS = 10 * 60 * 1000;

const RATE_PATTERN =
  /rate.?limit|too many requests|\b429\b|quota.?exceeded|resource.?exhausted|retry.?later|provider.?returned.?error.*429|usage.?limit|exceeds retry\.maxDelayMs|provider requested.*wait/i;

// Explicit account-level quota only (not exit-IP): rotating the IP cannot help,
// so the extension stands down instead of burning pool addresses.
// Holds are keyed per provider: a ChatGPT plus-plan limit must not stand down
// zen rotations (its FreeUsageLimitError is exit-IP based and rotates fine).
// NOTE: FreeUsageLimit is IP-based here — it rotates like any other 429.
// ChatGPT plus-plan usage limits are account-based — they stand down.
// Codex `usage_limit_reached` ("The usage limit has been reached") is also
// account-scoped: a fresh exit IP cannot clear it, so it stands down too.
// This extension only revives opencode-zen 429s; any other attributed provider
// stands down in maybeRateRotate even without quota wording.
const ACCOUNT_QUOTA_PATTERN = /exceeded.*quota.*account|account.*quota|you have hit your .* usage limit|chatgpt.*usage.?limit|usage limit.*plus.?plan|usage_limit_reached|usage.?limit has been reached/i;

export function isAccountQuotaText(text: unknown): boolean {
  return typeof text === "string" && !!text && ACCOUNT_QUOTA_PATTERN.test(text);
}

export function asProvider(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Best-effort provider attribution for a 429: current model first, then text hints. */
export function providerFromText(text: unknown): string | undefined {
  if (typeof text !== "string" || !text) return undefined;
  // Bare "codex" catches "Codex error event: ... (code=usage_limit_reached)",
  // which carries no "openai-" prefix.
  if (/chatgpt|openai.?codex|plus.?plan|\bcodex\b/i.test(text)) return "openai-codex";
  if (/freeusagelimit|opencode.?zen/i.test(text)) return "opencode-zen";
  return undefined;
}

export function eventProvider(ctx: unknown, msg?: unknown, text?: unknown): string | undefined {
  const model = (ctx as { model?: { provider?: unknown } } | null)?.model;
  const fromCtx = asProvider(model?.provider);
  if (fromCtx) return fromCtx;
  const fromMsg = asProvider((msg as { provider?: unknown } | null)?.provider);
  if (fromMsg) return fromMsg;
  return providerFromText(text);
}

export type QuotaHolds = Record<string, number>;

export function asHolds(value: unknown): QuotaHolds {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    // Legacy file form: one global number (written before per-provider holds).
    // The only writer was an account-quota error, which in practice is the
    // codex plus-plan limit — scope it there so zen rotation revives.
    const n = asNumber(value);
    return n > 0 ? { "openai-codex": n } : {};
  }
  const out: QuotaHolds = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const n = asNumber(v);
    if (k && n > 0) out[k] = n;
  }
  return out;
}

export function mergedHolds(...maps: Array<QuotaHolds | undefined>): QuotaHolds {
  const out: QuotaHolds = {};
  for (const m of maps) {
    if (!m) continue;
    for (const [k, v] of Object.entries(m)) out[k] = Math.max(out[k] ?? 0, v);
  }
  return out;
}

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

export interface RotateConfig {
  script: string;
  panel: string;
  intervalMs: number;
  minGapMs: number;
  settleMs: number;
  lockFile: string;
  stateFile: string;
  onRateLimit: boolean;
  onHourly: boolean;
  maxPerHour: number;
  noV2rayn: boolean;
  staleLockMs: number;
  recovery: boolean;
  recoveryDelayMs: number;
  egressUrl: string;
  egressPollMs: number;
  transportRetry: boolean;
  transportDelayMs: number;
  transportMax: number;
  transportWindowMs: number;
}
export function loadConfig(): RotateConfig {
  return {
    script: envStr("BPB_ROTATE_SCRIPT", SCRIPT_DEFAULT),
    panel: envStr("BPB_ROTATE_PANEL", "").trim(),
    intervalMs: envInt("BPB_ROTATE_INTERVAL_MS", HOUR_MS),
    minGapMs: envInt("BPB_ROTATE_MIN_GAP_MS", 0),
    settleMs: envInt("BPB_ROTATE_SETTLE_MS", 75_000),
    lockFile: envStr("BPB_ROTATE_LOCK_FILE", LOCK_DEFAULT),
    stateFile: envStr("BPB_ROTATE_STATE_FILE", STATE_DEFAULT),
    onRateLimit: envBool("BPB_ROTATE_ON_RATE_LIMIT", true),
    onHourly: envBool("BPB_ROTATE_ON_HOURLY", true),
    maxPerHour: envInt("BPB_ROTATE_MAX_PER_HOUR", 15),
    noV2rayn: envBool("BPB_ROTATE_NO_V2RAYN", false),
    staleLockMs: envInt("BPB_ROTATE_STALE_LOCK_MS", 5 * 60 * 1000),
    recovery: envBool("BPB_ROTATE_RECOVERY", true),
    recoveryDelayMs: envInt("BPB_ROTATE_RECOVERY_DELAY_MS", 0),
    egressUrl: envStr("BPB_ROTATE_EGRESS_URL", "https://opencode.ai/cdn-cgi/trace"),
    egressPollMs: Math.max(20, envInt("BPB_ROTATE_EGRESS_POLL_MS", 2000)),
    transportRetry: envBool("BPB_ROTATE_TRANSPORT_RETRY", true),
    transportDelayMs: envInt("BPB_ROTATE_TRANSPORT_DELAY_MS", 15_000),
    transportMax: envInt("BPB_ROTATE_TRANSPORT_MAX", 3),
    transportWindowMs: envInt("BPB_ROTATE_TRANSPORT_WINDOW_MS", 10 * 60 * 1000),
  };
}

export function isRateLimitText(text: unknown): boolean {
  if (typeof text !== "string" || !text) return false;
  return RATE_PATTERN.test(text);
}

/** Early detector: raw provider HTTP status. */
export function isRateLimitStatus(status: unknown): boolean {
  return status === 429;
}

/** Exact-error confirmation from an assistant error turn. */
export function isRateLimitAssistantMessage(msg: any): boolean {
  if (!msg || typeof msg !== "object") return false;
  if (msg.role !== undefined && msg.role !== "assistant") return false;
  if (msg.stopReason !== undefined && msg.stopReason !== "error") return false;
  if (msg.errorStatus !== undefined && msg.errorStatus !== null) {
    if (Number(msg.errorStatus) === 429) return true;
  }
  return isRateLimitText(msg.errorMessage);
}

function tail(text: string, max = 2000): string {
  const t = text.trim();
  return t.length <= max ? t : `…${t.slice(-max)}`;
}

interface RotationState {
  rotating: boolean;
  lastRotateAt: number;
  lastRateTriggerAt: number;
  lastRotationSuccessAt: number;
  rateHits: number[];
}

function newState(): RotationState {
  return { rotating: false, lastRotateAt: 0, lastRateTriggerAt: 0, lastRotationSuccessAt: 0, rateHits: [] };
}

/** Most recent assistant message (role missing/undefined counts as assistant, matching prior loops). */
function lastAssistantMessage(messages: unknown[]): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    if ("role" in msg && msg.role !== undefined && msg.role !== "assistant") continue;
    return msg;
  }
  return undefined;
}

/** Summarize the terminal assistant message for debug/event logs (no prompt/body content). */
function describeTerminal(messages: unknown): { count: number; stop?: unknown; errorTail?: string; status?: unknown } {
  const count = Array.isArray(messages) ? messages.length : 0;
  const last = Array.isArray(messages) ? lastAssistantMessage(messages) : undefined;
  if (!last || typeof last !== "object") return { count };
  const err: unknown = "errorMessage" in last ? last.errorMessage : undefined;
  return {
    count,
    stop: "stopReason" in last ? last.stopReason : undefined,
    errorTail: typeof err === "string" && err ? tail(err, 300) : undefined,
    status: "errorStatus" in last ? last.errorStatus : undefined,
  };
}

/** Last assistant message of a terminally failed turn, when it is a 429. Terminal-only: a later success/abort must not re-trigger on a stale error. */
export interface RateLimitErrorInfo {
  errorMessage?: unknown;
  errorStatus?: unknown;
}

export function terminalRateLimitMessage(messages: unknown): RateLimitErrorInfo | undefined {
  if (!Array.isArray(messages)) return undefined;
  const msg = lastAssistantMessage(messages);
  if (!msg || typeof msg !== "object") return undefined;
  if (!isRateLimitAssistantMessage(msg)) return undefined;
  return {
    errorMessage: "errorMessage" in msg ? msg.errorMessage : undefined,
    errorStatus: "errorStatus" in msg ? msg.errorStatus : undefined,
  };
}

/**
 * Provider-stated wait extracted from a 429 error, in whole seconds.
 * Mirrors OMP core's parsing (retry-after-ms first, then retry-after
 * seconds), floored at 60s so a degenerate value can't disable hiding.
 * Returns 0 when the error carries no usable duration.
 */
export function parseRetryAfterSec(text: unknown): number {
  if (typeof text !== "string" || !text) return 0;
  const ms = /retry-after-ms\s*[:=]\s*(\d+)/i.exec(text);
  if (ms) return Math.max(60, Math.floor(Number(ms[1]) / 1000));
  const reqMs = /requested\s+(\d+)\s*ms/i.exec(text);
  if (reqMs) return Math.max(60, Math.floor(Number(reqMs[1]) / 1000));
  const min = /try again in\s*~?\s*(\d+)\s*min/i.exec(text);
  if (min) return Math.max(60, Number(min[1]) * 60);
  const sec = /retry-after\s*[:=]\s*(\d+)/i.exec(text);
  if (sec) return Math.max(60, Math.floor(Number(sec[1])));
  return 0;
}
const TRANSPORT_PATTERN =
  /unknown[ _-]+certificate[ _-]+error|socket (connection )?(was )?closed|other side closed|socket hang ?up|fetch failed|unexpected eof|\beof\b|connection reset|reset by peer|ECONNRESET|EPIPE|network socket closed|net_io_eof|connection (was )?terminated|TLS connection (was )?closed|ws close|websocket.{0,20}closed|getaddrinfo|EAI_AGAIN|ENOTFOUND|name resolution|temporary failure|timed out|ETIMEDOUT|deadline exceeded|handshake (failure|timed out)|bad gateway|service unavailable|gateway timeout|\b50[023]\b/i;

const ABORT_PATTERN = /abort|interrupt.*user|user.*interrupt|cancel+ed by user/i;

// Retrying these can never help: auth/permission failures repeat identically.
const FATAL_PATTERN = /40[13]\b|unauthorized|forbidden|not available in your country|invalid.?api.?key|authentication (failed|error)|permission denied/i;

// The rotator's own failure text mentions connection resets; never mistake
// our own errors for a provider transport blip (that would re-fire a stale
// prompt into a healthy session).
const ROTATOR_OUTPUT_PATTERN = /bpb-rotate|Panel request failed|Exit-node rotation/i;

export function isTransportErrorText(text: unknown): boolean {
  if (typeof text !== "string" || !text) return false;
  if (ABORT_PATTERN.test(text)) return false;
  if (ROTATOR_OUTPUT_PATTERN.test(text)) return false;
  if (FATAL_PATTERN.test(text)) return false;
  return TRANSPORT_PATTERN.test(text);
}
/** Terminal assistant error turn caused by a dead transport (not a 429, not an abort). Terminal-only. */
export function terminalTransportMessage(messages: unknown): RateLimitErrorInfo | undefined {
  if (!Array.isArray(messages)) return undefined;
  const msg = lastAssistantMessage(messages);
  if (!msg || typeof msg !== "object") return undefined;
  if (isRateLimitAssistantMessage(msg)) return undefined;
  const stop: unknown = "stopReason" in msg ? msg.stopReason : undefined;
  if (stop !== "error") return undefined;
  const text: unknown = "errorMessage" in msg ? msg.errorMessage : undefined;
  if (!isTransportErrorText(text)) return undefined;
  return {
    errorMessage: "errorMessage" in msg ? msg.errorMessage : undefined,
    errorStatus: "errorStatus" in msg ? msg.errorStatus : undefined,
  };
}

function pruneHits(state: RotationState, now: number): void {
  state.rateHits = state.rateHits.filter((t) => now - t < HOUR_MS);
}

function tryAcquireFileLock(lockFile: string, staleMs: number): boolean {
  try {
    const st = fs.statSync(lockFile);
    if (Date.now() - st.mtimeMs < staleMs) return false;
    try {
      fs.unlinkSync(lockFile);
    } catch {
      return false;
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") return false;
  }
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, `${process.pid}:${Date.now()}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function releaseFileLock(lockFile: string): void {
  try {
    fs.unlinkSync(lockFile);
  } catch {
    // lock already gone or stolen; ignore
  }
}

/**
 * Rotation decisions shared across sessions/processes. Every instance keeps
 * fast in-memory state but merges with this file before deciding, and
 * publishes after a successful rotation, so N concurrent 429s from a main
 * session plus its subagents still produce exactly one rotation.
 */
export interface SharedRotationState {
  lastRotateAt: number;
  lastRotationSuccessAt: number;
  rateHits: number[];
  transportWindowStart: number;
  transportAttempts: number;
  /** Account-quota outage per provider (provider -> wall-clock ms). */
  quotaHoldUntil: Record<string, number>;
  /** Next wall-clock time an hourly rotation is due; 0 = uninitialized. */
  nextHourlyDue: number;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function readSharedState(stateFile: string): SharedRotationState | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(stateFile, "utf-8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const hits =
    "rateHits" in parsed && Array.isArray(parsed.rateHits)
      ? parsed.rateHits.map(asNumber).filter((n) => n > 0)
      : [];
  return {
    lastRotateAt: "lastRotateAt" in parsed ? asNumber(parsed.lastRotateAt) : 0,
    lastRotationSuccessAt: "lastRotationSuccessAt" in parsed ? asNumber(parsed.lastRotationSuccessAt) : 0,
    rateHits: hits,
    transportWindowStart: "transportWindowStart" in parsed ? asNumber(parsed.transportWindowStart) : 0,
    transportAttempts: "transportAttempts" in parsed ? asNumber(parsed.transportAttempts) : 0,
    quotaHoldUntil: "quotaHoldUntil" in parsed ? asHolds((parsed as Record<string, unknown>).quotaHoldUntil) : {},
    nextHourlyDue: "nextHourlyDue" in parsed ? asNumber(parsed.nextHourlyDue) : 0,
  };
}

export function writeSharedState(stateFile: string, shared: SharedRotationState): void {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(shared) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  } catch {
    // State is best-effort coordination; a failed write only weakens
    // cross-session dedupe, never blocks a rotation decided under the lock.
  }
}

/** Minimal ExtensionContext surface this extension touches for recovery. */
interface RecoveryContext {
  readonly ui?: {
    notify?(message: string, type?: "info" | "warning" | "error"): void;
  };
  model?: { provider?: string };
  isIdle?(): boolean;
  sessionManager?: { getBranch?(): Array<{ type?: string; message?: unknown }> };
  setInterval?(callback: () => void, ms?: number): unknown;
  setTimeout?(callback: (...args: Array<never>) => void, ms?: number): unknown;
  clearTimer?(timer: unknown): void;
}
export default function (pi: any) {
  const cfg = loadConfig();
  const state: RotationState = newState();
  let hourlyArmed = false;
  // Last user prompt, kept only as presence proof a turn was in-flight + for
  // diagnostics. Revival re-drives via a minimal hint, never a full repeat.
  let lastPrompt = "";
  // Minimal resume sent as followUp to revive a killed turn: cheap and avoids
  // confusing the model with a duplicated full prompt; history carries context.
  const RESUME_HINT = "continue";
  // Timers belong to the failed conversation, never to the shared rotator.
  let pendingRecovery: { timer: unknown; clearTimer: (timer: unknown) => void } | undefined;
  // Pending transport-blip retry with its owner's clearTimer.
  let pendingTransport: { timer: unknown; clearTimer: (timer: unknown) => void } | undefined;
  let generation = 0;
  let turnIP: string | undefined;
  let turnRotationAt = 0;
  let lastRetriedRotation = 0;
  let egressTimer: { timer: unknown; clearTimer: (timer: unknown) => void } | undefined;
  let probe: { controller: AbortController; generation: number } | undefined;
  let waiting: { ctx: RecoveryContext; generation: number; ip?: string; rotationAt: number } | undefined;
  // Provider-stated hide duration for the next rate rotation, parsed from the
  // triggering 429 text. Consumed once by buildArgs; hourly/manual never use it.
  let rateCooldownSec = 0;
  // Per-provider account-level quota outage: rotation cannot help for that
  // provider. Learned from error text, shared across sessions so a second
  // chat hitting the same quota stands down instead of burning another IP.
  // Keyed by provider — a codex plus-plan limit must not stand down zen
  // (FreeUsageLimit is exit-IP based and rotates fine).
  let quotaHolds: QuotaHolds = {};

  function getQuotaHold(provider?: string): number {
    const shared = readSharedState(cfg.stateFile);
    const all = mergedHolds(quotaHolds, shared?.quotaHoldUntil);
    if (provider) return Math.max(all[provider] ?? 0, all.global ?? 0);
    return Object.values(all).reduce((m, n) => Math.max(m, n), 0);
  }

  // Returns true when text identifies account quota; extends that provider's
  // hold to the provider-stated reset (default 1h) and reports whether fresh.
  function noteQuota(text: unknown, source?: string, provider?: string): boolean {
    if (!isAccountQuotaText(text)) return false;
    const key = provider ?? providerFromText(text) ?? "global";
    const resetMs = Math.max(parseRetryAfterSec(text), 3600) * 1000;
    const now = Date.now();
    const effective = getQuotaHold(key);
    const fresh = now >= effective;
    quotaHolds = mergedHolds(quotaHolds, { [key]: now + resetMs });
    const shared = readSharedState(cfg.stateFile);
    writeSharedState(cfg.stateFile, {
      lastRotateAt: shared?.lastRotateAt ?? 0,
      lastRotationSuccessAt: shared?.lastRotationSuccessAt ?? 0,
      rateHits: shared?.rateHits ?? [],
      transportWindowStart: shared?.transportWindowStart ?? 0,
      transportAttempts: shared?.transportAttempts ?? 0,
      quotaHoldUntil: mergedHolds(quotaHolds, shared?.quotaHoldUntil),
      nextHourlyDue: shared?.nextHourlyDue ?? 0,
    });
    pi.logger?.debug?.("[bpb-rotate] quota hold extended", { source, provider: key, holdMin: Math.round(resetMs / 60000), fresh });
    return fresh;
  }

  // Append-only JSONL event log: 429s, rotations, recoveries, errors.
  // One line per event, never throws — logging must not break rotation.
  function logEvent(type: string, detail?: Record<string, unknown>): void {
    try {
      const file = process.env.BPB_ROTATE_EVENT_LOG ||
        path.join(os.homedir(), ".config", "bpb-rotate", "events.log");
      fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), event: type, ...(detail ?? {}) }) + "\n");
    } catch {
      // ignore
    }
  }

  pi.logger?.debug?.("[bpb-rotate] extension loaded", {
    intervalMs: cfg.intervalMs,
    onRateLimit: cfg.onRateLimit,
    onHourly: cfg.onHourly,
  });

  function buildArgs(reason: string): string[] {
    const args = ["rotate", "--auto"];
    // No explicit panel: let the script resolve the active v2rayN subscription.
    args.push("--panel", cfg.panel ? cfg.panel : "auto");
    if (cfg.noV2rayn) args.push("--no-v2rayn");
    args.push("--reason", reason === "rate limit" ? "rate-limit" : reason === "hourly" ? "hourly" : "manual");
    if (reason === "rate limit" && rateCooldownSec > 0) {
      args.push("--cooldown-seconds", String(rateCooldownSec));
      rateCooldownSec = 0;
    }
    return args;
  }

  function mergeSharedState(): void {
    const shared = readSharedState(cfg.stateFile);
    if (!shared) return;
    if (shared.lastRotateAt > state.lastRotateAt) state.lastRotateAt = shared.lastRotateAt;
    if (shared.lastRotationSuccessAt > state.lastRotationSuccessAt) {
      state.lastRotationSuccessAt = shared.lastRotationSuccessAt;
    }
    const hits = [...state.rateHits, ...shared.rateHits].filter((n, i, all) => all.indexOf(n) === i);
    state.rateHits = hits;
    pruneHits(state, Date.now());
  }

  function publishSharedState(hourlyDue?: number): void {
    pruneHits(state, Date.now());
    const shared = readSharedState(cfg.stateFile);
    const cutoff = Date.now() - HOUR_MS;
    const hits = [...state.rateHits, ...(shared?.rateHits ?? [])].filter((n, i, all) => n > cutoff && all.indexOf(n) === i);
    writeSharedState(cfg.stateFile, {
      lastRotateAt: Math.max(state.lastRotateAt, shared?.lastRotateAt ?? 0),
      lastRotationSuccessAt: Math.max(state.lastRotationSuccessAt, shared?.lastRotationSuccessAt ?? 0),
      rateHits: hits,
      transportWindowStart: shared?.transportWindowStart ?? 0,
      transportAttempts: shared?.transportAttempts ?? 0,
      quotaHoldUntil: mergedHolds(quotaHolds, shared?.quotaHoldUntil),
      nextHourlyDue: hourlyDue ?? shared?.nextHourlyDue ?? 0,
    });
  }

  function describeSkip(now: number, reason?: string): string | null {
    mergeSharedState();
    if (state.rotating) return "rotation already in progress";
    if (cfg.minGapMs > 0 && now - state.lastRotateAt < cfg.minGapMs) {
      const wait = Math.ceil((cfg.minGapMs - (now - state.lastRotateAt)) / 1000);
      return `rotated recently; retry in ~${wait}s`;
    }
    // Suppress duplicate rotations while the client applies panel settings.
    // This guard never delays egress probes or conversation recovery.
    if (reason === "rate limit" && cfg.settleMs > 0 && state.lastRotationSuccessAt > 0 &&
        now - state.lastRotationSuccessAt < cfg.settleMs) {
      const wait = Math.ceil((cfg.settleMs - (now - state.lastRotationSuccessAt)) / 1000);
      return `exit just rotated; waiting settle (~${wait}s)`;
    }
    pruneHits(state, now);
    if (state.rateHits.length >= cfg.maxPerHour) {
      return `rate-rotation budget exhausted (${state.rateHits.length}/${cfg.maxPerHour} this hour)`;
    }
    return null;
  }

  async function runRotation(reason: string, ctx?: any): Promise<boolean> {
    const now = Date.now();
    const skip = describeSkip(now, reason);
    if (skip) {
      pi.logger?.debug?.(`[bpb-rotate] skip (${reason}): ${skip}`);
      logEvent("rotation_skip", { reason, cause: skip });
      return false;
    }
    if (!tryAcquireFileLock(cfg.lockFile, cfg.staleLockMs)) {
      pi.logger?.debug?.(`[bpb-rotate] skip (${reason}): lock held`);
      logEvent("rotation_skip", { reason, cause: "lock held" });
      ctx?.ui?.notify?.("BPB rotation skipped: another rotation is running", "warning");
      return false;
    }
    state.rotating = true;
    logEvent("rotation_start", { reason });
    try {
      const args = buildArgs(reason);
      ctx?.ui?.setStatus?.("bpb-rotate", `Rotating exit node (${reason})…`);
      const command = /\.py$/i.test(cfg.script) ? "python3" : cfg.script;
      if (command === "python3") args.unshift(cfg.script);
      pi.logger?.debug?.(`[bpb-rotate] exec: ${command} ${args.join(" ")}`);
      const res = await pi.exec(command, args, { timeout: 120_000 });
      const out = tail(`${res?.stdout ?? ""}\n${res?.stderr ?? ""}`.trim());
      if (res?.code === 0) {
        state.lastRotateAt = Date.now();
        state.lastRotationSuccessAt = state.lastRotateAt;
        state.rateHits.push(state.lastRotateAt);
        // Still under the file lock: publish so sibling sessions debouncing
        // their own 429s see this rotation instead of starting another.
        publishSharedState(cfg.intervalMs > 0 ? state.lastRotationSuccessAt + cfg.intervalMs : 0);
        ctx?.ui?.notify?.(`Panel rotation applied (${reason}); checking transport cutover`, "info");
        pi.logger?.debug?.(`[bpb-rotate] panel rotation success (${reason}): ${out.slice(-500)}`);
        logEvent("rotation_ok", { reason, egressVerified: false });
        void checkRecovery();
        return true;
      }
      ctx?.ui?.notify?.(`Exit-node rotation failed (code ${res?.code}): ${out.slice(-300)}`, "error");
      pi.logger?.debug?.(`[bpb-rotate] failed (${reason}) code=${res?.code}: ${out.slice(-1000)}`);
      logEvent("rotation_fail", { reason, code: res?.code ?? -1, tail: out.slice(-300) });
      return false;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      ctx?.ui?.notify?.(`Exit-node rotation error: ${msg.slice(-300)}`, "error");
      pi.logger?.debug?.(`[bpb-rotate] exec error (${reason}): ${msg.slice(-1000)}`);
      logEvent("rotation_fail", { reason, error: msg.slice(-300) });
      return false;
    } finally {
      state.rotating = false;
      releaseFileLock(cfg.lockFile);
      ctx?.ui?.setStatus?.("bpb-rotate", undefined);
    }
  }

  function maybeRateRotate(source: string, ctx?: unknown, cooldownSec?: number, errorText?: unknown, msg?: unknown): void {
    if (!cfg.onRateLimit) return;
    const now = Date.now();
    // Debounce duplicate signals for the same underlying 429 (status +
    // message_end + auto_retry_start all fire for one failure).
    if (now - state.lastRateTriggerAt < 60_000) return;
    state.lastRateTriggerAt = now;
    const errorTail = typeof errorText === "string" && errorText ? tail(errorText, 300) : undefined;
    const provider = eventProvider(ctx, msg, errorText);
    if (noteQuota(errorText, source, provider)) {
      pi.logger?.debug?.(`[bpb-rotate] account quota (${source}); rotation cannot help, standing down`, { provider, errorTail });
      logEvent("quota_standdown", { source, provider, errorTail });
      (ctx as RecoveryContext)?.ui?.notify?.("Account quota exhausted — new exit IP won't help; waiting out the reset", "warning");
      return;
    }
    if (now < getQuotaHold(provider)) {
      pi.logger?.debug?.(`[bpb-rotate] 429 inside quota hold (${source}); standing down`, { provider, errorTail });
      logEvent("quota_standdown", { source, provider, held: true, errorTail });
      return;
    }
    // Scope guard: only opencode-zen 429s are exit-IP based and clearable by
    // rotation. Any other attributed provider (e.g. openai-codex
    // usage_limit_reached, an account-level quota) can never be fixed by a
    // fresh exit IP — stand down instead of burning pool IPs and looping
    // `continue` revivals. Unknown provider still rotates (zen 429s that
    // carry no provider hint take the same path).
    if (provider !== undefined && provider.toLowerCase() !== "opencode-zen") {
      pi.logger?.debug?.(`[bpb-rotate] non-zen provider 429 (${source}); rotation cannot help, standing down`, { provider, errorTail });
      logEvent("provider_standdown", { source, provider, errorTail });
      return;
    }
    if (cooldownSec !== undefined && cooldownSec > 0) rateCooldownSec = cooldownSec;
    pi.logger?.debug?.(`[bpb-rotate] rate-limit signal (${source})`, { provider, errorTail });
    logEvent("rate_limit", { source, provider, errorTail });
    // Detached: awaiting the rotation here would exceed the host's 30s
    // handler budget and get killed. The lock + shared state keep detached
    // rotations from N sessions safe. Rejections are caught, never unhandled.
    void (async () => {
      await runRotation("rate limit", ctx);
      await checkRecovery();
    })().catch((err: unknown) => {
      pi.logger?.debug?.(`[bpb-rotate] detached rotation error: ${String((err as Error)?.message ?? err)}`);
    });
  }

  function clearRecoveryTimer(): void {
    if (!pendingRecovery) return;
    pendingRecovery.clearTimer(pendingRecovery.timer);
    pendingRecovery = undefined;
  }

  function cancelRecovery(): void {
    generation++;
    clearRecoveryTimer();
    if (egressTimer) {
      egressTimer.clearTimer(egressTimer.timer);
      egressTimer = undefined;
    }
    probe?.controller.abort();
    probe = undefined;
    waiting = undefined;
  }

  async function readEgressIP(): Promise<string | undefined> {
    if (probe) return undefined;
    const active = { controller: new AbortController(), generation };
    probe = active;
    try {
      const response = await globalThis.fetch(cfg.egressUrl, {
        keepalive: false,
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.any([active.controller.signal, AbortSignal.timeout(3000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      const ip = /^ip=([^\r\n]+)$/m.exec(await response.text())?.[1].trim();
      return generation === active.generation && ip && isIP(ip) ? ip : undefined;
    } catch {
      return undefined;
    } finally {
      if (probe === active) probe = undefined;
    }
  }

  function queueRecovery(current: NonNullable<typeof waiting>, ip: string | undefined, marker: number): void {
    if (pendingRecovery || waiting !== current) return;
    const ctx = current.ctx;
    if (typeof ctx.setTimeout !== "function" || typeof ctx.clearTimer !== "function") return;
    const timer = ctx.setTimeout(() => {
      pendingRecovery = undefined;
      if (waiting !== current || current.generation !== generation || ctx.isIdle?.() === false) return;
      const verified = ip !== undefined && current.ip !== undefined && ip !== current.ip;
      lastRetriedRotation = Math.max(lastRetriedRotation, marker);
      if (ip) turnIP = ip;
      cancelRecovery();
      logEvent("recovery_fired", { resumedAs: RESUME_HINT, egressVerified: verified });
      try {
        ctx.ui?.notify?.(verified ? "Egress changed; retrying the failed chat now" : "Panel applied; retrying with a fresh connection (egress unverified)", "info");
      } catch {
        // A disposed UI must not discard the already-authorized continuation.
      }
      pi.sendUserMessage(RESUME_HINT, { deliverAs: "followUp" });
    }, cfg.recoveryDelayMs);
    pendingRecovery = { timer, clearTimer: ctx.clearTimer.bind(ctx) };
    logEvent("recovery_scheduled", { delayMs: cfg.recoveryDelayMs, egressVerified: ip !== undefined && current.ip !== undefined && ip !== current.ip });
  }

  async function checkRecovery(): Promise<void> {
    const current = waiting;
    if (!current || pendingRecovery || current.generation !== generation || current.ctx.isIdle?.() === false) return;
    const ip = await readEgressIP();
    if (waiting !== current || current.generation !== generation) return;
    mergeSharedState();
    const marker = state.lastRotationSuccessAt;
    const newRotation = marker > current.rotationAt && marker > lastRetriedRotation;
    if (ip && current.ip && ip !== current.ip) {
      queueRecovery(current, ip, marker);
    } else if (!current.ip && newRotation) {
      // One request may prove recovery when trace was unavailable. Never
      // describe panel acknowledgement as verified egress migration.
      queueRecovery(current, ip, marker);
    } else if (ip && !current.ip) {
      current.ip = ip;
    }
  }

  function maybeScheduleRecovery(ctx: unknown): void {
    if (!cfg.recovery || waiting) return;
    const rctx = ctx as RecoveryContext;
    if (typeof rctx?.setInterval !== "function" || typeof rctx.clearTimer !== "function") return;
    waiting = { ctx: rctx, generation, ip: turnIP, rotationAt: turnRotationAt };
    const timer = rctx.setInterval(() => { void checkRecovery(); }, cfg.egressPollMs);
    egressTimer = { timer, clearTimer: rctx.clearTimer.bind(rctx) };
    void checkRecovery();
  }

  function cancelTransport(): void {
    if (!pendingTransport) return;
    try {
      pendingTransport.clearTimer(pendingTransport.timer);
    } catch {
      // timer already fired or the session is gone; ignore
    }
    pendingTransport = undefined;
    pi.logger?.debug?.("[bpb-rotate] transport retry cancelled");
    logEvent("transport_cancelled", {});
  }

  function reconcileOrphanedRecovery(ctx: RecoveryContext): void {
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    const messages = branch.filter(entry => entry.type === "message").map(entry => entry.message);
    const info = terminalRateLimitMessage(messages);
    if (!info || ctx.model?.provider !== "opencode-zen" || isAccountQuotaText(info.errorMessage) || Date.now() < getQuotaHold("opencode-zen")) return;
    // A resumed failed conversation has no reliable pre-failure egress sample.
    // Observe the current route and wait for its next cutover, not a shared claim.
    turnIP = undefined;
    turnRotationAt = readSharedState(cfg.stateFile)?.lastRotationSuccessAt ?? 0;
    maybeScheduleRecovery(ctx);
  }

  function sharedTransportBudget(now: number): { windowStart: number; attempts: number } {
    const shared = readSharedState(cfg.stateFile);
    if (shared && now - shared.transportWindowStart < cfg.transportWindowMs) {
      return { windowStart: shared.transportWindowStart, attempts: shared.transportAttempts };
    }
    return { windowStart: now, attempts: 0 };
  }

  function recordTransportAttempt(windowStart: number, attempts: number): void {
    const shared = readSharedState(cfg.stateFile);
    const hits = [...state.rateHits, ...(shared?.rateHits ?? [])].filter((n, i, all) => all.indexOf(n) === i);
    writeSharedState(cfg.stateFile, {
      lastRotateAt: Math.max(state.lastRotateAt, shared?.lastRotateAt ?? 0),
      lastRotationSuccessAt: Math.max(state.lastRotationSuccessAt, shared?.lastRotationSuccessAt ?? 0),
      rateHits: hits,
      transportWindowStart: windowStart,
      transportAttempts: attempts,
      quotaHoldUntil: mergedHolds(quotaHolds, shared?.quotaHoldUntil),
      nextHourlyDue: shared?.nextHourlyDue ?? 0,
    });
  }

  function maybeScheduleTransportRetry(ctx: RecoveryContext, info?: RateLimitErrorInfo): void {
    if (!cfg.transportRetry || cfg.transportDelayMs <= 0) {
      pi.logger?.debug?.("[bpb-rotate] transport retry skipped: disabled");
      logEvent("transport_skipped", { reason: "disabled" });
      return;
    }
    if (!lastPrompt) {
      pi.logger?.debug?.("[bpb-rotate] transport retry skipped: no prompt captured");
      logEvent("transport_skipped", { reason: "no-prompt", errorTail: typeof info?.errorMessage === "string" ? tail(info.errorMessage, 300) : undefined });
      return;
    }
    if (pendingTransport || pendingRecovery) {
      pi.logger?.debug?.("[bpb-rotate] transport retry skipped: already pending");
      logEvent("transport_skipped", { reason: "already-pending" });
      return;
    }
    // No rotation here: a dead socket says nothing about the exit IP, and
    // rotating on every blip would burn the pool. Just re-drive the turn
    // after a short settle, capped per window so a hard outage can't loop.
    const now = Date.now();
    const budget = sharedTransportBudget(now);
    if (budget.attempts >= cfg.transportMax) {
      pi.logger?.debug?.("[bpb-rotate] transport retry budget spent; needs a calm window");
      logEvent("transport_skipped", { reason: "budget-spent", attempts: budget.attempts, max: cfg.transportMax });
      return;
    }
    const setTimeoutFn = ctx.setTimeout;
    const clearTimerFn = ctx.clearTimer;
    const notifyFn = ctx.ui?.notify;
    if (typeof setTimeoutFn !== "function" || typeof clearTimerFn !== "function" || typeof notifyFn !== "function") {
      pi.logger?.debug?.("[bpb-rotate] transport retry skipped: no timer/notify in context");
      logEvent("transport_skipped", { reason: "no-timer" });
      return;
    }
    recordTransportAttempt(budget.windowStart, budget.attempts + 1);
    const promptTail = tail(lastPrompt, 200);
    const errorTail = typeof info?.errorMessage === "string" && info.errorMessage ? tail(info.errorMessage, 300) : undefined;
    const delay = cfg.transportDelayMs;
    const attempt = budget.attempts + 1;
    pi.logger?.debug?.("[bpb-rotate] transport retry scheduled", { delayMs: delay, attempt, max: cfg.transportMax, errorTail, promptTail, resumedAs: RESUME_HINT });
    logEvent("transport_scheduled", { delayMs: delay, attempt, max: cfg.transportMax, errorTail, promptTail, resumedAs: RESUME_HINT });
    const timer = setTimeoutFn(() => {
      pendingTransport = undefined;
      pi.logger?.debug?.("[bpb-rotate] transport retry firing", { attempt, promptTail, resumedAs: RESUME_HINT });
      logEvent("transport_fired", { attempt, promptTail, resumedAs: RESUME_HINT });
      try {
        notifyFn("Transport/TLS failure; retrying with certificate verification enabled…", "info");
      } catch {
        // UI gone; still retry below
      }
      pi.sendUserMessage(RESUME_HINT, { deliverAs: "followUp" });
    }, delay);
    pendingTransport = { timer, clearTimer: clearTimerFn };
    pi.logger?.debug?.(`[bpb-rotate] transport retry in ${Math.round(delay / 1000)}s`);
  }

  // Hourly ticks are only triggers: the schedule itself lives in shared
  // rotator state, so N sessions started at different times converge on one
  // cadence anchored to the last successful rotation instead of each
  // session rotating on its own offset.
  async function runHourly(ctx: any): Promise<void> {
    const now = Date.now();
    const due = readSharedState(cfg.stateFile)?.nextHourlyDue ?? 0;
    if (due <= 0) {
      publishSharedState(cfg.intervalMs > 0 ? now + cfg.intervalMs : 0);
      pi.logger?.debug?.("[bpb-rotate] hourly schedule initialized");
      return;
    }
    if (now < due) {
      pi.logger?.debug?.(`[bpb-rotate] hourly tick skipped: not due for ~${Math.ceil((due - now) / 1000)}s`);
      return;
    }
    const ok = await runRotation("hourly", ctx);
    if (!ok) publishSharedState(now + HOURLY_FAIL_DELAY_MS);
  }

  function armHourly(ctx: any): void {
    if (hourlyArmed || !cfg.onHourly || cfg.intervalMs <= 0) return;
    if (typeof ctx?.setInterval !== "function") return;
    hourlyArmed = true;
    ctx.setInterval(() => {
      try {
        if (typeof ctx?.isIdle === "function" && !ctx.isIdle()) {
          pi.logger?.debug?.("[bpb-rotate] hourly tick skipped: agent busy");
          return;
        }
        void runHourly(ctx);
      } catch (err: any) {
        pi.logger?.debug?.(`[bpb-rotate] hourly tick error: ${String(err?.message ?? err)}`);
      }
    }, cfg.intervalMs);
    pi.logger?.debug?.(`[bpb-rotate] hourly rotation armed every ${cfg.intervalMs}ms`);
  }

  pi.on("session_start", async (_event: any, ctx: RecoveryContext) => {
    armHourly(ctx);
    reconcileOrphanedRecovery(ctx);
  });

  pi.on("session_switch", (_event: unknown, ctx: RecoveryContext) => {
    cancelRecovery();
    cancelTransport();
    reconcileOrphanedRecovery(ctx);
  });

  pi.on("before_agent_start", async (event: { prompt?: unknown }, ctx: RecoveryContext) => {
    cancelRecovery();
    cancelTransport();
    if (typeof event?.prompt === "string" && event.prompt.trim()) lastPrompt = event.prompt;
    turnIP = undefined;
    turnRotationAt = readSharedState(cfg.stateFile)?.lastRotationSuccessAt ?? 0;
    if (cfg.recovery && ctx.model?.provider === "opencode-zen") turnIP = await readEgressIP();
  });

  pi.on("agent_start", () => {
    // A new turn is running: pending retries are moot, drop them.
    const hadPending = pendingTransport !== undefined || pendingRecovery !== undefined;
    cancelRecovery();
    cancelTransport();
    if (hadPending) pi.logger?.debug?.("[bpb-rotate] pending retry dropped: new turn started");
  });
  pi.on("after_provider_response", async (event: unknown, ctx: unknown) => {
    const status: unknown = event !== null && typeof event === "object" && "status" in event ? event.status : undefined;
    if (!isRateLimitStatus(status)) return;
    const errText: unknown =
      event !== null && typeof event === "object" && "errorMessage" in event ? event.errorMessage :
      event !== null && typeof event === "object" && "error" in event ? event.error :
      undefined;
    maybeRateRotate("http-429", ctx, parseRetryAfterSec(errText), errText);
  });

  pi.on("message_end", async (event: any, ctx: any) => {
    if (isRateLimitAssistantMessage(event?.message)) {
      const message = event?.message;
      const text = message !== null && typeof message === "object" && "errorMessage" in message ? message.errorMessage : undefined;
      maybeRateRotate("message-end", ctx, parseRetryAfterSec(text), text, message);
    }
  });

  pi.on("auto_retry_start", async (event: { errorMessage?: unknown }, ctx: RecoveryContext) => {
    if (isRateLimitText(event?.errorMessage)) {
      maybeRateRotate("auto-retry", ctx, parseRetryAfterSec(event?.errorMessage), event?.errorMessage);
    }
  });

  pi.on("agent_end", (event: { willContinue?: unknown; messages?: unknown }, ctx: RecoveryContext) => {
    // Core owns an already-scheduled retry. Never inject an extra follow-up.
    if (event?.willContinue === true) {
      cancelRecovery();
      cancelTransport();
      return;
    }
    pruneHits(state, Date.now());
    const summary = describeTerminal(event?.messages);
    const rateInfo = terminalRateLimitMessage(event?.messages);
    cancelRecovery();
    if (rateInfo) {
      const text = rateInfo !== null && typeof rateInfo === "object" && "errorMessage" in rateInfo ? rateInfo.errorMessage : undefined;
      const tmsg = Array.isArray(event?.messages) ? lastAssistantMessage(event.messages) : undefined;
      const provider = eventProvider(ctx, tmsg, text);
      pi.logger?.debug?.("[bpb-rotate] agent_end: terminal rate-limit", { ...summary, provider });
      if (noteQuota(text, "agent-end", provider)) {
        logEvent("quota_standdown", { source: "agent-end", provider, errorTail: summary.errorTail });
        ctx?.ui?.notify?.("Account quota exhausted — new exit IP won't help; waiting out the reset", "warning");
      } else if (Date.now() < getQuotaHold(provider)) {
        logEvent("quota_standdown", { source: "agent-end", provider, held: true, errorTail: summary.errorTail });
      } else if (provider !== undefined && provider.toLowerCase() !== "opencode-zen") {
        pi.logger?.debug?.("[bpb-rotate] agent_end: non-zen provider 429; no recovery — rotation cannot help", { provider, errorTail: summary.errorTail });
        logEvent("provider_standdown", { source: "agent-end", provider, errorTail: summary.errorTail });
      } else {
        maybeScheduleRecovery(ctx);
      }
      return;
    }
    const transportInfo = terminalTransportMessage(event?.messages);
    if (transportInfo) {
      pi.logger?.debug?.("[bpb-rotate] agent_end: terminal transport error", summary);
      maybeScheduleTransportRetry(ctx, transportInfo);
      return;
    }
    // Turn settled (success, abort, or other failure): no recovery ride-along.
    // Terminal-only detectors above guarantee a stale error buried behind a
    // later success/abort can never re-fire here (the phantom-resend bug).
    pi.logger?.debug?.("[bpb-rotate] agent_end: settled, clearing pending", summary);
    cancelRecovery();
    cancelTransport();
  });

  pi.on("session_shutdown", () => {
    cancelRecovery();
    cancelTransport();
  });

  pi.registerCommand("bpb-rotate", {
    description: "Rotate BPB exit node now (bpb-rotate.py --auto)",
    handler: async (args: string, ctx: any) => {
      const panel = args.trim();
      if (panel) cfg.panel = panel;
      await runRotation("manual", ctx);
      await checkRecovery();
    },
  });

  pi.registerCommand("bpb-rotate-status", {
    description: "Show BPB rotation config and last rotation",
    handler: async (_args: string, ctx: any) => {
      mergeSharedState();
      const last = state.lastRotateAt ? new Date(state.lastRotateAt).toLocaleString() : "never";
      const shared = readSharedState(cfg.stateFile);
      const holds = mergedHolds(quotaHolds, shared?.quotaHoldUntil);
      const holdStr =
        Object.entries(holds)
          .filter(([, v]) => v > Date.now())
          .map(([k, v]) => `${k}~${Math.ceil((v - Date.now()) / 60000)}m`)
          .join(", ") || "none";
      ctx?.ui?.notify?.(
        `bpb-rotate: panel=${cfg.panel || "auto(active v2rayN sub)"} last=${last} ` +
          `rate-hits=${state.rateHits.length}/${cfg.maxPerHour}/h interval=${Math.round(cfg.intervalMs / 60000)}m ` +
          `recovery=${pendingRecovery ? "scheduled" : waiting ? "waiting-for-egress" : "idle"}` +
          ` transport=${pendingTransport ? "scheduled" : "idle"}` +
          ` quota-holds=${holdStr}`,
        "info",
      );
    },
  });
}
