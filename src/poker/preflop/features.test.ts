import { describe, expect, it } from "vitest";
import { ALL_HANDS, comboCount, RANKS } from "../cards";
import { EQR_FIT } from "./eqrFit";
import { kickerChains } from "./export";
import { FEATURE_MEANS, FEATURE_NAMES, handFeatures } from "./features";

const idx = (h: string) => ALL_HANDS.indexOf(h);
/** The raw (uncentered) features: the centered ones plus the combo-weighted means. */
const raw = (h: string) => handFeatures(idx(h)).map((v, j) => v + FEATURE_MEANS[j]);
const sq = (r: number) => (r / 12) ** 2;
const J = Object.fromEntries(FEATURE_NAMES.map((n, j) => [n, j])) as Record<(typeof FEATURE_NAMES)[number], number>;

describe("handFeatures", () => {
  it("is centered: every column's combo-weighted sum over the 1,326 combos is 0", () => {
    expect(FEATURE_NAMES).toEqual(["pair", "suited", "hi2f5", "lo2", "gap", "pairRank2", "aceTop", "wheel", "suitConn"]);
    for (let j = 0; j < FEATURE_NAMES.length; j++) {
      const s = ALL_HANDS.reduce((acc, h, i) => acc + comboCount(h) * handFeatures(i)[j], 0);
      expect(Math.abs(s), FEATURE_NAMES[j]).toBeLessThan(1e-12);
    }
    // The means themselves: 78 pair combos, 312 suited, 192 unpaired ace-high, 64 wheel aces, and the rank terms.
    const want = [78 / 1326, 312 / 1326, 0.511312, 0.143791, 0.609351, 0.020425, 192 / 1326, 64 / 1326, 0.082956];
    FEATURE_MEANS.forEach((m, j) => expect(m, FEATURE_NAMES[j]).toBeCloseTo(want[j], 6));
  });

  it("follows the definitions of the realization model", () => {
    // [pair, suited, hi2f5, lo2, gap, pairRank2, aceTop, wheel, suitConn], raw. Ranks: 2 = 0 … A = 12.
    const close = (h: string, want: number[]) => raw(h).forEach((v, j) => expect(v, `${h} ${FEATURE_NAMES[j]}`).toBeCloseTo(want[j], 12));
    close("AA", [1, 0, 0, 0, 0, 1, 0, 0, 0]);
    close("22", [1, 0, 0, 0, 0, 0, 0, 0, 0]);
    close("77", [1, 0, 0, 0, 0, sq(5), 0, 0, 0]);
    close("AKs", [0, 1, 1, sq(11), 0, 0, 1, 0, 1]);
    close("A6s", [0, 1, 1, sq(4), 1, 0, 1, 0, 0]);
    close("A5s", [0, 1, 1, sq(3), 1, 0, 1, 1, 0]); // the wheel ace: four gaps or more
    close("A2o", [0, 0, 1, 0, 1, 0, 1, 1, 0]);
    close("K5s", [0, 1, sq(11), sq(3), 1, 0, 0, 0, 0]);
    close("76s", [0, 1, sq(5), sq(4), 0, 0, 0, 0, 1]);
    close("T8s", [0, 1, sq(8), sq(6), 0.25, 0, 0, 0, 0.75]);
    close("74o", [0, 0, sq(5), sq(2), 0.5, 0, 0, 0, 0]);
    close("72o", [0, 0, sq(5), 0, 1, 0, 0, 0, 0]);
    close("T8o", [0, 0, sq(8), sq(6), 0.25, 0, 0, 0, 0]);
    // The top-card term is flat at and below 5-high.
    close("54s", [0, 1, sq(3), sq(2), 0, 0, 0, 0, 1]);
    close("43s", [0, 1, sq(3), sq(1), 0, 0, 0, 0, 1]);
    close("32s", [0, 1, sq(3), 0, 0, 0, 0, 0, 1]);
    close("42o", [0, 0, sq(3), 0, 0.25, 0, 0, 0, 0]);
  });

  it("keeps the pair features on pairs and the hand features off them", () => {
    for (const [i, h] of ALL_HANDS.entries()) {
      const r = handFeatures(i).map((v, j) => v + FEATURE_MEANS[j]);
      const pair = h.length === 2;
      expect(Math.abs(r[J.pair] - (pair ? 1 : 0)), h).toBeLessThan(1e-12);
      if (!pair) expect(Math.abs(r[J.pairRank2]), h).toBeLessThan(1e-12);
      // Every non-pair feature is raw 0 on a pair.
      if (pair) for (const j of [J.suited, J.hi2f5, J.lo2, J.gap, J.aceTop, J.wheel, J.suitConn]) expect(Math.abs(r[j]), `${h} ${FEATURE_NAMES[j]}`).toBeLessThan(1e-12);
    }
  });

  it("is monotone in one rank per feature: top-card terms equal across kickers, lo2 rising, gap not rising, suitConn not falling", () => {
    for (const sfx of ["s", "o"])
      for (let hi = 12; hi >= 1; hi--)
        for (let lo = hi - 1; lo >= 1; lo--) {
          const a = handFeatures(idx(RANKS[hi] + RANKS[lo] + sfx)), b = handFeatures(idx(RANKS[hi] + RANKS[lo - 1] + sfx));
          const name = `${RANKS[hi]}${RANKS[lo]}${sfx} vs ${RANKS[hi]}${RANKS[lo - 1]}${sfx}`;
          expect(a[J.hi2f5], name).toBe(b[J.hi2f5]);
          expect(a[J.aceTop], name).toBe(b[J.aceTop]);
          expect(a[J.lo2], name).toBeGreaterThan(b[J.lo2]);
          expect(a[J.gap], name).toBeLessThanOrEqual(b[J.gap]);
          expect(a[J.suitConn], name).toBeGreaterThanOrEqual(b[J.suitConn]);
          // wheel steps only between A6 and A5.
          if (hi === 12 && lo === 4) expect(b[J.wheel] - a[J.wheel], name).toBe(1);
          else expect(a[J.wheel], name).toBe(b[J.wheel]);
        }
    // hi2f5 rises with the top card above 5-high and is flat at and below it.
    const top = (r: number) => handFeatures(idx(RANKS[r] + RANKS[0] + "o"))[J.hi2f5];
    for (let r = 12; r >= 4; r--) expect(top(r)).toBeGreaterThan(top(r - 1));
    expect(top(1)).toBe(top(3));
    expect(top(2)).toBe(top(3));
    // pairRank2 rises with the pair.
    for (let r = 12; r >= 1; r--) expect(handFeatures(idx(RANKS[r] + RANKS[r]))[J.pairRank2]).toBeGreaterThan(handFeatures(idx(RANKS[r - 1] + RANKS[r - 1]))[J.pairRank2]);
  });

  it("returns a copy and checks the index", () => {
    const a = handFeatures(0);
    const keep = a[0];
    a[0] = 7;
    expect(handFeatures(0)[0]).toBe(keep);
    expect(handFeatures(0)).toHaveLength(FEATURE_NAMES.length);
    expect(() => handFeatures(169)).toThrow();
    expect(() => handFeatures(-1)).toThrow();
  });
});

describe("EQR_FIT (generated by scripts/fit-realization.mjs)", () => {
  it("is intact: its sha256 matches its contents", async () => {
    const { sha256, ...body } = EQR_FIT;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body)));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(sha256);
  });

  it("was fitted on the features defined here, with α held at its prior", () => {
    expect(EQR_FIT.model).toBe("modelB-rank9");
    expect(EQR_FIT.features).toEqual([...FEATURE_NAMES]);
    expect(EQR_FIT.thetaO).toHaveLength(FEATURE_NAMES.length);
    expect(EQR_FIT.thetaI).toHaveLength(FEATURE_NAMES.length);
    expect(EQR_FIT.alpha).toBe(0.553);
    expect(EQR_FIT.alphaPrior).toBe(0.553);
    expect(EQR_FIT.alpha).toBe(EQR_FIT.alphaPrior);
    const m3 = EQR_FIT.alternatives.modelB3;
    expect(m3.features).toEqual(FEATURE_NAMES.slice(0, 3));
    expect(m3.alpha).toBe(EQR_FIT.alphaPrior);
    expect(m3.thetaO).toHaveLength(3);
    expect(m3.thetaI).toHaveLength(3);
    expect(EQR_FIT.alphaFree.features).toEqual([...FEATURE_NAMES]);
    expect(EQR_FIT.alphaFree.thetaO).toHaveLength(FEATURE_NAMES.length);
    // The per-class R of the alternative form was computed from the features when the fit ran: if features.ts
    // changes, this fails until the fit is rerun.
    const p = EQR_FIT.alternatives.product;
    expect(p.features).toEqual([...FEATURE_NAMES]);
    for (let h = 0; h < 169; h++) {
      const F = handFeatures(h);
      expect(p.rO[h]).toBeCloseTo(p.rO0 + F.reduce((s, v, j) => s + v * p.thetaO[j], 0), 5);
      expect(p.rI[h]).toBeCloseTo(p.rI0 + F.reduce((s, v, j) => s + v * p.thetaI[j], 0), 5);
    }
  });

  it("keeps u monotone: θ_lo2 ≥ 0, θ_gap ≤ 0, θ_gap − θ_suitConn ≤ 0 and θ_pairRank2 ≥ 0 on both sides", () => {
    // A refit that breaks one of these signs makes realization fall with a better kicker or a higher pair, which
    // the charts would show as kicker or pair inversions (PF-SANITY-7, PF-SANITY-2). In a suited row the gap slope is
    // θ_gap − θ_suitConn (suitConn = 1 − gap there).
    for (const theta of [EQR_FIT.thetaO, EQR_FIT.thetaI]) {
      expect(theta[J.lo2]).toBeGreaterThanOrEqual(0);
      expect(theta[J.gap]).toBeLessThanOrEqual(0);
      expect(theta[J.gap] - theta[J.suitConn]).toBeLessThanOrEqual(0);
      expect(theta[J.pairRank2]).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps the measured signs of the step terms: θ_aceTop < 0, θ_wheel > 0 and θ_suitConn < 0 on both sides", () => {
    // A regression guard on the output, not a fitting target: the packs measure these signs at 3.3–21 jackknife SE
    // from zero (fit 4acfad77aa35, 20 flop groups: aceTop −0.019 ± 0.005 / −0.023 ± 0.003, wheel +0.022 ± 0.004 /
    // +0.010 ± 0.003, suitConn −0.025 ± 0.002 / −0.032 ± 0.002, OOP / IP). A flip or a swap among the three keeps the
    // stored metrics inside the bounds below (aceTop flipped on both sides scores RMS 0.023 / 0.029), so it is caught
    // here; a refit that flips one, e.g. with a new pack, needs a review of the charts, not a changed sign.
    for (const theta of [EQR_FIT.thetaO, EQR_FIT.thetaI]) {
      expect(theta[J.aceTop]).toBeLessThan(0);
      expect(theta[J.wheel]).toBeGreaterThan(0);
      expect(theta[J.suitConn]).toBeLessThan(0);
    }
  });

  it("gives u that never falls along PF-SANITY-7's kicker ladder (the wheel aces below A6 excepted, as there)", () => {
    const u = (theta: number[], h: string) => handFeatures(idx(h)).reduce((s, f, k) => s + f * theta[k], 0);
    const ladder = kickerChains().filter(([a, b]) => a[0] === b[0]);
    expect(ladder.length).toBeGreaterThan(100);
    for (const theta of [EQR_FIT.thetaO, EQR_FIT.thetaI])
      for (const [better, worse] of ladder) expect(u(theta, better), `${better} ≥ ${worse}`).toBeGreaterThanOrEqual(u(theta, worse) - 1e-12);
  });

  it("describes its stored parameters by its stored metrics, within bounds a wrong write breaks", () => {
    // fit-realization.mjs scores r2, r2Gap, rms and perPack on the parameters as written (rounded, sliced into their
    // fields and rebuilt into β), so the metrics below belong to this cFit and θ. Measured on the 1,476 + 1,457 flops
    // of fit 4acfad77aa35: RMS 0.0158 / 0.0179, CV 0.0170 / 0.0185, R² of the gap 0.920 / 0.964. On those rows θ_O and
    // θ_I swapped score RMS 0.0447 / 0.0448, the hi2f5 signs flipped 0.086 / 0.152, the c sign flipped 0.157 / 0.157.
    const m = EQR_FIT.metrics;
    for (let s = 0; s < 2; s++) {
      expect(m.rms[s]).toBeLessThanOrEqual(0.03);
      expect(m.cvRms[s]).toBeLessThanOrEqual(0.03);
      expect(m.r2Gap[s]).toBeGreaterThanOrEqual(0.8);
    }
    // Position: the fitted context (OOP caller vs IP aggressor) moves pot share from O to I.
    expect(EQR_FIT.cFit).toBeLessThan(0);
    // The alternatives' stored metrics are scored the same way; bounded loosely (the 3-feature fit's IP RMS is 0.046).
    for (const alt of [EQR_FIT.alternatives.modelB3, EQR_FIT.alternatives.product, EQR_FIT.alphaFree])
      for (let s = 0; s < 2; s++) expect(alt.metrics.rms[s]).toBeLessThanOrEqual(0.06);
  });

  it("has a positive κ for every class and table size", () => {
    for (const k of [EQR_FIT.kappa3, EQR_FIT.kappa4]) {
      expect(k).toHaveLength(169);
      for (const v of k) expect(v).toBeGreaterThan(0.5);
    }
    // The strongest hand is the one whose multiway share the product of pairwise equities gets nearly right.
    expect(EQR_FIT.kappa3[ALL_HANDS.indexOf("AA")]).toBeLessThan(1.1);
  });
});
