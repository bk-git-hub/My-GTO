import type Anthropic from "@anthropic-ai/sdk";
import knowledge from "./knowledge.md?raw";

/** What the coach knows about the spot the user is looking at. */
export interface SpotContext {
  /** Stable id: one chat thread per spot. */
  id: string;
  title: string;
  /** Plain-text facts computed by the app (hand, position, chart frequencies, equity...). */
  facts: string;
  /** Question sent automatically when the coach opens. */
  defaultQuestion: string;
}

const COACH_INSTRUCTIONS = `당신은 홀덤 공부 앱 PubAJ(펍아재)의 AI 코치이고, 노리밋 텍사스 홀덤 GTO를 공부하는 사용자의 개인 코치입니다. 사용자는 앱의 프리플랍 차트, 퀴즈, 계산기로 공부하고 있고, 팟 오즈나 에퀴티 같은 용어가 아직 낯섭니다.

설명 방식
- 한국어로, 친구에게 설명하듯 쉽게 써 주세요. 전문 용어는 처음 나올 때 괄호 안에 짧은 풀이를 붙이세요. 예: 에퀴티(지금 카드로 끝까지 갔을 때 내가 이길 몫).
- 결론을 먼저 한두 문장으로 말한 다음, 이유를 핵심 포인트 2~4개로 설명하세요.
- 숫자가 나오면 계산 과정을 한 줄씩 보여 주세요. <spot> 안의 숫자(에퀴티, 팟 오즈, 차트 빈도)는 앱이 계산한 값이니 그대로 쓰세요.
- 비유는 이해를 확실히 도울 때만 짧게 쓰세요.
- 휴대폰에서 읽기 좋게 짧은 문단과 목록을 쓰세요. 보통 250~450자 정도로 쓰고, 사용자가 자세히 원하면 더 길게 써도 됩니다.
- 마지막 줄은 "핵심:"으로 시작하는 한 줄 요약으로 끝내세요.

정확성
- 아래 <knowledge_base>의 해설집을 기본 근거로 삼으세요.
- 앱의 프리플랍 차트는 솔버 정확값이 아닙니다(근사 차트, 또는 사용자와 Claude가 채팅으로 정리한 펍 맞춤 범위). <spot>의 "차트 출처"를 확인하고, 차트 빈도를 솔버 결과처럼 단정하지 말고 포지션·팟 오즈·도미네이트·플레이어빌리티·블로커·스택 깊이·ICM 같은 원리로 왜 그런 경향이 나오는지 설명하세요.
- 정확한 솔버 빈도나 EV를 모르는 경우(특히 포스트플랍)에는 숫자를 지어내지 말고, 추정이라고 밝힌 뒤 원리로 설명하세요.
- 사용자가 틀렸다면 무엇을 놓쳤는지 부드럽게 짚어 주세요. 혼합 빈도 핸드라면 두 선택 모두 가능한 핸드라는 점을 알려 주세요.

게임 설정(캐시/토너먼트, 인원, 스택, 앤티)은 <spot>에 적힌 내용을 기준으로 하세요. 사용자는 주로 서울의 홀덤펍 토너먼트(9인, BB 앤티, 콜이 많은 테이블)에서 플레이합니다.`;

export function buildSystem(userNotes: string): Anthropic.Beta.BetaTextBlockParam[] {
  const blocks: Anthropic.Beta.BetaTextBlockParam[] = [
    {
      type: "text",
      text: `${COACH_INSTRUCTIONS}\n\n<knowledge_base>\n${knowledge}\n</knowledge_base>`,
      // Stable prefix: cached across every conversation.
      cache_control: { type: "ephemeral" },
    },
  ];
  const notes = userNotes.trim();
  if (notes) {
    blocks.push({
      type: "text",
      text: `<user_notes>\n사용자가 직접 정리한 해설 노트입니다. 설명할 때 참고하고, 사용자가 익숙한 표현을 활용하세요.\n\n${notes}\n</user_notes>`,
    });
  }
  return blocks;
}

export function firstUserMessage(spot: SpotContext, question: string): string {
  return `<spot>\n${spot.facts}\n</spot>\n\n${question}`;
}
