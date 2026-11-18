import { afterEach, describe, expect, it, vi } from "vitest";
import {
  arrivedAt,
  backMove,
  backTo,
  claimBack,
  entryIndex,
  entryTrail,
  INDEX_KEY,
  nextEntry,
  pageBack,
  parentRoute,
  pushedTrail,
  TRAIL_KEY,
  TRAIL_MAX,
  withIndex,
  withTrail,
  type GoHow,
} from "./backNav";

describe("the screen above (back with no earlier entry)", () => {
  it("a saved hand → 지난 기록", () => {
    expect(parentRoute("log/h_1731000000000_ab12")).toBe("log/list");
    expect(parentRoute("log/abc")).toBe("log/list");
  });

  it("남의 핸드, and another player's hand under it → 빠른 기록 (its toggle lives there)", () => {
    expect(parentRoute("log/other")).toBe("log/fast");
    expect(parentRoute("log/other/h_1")).toBe("log/fast");
  });

  it("one tournament → 토너먼트 기록 → 빠른 기록", () => {
    expect(parentRoute("log/fast/past")).toBe("log/fast");
    expect(parentRoute("log/fast/t/t-abc")).toBe("log/fast/past");
    expect(parentRoute("log/fast/s/abc-123")).toBe("log/fast/past");
    const chain = ["log/fast/t/x"];
    while (chain[chain.length - 1] !== "home" && chain.length < 6) chain.push(parentRoute(chain[chain.length - 1]));
    expect(chain).toEqual(["log/fast/t/x", "log/fast/past", "log/fast", "home"]);
  });

  it("a solver report or flop → the scenario list", () => {
    expect(parentRoute("solver/srp-btn-bb-100")).toBe("solver");
    expect(parentRoute("solver/srp-btn-bb-100/AsKd7c")).toBe("solver");
    expect(parentRoute("solver/srp-btn-bb-100/AsKd7c/0.2")).toBe("solver");
  });

  it("everything else → home: the menu's screens, the hand log's own screens, an unknown route", () => {
    for (const r of ["log", "log/new", "log/fast", "log/list", "log/list/mine", "log/list/other", "log/players", "solver", "charts", "play", "calc", "settings", "quiz", "quiz/stack", "quiz/odds", "home", "nowhere"]) {
      expect(parentRoute(r), r).toBe("home");
    }
  });

  it("going up always ends at home, in at most two steps", () => {
    for (const r of ["log/abc", "log/other/x", "solver/p/b/1", "quiz/equity"]) {
      const chain = [r];
      while (chain[chain.length - 1] !== "home" && chain.length < 5) chain.push(parentRoute(chain[chain.length - 1]));
      expect(chain[chain.length - 1], r).toBe("home");
      expect(chain.length, r).toBeLessThanOrEqual(3);
    }
  });
});

describe("what back does, in order", () => {
  it("the page's own step back first: nothing else happens", () => {
    expect(backMove(() => true, 3, "log")).toEqual({ kind: "page" });
    expect(backMove(() => true, 0, "log/abc")).toEqual({ kind: "page" });
  });

  it("asks the page first, even with an earlier entry", () => {
    const page = vi.fn(() => false);
    expect(backMove(page, 2, "log/list")).toEqual({ kind: "history" });
    expect(page).toHaveBeenCalledTimes(1);
  });

  it("then the earlier in-app entry, when there is one (place above 0)", () => {
    expect(backMove(() => false, 1, "log/abc")).toEqual({ kind: "history" });
  });

  it("else (the app opened here: a deep link, a shared address, a reload) the screen above", () => {
    expect(backMove(() => false, 0, "log/abc")).toEqual({ kind: "up", route: "log/list" });
    expect(backMove(() => false, 0, "log/other")).toEqual({ kind: "up", route: "log/fast" });
    expect(backMove(() => false, 0, "solver/p/b")).toEqual({ kind: "up", route: "solver" });
    expect(backMove(() => false, 0, "settings")).toEqual({ kind: "up", route: "home" });
  });
});

describe("a page's own step back", () => {
  const releases: (() => void)[] = [];
  const claim = (h: () => boolean | void) => {
    const r = claimBack(h);
    releases.push(r);
    return r;
  };
  afterEach(() => releases.splice(0).forEach((r) => r()));

  it("nothing claimed: the page doesn't take it", () => {
    expect(pageBack()).toBe(false);
  });

  it("the latest claim runs, and only it; given up, the one before is back", () => {
    const first = vi.fn();
    const second = vi.fn();
    claim(first);
    const drop = claim(second);
    expect(pageBack()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    drop();
    expect(pageBack()).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("a handler returning false hands back to the route back; giving up twice is harmless", () => {
    const drop = claim(() => false);
    expect(pageBack()).toBe(false);
    expect(backMove(pageBack, 0, "log/abc")).toEqual({ kind: "up", route: "log/list" });
    drop();
    drop();
    expect(pageBack()).toBe(false);
  });
});

describe("the place of each history entry", () => {
  it("reads a place only from the app's own stamp", () => {
    expect(entryIndex(null)).toBeNull();
    expect(entryIndex(undefined)).toBeNull();
    expect(entryIndex("x")).toBeNull();
    expect(entryIndex({})).toBeNull();
    expect(entryIndex({ [INDEX_KEY]: -1 })).toBeNull();
    expect(entryIndex({ [INDEX_KEY]: 1.5 })).toBeNull();
    expect(entryIndex({ [INDEX_KEY]: "2" })).toBeNull();
    expect(entryIndex({ [INDEX_KEY]: 0 })).toBe(0);
    expect(entryIndex({ [INDEX_KEY]: 4, other: true })).toBe(4);
  });

  it("stamps a place keeping what else the entry held", () => {
    expect(withIndex(null, 0)).toEqual({ [INDEX_KEY]: 0 });
    expect(withIndex({ a: 1, [INDEX_KEY]: 7 }, 2)).toEqual({ a: 1, [INDEX_KEY]: 2 });
  });

  it("the entry the app opens on is 0, unless it has a place already (a reload keeps it)", () => {
    expect(arrivedAt(null, -1)).toEqual({ idx: 0, stamp: true });
    expect(arrivedAt({ [INDEX_KEY]: 3 }, -1)).toEqual({ idx: 3, stamp: false });
  });

  it("a step back or forward lands on the entry's own place; an address typed by hand goes one up", () => {
    expect(arrivedAt({ [INDEX_KEY]: 1 }, 2)).toEqual({ idx: 1, stamp: false });
    expect(arrivedAt(null, 2)).toEqual({ idx: 3, stamp: true });
  });

  it("a new screen goes one place up; the screen already open and the screen above take this place", () => {
    expect(nextEntry(0, false)).toEqual({ idx: 1, push: true });
    expect(nextEntry(4, false)).toEqual({ idx: 5, push: true });
    expect(nextEntry(4, true)).toEqual({ idx: 4, push: false });
  });

  it("keeps the routes under an entry, nearest last, and only the last TRAIL_MAX of them", () => {
    expect(entryTrail(null)).toEqual([]);
    expect(entryTrail({ [INDEX_KEY]: 2 })).toEqual([]);
    expect(entryTrail({ [TRAIL_KEY]: "home" })).toEqual([]);
    expect(entryTrail({ [TRAIL_KEY]: ["home", 3] })).toEqual([]);
    expect(entryTrail({ [TRAIL_KEY]: ["home", "log/list"] })).toEqual(["home", "log/list"]);
    expect(withTrail({ [INDEX_KEY]: 2 }, ["home"])).toEqual({ [INDEX_KEY]: 2, [TRAIL_KEY]: ["home"] });
    expect(pushedTrail([], "home")).toEqual(["home"]);
    expect(pushedTrail(["home"], "log/list")).toEqual(["home", "log/list"]);
    const long = Array.from({ length: TRAIL_MAX }, (_, i) => `r${i}`);
    expect(pushedTrail(long, "last")).toEqual([...long.slice(1), "last"]);
  });
});

describe("an in-page back link (‹ 지난 기록, ← 시나리오, ← 리포트)", () => {
  it("goes back through history to the nearest entry showing its screen", () => {
    expect(backTo(["home", "log/list/mine"], "log/list/mine")).toEqual({ kind: "history", steps: 1 });
    expect(backTo(["home", "solver", "solver/p", "solver/p/b", "solver/p/b/0"], "solver/p")).toEqual({ kind: "history", steps: 3 });
    expect(backTo(["home", "log/list", "log/a", "log/list"], "log/list")).toEqual({ kind: "history", steps: 1 });
  });

  it("else takes this entry's place (the screen wasn't under it: a deep link, another tab of the list)", () => {
    expect(backTo([], "log/list")).toEqual({ kind: "replace" });
    expect(backTo(["home", "log/list"], "log/list/mine")).toEqual({ kind: "replace" });
  });
});

describe("the app's history, as a browser keeps it", () => {
  /** The browser's history for one tab, with App's bookkeeping on top (App.tsx open/go/back/onNav). */
  function session(hash: string) {
    const entries: { hash: string; state: unknown }[] = [{ hash, state: null }];
    let at = 0;
    let place = -1;
    let trail: string[] = [];
    let shown = hash;
    const arrive = () => {
      const { idx, stamp } = arrivedAt(entries[at].state, place);
      if (stamp) {
        trail = place < 0 ? [] : pushedTrail(trail, shown);
        entries[at].state = withTrail(withIndex(entries[at].state, idx), trail);
      } else trail = entryTrail(entries[at].state);
      place = idx;
      shown = entries[at].hash;
    };
    arrive();
    const open = (to: string, replace: boolean) => {
      const next = nextEntry(place, replace || to === shown);
      if (next.push) {
        trail = pushedTrail(trail, shown);
        entries.splice(at + 1);
        entries.push({ hash: to, state: withTrail(withIndex(null, next.idx), trail) });
        at++;
      } else entries[at] = { hash: to, state: withTrail(withIndex(entries[at].state, next.idx), trail) };
      place = next.idx;
      shown = to;
    };
    const stepBack = (steps: number) => {
      at -= steps;
      arrive();
    };
    return {
      get hash() {
        return entries[at].hash;
      },
      get place() {
        return place;
      },
      /** A page opens a screen (App's `go`). */
      go(to: string, how: GoHow = "push") {
        if (how === "back" && to !== shown) {
          const move = backTo(trail, to);
          if (move.kind === "history") return stepBack(move.steps);
        }
        open(to, how !== "push");
      },
      /** The header's ‹ with no page step: what App does, and the popstate it leads to. */
      back() {
        const move = backMove(() => false, place, shown);
        if (move.kind === "history") stepBack(1);
        else if (move.kind === "up") open(move.route, true);
        return move.kind;
      },
      typed(to: string) {
        entries.splice(at + 1);
        entries.push({ hash: to, state: null });
        at++;
        arrive();
      },
      /** The page loaded again on the same entry: App's memory gone, the entry's state kept. */
      reload() {
        place = -1;
        trail = [];
        shown = entries[at].hash;
        arrive();
      },
      /** Back to the top, as the header's ‹ would go: the screens on the way. */
      walkOut() {
        const seen: string[] = [];
        for (let i = 0; i < 20 && !(shown === "home" && place === 0); i++) {
          this.back();
          seen.push(shown);
        }
        return seen;
      },
      get length() {
        return entries.length;
      },
    };
  }

  it("opened on home: screens stack up and back walks them down to home", () => {
    const s = session("home");
    s.go("log/list");
    s.go("log/abc");
    expect(s.place).toBe(2);
    expect(s.back()).toBe("history");
    expect(s.hash).toBe("log/list");
    expect(s.back()).toBe("history");
    expect(s.hash).toBe("home");
    expect(s.place).toBe(0);
  });

  it("the screen already open (a new hand from the menu) adds no step back to itself", () => {
    const s = session("home");
    s.go("log");
    s.go("log");
    expect(s.length).toBe(2);
    expect(s.back()).toBe("history");
    expect(s.hash).toBe("home");
  });

  it("opened on a saved hand (cold start): back goes up through 지난 기록 to home, never out of the app", () => {
    const s = session("log/abc");
    expect(s.place).toBe(0);
    expect(s.back()).toBe("up");
    expect(s.hash).toBe("log/list");
    expect(s.place).toBe(0);
    expect(s.back()).toBe("up");
    expect(s.hash).toBe("home");
    expect(s.length).toBe(1);
  });

  it("an address typed by hand gets the next place, so back returns to the screen before it", () => {
    const s = session("home");
    s.go("charts");
    s.typed("calc");
    expect(s.place).toBe(2);
    expect(s.back()).toBe("history");
    expect(s.hash).toBe("charts");
  });

  it("a back link to the screen under it goes back there: ‹ never leads into the screen just left", () => {
    const s = session("home");
    s.go("log/list/mine");
    s.go("log/abc");
    s.go("log/list/mine", "back");
    expect(s.hash).toBe("log/list/mine");
    expect(s.place).toBe(1);
    expect(s.walkOut()).toEqual(["home"]);
  });

  it("a back link several screens up goes back past them all (← 리포트 from deep in a flop)", () => {
    const s = session("home");
    s.go("solver");
    s.go("solver/p");
    s.go("solver/p/b");
    s.go("solver/p/b/0");
    s.go("solver/p/b/0.1");
    s.go("solver/p", "back");
    expect(s.hash).toBe("solver/p");
    expect(s.place).toBe(2);
    expect(s.walkOut()).toEqual(["solver", "home"]);
  });

  it("a back link to a screen not under it takes this entry's place", () => {
    // #log, then its "‹ 지난 기록": the list wasn't open before, so ‹ from the list goes where #log would have
    const s = session("home");
    s.go("log");
    s.go("log/list/mine", "back");
    expect(s.hash).toBe("log/list/mine");
    expect(s.place).toBe(1);
    expect(s.length).toBe(2);
    expect(s.walkOut()).toEqual(["home"]);
  });

  it("a back link on a deep link (the app opened there) takes its place, then ‹ goes up as usual", () => {
    const s = session("log/abc");
    s.go("log/list/mine", "back");
    expect(s.hash).toBe("log/list/mine");
    expect(s.place).toBe(0);
    expect(s.walkOut()).toEqual(["home"]);
  });

  it("tabs and toggles take the entry's place: one ‹ leaves them, whichever tab is on", () => {
    const s = session("home");
    s.go("log/list");
    s.go("log/list/mine", "replace");
    s.go("log/list/other", "replace");
    s.go("log/players", "replace");
    s.go("log/list", "replace");
    expect(s.length).toBe(2);
    expect(s.walkOut()).toEqual(["home"]);
  });

  it("a deleted hand isn't a step back from the list it goes back to", () => {
    const s = session("home");
    s.go("log/list");
    s.go("log/list/mine", "replace");
    s.go("log/abc");
    // 삭제 → back to the list (the same tab: back through history; another tab: in the hand's place)
    s.go("log/list/mine", "back");
    expect(s.walkOut()).toEqual(["home"]);
    s.go("log/list");
    s.go("log/abc");
    s.go("log/list/mine", "back");
    expect(s.hash).toBe("log/list/mine");
    expect(s.walkOut()).toEqual(["log/list", "home"]);
  });

  it("the routes under an entry survive a reload (they are kept on the entry), typed addresses included", () => {
    const s = session("home");
    s.go("solver");
    s.go("solver/p");
    s.go("solver/p/b");
    s.typed("solver/p/b/0");
    s.reload();
    expect(s.place).toBe(4);
    s.go("solver/p", "back");
    expect(s.hash).toBe("solver/p");
    expect(s.place).toBe(2);
    expect(s.walkOut()).toEqual(["solver", "home"]);
  });
});
