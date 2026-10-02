// Give each native Zen session a stable gateway ID and each request a fresh ID.
import { createHash, randomBytes } from "node:crypto";

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MASK48 = BigInt("0xffffffffffff");
const OFFICIAL_SESSION_ID = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const ZEN_PATH = /^\/zen\/v1\/(?:chat\/completions|responses|messages)\/?$/;
const WRAP_KEY = Symbol.for("omp.zenSpoof.fetchWrapped");

let lastTs = 0;
let counter = 0;

function mintRequestId() {
  const nowMs = Date.now();
  if (nowMs !== lastTs) {
    lastTs = nowMs;
    counter = 0;
  }
  counter++;
  const now = (BigInt(nowMs) * BigInt(0x1000) + BigInt(counter)) & MASK48;
  const timestamp = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) timestamp[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
  const random = randomBytes(14);
  let suffix = "";
  for (let i = 0; i < 14; i++) suffix += B62[random[i] % 62];
  return `msg_${timestamp.toString("hex")}${suffix}`;
}

function sessionIdFor(nativeId: string | null) {
  if (nativeId && OFFICIAL_SESSION_ID.test(nativeId)) return nativeId;
  const material = nativeId
    ? `omp:zen:native-session\0${nativeId}`
    : "omp:zen:missing-native-session";
  const digest = createHash("sha256").update(material).digest();
  let suffix = "";
  for (let i = 6; i < 20; i++) suffix += B62[digest[i] % 62];
  return `ses_${digest.subarray(0, 6).toString("hex")}${suffix}`;
}

function isZenEndpoint(input: RequestInfo | URL) {
  const rawUrl = input instanceof Request
    ? input.url
    : input instanceof URL
      ? input.href
      : input;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.hostname !== "opencode.ai") return false;
  return ZEN_PATH.test(url.pathname);
}

export default function (pi) {
  const originalFetch = globalThis.fetch;
  const taggedFetch = originalFetch as typeof fetch & { [WRAP_KEY]?: boolean };
  if (taggedFetch[WRAP_KEY]) return;
  const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const zen = isZenEndpoint(input);
    let nextInit = init;
    let startedAt = 0;
    if (zen) {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      if (init?.headers != null) {
        new Headers(init.headers).forEach((value, name) => headers.set(name, value));
      }
      headers.set("x-opencode-session", sessionIdFor(headers.get("x-opencode-session")));
      headers.set("x-opencode-request", mintRequestId());
      nextInit = { ...(init ?? {}), headers, keepalive: false };
      startedAt = Date.now();
    }

    try {
      const response = await originalFetch.call(globalThis, input, nextInit);
      if (zen) pi.logger?.debug?.("[zen-spoof] zen fetch", { ms: Date.now() - startedAt, status: response?.status });
      return response;
    } catch (error: unknown) {
      if (zen) pi.logger?.debug?.("[zen-spoof] zen fetch threw", { ms: Date.now() - startedAt });
      throw error;
    }
  };

  const preconnect = (originalFetch as typeof fetch & { preconnect?: (...args: any[]) => any }).preconnect;
  if (typeof preconnect === "function") {
    Object.defineProperty(wrappedFetch, "preconnect", {
      configurable: true,
      value: preconnect.bind(originalFetch),
    });
  }

  globalThis.fetch = wrappedFetch;
  Object.defineProperty(wrappedFetch, WRAP_KEY, { value: true });
}
