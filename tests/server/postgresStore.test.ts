import { describe, expect, it } from "vitest";
import { PostgresStore, type SqlClient } from "../../server/store.postgres";
import { makeAttempt } from "./helpers";

/** Records statements and answers from a queue of canned row sets. */
function fakeSql(answers: unknown[][]) {
  const calls: { text: string; params: unknown[] }[] = [];
  const sql: SqlClient = {
    async query<T>(text: string, params: unknown[]) {
      calls.push({ text, params });
      return { rows: (answers.shift() ?? []) as T[] };
    },
  };
  return { sql, calls };
}

describe("PostgresStore (fake SqlClient)", () => {
  it("inserts with ON CONFLICT DO NOTHING and derives duplicates", async () => {
    const a = makeAttempt();
    const b = makeAttempt({ title: "'; DROP TABLE users; --" });
    const { sql, calls } = fakeSql([[{ id: a.id }]]);
    const res = await new PostgresStore(sql).insertAttempts("USER", [b, a]);
    expect(res).toEqual({ accepted: [a.id], duplicates: [b.id] });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("ON CONFLICT (user_id, id) DO NOTHING");
    expect(calls[0].text).toContain("FOR UPDATE");
    expect(calls[0].text).not.toContain("DROP TABLE");
    expect(calls[0].params[0]).toBe("USER");
    expect(JSON.parse(calls[0].params[1] as string)[1].payload.title).toBe(b.title);
  });

  it("pages by seq and keeps the cursor as text", async () => {
    const a = makeAttempt();
    const { sql, calls } = fakeSql([[{ seq: "42", payload: a }], []]);
    const store = new PostgresStore(sql);
    expect(await store.listAttempts("USER", null, 10)).toEqual({ attempts: [a], cursor: "42" });
    expect(calls[0].params).toEqual(["USER", "0", 10]);
    expect(await store.listAttempts("USER", "42", 10)).toEqual({ attempts: [], cursor: null });
  });

  it("consumes usage atomically and reports the count when over the limit", async () => {
    const { sql, calls } = fakeSql([[{ count: 3 }], [], [{ count: 5 }]]);
    const store = new PostgresStore(sql);
    expect(await store.consumeUsage("U", "coach", "2026-11-05", 5)).toEqual({ allowed: true, used: 3 });
    expect(await store.consumeUsage("U", "coach", "2026-11-05", 5)).toEqual({ allowed: false, used: 5 });
    expect(calls[0].text).toContain("WHERE usage_counters.count < $4");
  });

  it("creates the user and device on first sight", async () => {
    const { sql, calls } = fakeSql([[], [], [{ id: "NEWUSER", created_ms: "1700000000000" }]]);
    const user = await new PostgresStore(sql).getOrCreateUserForDevice("DEV", "NEWUSER", 1700000000000);
    expect(user).toEqual({ id: "NEWUSER", createdAt: 1700000000000 });
    expect(calls).toHaveLength(3);
    expect(calls[1].text).toContain("ON CONFLICT (device_id) DO UPDATE");
    expect(calls[1].params).toEqual(["DEV", "NEWUSER", 1700000000000]);
  });
});
