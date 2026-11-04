import type { ActionDef, ChartSetDef, ScenarioDef } from "../charts";

/**
 * 야자수 방이점 토너먼트용 레인지 (9인, BB 앤티, 시작 50,000 = 250bb).
 *
 * 출처: 2026-10-31 bk와 Claude의 채팅("홀덤 대화 기록")에서 정리한 범위를
 * 그대로 옮겼다. "적힌 패보다 높은 패는 다 포함" 표기는 X+ 로 풀었다
 * (예: K8s → K8s+, Q9s → Q9s+ = Q9s·QTs·QJs, 98s → 98s).
 * 솔버 결과가 아니라, 콜이 많은 홀덤펍에 맞춰 단순화한 값이다.
 *
 * 옮기면서 고친 곳:
 *  - 17bb CO 푸시: 채팅은 6인 CO 범위(KQo)를 그대로 썼는데, 9인 HJ 범위(KJo+)보다
 *    좁아져서 KJo+ 로 맞췄다. 뒤 자리가 앞 자리보다 좁으면 안 되기 때문.
 *  - 11bb SB "BB만 남았다면 거의 다 올인"은 구체적인 범위(약 70%)로 풀어 썼다.
 */

const POS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
const EARLY = ["UTG", "UTG+1", "UTG+2"];
const LATE = ["HJ", "CO", "BTN", "SB"];

const open = (range: string, size: string): ActionDef => ({ key: "open", label: `오픈 ${size}`, color: "raise", range });
const small = (range: string): ActionDef => ({ key: "small", label: "2bb 오픈", color: "open", range });
const shove = (range: string, label = "올인"): ActionDef => ({ key: "shove", label, color: "allin", range });
const threeBet = (range: string, label = "3벳"): ActionDef => ({ key: "3bet", label, color: "raise", range });
const call = (range: string): ActionDef => ({ key: "call", label: "콜", color: "call", range });

function rfi(hero: string, title: string, actions: ActionDef[]): ScenarioDef {
  return {
    id: `rfi-${hero.toLowerCase().replace("+", "p")}`,
    kind: "rfi",
    hero,
    chip: hero,
    title: `${hero} ${title}`,
    description: "",
    actions,
  };
}

// ───────────────────────── 딥 (100bb 이상, 레벨 1~4) ─────────────────────────

const DEEP_OPEN: Record<string, string> = {
  UTG: "55+, A9s+, A4s-A5s, KTs+, QTs+, JTs, T9s, AJo+, KQo",
  "UTG+1": "44+, A8s+, A3s-A5s, KTs+, QTs+, JTs, T9s, 98s, AJo+, KQo",
  "UTG+2": "33+, A7s+, A2s-A5s, K9s+, Q9s+, J9s+, T9s, 98s, 87s, ATo+, KJo+",
  LJ: "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, 87s, 76s, 65s, ATo+, KJo+, QJo",
  HJ: "22+, A2s+, K8s+, Q9s+, J9s+, T8s+, 97s+, 86s+, 75s+, 65s, 54s, ATo+, KJo+, QJo",
  CO: "22+, A2s+, K5s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, 64s+, 54s, A8o+, KTo+, QTo+, JTo",
  BTN: "22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 85s+, 74s+, 64s+, 53s+, A7o+, K9o+, Q9o+, J9o+, T9o",
  SB: "22+, A2s+, K7s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, A7o+, K9o+, QTo+, JTo",
};

const DEEP: ScenarioDef[] = [
  ...Object.entries(DEEP_OPEN).map(([p, r]) => rfi(p, "오픈 레인지", [open(r, "3~4bb")])),
  {
    id: "mp-vs-early",
    kind: "vsOpen",
    hero: "UTG+2",
    villain: "UTG",
    chip: "UTG+1·UTG+2 vs UTG",
    heroSeats: ["UTG+1", "UTG+2"],
    title: "UTG+1·UTG+2 vs UTG 오픈",
    description: "딥스택이라 22~66 셋마이닝 콜 포함.",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-JJ, AQs")],
  },
  {
    id: "hj-vs-early",
    kind: "vsOpen",
    hero: "HJ",
    villain: "EP",
    villainSeats: EARLY,
    chip: "LJ·HJ vs EP",
    heroSeats: ["LJ", "HJ"],
    title: "LJ·HJ vs EP 오픈",
    description: "",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-JJ, AJs-AQs, KQs, JTs, T9s")],
  },
  {
    id: "co-vs-early",
    kind: "vsOpen",
    hero: "CO",
    villain: "EP",
    villainSeats: EARLY,
    chip: "CO vs EP",
    title: "CO vs EP 오픈",
    description: "",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-JJ, AJs-AQs, KQs, JTs, T9s, 98s")],
  },
  {
    id: "co-vs-hj",
    kind: "vsOpen",
    hero: "CO",
    villain: "HJ",
    chip: "CO vs HJ",
    title: "CO vs HJ 오픈",
    description: "",
    actions: [threeBet("JJ+, AQs+, AKo"), call("22-TT, ATs-AJs, KJs-KQs, QJs, JTs, T9s, 98s, AQo")],
  },
  {
    id: "btn-vs-early",
    kind: "vsOpen",
    hero: "BTN",
    villain: "EP·MP",
    villainSeats: ["UTG", "UTG+1", "UTG+2", "LJ", "HJ"],
    chip: "BTN vs EP·MP",
    title: "BTN vs EP·MP 오픈",
    description: "IP라 수딧 커넥터까지 콜.",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-JJ, AJs-AQs, KQs, JTs, T9s, 98s, 87s")],
  },
  {
    id: "btn-vs-co",
    kind: "vsOpen",
    hero: "BTN",
    villain: "CO",
    chip: "BTN vs CO",
    title: "BTN vs CO 오픈",
    description: "",
    actions: [
      threeBet("JJ+, AQs+, AKo"),
      call("22-TT, ATs-AJs, KTs-KQs, QTs-QJs, JTs, T9s, 98s, 87s, 76s, AJo-AQo, KQo"),
    ],
  },
  {
    id: "sb-vs-early",
    kind: "vsOpen",
    hero: "SB",
    villain: "EP·MP",
    villainSeats: ["UTG", "UTG+1", "UTG+2", "LJ", "HJ"],
    chip: "SB vs EP·MP",
    title: "SB vs EP·MP 오픈",
    description: "OOP에 뒤에 BB. 콜은 멀티웨이일 때만.",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-TT, AQs, KQs")],
  },
  {
    id: "sb-vs-late",
    kind: "vsOpen",
    hero: "SB",
    villain: "LP",
    villainSeats: ["CO", "BTN"],
    chip: "SB vs LP",
    title: "SB vs LP 오픈",
    description: "",
    actions: [threeBet("JJ+, AQs+, AQo+"), call("22-TT, KQs")],
  },
  {
    id: "bb-vs-early",
    kind: "vsOpen",
    hero: "BB",
    villain: "EP",
    villainSeats: EARLY,
    chip: "BB vs EP",
    title: "BB vs EP 오픈",
    description: "3bb 오픈, 콜러 없음 기준. 콜러가 있으면 오프수딧 제외.",
    actions: [
      threeBet("QQ+, AKs, AKo"),
      call("22-JJ, A2s-AQs, KTs+, QTs+, JTs, T9s, 98s, 87s, 76s, 65s, AQo, KQo"),
    ],
  },
  {
    id: "bb-vs-late",
    kind: "vsOpen",
    hero: "BB",
    villain: "MP·LP",
    villainSeats: ["LJ", "HJ", "CO", "BTN", "SB"],
    chip: "BB vs MP·LP",
    title: "BB vs MP·LP 오픈",
    description: "콜러가 있으면 오프수딧 제외.",
    actions: [
      threeBet("TT+, AQs+, AQo+"),
      call("22-99, A2s-AJs, K5s+, Q7s+, J7s+, T7s+, 96s+, 85s+, 74s+, 64s+, 53s+, A7o-AJo, K9o+, Q9o+, J9o+, T9o"),
    ],
  },
  {
    id: "vs-3bet",
    kind: "vs3bet",
    hero: "Hero",
    chip: "vs 3벳",
    title: "오픈 vs 3벳",
    description: "예: 600 오픈 vs 2,200 3벳. 펍 3벳은 대부분 QQ+·AK. 딥스택이라 스몰페어 셋마이닝 콜.",
    actions: [{ key: "4bet", label: "4벳", color: "raise", range: "QQ+, AKs, AKo" }, call("22-JJ, AJs-AQs, KQs")],
  },
];

// ───────────────────────── 미들 (약 40~80bb) ─────────────────────────

const MID_OPEN: Record<string, string> = {
  UTG: "55+, A9s+, A5s, KTs+, QTs+, JTs, AJo+, KQo",
  "UTG+1": "55+, A8s+, A4s-A5s, KTs+, QTs+, JTs, T9s, AJo+, KQo",
  "UTG+2": "44+, A7s+, A2s-A5s, K9s+, Q9s+, J9s+, T9s, 98s, ATo+, KJo+",
  LJ: "33+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, 87s, ATo+, KJo+, QJo",
  HJ: "22+, A2s+, K8s+, Q9s+, J9s+, T8s+, 97s+, 87s, 76s, ATo+, KJo+, QJo",
  CO: "22+, A2s+, K5s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, 65s, A8o+, KTo+, QTo+, JTo",
  BTN: "22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 85s+, 74s+, 64s+, 53s+, A5o+, K9o+, Q9o+, J9o+, T9o",
  SB: "22+, A2s+, K5s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, A7o+, K9o+, QTo+, JTo",
};

const MID: ScenarioDef[] = [
  ...Object.entries(MID_OPEN).map(([p, r]) => rfi(p, "오픈 레인지", [open(r, "2.5bb")])),
  {
    id: "mp-vs-early",
    kind: "vsOpen",
    hero: "UTG+2",
    villain: "UTG~UTG+1",
    villainSeats: ["UTG", "UTG+1"],
    chip: "UTG+2·LJ vs UTG",
    heroSeats: ["UTG+2", "LJ"],
    title: "UTG+2·LJ vs UTG·UTG+1 오픈",
    description: "스몰페어 콜은 오픈이 2.5bb 이하일 때만 (크면 77+).",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-JJ, AJs-AQs, KQs, JTs")],
  },
  {
    id: "hj-vs-early",
    kind: "vsOpen",
    hero: "HJ",
    villain: "EP",
    villainSeats: EARLY,
    chip: "HJ vs EP",
    title: "HJ vs EP 오픈",
    description: "스몰페어 콜은 오픈이 2.5bb 이하일 때만 (크면 77+).",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-JJ, AJs-AQs, KQs, JTs, T9s")],
  },
  {
    id: "co-vs-early",
    kind: "vsOpen",
    hero: "CO",
    villain: "EP",
    villainSeats: EARLY,
    chip: "CO vs EP",
    title: "CO vs EP 오픈",
    description: "",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-JJ, AJs-AQs, KQs, JTs, T9s, 98s, AQo")],
  },
  {
    id: "co-vs-mid",
    kind: "vsOpen",
    hero: "CO",
    villain: "LJ~HJ",
    villainSeats: ["LJ", "HJ"],
    chip: "CO vs LJ·HJ",
    title: "CO vs LJ·HJ 오픈",
    description: "",
    actions: [threeBet("JJ+, AQs+, AKo"), call("22-TT, ATs-AJs, KJs-KQs, QJs, JTs, T9s, 98s, AQo")],
  },
  {
    id: "btn-vs-early",
    kind: "vsOpen",
    hero: "BTN",
    villain: "EP",
    villainSeats: EARLY,
    chip: "BTN vs EP",
    title: "BTN vs EP 오픈",
    description: "",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-JJ, AJs-AQs, KQs, JTs, T9s, 98s, 87s, AQo")],
  },
  {
    id: "btn-vs-mid",
    kind: "vsOpen",
    hero: "BTN",
    villain: "LJ~HJ",
    villainSeats: ["LJ", "HJ"],
    chip: "BTN vs LJ·HJ",
    title: "BTN vs LJ·HJ 오픈",
    description: "",
    actions: [
      threeBet("JJ+, AQs+, AKo"),
      call("22-TT, ATs-AJs, KTs-KQs, QTs-QJs, JTs, T9s, 98s, 87s, AQo, KQo"),
    ],
  },
  {
    id: "btn-vs-co",
    kind: "vsOpen",
    hero: "BTN",
    villain: "CO",
    chip: "BTN vs CO",
    title: "BTN vs CO 오픈",
    description: "",
    actions: [
      threeBet("JJ+, AQs+, AKo"),
      call("22-TT, ATs-AJs, KTs-KQs, QTs-QJs, JTs, T9s, 98s, 87s, 76s, AJo-AQo, KQo"),
    ],
  },
  {
    id: "sb-vs-early",
    kind: "vsOpen",
    hero: "SB",
    villain: "EP",
    villainSeats: EARLY,
    chip: "SB vs EP",
    title: "SB vs EP 오픈",
    description: "콜은 멀티웨이일 때만.",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-TT, AQs, KQs")],
  },
  {
    id: "sb-vs-late",
    kind: "vsOpen",
    hero: "SB",
    villain: "MP·LP",
    villainSeats: ["LJ", "HJ", "CO", "BTN"],
    chip: "SB vs MP·LP",
    title: "SB vs MP·LP 오픈",
    description: "",
    actions: [threeBet("JJ+, AQs+, AQo+"), call("22-TT, KQs")],
  },
  {
    id: "bb-vs-early",
    kind: "vsOpen",
    hero: "BB",
    villain: "EP",
    villainSeats: EARLY,
    chip: "BB vs EP",
    title: "BB vs EP 오픈",
    description: "콜러 없음 기준. 콜러가 있으면 오프수딧 제외.",
    actions: [
      threeBet("QQ+, AKs, AKo"),
      call("22-JJ, A2s-AQs, KTs+, QTs+, JTs, T9s, 98s, 87s, 76s, 65s, AQo, KQo"),
    ],
  },
  {
    id: "bb-vs-late",
    kind: "vsOpen",
    hero: "BB",
    villain: "MP·LP",
    villainSeats: ["LJ", "HJ", "CO", "BTN", "SB"],
    chip: "BB vs MP·LP",
    title: "BB vs MP·LP 오픈",
    description: "BTN 오픈이면 A2o까지 콜.",
    actions: [
      threeBet("TT+, AQs+, AQo+"),
      call("22-99, A2s-AJs, K5s+, Q7s+, J7s+, T7s+, 96s+, 85s+, 74s+, 64s+, 53s+, A7o-AJo, K9o+, Q9o+, J9o+, T9o"),
    ],
  },
  {
    id: "vs-3bet",
    kind: "vs3bet",
    hero: "Hero",
    chip: "vs 3벳",
    title: "오픈 vs 3벳",
    description: "QQ+, AK는 끝까지(올인). 콜은 IP일 때.",
    actions: [{ key: "4bet", label: "4벳/올인", color: "allin", range: "QQ+, AKs, AKo" }, call("TT-JJ, AQs")],
  },
  {
    id: "vs-short-shove",
    kind: "vsShove",
    hero: "Hero",
    villain: "숏스택",
    chip: "vs 숏스택 푸시",
    title: "vs 숏스택(~20bb) 푸시 콜 레인지",
    description: "리엔트리 숏스택은 넓게 푸시.",
    actions: [call("TT+, AJs+, AJo+")],
  },
];

// ───────────────────────── 숏 (약 17bb) ─────────────────────────

const SHORT_SHOVE: Record<string, string> = {
  UTG: "77+, ATs+, AJo+, KQs",
  "UTG+1": "66+, A9s+, AJo+, KQs",
  "UTG+2": "55+, A8s+, ATo+, KJs+, KQo",
  LJ: "44+, A7s+, ATo+, KTs+, KQo, QJs",
  HJ: "33+, A2s+, A9o+, KTs+, KJo+, QTs+, JTs",
  CO: "22+, A2s+, A5o+, KTs+, KJo+, QTs+, JTs",
  BTN: "22+, A2s+, A2o+, K9s+, KTo+, Q9s+, QJo, J9s+, T9s",
  SB: "22+, A2s+, A2o+, K5s+, K9o+, Q8s+, QTo+, J8s+, JTo, T8s+, 98s, 87s",
};

const SHORT: ScenarioDef[] = [
  ...Object.entries(SHORT_SHOVE).map(([p, r]) =>
    rfi(p, "오픈·푸시 레인지", [small("TT+, AQs+, AQo+"), shove(r)]),
  ),
  {
    id: "reshove-vs-early",
    kind: "vsOpen",
    hero: "Hero",
    villain: "EP",
    villainSeats: EARLY,
    chip: "vs EP 오픈",
    title: "vs EP 오픈 3벳 올인",
    description: "플랫 콜 없음. BB도 3벳 올인 or 폴드.",
    actions: [shove("88+, AQs+, AQo+", "3벳 올인")],
  },
  {
    id: "reshove-vs-late",
    kind: "vsOpen",
    hero: "Hero",
    villain: "HJ~SB",
    villainSeats: LATE,
    chip: "vs HJ~SB 오픈",
    title: "vs HJ~SB 오픈 3벳 올인",
    description: "",
    actions: [shove("44+, A8s+, A9o+, KJs+, KQo", "3벳 올인")],
  },
  {
    id: "bb-vs-late",
    kind: "vsOpen",
    hero: "BB",
    villain: "HJ~SB",
    villainSeats: LATE,
    chip: "BB vs HJ~SB",
    title: "BB vs HJ~SB 2bb 오픈",
    description: "콜러가 있으면 콜 없이 3벳 올인 or 폴드.",
    actions: [shove("44+, A8s+, A9o+, KJs+, KQo", "3벳 올인"), call("K9s-KTs, QTs-QJs, J9s-JTs, T9s, 98s, KJo")],
  },
  {
    id: "call-vs-early-shove",
    kind: "vsShove",
    hero: "Hero",
    villain: "EP",
    villainSeats: EARLY,
    chip: "vs EP 푸시",
    title: "vs EP 푸시 콜 레인지",
    description: "",
    actions: [call("99+, AQs+, AQo+")],
  },
  {
    id: "call-vs-late-shove",
    kind: "vsShove",
    hero: "Hero",
    villain: "HJ~SB·숏스택",
    villainSeats: LATE,
    chip: "vs HJ~SB·숏 푸시",
    title: "vs HJ~SB·숏스택 푸시 콜 레인지",
    description: "",
    actions: [call("77+, ATs+, ATo+, KQs, KQo")],
  },
];

// ───────────────────────── 푸시/폴드 (약 11bb, 버블 근처) ─────────────────────────

const PUSH_SHOVE: Record<string, string> = {
  UTG: "55+, A8s+, ATo+, KJs+, KQo",
  "UTG+1": "44+, A7s+, A9o+, KTs+, KQo, QJs",
  "UTG+2": "33+, A4s+, A8o+, KTs+, KJo+, QJs, JTs",
  LJ: "22+, A2s+, A7o+, K9s+, KJo+, QTs+, JTs",
  HJ: "22+, A2s+, A5o+, K8s+, KTo+, Q9s+, QJo, J9s+, T9s",
  CO: "22+, A2s+, A2o+, K5s+, K9o+, Q8s+, QTo+, J8s+, JTo, T8s+, 98s",
  BTN: "22+, A2s+, A2o+, K2s+, K7o+, Q5s+, Q9o+, J7s+, J9o+, T7s+, T9o, 97s+, 87s",
  SB: "22+, A2s+, A2o+, K2s+, K2o+, Q2s+, Q5o+, J3s+, J7o+, T5s+, T7o+, 95s+, 97o+, 84s+, 86o+, 74s+, 76o, 63s+, 65o, 53s+, 43s",
};

const PUSH: ScenarioDef[] = [
  ...Object.entries(PUSH_SHOVE).map(([p, r]) =>
    rfi(p, "푸시 레인지", [shove(r)]),
  ),
  {
    id: "reshove-vs-early",
    kind: "vsOpen",
    hero: "Hero",
    villain: "EP",
    villainSeats: EARLY,
    chip: "vs EP 오픈",
    title: "vs EP 오픈 3벳 올인",
    description: "",
    actions: [shove("77+, AJs+, AQo+", "3벳 올인")],
  },
  {
    id: "reshove-vs-late",
    kind: "vsOpen",
    hero: "Hero",
    villain: "HJ~SB",
    villainSeats: LATE,
    chip: "vs HJ~SB 오픈",
    title: "vs HJ~SB 오픈 3벳 올인",
    description: "",
    actions: [shove("22+, A7s+, A9o+, KJs+, KJo+", "3벳 올인")],
  },
  {
    id: "call-vs-early-shove",
    kind: "vsShove",
    hero: "Hero",
    villain: "EP",
    villainSeats: EARLY,
    chip: "vs EP 푸시",
    title: "vs EP 푸시 콜 레인지",
    description: "버블 근처(ICM) 기준.",
    actions: [call("TT+, AQs+, AQo+")],
  },
  {
    id: "call-vs-late-shove",
    kind: "vsShove",
    hero: "Hero",
    villain: "HJ~SB·숏스택",
    villainSeats: LATE,
    chip: "vs HJ~SB·숏 푸시",
    title: "vs HJ~SB·숏스택 푸시 콜 레인지",
    description: "나보다 짧은 스택이 많으면 더 타이트하게.",
    actions: [call("88+, AJs+, AJo+, KQs")],
  },
];

export const YAJASU: ChartSetDef = {
  id: "yajasu",
  label: "야자수 펍 토너먼트",
  game: "홀덤펍 토너먼트 · 9인 테이블 · BB 앤티(빅블라인드가 BB만큼 앤티) · 시작 50,000칩(250bb) · 20분 레벨(15레벨부터 12분) · 리엔트리 14레벨까지 · ITM 12등 · 콜이 많고 멀티웨이가 흔한 테이블",
  source:
    "bk와 Claude의 채팅(2026-10-31)에서 이 펍에 맞춰 정리한 범위예요. 솔버 결과가 아니라 콜이 많은 테이블에 맞춘 단순화 값이에요.",
  positions: POS,
  stages: [
    {
      id: "deep",
      label: "딥",
      stack: "100bb 이상",
      description: "Lv1~4. 오픈 3~4bb (림퍼당 +1bb). 스몰페어·수딧 커넥터는 셋·강한 드로우가 아니면 플랍에서 포기. 블러프 최소화.",
      scenarios: DEEP,
    },
    {
      id: "mid",
      label: "미들",
      stack: "약 40~80bb",
      description: "오픈 2.5bb. EP 투기적 핸드 축소, CO·BTN·SB 스틸 확대.",
      scenarios: MID,
    },
    {
      id: "short",
      label: "숏",
      stack: "약 15~20bb",
      description: "2bb 오픈(TT+, AQ+ — 리쉬브에 콜) / 오픈 푸시 / 3벳 올인. 플랫 콜 거의 없음.",
      scenarios: SHORT,
    },
    {
      id: "push",
      label: "푸시/폴드",
      stack: "약 10bb 이하",
      description: "푸시 or 폴드. 푸시는 넓게, 콜은 좁게(버블일수록 더). 7~9bb면 한 단계 더 넓게.",
      scenarios: PUSH,
    },
  ],
};
