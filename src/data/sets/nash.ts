import type { ChartSetDef, ScenarioDef, StageDef } from "../charts";
import { NASH_STAGES, type NashStage } from "./nashData";

/**
 * 푸시/폴드 내쉬 차트: scripts/make-nash.mjs가 계산한 칩EV 균형 (nashData.ts).
 * 펍 토너먼트 구조(9인, BB 앤티 1bb)에서 모두 같은 스택일 때의 정답 기준선이다.
 */

const POS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
const CALLERS = ["BB", "SB", "BTN", "CO", "HJ", "LJ", "UTG+2", "UTG+1"];
const id = (seat: string) => seat.toLowerCase().replace("+", "p");

function stage(s: NashStage): StageDef {
  const push: ScenarioDef[] = POS.slice(0, 8).map((seat) => ({
    id: `push-${id(seat)}`,
    kind: "rfi",
    hero: seat,
    chip: seat,
    title: `${seat} 푸시 레인지`,
    description: "",
    actions: [{ key: "shove", label: "올인", color: "allin", range: s.push[seat] }],
  }));
  const calls: ScenarioDef[] = CALLERS.flatMap((caller) =>
    POS.slice(0, POS.indexOf(caller)).map((shover) => ({
      id: `call-${id(caller)}-vs-${id(shover)}`,
      kind: "vsShove" as const,
      hero: caller,
      villain: shover,
      chip: `${caller} vs ${shover}`,
      title: `${caller} 콜 vs ${shover} 올인`,
      description: "",
      actions: [{ key: "call", label: "콜", color: "call" as const, range: s.call[caller][shover] }],
    })),
  );
  return {
    id: `${s.stack}bb`,
    label: `${s.stack}bb`,
    stack: `모두 ${s.stack}bb`,
    description: "칩EV 내쉬 균형. 콜은 사이 자리가 모두 폴드한 경우이고, 콜이 한 명 나오면 나머지는 폴드한다고 가정해요.",
    scenarios: [...push, ...calls],
  };
}

export const NASH: ChartSetDef = {
  id: "nash",
  label: "푸시/폴드 내쉬 (9인·BB 앤티)",
  game: "홀덤펍 토너먼트 · 9인 · BB 앤티 1bb · 모두 같은 스택 · 푸시 or 폴드만 하는 구간",
  source:
    "이 앱이 직접 계산한 칩EV 내쉬 균형이에요 (오픈소스 계산 코드: scripts/make-nash.mjs). 모두 같은 스택, 오버콜 없음, ICM(상금 구조) 미반영이라 버블이나 머니 근처에서는 콜을 더 좁혀야 해요.",
  positions: POS,
  stages: NASH_STAGES.map(stage),
};
