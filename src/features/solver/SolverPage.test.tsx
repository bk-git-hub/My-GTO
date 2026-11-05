import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeFlopFile, validateFlopFile, validateManifest, type FlopFile, type Manifest, type PackEntry } from "../../presolve/format";
import { buildSyntheticPacks } from "../../../tests/fixtures/solverPack";
import { ComboDetail } from "./ComboDetail";
import { FlopView } from "./FlopView";
import { createPackClient, packsBase, type LoadedFlop } from "./packs";
import { DEFAULT_REPORT, ReportView } from "./ReportView";
import { ScenarioPicker } from "./ScenarioPicker";
import { SolverPage } from "./SolverPage";
import { aggregateByHandClass } from "../../presolve/format";
import { actionColors, unblockedCounts } from "./view";

let manifest: Manifest;
let flops: Map<string, FlopFile>;
let files: { path: string; json: string }[];

beforeAll(async () => {
  ({ manifest, flops, files } = await buildSyntheticPacks());
});

const noop = () => {};
/** renderToString puts <!-- --> between adjacent text nodes. */
const render = (el: ReactElement) => renderToString(el).replace(/<!-- -->/g, "");

function loaded(path: string): LoadedFlop {
  const file = flops.get(path)!;
  const entry = manifest.packs.flatMap((p) => p.files).find((f) => f.path === path)!;
  return { entry, file, flop: decodeFlopFile(file), bytes: entry.bytes, integrity: Promise.resolve("ok") };
}

describe("synthetic pack fixture", () => {
  it("is valid per the pack format", () => {
    expect(validateManifest(manifest)).toEqual([]);
    expect(manifest.packs.map((p) => p.files.length)).toEqual([3, 3]);
    for (const f of flops.values()) expect(validateFlopFile(f)).toEqual([]);
    for (const { json } of files) expect(json.length).toBeLessThan(96 * 1024);
    // depth ≤ 2 plus raise responses
    const first = flops.get(manifest.packs[0].files[0].path)!;
    expect(first.nodes.some((n) => n.path.length === 3)).toBe(true);
  });
});

describe("smoke render (react-dom/server)", () => {
  it("renders the scenario list", () => {
    const html = render(<ScenarioPicker packs={manifest.packs} onPick={noop} />);
    expect(html).toContain("BTN vs BB 싱글 레이즈드 팟 (100bb)");
    expect(html).toContain("캐시 6맥스");
    expect(html).toContain("펍 토너먼트");
    expect(html).toContain("Pro");
  });

  it("renders the report with every flop, the average row and filter chips", () => {
    const pack = manifest.packs[0];
    const html = render(<ReportView pack={pack} state={DEFAULT_REPORT} onState={noop} onOpen={noop} onBack={noop} />);
    expect(html).toContain("전체 평균");
    expect(html).toContain("레인보우");
    expect(html).toContain("모노톤");
    expect(html).toContain("BB 벳");
    expect(html).toContain("BTN 벳");
    expect((html.match(/class="sv-tr"/g) ?? []).length).toBe(3);
    const filtered = render(<ReportView pack={pack} state={{ ...DEFAULT_REPORT, chips: ["monotone"] }} onState={noop} onOpen={noop} onBack={noop} />);
    expect(filtered).toContain("조건에 맞는 플랍이 없어요");
    expect(filtered).toContain("필터 평균");
  });

  it("gives the report table valid table roles", () => {
    const pack = manifest.packs[0];
    const html = render(<ReportView pack={pack} state={DEFAULT_REPORT} onState={noop} onOpen={noop} onBack={noop} />);
    // aria-sort belongs on the column header, not on its button; rows are not buttons.
    expect(html).not.toMatch(/<button[^>]*aria-sort/);
    expect(html).not.toMatch(/<button[^>]*role="row"/);
    expect((html.match(/role="columnheader"/g) ?? []).length).toBe(5);
    expect(html).toMatch(/role="columnheader" aria-sort="descending"><button class="sv-th on"/);
    // head + average + one row per flop, each average/flop row with a row header and four cells
    expect((html.match(/role="row"/g) ?? []).length).toBe(2 + pack.files.length);
    expect((html.match(/role="rowheader"/g) ?? []).length).toBe(1 + pack.files.length);
    expect((html.match(/role="cell"/g) ?? []).length).toBe(4 * (1 + pack.files.length));
    expect((html.match(/class="sv-open"/g) ?? []).length).toBe(pack.files.length);
    const filtered = render(<ReportView pack={pack} state={{ ...DEFAULT_REPORT, chips: ["monotone"] }} onState={noop} onOpen={noop} onBack={noop} />);
    // The empty-state note sits after the table, not inside role=table.
    const from = filtered.lastIndexOf("<div", filtered.indexOf('role="table"'));
    let depth = 0;
    let closedAt = -1;
    for (const m of filtered.slice(from).matchAll(/<div|<\/div>/g)) {
      depth += m[0] === "<div" ? 1 : -1;
      if (depth === 0) {
        closedAt = from + m.index!;
        break;
      }
    }
    expect(closedAt).toBeGreaterThan(from);
    expect(closedAt).toBeLessThan(filtered.indexOf("조건에 맞는"));
  });

  it("shows OOP's answer to each c-bet when its first action is only a check", () => {
    const base = manifest.packs[0];
    const pack: PackEntry = {
      ...base,
      summaryNodes: [
        { path: [], player: 0, labels: ["체크"], kinds: ["check"] },
        { path: [0], player: 1, labels: ["체크", "벳 33%", "벳 75%"], kinds: ["check", "bet", "bet"] },
        { path: [0, 1], player: 0, labels: ["폴드", "콜", "레이즈 7.3"], kinds: ["fold", "call", "raise"] },
        { path: [0, 2], player: 0, labels: ["폴드", "콜", "레이즈 12.4"], kinds: ["fold", "call", "raise"] },
      ],
      files: base.files.map((f) => ({ ...f, summary: { ...f.summary, freq: [[1], [0.45, 0.15, 0.4], [0.32, 0.53, 0.15], [0.5, 0.43, 0.07]] } })),
    };
    const html = render(<ReportView pack={pack} state={DEFAULT_REPORT} onState={noop} onOpen={noop} onBack={noop} />);
    expect(html).not.toContain("BB 벳");
    expect(html).toContain("BB 폴드");
    expect(html).toContain("BB 열");
    expect(html).toContain("vs 벳 33%");
    expect(html).toContain("vs 벳 75%");
    expect(html).toContain("BTN 벳");
    expect(html).toContain("32%");
    const vs75 = render(<ReportView pack={pack} state={{ ...DEFAULT_REPORT, oopCol: 1 }} onState={noop} onOpen={noop} onBack={noop} />);
    expect(vs75).toContain("50%");
    expect(vs75).toMatch(/aria-pressed="true"[^>]*>vs 벳 75%/);
  });

  it("renders a flop node with grid, actions and a selected hand", () => {
    const pack = manifest.packs[0];
    const lf = loaded(pack.files[0].path);
    const html = render(
      <FlopView pack={pack} loaded={lf} path={[0]} selected="AKs" onSelect={noop} onPath={noop} onReport={noop} gridMode="strategy" onGridMode={noop} />,
    );
    expect(html).toContain("BTN</b> 차례");
    expect(html).toContain("BB</b> 체크");
    expect((html.match(/sv-cell/g) ?? []).length).toBeGreaterThanOrEqual(169);
    expect(html).toContain("sv-cell empty");
    expect(html).toContain("AKs");
    expect(html).toContain("평균");
    expect(html).toContain("→ 턴");
    // Every action has a button.
    expect((html.match(/class="sv-act"/g) ?? []).length).toBe(lf.flop.node([0])!.actions.length);
    // Labels never take a per-cell color (they can sit over several colors); styles.css gives them a halo.
    expect((html.match(/<span class="sv-lab">/g) ?? []).length).toBe(169);
    expect(html).toContain("비중 ");
    expect(html).not.toMatch(/비중 \d+</);
  });

  it("renders the end of the flop and a missing line", () => {
    const pack = manifest.packs[0];
    const lf = loaded(pack.files[0].path);
    const street = render(
      <FlopView pack={pack} loaded={lf} path={[0, 0]} selected={null} onSelect={noop} onPath={noop} onReport={noop} gridMode="range" onGridMode={noop} />,
    );
    expect(street).toContain("턴은 실시간 계산 예정");
    const fold = render(
      <FlopView pack={pack} loaded={lf} path={[1, 0]} selected={null} onSelect={noop} onPath={noop} onReport={noop} gridMode="strategy" onGridMode={noop} />,
    );
    expect(fold).toContain("BTN 폴드");
    // No particle after a position name; nothing put in on the flop → no "0bb를 잃어요".
    expect(fold).toContain("BB 승리 · 팟 ");
    expect(fold).toContain("BTN 쪽은 플랍에서 추가로 잃은 칩이 없어요.");
    expect(fold).not.toMatch(/BTN[가는]|0bb를 잃어요/);
    // Folding to a check-raise loses the c-bet.
    const raised = lf.flop.nodes.find((n) => n.path.length === 3 && n.actions[0].kind === "fold")!;
    const foldToRaise = render(
      <FlopView pack={pack} loaded={lf} path={[...raised.path, 0]} selected={null} onSelect={noop} onPath={noop} onReport={noop} gridMode="strategy" onGridMode={noop} />,
    );
    expect(foldToRaise).toMatch(/쪽은 플랍에서 넣은 \d+(\.\d)?bb를 잃어요\./);
    const bad = render(
      <FlopView pack={pack} loaded={lf} path={[7, 7]} selected={null} onSelect={noop} onPath={noop} onReport={noop} gridMode="strategy" onGridMode={noop} />,
    );
    expect(bad).toContain("이 라인은 이 파일에 없어요");
  });

  it("renders combo detail rows for a hand", () => {
    const pack = manifest.packs[1];
    const lf = loaded(pack.files[0].path);
    const node = lf.flop.node([])!;
    const agg = aggregateByHandClass(node);
    const hand = (Object.keys(agg) as string[]).find((h) => agg[h].combos > 2)!;
    const html = render(
      <ComboDetail node={node} hand={hand} agg={agg[hand]} colors={actionColors(node.actions, node)} who="BB" unblocked={unblockedCounts(lf.flop.board)[hand]} onClose={noop} />,
    );
    expect((html.match(/class="sv-crow"/g) ?? []).length).toBe(agg[hand].combos);
    expect(html).toContain("best");
  });

  it("SolverPage renders its loading state on the server", () => {
    const client = createPackClient({ base: "/packs/", fetch: () => new Promise<Response>(() => {}) });
    expect(render(<SolverPage sub="" client={client} />)).toContain("불러오는 중");
  });
});

describe("pack client", () => {
  const respond = (status: number, body: string | ArrayBuffer, type = "application/json") =>
    Promise.resolve(new Response(status === 404 ? "not found" : body, { status, headers: { "content-type": type } }));

  it("treats a missing manifest (404 or SPA fallback HTML) as no packs", async () => {
    const warns: string[] = [];
    const a = createPackClient({ base: "/p/", fetch: () => respond(404, ""), warn: (m) => warns.push(m) });
    expect(await a.manifest()).toEqual({ status: "empty" });
    const b = createPackClient({ base: "/p/", fetch: () => respond(200, "<!doctype html><html></html>", "text/html") });
    expect(await b.manifest()).toEqual({ status: "empty" });
    const c = createPackClient({ base: "/p/", fetch: () => respond(500, "") });
    await expect(c.manifest()).rejects.toThrow("HTTP 500");
    expect(warns).toEqual([]);
  });

  it("loads, caches and checks the sha256 of flop files without blocking on a mismatch", async () => {
    const urls: string[] = [];
    const byPath = new Map(files.map((f) => [f.path, f.json]));
    const fetcher = (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === "/p/manifest.json") return respond(200, JSON.stringify(manifest));
      const json = byPath.get(url.slice(3));
      return json === undefined ? respond(404, "") : respond(200, new TextEncoder().encode(json).buffer as ArrayBuffer);
    };
    const warns: string[] = [];
    const client = createPackClient({ base: "/p/", fetch: fetcher, warn: (m) => warns.push(m) });
    const m = await client.manifest();
    expect(m.status).toBe("ready");
    const entry = manifest.packs[0].files[1];
    const lf = await client.flop(entry);
    expect(lf.flop.boardKey).toBe(entry.board);
    expect(await lf.integrity).toBe("ok");
    await client.flop(entry);
    await client.manifest();
    expect(urls.filter((u) => u.endsWith(entry.path)).length).toBe(1);
    expect(urls.filter((u) => u.endsWith("manifest.json")).length).toBe(1);

    const tampered = { ...entry, sha256: "f".repeat(64) };
    const other = createPackClient({ base: "/p/", fetch: fetcher, warn: (m) => warns.push(m) });
    const bad = await other.flop(tampered);
    expect(bad.flop.nodes.length).toBeGreaterThan(0);
    expect(await bad.integrity).toBe("mismatch");
    expect(warns.some((w) => w.includes("sha256"))).toBe(true);

    const noCrypto = createPackClient({ base: "/p/", fetch: fetcher, subtle: null });
    expect(await (await noCrypto.flop(entry)).integrity).toBe("unavailable");

    await expect(client.flop({ ...entry, path: "nope/v1/flop-AsKh7d.json" })).rejects.toThrow("서버에 없어요");
  });

  it("honours ?packs= only in dev builds", () => {
    expect(packsBase("./", false, "?packs=packs-dev")).toBe("./packs/");
    expect(packsBase("./", true, "?packs=packs-dev")).toBe("./packs-dev/");
    expect(packsBase("./", true, "?packs=../secret")).toBe("./packs/");
    expect(packsBase("/app/", true, "")).toBe("/app/packs/");
  });
});
