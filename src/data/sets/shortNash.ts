import type { ChartSetDef, ScenarioDef, StageDef } from "../charts";
import { SHORT_NASH_OPEN, SHORT_NASH_STAGES, type ShortNashStage } from "./shortNashData";

/**
 * 숏스택 내쉬 (오픈·리쉬브): scripts/make-shortnash.mjs가 프리플랍 솔버의 DCFR 엔진으로 계산한 칩EV 균형
 * (shortNashData.ts). 퍼스트 인은 폴드/2bb 오픈/올인, 오픈에는 3벳 올인 or 폴드(BB는 콜도), 리쉬브에 오픈한 사람
 * 콜/폴드. 보정된 솔버 숏스택 스테이지(25·20·15bb)가 나오기 전까지 12~25bb의 임시 기준 차트다.
 */

const POS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
const id = (seat: string) => seat.toLowerCase().replace("+", "p");
const later = (seat: string) => POS.slice(POS.indexOf(seat) + 1);
const earlier = (seat: string) => POS.slice(0, POS.indexOf(seat)).filter((s) => s !== "BB");

function stage(s: ShortNashStage): StageDef {
  const rfi: ScenarioDef[] = POS.slice(0, 8).map((seat) => ({
    id: `rfi-${id(seat)}`,
    kind: "rfi",
    hero: seat,
    chip: seat,
    title: `${seat} 오픈·올인 레인지`,
    description: "",
    actions: [
      { key: "open", label: `${SHORT_NASH_OPEN}bb 오픈`, color: "open", range: s.open[seat] },
      { key: "shove", label: "올인", color: "allin", range: s.jam[seat] },
    ],
  }));
  const vsOpen: ScenarioDef[] = ["BB", "SB", "BTN", "CO", "HJ", "LJ", "UTG+2", "UTG+1"].flatMap((me) =>
    earlier(me).map((opener) => ({
      id: `${id(me)}-vs-${id(opener)}-open`,
      kind: "vsOpen" as const,
      hero: me,
      villain: opener,
      chip: `${me} vs ${opener}`,
      title: `${me} vs ${opener} ${SHORT_NASH_OPEN}bb 오픈`,
      description: me === "BB" ? "BB만 콜할 수 있어요. 다른 자리는 3벳 올인 or 폴드." : "3벳 올인 or 폴드 (플랫 콜 없음).",
      actions: [
        { key: "shove", label: "3벳 올인", color: "allin" as const, range: s.reJam[me][opener] },
        ...(me === "BB" ? [{ key: "call", label: "콜", color: "call" as const, range: s.bbCall[opener] }] : []),
      ],
    })),
  );
  const vs3bet: ScenarioDef[] = POS.slice(0, 8).flatMap((opener) =>
    later(opener).map((jammer) => ({
      id: `${id(opener)}-open-vs-${id(jammer)}-jam`,
      kind: "vs3bet" as const,
      hero: opener,
      villain: jammer,
      chip: `${opener} vs ${jammer}`,
      title: `${opener} 오픈 후 vs ${jammer} 3벳 올인`,
      description: "",
      actions: [{ key: "call", label: "콜", color: "call" as const, range: s.callReJam[opener][jammer] }],
    })),
  );
  const vsShove: ScenarioDef[] = ["BB", "SB", "BTN", "CO", "HJ", "LJ", "UTG+2", "UTG+1"].flatMap((me) =>
    earlier(me).map((jammer) => ({
      id: `call-${id(me)}-vs-${id(jammer)}`,
      kind: "vsShove" as const,
      hero: me,
      villain: jammer,
      chip: `${me} vs ${jammer}`,
      title: `${me} 콜 vs ${jammer} 올인`,
      description: "",
      actions: [{ key: "call", label: "콜", color: "call" as const, range: s.callJam[me][jammer] }],
    })),
  );
  return {
    id: `${s.stack}bb`,
    label: `${s.stack}bb`,
    stack: `모두 ${s.stack}bb`,
    description: `DCFR로 계산한 칩EV 균형. 오픈은 ${SHORT_NASH_OPEN}bb. BB가 콜한 뒤의 플레이는 단순화(체크다운, 핸드 종류별 에퀴티 실현율)했어요.`,
    scenarios: [...rfi, ...vsOpen, ...vs3bet, ...vsShove],
  };
}

export const SHORT_NASH: ChartSetDef = {
  id: "shortnash",
  label: "숏스택 내쉬 (10~25bb·오픈/리쉬브·DCFR)",
  game: `홀덤펍 토너먼트 · 9인 · BB 앤티 1bb · 모두 같은 스택 · 퍼스트 인은 폴드/${SHORT_NASH_OPEN}bb 오픈/올인`,
  source:
    "이 앱의 프리플랍 솔버 엔진(DCFR)이 이 단순한 게임을 직접 푼 칩EV 균형이에요 (scripts/make-shortnash.mjs). 모두 같은 스택, 오버콜 없음, BB 말고는 플랫 콜 없음, ICM 미반영. BB 콜 이후는 체크다운으로 보고 BB가 핸드 종류별로 에퀴티 일부만 가져간다고 가정해서(페어·좋은 수티드 90%, 오프수트 브로드웨이 85%, 약한 오프수트 50%, 스택이 짧을수록 100%에 가깝게) 그 부분은 근사예요. 오픈한 뒤 리쉬브를 받는 차트에서 그 자리가 오픈하지 않는 핸드 칸은 '오픈했다면' 기준의 최선 응답이에요. 솔버 차트에 보정된 25·20·15bb가 들어오기 전까지 12~25bb의 임시 기준이에요.",
  positions: POS,
  stages: SHORT_NASH_STAGES.map(stage),
};
