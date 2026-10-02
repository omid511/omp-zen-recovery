import { afterEach, beforeEach, expect, test } from "bun:test";
import install from "../extensions/zen-spoof";

type Call = { request: Request; init?: RequestInit };
let originalFetch: typeof fetch;
let calls: Call[];
const endpoint = "https://opencode.ai/zen/v1/chat/completions";
const api = { logger: { debug() {} } };

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  const capture = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ request: new Request(input, init), init });
    return new Response("ok");
  };
  // Bun's extra static fetch property is irrelevant to this isolated transport.
  globalThis.fetch = capture as typeof fetch;
  install(api);
});
afterEach(() => { globalThis.fetch = originalFetch; });

async function send(session?: string) {
  await fetch(endpoint, { headers: session ? { "x-opencode-session": session } : {} });
  return calls[calls.length - 1].request.headers;
}

test("parent identity survives child installation; fresh native session gets a different identity", async () => {
  const parent = await send("parent-native");
  install(api);
  const child = await send("child-native");
  const parentAgain = await send("parent-native");
  const fresh = await send("fresh-native");
  expect(parent.get("x-opencode-session")).toMatch(/^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
  expect(parentAgain.get("x-opencode-session")).toBe(parent.get("x-opencode-session"));
  expect(child.get("x-opencode-session")).not.toBe(parent.get("x-opencode-session"));
  expect(fresh.get("x-opencode-session")).not.toBe(parent.get("x-opencode-session"));
  expect(parentAgain.get("x-opencode-request")).not.toBe(parent.get("x-opencode-request"));
  expect(parentAgain.get("x-opencode-request")).toMatch(/^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
});

test("Request init headers win before normalization without losing body or abort signal", async () => {
  const controller = new AbortController();
  const request = new Request(endpoint, { method: "POST", body: "original payload", headers: { "x-opencode-session": "wrong-native", "x-extra": "old" } });
  await fetch(request, { headers: { "x-opencode-session": "right-native", "x-extra": "new", Authorization: "test-token" }, signal: controller.signal, keepalive: true });
  const captured = calls[0];
  expect(await captured.request.text()).toBe("original payload");
  expect(captured.request.method).toBe("POST");
  expect(captured.request.headers.get("x-extra")).toBe("new");
  expect(captured.request.headers.get("Authorization")).toBe("test-token");
  expect(captured.init?.signal).toBe(controller.signal);
  expect(captured.init?.keepalive).toBe(false);
  const expected = await send("right-native");
  expect(captured.request.headers.get("x-opencode-session")).toBe(expected.get("x-opencode-session"));
  controller.abort();
  expect(captured.request.signal.aborted).toBe(true);
});

test("official identity is preserved and a missing native identity is stable", async () => {
  const official = "ses_0123456789ab0123456789ABCD";
  expect((await send(official)).get("x-opencode-session")).toBe(official);
  const absent = await send();
  await send("different-session");
  expect((await send()).get("x-opencode-session")).toBe(absent.get("x-opencode-session"));
});

test("only exact Zen host and supported paths force fresh connections", async () => {
  for (const url of [
    "https://opencode.ai.evil.example/zen/v1/chat/completions",
    "https://example.test/path/opencode.ai/zen/v1/chat/completions",
    "https://opencode.ai/cdn-cgi/trace",
    "https://opencode.ai/go/v1/chat/completions",
    "https://opencode.ai/zen/v1/chat/completions/extra",
    "http://opencode.ai/zen/v1/chat/completions",
  ]) {
    await fetch(url, { headers: { "x-opencode-session": "untouched" }, keepalive: true });
    expect(calls[calls.length - 1].request.headers.get("x-opencode-session")).toBe("untouched");
    expect(calls[calls.length - 1].init?.keepalive).toBe(true);
  }
  for (const path of ["chat/completions", "responses", "messages/"]) {
    await fetch(new URL(`https://opencode.ai/zen/v1/${path}?probe=1`), { headers: { "x-opencode-session": "native" }, keepalive: true });
    expect(calls[calls.length - 1].init?.keepalive).toBe(false);
    expect(calls[calls.length - 1].request.headers.get("x-opencode-session")).toMatch(/^ses_/);
  }
});
