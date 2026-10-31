import { describe, expect, it, vi } from "vitest";
import { handleAnthropicProxy, upstreamPath } from "../api/anthropic";

const ENV = { ANTHROPIC_API_KEY: "sk-server", APP_PASSCODE: "letmein" };

function req(path: string, init: RequestInit & { passcode?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.passcode !== undefined) headers.set("x-app-passcode", init.passcode);
  return new Request(`https://my-gto.vercel.app${path}`, { ...init, headers });
}

const messagesBody = JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [] });

describe("anthropic proxy", () => {
  it("fails closed when the API key is missing", async () => {
    const res = await handleAnthropicProxy(req("/api/anthropic?path=v1/messages", { passcode: "x" }), { APP_PASSCODE: "x" });
    expect(res.status).toBe(503);
    expect((await res.json()).error.type).toBe("proxy_error");
  });

  it("skips the passcode check when APP_PASSCODE is not set", async () => {
    const upstream = vi.fn(async () => Response.json({ id: "claude-opus-5-5" }));
    const res = await handleAnthropicProxy(
      req("/api/anthropic?path=v1/models/claude-opus-5-5"),
      { ANTHROPIC_API_KEY: "sk-server" },
      upstream as unknown as typeof fetch,
    );
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("rejects a wrong or missing passcode", async () => {
    const upstream = vi.fn();
    expect((await handleAnthropicProxy(req("/api/anthropic?path=v1/messages", { passcode: "nope" }), ENV, upstream)).status).toBe(401);
    expect((await handleAnthropicProxy(req("/api/anthropic?path=v1/messages"), ENV, upstream)).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("only allows the app's endpoints, methods and models", async () => {
    const upstream = vi.fn();
    const call = (path: string, init: RequestInit = {}) =>
      handleAnthropicProxy(req(path, { passcode: "letmein", ...init }), ENV, upstream);
    expect((await call("/api/anthropic?path=v1/organizations/me")).status).toBe(404);
    expect((await call("/api/anthropic?path=v1/messages")).status).toBe(405);
    expect(
      (await call("/api/anthropic?path=v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-fable-5-1" }) })).status,
    ).toBe(400);
    expect((await call("/api/anthropic?path=v1/messages", { method: "POST", body: "not json" })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("forwards messages with the server key and streams the response back", async () => {
    const upstream = vi.fn(async () =>
      new Response("event: message_stop\ndata: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream", "request-id": "req_1", "x-internal": "drop" },
      }),
    );
    const res = await handleAnthropicProxy(
      req("/api/anthropic?path=v1/messages&beta=true", {
        method: "POST",
        passcode: "letmein",
        body: messagesBody,
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "server-side-fallback-2026-07-01",
          "x-api-key": "client-placeholder",
        },
      }),
      ENV,
      upstream as unknown as typeof fetch,
    );
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    const sent = new Headers(init.headers);
    expect(sent.get("x-api-key")).toBe("sk-server");
    expect(sent.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(sent.get("x-app-passcode")).toBeNull();
    expect(init.body).toBe(messagesBody);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-internal")).toBeNull();
    expect(await res.text()).toContain("message_stop");
  });

  it("passes upstream errors through unchanged", async () => {
    const upstream = vi.fn(async () => Response.json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { status: 429 }));
    const res = await handleAnthropicProxy(
      req("/api/anthropic?path=v1/models/claude-opus-5-5", { passcode: "letmein" }),
      ENV,
      upstream as unknown as typeof fetch,
    );
    expect(res.status).toBe(429);
    expect((await res.json()).error.type).toBe("rate_limit_error");
  });

  it("reads the path from the rewrite param or the raw pathname", () => {
    expect(upstreamPath(new URL("https://x/api/anthropic?path=v1/messages"))).toBe("v1/messages");
    expect(upstreamPath(new URL("https://x/api/anthropic/v1/models/claude-opus-5-5"))).toBe("v1/models/claude-opus-5-5");
    expect(upstreamPath(new URL("https://x/api/anthropic?path=v1/models/../admin"))).toBeNull();
  });
});
