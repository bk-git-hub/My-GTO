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
 *  - 17bb CO 올인: 채팅은 6인 CO 범위(KQo)를 그대로 썼는데, 9인 HJ 범위(KJo+)보다
 *    좁아져서 KJo+ 로 맞췄다. 뒤 자리가 앞 자리보다 좁으면 안 되기 때문.
 *  - 11bb SB "BB만 남았다면 거의 다 올인"은 구체적인 범위(약 70%)로 풀어 썼다.
 */

const POS = ["UTG", "UTG+1", "MP", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
const EARLY = ["UTG", "UTG+1", "MP"];
const LATE = ["HJ", "CO", "BTN", "SB"];

const open = (range: string, size: string): ActionDef => ({ key: "open", label: `오픈 ${size}`, color: "raise", range });
const small = (range: string): ActionDef => ({ key: "small", label: "작게 열기 2bb", color: "open", range });
const shove = (range: string, label = "올인"): ActionDef => ({ key: "shove", label, color: "allin", range });
const threeBet = (range: string, label = "3벳"): ActionDef => ({ key: "3bet", label, color: "raise", range });
const call = (range: string): ActionDef => ({ key: "call", label: "콜", color: "call", range });

function rfi(hero: string, desc: string, actions: ActionDef[]): ScenarioDef {
  return {
    id: `rfi-${hero.toLowerCase().replace("+", "p")}`,
    kind: "rfi",
    hero,
    chip: hero,
    title: `${hero} 먼저 들어갈 때`,
    description: desc,
    actions,
  };
}

const RFI_DESC: Record<string, string> = {
  UTG: "앞에 아무도 없고 UTG(가장 빠른 자리). 뒤에 8명이 남아 있어 가장 좁게.",
  "UTG+1": "UTG가 폴드. 뒤에 7명.",
  MP: "앞에서 모두 폴드. 뒤에 6명.",
  LJ: "앞에서 모두 폴드. 뒤에 5명.",
  HJ: "앞에서 모두 폴드. 뒤에 4명.",
  CO: "앞에서 모두 폴드. 버튼과 블라인드만 남음.",
  BTN: "앞에서 모두 폴드. 블라인드 둘만 남고 플랍 이후 항상 마지막에 행동해요.",
  SB: "모두 폴드하고 BB만 남음.",
};

// ───────────────────────── 딥 (100bb 이상, 레벨 1~4) ─────────────────────────

const DEEP_OPEN: Record<string, string> = {
  UTG: "55+, A9s+, A4s-A5s, KTs+, QTs+, JTs, T9s, AJo+, KQo",
  "UTG+1": "44+, A8s+, A3s-A5s, KTs+, QTs+, JTs, T9s, 98s, AJo+, KQo",
  MP: "33+, A7s+, A2s-A5s, K9s+, Q9s+, J9s+, T9s, 98s, 87s, ATo+, KJo+",
  LJ: "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, 87s, 76s, 65s, ATo+, KJo+, QJo",
  HJ: "22+, A2s+, K8s+, Q9s+, J9s+, T8s+, 97s+, 86s+, 75s+, 65s, 54s, ATo+, KJo+, QJo",
  CO: "22+, A2s+, K5s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, 64s+, 54s, A8o+, KTo+, QTo+, JTo",
  BTN: "22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 85s+, 74s+, 64s+, 53s+, A7o+, K9o+, Q9o+, J9o+, T9o",
  SB: "22+, A2s+, K7s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, A7o+, K9o+, QTo+, JTo",
};

const DEEP: ScenarioDef[] = [
  ...Object.entries(DEEP_OPEN).map(([p, r]) => rfi(p, RFI_DESC[p], [open(r, "3~4bb")])),
  {
    id: "mp-vs-early",
    kind: "vsOpen",
    hero: "MP",
    villain: "UTG",
    chip: "MP vs UTG",
    title: "MP vs UTG 오픈 (UTG+1도 같음)",
    description: "앞자리 오픈에 앞쪽 자리에서 대응. 스택이 깊으니 22~66도 셋을 노리고 콜해요.",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-JJ, AQs")],
  },
  {
    id: "hj-vs-early",
    kind: "vsOpen",
    hero: "HJ",
    villain: "UTG~MP",
    villainSeats: EARLY,
    chip: "HJ vs 앞자리",
    title: "LJ·HJ vs 앞자리 오픈",
    description: "UTG~MP 오픈에 LJ·HJ에서 대응.",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-JJ, AJs-AQs, KQs, JTs, T9s")],
  },
  {
    id: "co-vs-early",
    kind: "vsOpen",
    hero: "CO",
    villain: "UTG~MP",
    villainSeats: EARLY,
    chip: "CO vs 앞자리",
    title: "CO vs 앞자리 오픈",
    description: "UTG~MP 오픈에 CO에서 대응.",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-JJ, AJs-AQs, KQs, JTs, T9s, 98s")],
  },
  {
    id: "co-vs-hj",
    kind: "vsOpen",
    hero: "CO",
    villain: "HJ",
    chip: "CO vs HJ",
    title: "CO vs HJ 오픈",
    description: "HJ 오픈에 CO에서 대응. 상대 범위가 넓어져서 3벳과 콜이 넓어져요.",
    actions: [threeBet("JJ+, AQs+, AKo"), call("22-TT, ATs-AJs, KJs-KQs, QJs, JTs, T9s, 98s, AQo")],
  },
  {
    id: "btn-vs-early",
    kind: "vsOpen",
    hero: "BTN",
    villain: "UTG~HJ",
    villainSeats: ["UTG", "UTG+1", "MP", "LJ", "HJ"],
    chip: "BTN vs 앞자리",
    title: "BTN vs 앞·중간 자리 오픈",
    description: "UTG~HJ 오픈에 버튼에서 대응. 플랍 이후 유리한 자리라 수딧 커넥터도 콜해요.",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-JJ, AJs-AQs, KQs, JTs, T9s, 98s, 87s")],
  },
  {
    id: "btn-vs-co",
    kind: "vsOpen",
    hero: "BTN",
    villain: "CO",
    chip: "BTN vs CO",
    title: "BTN vs CO 오픈",
    description: "CO 오픈에 버튼에서 대응.",
    actions: [
      threeBet("JJ+, AQs+, AKo"),
      call("22-TT, ATs-AJs, KTs-KQs, QTs-QJs, JTs, T9s, 98s, 87s, 76s, AJo-AQo, KQo"),
    ],
  },
  {
    id: "sb-vs-early",
    kind: "vsOpen",
    hero: "SB",
    villain: "UTG~HJ",
    villainSeats: ["UTG", "UTG+1", "MP", "LJ", "HJ"],
    chip: "SB vs 앞자리",
    title: "SB vs 앞·중간 자리 오픈",
    description: "SB는 플랍 이후 계속 먼저 행동하고 뒤에 BB도 있어요. 콜은 여러 명이 이미 들어와 있을 때만.",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-TT, AQs, KQs")],
  },
  {
    id: "sb-vs-late",
    kind: "vsOpen",
    hero: "SB",
    villain: "CO~BTN",
    villainSeats: ["CO", "BTN"],
    chip: "SB vs 뒤쪽",
    title: "SB vs CO·BTN 오픈",
    description: "뒤쪽 자리 오픈에는 3벳을 넓혀요. 콜은 여전히 조금만.",
    actions: [threeBet("JJ+, AQs+, AQo+"), call("22-TT, KQs")],
  },
  {
    id: "bb-vs-early",
    kind: "vsOpen",
    hero: "BB",
    villain: "UTG~MP",
    villainSeats: EARLY,
    chip: "BB vs 앞자리",
    title: "BB vs 앞자리 오픈",
    description: "3bb(600) 오픈, 다른 콜러가 없을 때. 앞에 콜러가 있으면 오프수딧을 빼고 좁혀요.",
    actions: [
      threeBet("QQ+, AKs, AKo"),
      call("22-JJ, A2s-AQs, KTs+, QTs+, JTs, T9s, 98s, 87s, 76s, 65s, AQo, KQo"),
    ],
  },
  {
    id: "bb-vs-late",
    kind: "vsOpen",
    hero: "BB",
    villain: "LJ~SB",
    villainSeats: ["LJ", "HJ", "CO", "BTN", "SB"],
    chip: "BB vs 뒤쪽",
    title: "BB vs 뒤쪽 자리 오픈",
    description: "뒤쪽 자리는 넓게 여니까 BB도 넓게 지켜요. 앞에 콜러가 있으면 오프수딧을 빼요.",
    actions: [
      threeBet("TT+, AQs+, AQo+"),
      call("22-99, A2s-AJs, K5s+, Q7s+, J7s+, T7s+, 96s+, 85s+, 74s+, 64s+, 53s+, A7o-AJo, K9o+, Q9o+, J9o+, T9o"),
    ],
  },
  {
    id: "vs-3bet",
    kind: "vs3bet",
    hero: "내 오픈",
    chip: "3벳 맞음",
    title: "내가 열었는데 3벳을 맞았을 때",
    description: "예: 600 오픈에 2,200 3벳. 펍의 3벳은 대부분 QQ+·AK. 스택이 깊어서 스몰페어는 셋을 노리고 콜해요.",
    actions: [{ key: "4bet", label: "4벳", color: "raise", range: "QQ+, AKs, AKo" }, call("22-JJ, AJs-AQs, KQs")],
  },
];

// ───────────────────────── 미들 (약 40~80bb) ─────────────────────────

const MID_OPEN: Record<string, string> = {
  UTG: "55+, A9s+, A5s, KTs+, QTs+, JTs, AJo+, KQo",
  "UTG+1": "55+, A8s+, A4s-A5s, KTs+, QTs+, JTs, T9s, AJo+, KQo",
  MP: "44+, A7s+, A2s-A5s, K9s+, Q9s+, J9s+, T9s, 98s, ATo+, KJo+",
  LJ: "33+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, 87s, ATo+, KJo+, QJo",
  HJ: "22+, A2s+, K8s+, Q9s+, J9s+, T8s+, 97s+, 87s, 76s, ATo+, KJo+, QJo",
  CO: "22+, A2s+, K5s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, 65s, A8o+, KTo+, QTo+, JTo",
  BTN: "22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 85s+, 74s+, 64s+, 53s+, A5o+, K9o+, Q9o+, J9o+, T9o",
  SB: "22+, A2s+, K5s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, A7o+, K9o+, QTo+, JTo",
};

const MID: ScenarioDef[] = [
  ...Object.entries(MID_OPEN).map(([p, r]) => rfi(p, RFI_DESC[p], [open(r, "2.5bb")])),
  {
    id: "mp-vs-early",
    kind: "vsOpen",
    hero: "MP",
    villain: "UTG~UTG+1",
    villainSeats: ["UTG", "UTG+1"],
    chip: "MP·LJ vs 앞자리",
    title: "MP·LJ vs 앞자리 오픈",
    description: "스몰페어 콜은 오픈이 2.5bb 이하일 때만 (크면 77+).",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-JJ, AJs-AQs, KQs, JTs")],
  },
  {
    id: "hj-vs-early",
    kind: "vsOpen",
    hero: "HJ",
    villain: "UTG~MP",
    villainSeats: EARLY,
    chip: "HJ vs 앞자리",
    title: "HJ vs 앞자리 오픈",
    description: "스몰페어 콜은 오픈이 2.5bb 이하일 때만 (크면 77+).",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-JJ, AJs-AQs, KQs, JTs, T9s")],
  },
  {
    id: "co-vs-early",
    kind: "vsOpen",
    hero: "CO",
    villain: "UTG~MP",
    villainSeats: EARLY,
    chip: "CO vs 앞자리",
    title: "CO vs 앞자리 오픈",
    description: "UTG~MP 오픈에 CO에서 대응.",
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
    description: "중간 자리 오픈에는 3벳에 JJ, AQs를 더해요.",
    actions: [threeBet("JJ+, AQs+, AKo"), call("22-TT, ATs-AJs, KJs-KQs, QJs, JTs, T9s, 98s, AQo")],
  },
  {
    id: "btn-vs-early",
    kind: "vsOpen",
    hero: "BTN",
    villain: "UTG~MP",
    villainSeats: EARLY,
    chip: "BTN vs 앞자리",
    title: "BTN vs 앞자리 오픈",
    description: "UTG~MP 오픈에 버튼에서 대응.",
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
    description: "중간 자리 오픈에 버튼에서 대응.",
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
    description: "CO 오픈에 버튼에서 대응.",
    actions: [
      threeBet("JJ+, AQs+, AKo"),
      call("22-TT, ATs-AJs, KTs-KQs, QTs-QJs, JTs, T9s, 98s, 87s, 76s, AJo-AQo, KQo"),
    ],
  },
  {
    id: "sb-vs-early",
    kind: "vsOpen",
    hero: "SB",
    villain: "UTG~MP",
    villainSeats: EARLY,
    chip: "SB vs 앞자리",
    title: "SB vs 앞자리 오픈",
    description: "콜은 여러 명이 이미 들어와 있을 때만.",
    actions: [threeBet("QQ+, AKs, AKo"), call("22-TT, AQs, KQs")],
  },
  {
    id: "sb-vs-late",
    kind: "vsOpen",
    hero: "SB",
    villain: "LJ~BTN",
    villainSeats: ["LJ", "HJ", "CO", "BTN"],
    chip: "SB vs 뒤쪽",
    title: "SB vs 뒤쪽 자리 오픈",
    description: "뒤쪽 자리 오픈에는 3벳을 JJ+, AQ+로 넓혀요.",
    actions: [threeBet("JJ+, AQs+, AQo+"), call("22-TT, KQs")],
  },
  {
    id: "bb-vs-early",
    kind: "vsOpen",
    hero: "BB",
    villain: "UTG~MP",
    villainSeats: EARLY,
    chip: "BB vs 앞자리",
    title: "BB vs 앞자리 오픈",
    description: "다른 콜러가 없을 때 기준. 콜러가 있으면 오프수딧을 빼요.",
    actions: [
      threeBet("QQ+, AKs, AKo"),
      call("22-JJ, A2s-AQs, KTs+, QTs+, JTs, T9s, 98s, 87s, 76s, 65s, AQo, KQo"),
    ],
  },
  {
    id: "bb-vs-late",
    kind: "vsOpen",
    hero: "BB",
    villain: "LJ~SB",
    villainSeats: ["LJ", "HJ", "CO", "BTN", "SB"],
    chip: "BB vs 뒤쪽",
    title: "BB vs 뒤쪽 자리 오픈",
    description: "BTN이 열었다면 A2o까지 콜해요.",
    actions: [
      threeBet("TT+, AQs+, AQo+"),
      call("22-99, A2s-AJs, K5s+, Q7s+, J7s+, T7s+, 96s+, 85s+, 74s+, 64s+, 53s+, A7o-AJo, K9o+, Q9o+, J9o+, T9o"),
    ],
  },
  {
    id: "vs-3bet",
    kind: "vs3bet",
    hero: "내 오픈",
    chip: "3벳 맞음",
    title: "내가 열었는데 3벳을 맞았을 때",
    description: "이 스택에서는 3벳하면 스택의 5분의 1 가까이 들어가요. QQ+, AK는 4벳을 맞아도 올인. 콜은 플랍 이후 유리한 자리일 때.",
    actions: [{ key: "4bet", label: "4벳/올인", color: "allin", range: "QQ+, AKs, AKo" }, call("TT-JJ, AQs")],
  },
  {
    id: "vs-short-shove",
    kind: "vsShove",
    hero: "나",
    villain: "짧은 스택",
    chip: "짧은 스택 올인",
    title: "짧은 스택(20bb 안팎)이 올인했을 때",
    description: "새로 들어온 사람(리엔트리)이나 짧은 스택은 넓게 올인해요.",
    actions: [call("TT+, AJs+, AJo+")],
  },
];

// ───────────────────────── 숏 (약 17bb) ─────────────────────────

const SHORT_SHOVE: Record<string, string> = {
  UTG: "77+, ATs+, AJo+, KQs",
  "UTG+1": "66+, A9s+, AJo+, KQs",
  MP: "55+, A8s+, ATo+, KJs+, KQo",
  LJ: "44+, A7s+, ATo+, KTs+, KQo, QJs",
  HJ: "33+, A2s+, A9o+, KTs+, KJo+, QTs+, JTs",
  CO: "22+, A2s+, A5o+, KTs+, KJo+, QTs+, JTs",
  BTN: "22+, A2s+, A2o+, K9s+, KTo+, Q9s+, QJo, J9s+, T9s",
  SB: "22+, A2s+, A2o+, K5s+, K9o+, Q8s+, QTo+, J8s+, JTo, T8s+, 98s, 87s",
};

const SHORT: ScenarioDef[] = [
  ...Object.entries(SHORT_SHOVE).map(([p, r]) =>
    rfi(p, `${RFI_DESC[p]} TT+·AQ+는 작게 열고, 올인을 맞으면 콜해요.`, [small("TT+, AQs+, AQo+"), shove(r)]),
  ),
  {
    id: "reshove-vs-early",
    kind: "vsOpen",
    hero: "나",
    villain: "UTG~MP",
    villainSeats: EARLY,
    chip: "앞자리 오픈",
    title: "앞자리(UTG~MP) 오픈에 3벳 올인",
    description: "이 스택에서는 콜하고 플랍을 보는 플레이는 거의 안 해요. BB도 앞자리 오픈에는 3벳 올인 아니면 폴드.",
    actions: [shove("88+, AQs+, AQo+", "3벳 올인")],
  },
  {
    id: "reshove-vs-late",
    kind: "vsOpen",
    hero: "나",
    villain: "HJ~SB",
    villainSeats: LATE,
    chip: "뒤쪽 오픈",
    title: "뒤쪽 자리(HJ~SB) 오픈에 3벳 올인",
    description: "뒤쪽 자리는 넓게 여니까 3벳 올인도 넓게.",
    actions: [shove("44+, A8s+, A9o+, KJs+, KQo", "3벳 올인")],
  },
  {
    id: "bb-vs-late",
    kind: "vsOpen",
    hero: "BB",
    villain: "HJ~SB",
    villainSeats: LATE,
    chip: "BB vs 뒤쪽",
    title: "BB vs 뒤쪽 자리 작은 오픈",
    description: "앞에 콜러가 한 명이라도 있으면 콜은 빼고 3벳 올인 아니면 폴드.",
    actions: [shove("44+, A8s+, A9o+, KJs+, KQo", "3벳 올인"), call("K9s-KTs, QTs-QJs, J9s-JTs, T9s, 98s, KJo")],
  },
  {
    id: "call-vs-early-shove",
    kind: "vsShove",
    hero: "나",
    villain: "UTG~MP",
    villainSeats: EARLY,
    chip: "앞자리 올인",
    title: "앞자리가 올인했을 때 콜",
    description: "앞자리 올인 범위는 강해요.",
    actions: [call("99+, AQs+, AQo+")],
  },
  {
    id: "call-vs-late-shove",
    kind: "vsShove",
    hero: "나",
    villain: "뒤쪽·짧은 스택",
    villainSeats: LATE,
    chip: "뒤쪽 올인",
    title: "뒤쪽 자리나 짧은 스택이 올인했을 때 콜",
    description: "뒤쪽 자리와 짧은 스택은 넓게 올인해요.",
    actions: [call("77+, ATs+, ATo+, KQs, KQo")],
  },
];

// ───────────────────────── 푸시/폴드 (약 11bb, 버블 근처) ─────────────────────────

const PUSH_SHOVE: Record<string, string> = {
  UTG: "55+, A8s+, ATo+, KJs+, KQo",
  "UTG+1": "44+, A7s+, A9o+, KTs+, KQo, QJs",
  MP: "33+, A4s+, A8o+, KTs+, KJo+, QJs, JTs",
  LJ: "22+, A2s+, A7o+, K9s+, KJo+, QTs+, JTs",
  HJ: "22+, A2s+, A5o+, K8s+, KTo+, Q9s+, QJo, J9s+, T9s",
  CO: "22+, A2s+, A2o+, K5s+, K9o+, Q8s+, QTo+, J8s+, JTo, T8s+, 98s",
  BTN: "22+, A2s+, A2o+, K2s+, K7o+, Q5s+, Q9o+, J7s+, J9o+, T7s+, T9o, 97s+, 87s",
  SB: "22+, A2s+, A2o+, K2s+, K2o+, Q2s+, Q5o+, J3s+, J7o+, T5s+, T7o+, 95s+, 97o+, 84s+, 86o+, 74s+, 76o, 63s+, 65o, 53s+, 43s",
};

const PUSH: ScenarioDef[] = [
  ...Object.entries(PUSH_SHOVE).map(([p, r]) =>
    rfi(p, `${RFI_DESC[p]} 올인 아니면 폴드. 먼저 미는 건 넓게.`, [shove(r)]),
  ),
  {
    id: "reshove-vs-early",
    kind: "vsOpen",
    hero: "나",
    villain: "UTG~MP",
    villainSeats: EARLY,
    chip: "앞자리 오픈",
    title: "앞자리 오픈에 올인",
    description: "누가 먼저 열었을 때 올인으로 맞받는 범위.",
    actions: [shove("77+, AJs+, AQo+")],
  },
  {
    id: "reshove-vs-late",
    kind: "vsOpen",
    hero: "나",
    villain: "HJ~SB",
    villainSeats: LATE,
    chip: "뒤쪽 오픈",
    title: "뒤쪽 자리 오픈에 올인",
    description: "뒤쪽 자리 오픈에는 넓게 맞받아요.",
    actions: [shove("22+, A7s+, A9o+, KJs+, KJo+")],
  },
  {
    id: "call-vs-early-shove",
    kind: "vsShove",
    hero: "나",
    villain: "UTG~MP",
    villainSeats: EARLY,
    chip: "앞자리 올인",
    title: "앞자리가 올인했을 때 콜",
    description: "상금권이 가까우면 받는 범위는 좁게. 지면 바로 탈락이에요.",
    actions: [call("TT+, AQs+, AQo+")],
  },
  {
    id: "call-vs-late-shove",
    kind: "vsShove",
    hero: "나",
    villain: "뒤쪽·짧은 스택",
    villainSeats: LATE,
    chip: "뒤쪽 올인",
    title: "뒤쪽 자리나 나보다 짧은 스택이 올인했을 때 콜",
    description: "나보다 짧은 스택이 많으면 더 좁혀도 돼요.",
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
      description: "레벨 1~4. 오픈은 3~4bb(림프 한 명당 1bb 추가). 수딧 커넥터·스몰페어는 맞으면 크게, 안 맞으면 빨리 접기. 블러프는 거의 안 해요.",
      scenarios: DEEP,
    },
    {
      id: "mid",
      label: "미들",
      stack: "약 40~80bb",
      description: "오픈 2.5bb. 앞자리의 투기적인 패(스몰페어·수딧 커넥터)를 줄이고, CO·BTN·SB에서 블라인드를 적극적으로 훔쳐요.",
      scenarios: MID,
    },
    {
      id: "short",
      label: "숏",
      stack: "약 15~20bb",
      description: "작게 열기(2bb), 올인으로 열기, 3벳 올인 세 가지로 플레이해요. 작게 연 패는 올인을 맞으면 콜해요.",
      scenarios: SHORT,
    },
    {
      id: "push",
      label: "푸시/폴드",
      stack: "약 10bb 이하",
      description: "올인 아니면 폴드. 먼저 미는 건 넓게, 남의 올인을 받는 건 좁게(상금권이 가까울수록 더). 7~9bb면 한 칸씩 더 넓혀요.",
      scenarios: PUSH,
    },
  ],
};
