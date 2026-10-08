# omp-zen-recovery

Native OMP plugin for OpenCode Zen identity, fresh HTTP connections, TUN cutover recovery, and bounded transport/TLS retries. Extracted from [bpb-rotate](https://github.com/omid511/bpb-rotate).

## Install

```bash
omp plugin install github:omid511/omp-zen-recovery
```

Restart OMP once and resume your existing conversation. No new chat or `/fresh` is needed. Update through OMP's plugin manager:

```bash
omp plugin upgrade omp-zen-recovery
```

If you previously copied `bpb-rate-limit-rotate.ts` and `zen-spoof.ts` into `~/.omp/agent/extensions`, remove those two copies after installing the plugin. Loading both copies would install duplicate recovery handlers. Keep unrelated extensions.

Install and configure the separate `bpb-rotate` CLI for automatic IP rotation. The plugin calls `bpb-rotate` from PATH by default, supporting Python-installed CLI and standalone binaries. `BPB_ROTATE_SCRIPT` can instead name a custom executable or a `.py` entrypoint; `.py` files are invoked with `python3`.

Keep your existing Zen provider identity headers (`User-Agent: opencode/<version>`, `x-opencode-client: cli`, `x-opencode-project: global`). This plugin rewrites session/request IDs, not credentials, tool declarations, or those headers.

## Recovery

- **Terminal Zen 429:** sample provider-host public egress before a turn, then watch for a changed IP while the failed conversation is idle. Automatic panel rotations, `/bpb-rotate`, and external/manual TUN rotations can all wake the same conversation.
- **Panel success is not transport success:** a continuation normally waits for observed egress change. If the pre-turn trace failed, one explicitly unverified fresh-request attempt is permitted after known panel success. The provider's next response determines recovery.
- **Unknown certificate error:** `unknown certificate error` and `UNKNOWN_CERTIFICATE_ERROR` enter the existing bounded transport-retry path. Retry after 15 seconds by default, at most three retries per ten-minute window shared across sessions. TLS verification remains enabled; no insecure fetch option, certificate exception, or trust-store change is installed. A persistent invalid certificate requires repairing the certificate/trust chain; retry cannot make it valid.
- **Other transient transport failures:** closed sockets, DNS failures, timeouts and selected 5xx failures share that transport budget. TLS/transport errors do not rotate IPs by themselves.
- **Codex account quota:** a terminal `usage_limit_reached` / “The usage limit has been reached” arms each failed Codex conversation independently. OMP's model usage-health API supplies `resetsAt`; the plugin schedules a wakeup for **reset + 120 seconds**. At that deadline it checks quota again: if another window remains exhausted, it waits for that reset plus two minutes instead of issuing a premature continuation. This never rotates IPs, redeems reset credits, clears account blocks, or consumes the Zen/transport retry budget.
- A selected account is honored when present. Without account affinity (including reopened multi-account chats), the alarm uses an available account or the earliest known account reset, then rechecks availability at the deadline. If quota is already available on the first lookup, it waits two minutes from that observation. Missing usable reset data is rechecked once a minute, never replaced with a guessed one-hour reset. Queries are bounded to ten seconds and cancelled with the chat's lifecycle. A reopened failed chat rearms through its session history; closed processes cannot run timers. Early healthy quota reports do not bypass an already-armed grace period.
- Core-owned retries never receive an extra extension continuation. New turns, success, abort, session switch and shutdown cancel pending recovery. Explicit account quotas and non-Zen 429s never trigger Zen revival.

Zen requests force `keepalive: false` only on HTTPS `opencode.ai/zen/v1/{chat/completions,responses,messages}`. Native session IDs map to stable isolated gateway IDs; each request gets a fresh request ID. Bodies, cancellation and prompt-cache keys remain intact. A connection is not a prompt cache.

Codex reset timing uses the host's [HealthApi.model](https://github.com/can1357/oh-my-pi/blob/v18.4.4/packages/ai/src/auth/types.ts) and [selected-account health implementation](https://github.com/can1357/oh-my-pi/blob/v18.4.4/packages/ai/src/auth/health.ts). It reads the normalized millisecond timestamp rather than trying to recover reset fields discarded from the formatted Codex error message.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BPB_ROTATE_SCRIPT` | `bpb-rotate` | Rotator executable or Python entrypoint |
| `BPB_ROTATE_PANEL` | automatic | Active v2rayN subscription's panel |
| `BPB_ROTATE_ON_RATE_LIMIT` | `true` | Automatic rotation on eligible 429s |
| `BPB_ROTATE_ON_HOURLY` | `true` | Shared hourly rotation schedule |
| `BPB_ROTATE_MAX_PER_HOUR` | `15` | Rotation budget |
| `BPB_ROTATE_MIN_GAP_MS` | `0` | Minimum gap between rotations |
| `BPB_ROTATE_SETTLE_MS` | `75000` | Suppress duplicate panel rotations; does not delay recovery |
| `BPB_ROTATE_RECOVERY` | `true` | Failed-429-chat revival |
| `BPB_ROTATE_RECOVERY_DELAY_MS` | `0` | Additional delay after cutover detection |
| `BPB_ROTATE_EGRESS_POLL_MS` | `2000` | Failed-chat-only polling; minimum 20 ms |
| `BPB_ROTATE_EGRESS_URL` | `https://opencode.ai/cdn-cgi/trace` | Trace endpoint returning `ip=...` |
| `BPB_ROTATE_TRANSPORT_RETRY` | `true` | Includes unknown certificate errors |
| `BPB_ROTATE_TRANSPORT_DELAY_MS` | `15000` | Transport retry delay |
| `BPB_ROTATE_TRANSPORT_MAX` | `3` | Shared transport retry budget |
| `BPB_ROTATE_TRANSPORT_WINDOW_MS` | `600000` | Transport retry budget window |
| `BPB_ROTATE_EVENT_LOG` | `~/.config/bpb-rotate/events.log` | Rotation/recovery JSONL events |

Trace requests use fresh connections, request no caching, and time out after three seconds. Changing the trace host can sample a different TUN route. Remove any old `BPB_ROTATE_RECOVERY_DELAY_MS=75000` override for immediate continuation after detected cutover.

Commands: `/bpb-rotate [panel]` and `/bpb-rotate-status`. Manual rotation does not wait out a core retry sleep. Status distinguishes `waiting-for-egress`, `scheduled`, and `idle`.

## Development

```bash
bun test tests/
```

Regression coverage includes certificate retry limits/cancellation, external cutover, rotation completion races, parent/child isolation, quota guards, and request/header precedence.

Verified with 27 regression tests, native GitHub plugin installation and
`omp plugin doctor`. An isolated real OMP 18.4.4 RPC session using the
natively installed plugin automatically continued after an injected terminal
`unknown certificate error`, receiving HTTP 200 from a local provider fixture.
The CLI runner was also exercised against an executable fixture. These are
local recovery/installation checks, not a claim that a real invalid certificate
or provider quota has been repaired.

### 1.1.0 — Codex reset wakeups

Added independent per-chat account-quota wakeups at the selected model's reset plus two minutes. Verified with 43 plugin tests, including separate parent/child wakeups, overlapping exhausted windows, lifecycle cancellation and fencing of late responses. An HTTP-backed smoke with accelerated managed time observed two usage queries, a deadline exactly 120,000 ms after reset, and one successful continuation in the original conversation. This validates local timing and recovery; it does not claim a live Codex account reset was observed.

### 1.1.1 — Actually start the idle Codex chat

Fixed two alarm failures: multiple accounts without a `selected` marker previously polled forever, and explicit `deliverAs: "followUp"` merely queued the alarm's `continue` without starting an idle turn. Codex wakeup now omits that option to enter OMP's prompt flow. The unpinned-account regressions failed before the fix and pass afterward. A real isolated OMP RPC smoke using accelerated managed timers and two unpinned account reports observed the alarm at reset + 120,000 ms and a completed response from one local provider request; before the dispatch fix it observed only a queued `continue`, with no provider request. No live Codex quota reset or OpenCode rotation behavior is claimed by this verification.


