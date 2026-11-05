import { describe, expect, it } from "vitest";
import { handleV1 } from "../../api/v1";
import { NOW, SECRET } from "./helpers";

const req = (path: string) => new Request(`https://pubaz.vercel.app${path}`);

describe("api/v1 entry (fails closed)", () => {
  it("returns 503 when unconfigured", async () => {
    for (const env of [
      {},
      { AUTH_SECRET: SECRET },
      { SERVER_MODE: "memory" },
      { SERVER_MODE: "memory", AUTH_SECRET: "short" },
      { SERVER_MODE: "postgres", AUTH_SECRET: SECRET, DATABASE_URL: "postgres://x" },
      { SERVER_MODE: "memory", AUTH_SECRET: SECRET, VERCEL_ENV: "production" },
    ]) {
      const res = await handleV1(req("/api/v1?path=health"), env, () => NOW);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: { code: "unavailable", message: "서버 준비 중" } });
    }
  });

  it("serves the dev-only memory mode when explicitly enabled", async () => {
    const res = await handleV1(req("/api/v1?path=health"), { SERVER_MODE: "memory", AUTH_SECRET: SECRET }, () => NOW);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
