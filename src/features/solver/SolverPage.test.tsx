import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeFlopFile, validateFlopFile, validateManifest, type FlopFile, type Manifest, type PackEntry } from "../../presolve/format";
import { buildSyntheticCatalog, buildSyntheticPacks } from "../../../tests/fixtures/solverPack";
import { ComboDetail } from "./ComboDetail";
import { FlopView } from "./FlopView";
import { createPackClient, packsBase, type LoadedFlop } from "./packs";
import { DEFAULT_REPORT, ReportView } from "./ReportView";
import { ScenarioPicker } from "./ScenarioPicker";
import { SolverPage } from "./SolverPage";
import { SpotPicker } from "./SpotPicker";
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
    const html = render(<ScenarioPicker packs={manifest.packs.map((p) => ({ ...p, flops: p.files.length }))} onPick={noop} />);
    expect(html).toContain("BTN vs BB 싱글 레이즈드 팟 (100bb)");
    expect(html).toContain("캐시 6맥스");
    expect(html).toContain("펍 토너먼트");
    expect(html).toContain("Pro");
    expect(html).toContain("플랍 3개");
  });

  it("renders the spot picker: stack and pot, one row per seat, progress, 준비 중 and the earlier packs", async () => {
    const spot = { chart: "solver", stage: "55bb-2.2", stack: 55, pot: "srp", raiser: "BTN", caller: "BB" } as const;
    const { catalog } = await buildSyntheticCatalog(undefined, {
      spots: { "pub-srp-btn-bb-40": spot },
      planned: [
        { id: "sv-srp-hj-bb-55", title: "HJ 오픈 vs BB 콜 · 55bb", pot: 5.9, stack: 51.8, spot: { ...spot, raiser: "HJ" } },
        { id: "sv-srp-sb-bb-55", title: "SB 오픈 vs BB 콜 · 55bb", pot: 7, stack: 51, spot: { ...spot, raiser: "SB", confidence: "low" } },
      ],
    });
    const html = render(<SpotPicker catalog={catalog} onPick={noop} initial={{ stack: 55, pot: "srp" }} />);
    expect(html).toContain("계산된 헤즈업 플랍 전략이에요");
    for (const t of ["55bb", "35bb", "100bb", "싱글 레이즈", "3벳 팟"]) expect(html).toContain(t);
    expect(html).toMatch(/aria-pressed="true"[^>]*>55bb/);
    // Stacks in ascending order.
    expect(html.indexOf(">35bb<")).toBeLessThan(html.indexOf(">55bb<"));
    expect(html.indexOf(">55bb<")).toBeLessThan(html.indexOf(">100bb<"));
    // Five rows: UTG, HJ, CO, BTN, SB against the BB; only the BTN has files.
    expect((html.match(/class="sv-spot( off)?"/g) ?? []).length).toBe(5);
    expect(html).toContain("BTN 오픈 · BB 콜");
    expect(html).toContain("플랍 3/1,755");
    expect(html).toMatch(/HJ 오픈 · BB 콜<\/b><span class="sv-planned">준비 중/);
    expect(html).toContain("팟 5.9bb · 스택 51.8bb · SPR 8.8");
    expect((html.match(/disabled=""/g) ?? []).length).toBe(4);
    // A pack starting from a range the chart rates 낮음 says so, once, with one line explaining it.
    expect((html.match(/class="sv-low">프리플랍 신뢰도 낮음</g) ?? []).length).toBe(1);
    expect(html).toMatch(/SB 오픈 · BB 콜<\/b><span class="sv-planned">준비 중<\/span><\/span><span class="muted small">팟 7bb · 스택 51bb · SPR 7\.3<span class="sv-low">/);
    expect(html).toContain("프리플랍 신뢰도 낮음: 시작 레인지가 된 프리플랍 차트가 덜 확실한 팟이에요.");
    // The cash pack has no solver spot: it is under 다른 팩, folded while a row of the grid has flops.
    expect(html).toContain("다른 팩 (이전 차트)");
    expect(html).toContain("BTN vs BB 싱글 레이즈드 팟 (100bb)");
    expect(html).toMatch(/<details class="sv-others">/);
    expect(html).not.toContain("아직 계산 중이에요");
    const threeBet = render(<SpotPicker catalog={catalog} onPick={noop} initial={{ stack: 55, pot: "3bp" }} />);
    expect((threeBet.match(/class="sv-spot( off)?"/g) ?? []).length).toBe(3);
    for (const t of ["BB 3벳 · BTN 콜", "BTN 3벳 · CO 콜", "SB 3벳 · BTN 콜"]) expect(threeBet).toContain(t);
  });

  it("opens the earlier packs while no row of the chosen stack and pot has a flop yet (the first days of the queue)", async () => {
    const spot = { chart: "solver", stage: "55bb-2.2", stack: 55, pot: "srp", raiser: "BTN", caller: "BB" } as const;
    const { catalog } = await buildSyntheticCatalog(undefined, {
      spots: { "pub-srp-btn-bb-40": spot },
      planned: [{ id: "sv-srp-hj-bb-35", title: "HJ 오픈 vs BB 콜 · 35bb", pot: 5.5, stack: 32, spot: { ...spot, stage: "35bb-2", stack: 35, raiser: "HJ" } }],
    });
    const html = render(<SpotPicker catalog={catalog} onPick={noop} initial={{ stack: 35, pot: "srp" }} />);
    expect((html.match(/class="sv-spot off"/g) ?? []).length).toBe(5);
    expect(html).toContain("아직 계산 중이에요. 그동안 아래 이전 차트 팩을 볼 수 있어요.");
    expect(html).toMatch(/<details class="sv-others" open="">/);
    // At 55bb the BTN's pack has flops: folded again.
    const at55 = render(<SpotPicker catalog={catalog} onPick={noop} initial={{ stack: 55, pot: "srp" }} />);
    expect(at55).toMatch(/<details class="sv-others">/);
  });

  it("shows only the earlier packs, opened, when no solver-chart pack is known", () => {
    const catalog = { packs: manifest.packs.map((p) => ({ ...p, flops: p.files.length, weight: 1, index: { path: "", sha256: "", bytes: 0 } })) };
    const html = render(<SpotPicker catalog={catalog} onPick={noop} initial={{ stack: 55, pot: "srp" }} />);
    expect(html).toContain("준비 중이에요");
    expect(html).toMatch(/<details class="sv-others" open="">/);
    expect(html).not.toContain("sv-spot");
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
    expect(render(<SolverPage sub="" client={client} />)).toContain("팩 불러오는 중");
  });
});

describe("pack client, bundled v1 manifest (no data.json)", () => {
  const respond = (status: number, body: string | ArrayBuffer, type = "application/json") =>
    Promise.resolve(new Response(status === 404 ? "not found" : body, { status, headers: { "content-type": type } }));

  it("treats a missing manifest (404 or SPA fallback HTML) as no packs", async () => {
    const warns: string[] = [];
    const a = createPackClient({ base: "/p/", fetch: () => respond(404, ""), warn: (m) => warns.push(m) });
    expect(await a.catalog()).toEqual({ status: "empty" });
    const b = createPackClient({ base: "/p/", fetch: () => respond(200, "<!doctype html><html></html>", "text/html") });
    expect(await b.catalog()).toEqual({ status: "empty" });
    // data.json missing, the v1 manifest failing: an error to retry.
    const c = createPackClient({ base: "/p/", fetch: (u) => (String(u).endsWith("data.json") ? respond(404, "") : respond(500, "")) });
    await expect(c.catalog()).rejects.toThrow("HTTP 500");
    expect(warns).toEqual([]);
  });

  it("loads, caches and checks the sha256 of flop files without blocking on a mismatch", async () => {
    const urls: string[] = [];
    const byPath = new Map(files.map((f) => [f.path, f.json]));
    const fetcher = (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === "/p/data.json") return respond(404, "");
      if (url === "/p/manifest.json") return respond(200, JSON.stringify(manifest));
      const json = byPath.get(url.slice(3));
      return json === undefined ? respond(404, "") : respond(200, new TextEncoder().encode(json).buffer as ArrayBuffer);
    };
    const warns: string[] = [];
    const client = createPackClient({ base: "/p/", fetch: fetcher, warn: (m) => warns.push(m) });
    const m = await client.catalog();
    expect(m.status === "ready" && m.source).toBe("bundled");
    expect(m.status === "ready" && m.catalog.packs.map((p) => [p.id, p.flops])).toEqual(manifest.packs.map((p) => [p.id, p.files.length]));
    expect(await client.pack(manifest.packs[0].id)).toEqual(manifest.packs[0]);
    const entry = manifest.packs[0].files[1];
    const lf = await client.flop(entry);
    expect(lf.flop.boardKey).toBe(entry.board);
    expect(await lf.integrity).toBe("ok");
    await client.flop(entry);
    await client.catalog();
    expect(urls.filter((u) => u.endsWith(entry.path)).length).toBe(1);
    expect(urls.filter((u) => u.endsWith("manifest.json")).length).toBe(1);

    const tampered = { ...entry, sha256: "f".repeat(64) };
    const other = createPackClient({ base: "/p/", fetch: fetcher, warn: (m) => warns.push(m) });
    await other.catalog();
    const bad = await other.flop(tampered);
    expect(bad.flop.nodes.length).toBeGreaterThan(0);
    expect(await bad.integrity).toBe("mismatch");
    expect(warns.some((w) => w.includes("sha256"))).toBe(true);

    const noCrypto = createPackClient({ base: "/p/", fetch: fetcher, subtle: null });
    await noCrypto.catalog();
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
