import type { ChartSetDef } from "../charts";

/**
 * 6맥스 캐시 100bb 근사 차트 (앱의 첫 버전 차트).
 * 솔버 정확값이 아니라 일반적인 GTO 경향을 손으로 정리한 학습용 출발점이다.
 */
export const CASH6: ChartSetDef = {
  id: "cash6",
  label: "6맥스 캐시 100bb",
  game: "6맥스 캐시 게임 · 100bb · 오픈 2.5bb (SB 3bb) · 앤티 없음",
  source: "일반적인 GTO 경향을 바탕으로 손으로 정리한 학습용 근사 차트예요 (솔버 정확값 아님).",
  positions: ["UTG", "HJ", "CO", "BTN", "SB", "BB"],
  stages: [
    {
      id: "100bb",
      label: "100bb",
      stack: "100bb",
      description: "캐시 게임 기본 스택. 오픈 2.5bb, 3벳은 IP 약 7.5bb / OOP 약 11bb.",
      scenarios: [
      {
        id: "rfi-utg",
        kind: "rfi",
        hero: "UTG",
        chip: "UTG",
        title: "UTG 오픈",
        description: "",
        actions: [
          { key: "raise", label: "오픈 2.5bb", color: "raise", range: "66+, 55:0.75, 44:0.5, 33:0.35, 22:0.35, A2s+, K9s+, K8s:0.4, K7s:0.2, QTs+, Q9s:0.7, JTs, J9s:0.6, T9s, T8s:0.3, 98s:0.6, 87s:0.4, 76s:0.4, 65s:0.3, ATo+, KJo+, KTo:0.3, QJo:0.4" },
        ],
      },
      {
        id: "rfi-hj",
        kind: "rfi",
        hero: "HJ",
        chip: "HJ",
        title: "HJ 오픈",
        description: "",
        actions: [
          { key: "raise", label: "오픈 2.5bb", color: "raise", range: "55+, 44:0.7, 33:0.5, 22:0.4, A2s+, K8s+, K7s:0.6, K6s:0.3, Q9s+, Q8s:0.4, J9s+, J8s:0.2, T8s+, 98s, 97s:0.5, 87s, 86s:0.2, 76s:0.8, 65s:0.5, 54s:0.3, ATo+, A9o:0.6, A8o:0.2, KTo+, QJo, QTo:0.4, JTo:0.3" },
        ],
      },
      {
        id: "rfi-co",
        kind: "rfi",
        hero: "CO",
        chip: "CO",
        title: "CO 오픈",
        description: "",
        actions: [
          { key: "raise", label: "오픈 2.5bb", color: "raise", range: "33+, 22:0.6, A2s+, K5s+, K4s:0.5, K3s:0.3, Q8s+, Q7s:0.6, Q6s:0.3, J8s+, J7s:0.5, T8s+, T7s:0.6, 97s, 96s:0.4, 87s, 86s:0.6, 76s, 75s:0.4, 65s, 64s:0.3, 54s:0.8, A9o+, A8o:0.8, A7o:0.5, A5o:0.4, KTo+, K9o:0.5, QTo+, Q9o:0.3, JTo, J9o:0.2, T9o:0.3" },
        ],
      },
      {
        id: "rfi-btn",
        kind: "rfi",
        hero: "BTN",
        chip: "BTN",
        title: "BTN 오픈",
        description: "",
        actions: [
          { key: "raise", label: "오픈 2.5bb", color: "raise", range: "22+, A2s+, K2s+, Q4s+, Q3s:0.6, Q2s:0.4, J6s+, J5s:0.6, J4s:0.4, T6s+, T5s:0.4, 96s+, 95s:0.3, 85s+, 84s:0.3, 74s+, 64s+, 63s:0.3, 53s+, 43s:0.5, A2o+, K8o+, K7o:0.6, K6o:0.3, Q9o+, Q8o:0.6, J9o+, J8o:0.5, T8o+, T7o:0.2, 98o, 97o:0.4, 87o:0.6, 76o:0.3" },
        ],
      },
      {
        id: "rfi-sb",
        kind: "rfi",
        hero: "SB",
        chip: "SB",
        title: "SB 오픈 (레이즈 or 폴드)",
        description: "레이즈/폴드만 (솔버는 림프 혼합).",
        actions: [
          { key: "raise", label: "오픈 3bb", color: "raise", range: "22+, A2s+, K2s+, Q3s+, Q2s:0.5, J5s+, J4s:0.5, T6s+, 96s+, 85s+, 75s+, 64s+, 54s, 53s:0.5, 43s:0.4, A2o+, K8o+, K7o:0.3, Q9o+, Q8o:0.3, J9o+, J8o:0.2, T9o, T8o:0.2, 98o:0.3, 87o:0.2" },
        ],
      },
      {
        id: "bb-vs-utg",
        kind: "vsOpen",
        hero: "BB",
        villain: "UTG",
        chip: "BB vs UTG",
        title: "BB vs UTG 오픈",
        description: "",
        actions: [
          { key: "raise", label: "3벳 11bb", color: "raise", range: "KK+, QQ:0.6, JJ:0.2, AKs, AKo:0.7, AQs:0.3, A5s:0.5, A4s:0.4, KQs:0.2, 76s:0.15, 65s:0.15" },
          { key: "call", label: "콜", color: "call", range: "QQ:0.4, JJ:0.8, TT-22, AQs:0.7, AJs-A6s, A5s:0.5, A4s:0.6, A3s, A2s, KQs:0.8, KJs-K6s, QJs-Q8s, JTs-J8s, T9s, T8s, 98s, 97s, 87s, 86s, 76s:0.85, 75s, 65s:0.85, 54s, AKo:0.3, AQo, AJo, ATo:0.7, KQo, KJo:0.6, QJo:0.4" },
        ],
      },
      {
        id: "bb-vs-hj",
        kind: "vsOpen",
        hero: "BB",
        villain: "HJ",
        chip: "BB vs HJ",
        title: "BB vs HJ 오픈",
        description: "BB vs UTG와 BB vs CO 사이.",
        actions: [
          { key: "raise", label: "3벳 11bb", color: "raise", range: "QQ+, JJ:0.3, AKs, AKo:0.85, AQs:0.4, AJs:0.15, A5s:0.6, A4s:0.5, A3s:0.15, KQs:0.3, KJs:0.15, 76s:0.15, 65s:0.2" },
          { key: "call", label: "콜", color: "call", range: "JJ:0.7, TT-22, AQs:0.6, AJs:0.85, ATs-A6s, A5s:0.4, A4s:0.5, A3s:0.85, A2s, KQs:0.7, KJs:0.85, KTs-K5s, QJs-Q7s, JTs-J7s, T9s-T7s, 98s, 97s, 96s:0.5, 87s, 86s, 85s:0.3, 76s:0.85, 75s, 65s:0.8, 64s:0.5, 54s, 53s:0.3, AKo:0.15, AQo, AJo, ATo:0.85, A9o:0.4, KQo, KJo:0.8, KTo:0.4, QJo:0.7, QTo:0.3, JTo:0.5" },
        ],
      },
      {
        id: "bb-vs-co",
        kind: "vsOpen",
        hero: "BB",
        villain: "CO",
        chip: "BB vs CO",
        title: "BB vs CO 오픈",
        description: "",
        actions: [
          { key: "raise", label: "3벳 11bb", color: "raise", range: "QQ+, JJ:0.5, TT:0.2, AKs, AQs:0.6, AJs:0.3, A5s:0.7, A4s:0.6, A3s:0.3, KQs:0.4, KJs:0.3, K9s:0.2, QJs:0.2, J9s:0.2, T9s:0.2, 87s:0.2, 76s:0.2, 65s:0.25, AKo, AQo:0.4, AJo:0.2, KQo:0.2" },
          { key: "call", label: "콜", color: "call", range: "JJ:0.5, TT:0.8, 99-22, AQs:0.4, AJs:0.7, ATs-A6s, A5s:0.3, A4s:0.4, A3s:0.7, A2s, KQs:0.6, KJs:0.7, KTs, K9s:0.8, K8s-K2s, QJs:0.8, QTs-Q5s, JTs, J9s:0.8, J8s-J6s, T9s:0.8, T8s-T6s, 98s, 97s, 96s, 87s:0.8, 86s, 85s, 76s:0.8, 75s, 74s:0.5, 65s:0.75, 64s, 54s, 53s, 43s:0.5, AQo:0.6, AJo:0.8, ATo-A7o, A5o:0.5, KJo-K9o, KQo:0.8, QJo, QTo, Q9o:0.5, JTo, J9o:0.5, T9o, 98o:0.4" },
        ],
      },
      {
        id: "bb-vs-btn",
        kind: "vsOpen",
        hero: "BB",
        villain: "BTN",
        chip: "BB vs BTN",
        title: "BB vs BTN 오픈",
        description: "",
        actions: [
          { key: "raise", label: "3벳 11bb", color: "raise", range: "QQ+, JJ:0.6, TT:0.3, 99:0.2, AKs, AQs, AJs:0.5, ATs:0.3, A5s:0.8, A4s:0.7, A3s:0.5, A2s:0.3, KQs:0.6, KJs:0.5, KTs:0.3, K9s:0.3, K8s:0.2, QJs:0.4, QTs:0.3, Q9s:0.2, JTs:0.3, J9s:0.3, T9s:0.3, T8s:0.2, 98s:0.25, 87s:0.25, 76s:0.25, 65s:0.3, 54s:0.3, AKo, AQo:0.7, AJo:0.4, ATo:0.2, KQo:0.4, KJo:0.2, A5o:0.2" },
          { key: "call", label: "콜", color: "call", range: "JJ:0.4, TT:0.7, 99:0.8, 88-22, AJs:0.5, ATs:0.7, A9s-A6s, A5s:0.2, A4s:0.3, A3s:0.5, A2s:0.7, KQs:0.4, KJs:0.5, KTs:0.7, K9s:0.7, K8s:0.8, K7s-K2s, QJs:0.6, QTs:0.7, Q9s:0.8, Q8s-Q2s, JTs:0.7, J9s:0.7, J8s-J3s, T9s:0.7, T8s:0.8, T7s-T4s, 98s:0.75, 97s-94s, 87s:0.75, 86s-84s, 76s:0.75, 75s-73s, 65s:0.7, 64s, 63s, 54s:0.7, 53s, 52s:0.5, 43s, 42s:0.4, 32s:0.4, AQo:0.3, AJo:0.6, ATo:0.8, A9o-A2o, A5o:0.8, KQo:0.6, KJo:0.8, KTo-K5o, QJo-Q7o, JTo-J7o, T9o-T7o, 98o, 97o, 87o, 86o:0.6, 76o, 75o:0.4, 65o, 54o:0.5" },
        ],
      },
      {
        id: "bb-vs-sb",
        kind: "vsOpen",
        hero: "BB",
        villain: "SB",
        chip: "BB vs SB",
        title: "BB vs SB 오픈",
        description: "",
        actions: [
          { key: "raise", label: "3벳 9bb", color: "raise", range: "TT+, 99:0.5, AJs+, ATs:0.6, A9s:0.3, A5s-A2s:0.5, KTs+, K9s:0.4, QTs+, Q9s:0.3, JTs, J9s:0.4, T9s:0.5, 98s:0.4, 87s:0.4, 76s:0.4, 65s:0.4, AJo+, ATo:0.5, KQo, KJo:0.5, QJo:0.3, K5o:0.2, Q8o:0.2, J8o:0.2" },
          { key: "call", label: "콜", color: "call", range: "99:0.5, 88-22, ATs:0.4, A9s:0.7, A8s-A6s, A5s-A2s:0.5, K9s:0.6, K8s-K2s, Q9s:0.7, Q8s-Q2s, J9s:0.6, J8s-J2s, T9s:0.5, T8s-T3s, 98s:0.6, 97s-93s, 87s:0.6, 86s-83s, 76s:0.6, 75s-73s, 65s:0.6, 64s-62s, 54s, 53s, 52s, 43s, 42s, 32s, ATo:0.5, A9o-A2o, KJo:0.5, KTo-K6o, K5o:0.8, K4o-K2o:0.6, QJo:0.7, QTo-Q9o, Q8o:0.8, Q7o-Q5o, JTo, J9o, J8o:0.8, J7o, T9o-T7o, 98o, 97o, 96o:0.5, 87o, 86o, 76o, 75o:0.5, 65o, 54o" },
        ],
      },
      {
        id: "btn-vs-utg",
        kind: "vsOpen",
        hero: "BTN",
        villain: "UTG",
        chip: "BTN vs UTG",
        title: "BTN vs UTG 오픈",
        description: "",
        actions: [
          { key: "raise", label: "3벳 7.5bb", color: "raise", range: "QQ+, JJ:0.4, AKs, AQs:0.5, AKo:0.8, A5s:0.5, A4s:0.4, KQs:0.3, K9s:0.15, 76s:0.15, 65s:0.15" },
          { key: "call", label: "콜", color: "call", range: "JJ:0.6, TT-66, 55:0.7, 44:0.5, 33:0.4, 22:0.4, AQs:0.5, AJs-ATs, A9s:0.5, A5s:0.3, A4s:0.3, KQs:0.7, KJs, KTs:0.7, QJs, QTs:0.6, JTs, J9s:0.3, T9s:0.8, 98s:0.6, 87s:0.5, 76s:0.4, 65s:0.3, AKo:0.2, AQo:0.7, AJo:0.3, KQo:0.5" },
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
          { key: "raise", label: "3벳 7.5bb", color: "raise", range: "TT+, 99:0.5, AJs+, ATs:0.7, A9s:0.3, A5s:0.8, A4s:0.6, A3s:0.3, KJs+, KTs:0.6, K9s:0.3, QJs:0.6, QTs:0.4, JTs:0.4, J9s:0.2, T9s:0.3, 98s:0.2, 87s:0.2, 76s:0.2, 65s:0.2, AQo+, AJo:0.5, KQo:0.6, KJo:0.2" },
          { key: "call", label: "콜", color: "call", range: "99:0.5, 88-22, ATs:0.3, A9s:0.7, A8s-A6s:0.8, A4s:0.4, A3s:0.5, KTs:0.4, K9s:0.6, QTs:0.6, Q9s:0.6, JTs:0.6, J9s:0.6, T9s:0.7, T8s:0.5, 98s:0.7, 87s:0.6, 76s:0.6, 65s:0.5, 54s:0.4, AJo:0.4, ATo:0.3, KQo:0.4, KJo:0.4, QJo:0.3" },
        ],
      },
      {
        id: "co-vs-hj",
        kind: "vsOpen",
        hero: "CO",
        villain: "HJ",
        chip: "CO vs HJ",
        title: "CO vs HJ 오픈",
        description: "",
        actions: [
          { key: "raise", label: "3벳 7.5bb", color: "raise", range: "JJ+, TT:0.6, 99:0.3, AQs+, AJs:0.7, ATs:0.4, A5s:0.8, A4s:0.6, A3s:0.3, KQs:0.8, KJs:0.5, KTs:0.3, QJs:0.4, JTs:0.3, T9s:0.2, 98s:0.15, 76s:0.15, 65s:0.15, AKo, AQo:0.6, KQo:0.3" },
          { key: "call", label: "콜", color: "call", range: "TT:0.4, 99:0.7, 88-55, 44:0.6, 33:0.4, 22:0.4, AJs:0.3, ATs:0.6, A9s:0.4, KJs:0.5, KTs:0.6, QJs:0.6, QTs:0.6, JTs:0.7, J9s:0.3, T9s:0.6, 98s:0.5, 87s:0.4, AQo:0.4, AJo:0.3, KQo:0.4" },
        ],
      },
      {
        id: "sb-vs-btn",
        kind: "vsOpen",
        hero: "SB",
        villain: "BTN",
        chip: "SB vs BTN",
        title: "SB vs BTN 오픈",
        description: "",
        actions: [
          { key: "raise", label: "3벳 11bb", color: "raise", range: "88+, 77:0.7, 66:0.5, 55:0.3, A9s+, A8s:0.7, A7s:0.5, A6s:0.4, A5s-A3s, A2s:0.6, KTs+, K9s:0.7, K8s:0.3, QTs+, Q9s:0.5, JTs, J9s:0.5, T9s:0.7, T8s:0.3, 98s:0.6, 87s:0.5, 76s:0.5, 65s:0.4, 54s:0.3, ATo+, A9o:0.3, A5o:0.2, KJo+, KTo:0.4, QJo:0.5, JTo:0.2" },
          { key: "call", label: "콜", color: "call", range: "77:0.2, 66:0.3, 55:0.3, 44:0.3, 33:0.2, 22:0.2" },
        ],
      },
      {
        id: "vs-3bet",
        kind: "vs3bet",
        hero: "Hero",
        chip: "vs 3벳",
        title: "오픈 vs 3벳",
        description: "내 오픈에 3벳이 들어온 평균적인 상황. 4벳은 약 2.3배, 나머지는 폴드. A5s·A4s는 4벳 블러프.",
        actions: [
          { key: "4bet", label: "4벳", color: "raise", range: "KK+, QQ:0.5, AKs, AKo:0.6, A5s:0.5, A4s:0.4" },
          { key: "call", label: "콜", color: "call", range: "QQ:0.5, JJ-77, 66:0.6, 55:0.5, 44:0.3, AQs, AJs, ATs:0.7, A9s:0.3, A5s:0.3, A4s:0.3, KQs, KJs, KTs:0.6, QJs, QTs:0.6, JTs, T9s:0.8, 98s:0.6, 87s:0.5, 76s:0.5, 65s:0.4, AKo:0.4, AQo:0.6, KQo:0.3" },
        ],
      },
      ],
    },
  ],
};
