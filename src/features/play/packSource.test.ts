import { describe, expect, it } from "vitest";
import type { Manifest } from "../../presolve/format";
import { readManifest } from "../../play/testPacks";
import type { PackClient } from "../solver/packs";
import { createPackSource } from "./packSource";

/** The AI table's pack source over a fake client: a bad manifest entry or a failed fetch never sticks for the session. */

function fakeClient(answers: (() => Promise<Manifest>)[]): PackClient & { calls: number } {
  const c = {
    base: "/packs/",
    calls: 0,
    manifest() {
      const f = answers[Math.min(c.calls++, answers.length - 1)];
      return f().then((manifest) => ({ status: "ready" as const, manifest, problems: [] }));
    },
    flop: () => Promise.reject(new Error("no flop files here")),
    reset() {},
  };
  return c;
}

describe("pack source", () => {
  it("skips a malformed manifest entry and keeps the others", async () => {
    const m = readManifest();
    const bad = { ...m.packs[0], id: "bad", scenario: { ...m.packs[0].scenario, rangeSources: [m.packs[0].scenario.rangeSources![0]] as unknown as [string, string] } };
    const src = createPackSource(fakeClient([async () => ({ ...m, packs: [bad, ...m.packs] })]));
    expect(await src.load({ kind: "manifest" })).toBe(true);
    expect(src.packs()!.map((p) => p.id).sort()).toEqual(["pub-srp-btn-bb-55", "pub-srp-utg-bb-55", "srp-btn-bb-100"]);
  });

  it("asks again after a failed manifest load, and a failed flop load answers false", async () => {
    const m = readManifest();
    const client = fakeClient([() => Promise.reject(new TypeError("offline")), async () => m]);
    const src = createPackSource(client);
    expect(await src.load({ kind: "manifest" })).toBe(false);
    expect(src.packs()).toBeNull();
    expect(await src.load({ kind: "manifest" })).toBe(true);
    expect(client.calls).toBe(2);
    expect(src.packs()!.length).toBe(3);
    const path = src.packs()![0].files.values().next().value!.path;
    expect(await src.load({ kind: "flop", path })).toBe(false);
  });
});
