# My GTO

홀덤 GTO를 혼자 공부하기 위한 PWA. 프리플랍 차트, 퀴즈, 스팟 계산기, 그리고 Claude API 기반 AI 코치가 들어 있다.

## 기능

| 탭 | 내용 |
|---|---|
| **차트** | 6맥스 100bb 프리플랍 차트 13종 (RFI 5개 + 오픈 대응 8개). 핸드를 누르면 빈도와 AI 해설 |
| **퀴즈** | 프리플랍(차트 기준 채점, 혼합 빈도는 부분 정답) · 팟 오즈/MDF/블러프/아웃츠/EV · 에퀴티 감각(프리플랍·플랍) |
| **계산기** | 내 핸드 + 보드 + 상대 레인지(또는 핸드) + 팟/베팅 → 에퀴티, 필요 에퀴티, 콜 EV, MDF |
| **AI 코치** | 어느 화면에서든 "AI 해설 요청" → 그 스팟 정보를 들고 대화 시작. 이어서 질문 가능 |

### AI 코치 설계

- 숫자는 **앱이 계산**하고(에퀴티·팟 오즈·차트 빈도), AI는 그 숫자를 받아 **쉽게 풀어서 설명**만 한다. 그래서 AI가 숫자를 지어낼 여지가 적다.
- 시스템 프롬프트에 기본 해설집(`src/features/coach/knowledge.md`)이 들어가고, 설정의 "나만의 해설 노트"가 함께 붙는다.
- 해설집 블록은 프롬프트 캐싱으로 재사용되고, 대화 내역은 자동 캐싱된다.
- 기본 모델은 Claude Opus 5.5. 설정에서 Sonnet 5.5 / Haiku 5.5로 바꿀 수 있다. Opus/Sonnet은 서버 측 거절 대체(`fallbacks: "default"`)가 켜져 있다.
- 대화는 스팟마다 따로 저장된다(최근 40개, 브라우저 localStorage).

## 실행

```bash
npm install
npm run dev        # 개발 서버
npm test           # 엔진·차트·퀴즈 테스트
npm run build      # dist/ 에 PWA 빌드
npm run preview    # 빌드 결과 미리보기
```

휴대폰에 설치하려면 `dist/`를 HTTPS 정적 호스팅(GitHub Pages, Vercel, Netlify 등)에 올리고, 브라우저 메뉴에서 "홈 화면에 추가"를 누르면 된다. `base: "./"`라서 하위 경로에 올려도 동작한다.

## API 키

1. [Claude Console](https://platform.claude.com/settings/keys)에서 API 키를 만든다.
2. Max/Ultra 요금제의 월 API 크레딧을 쓰려면 claude.ai → 설정 → 결제 → API 크레딧에서 Console 조직을 연결하고, **그 조직에서** 키를 만든다.
3. 앱의 설정 탭에 키를 넣고 "키 확인"을 누른다 (토큰을 쓰지 않는 모델 조회로 확인).

키는 그 기기의 브라우저에만 저장되고, 브라우저에서 Anthropic API로 직접 요청한다(`dangerouslyAllowBrowser`). **혼자 쓰는 용도로만 안전하다.** 앱을 마켓에 내거나 다른 사람이 쓰게 하려면 키를 서버(프록시)로 옮겨야 한다.

## 차트 데이터

`src/data/preflop.ts`의 차트는 **솔버 정확값이 아닌 학습용 근사 차트**다. 레인지 문자열만 바꾸면 직접 구한 솔버 결과로 교체할 수 있다.

```
"66+, 55:0.75, A2s+, KTo+, AJs-A6s, QJo:0.4"
 77+ = 77~AA   A2s+ = A2s~AKs   22-66, AJs-A6s = 범위   :0.4 = 40% 빈도 (뒤 토큰이 앞을 덮어씀)
```

## 구조

```
src/
  poker/        카드, 레인지 파서, 7장 핸드 평가기, 에퀴티(정확 계산/시뮬레이션), 팟 오즈 계산
  data/         프리플랍 차트
  features/
    charts/     차트 화면
    quiz/       퀴즈 화면 + 문제 생성기
    calc/       스팟 계산기
    coach/      AI 코치 (프롬프트, 해설집, Claude API 클라이언트, 대화 저장)
    settings/   설정
  state/        localStorage 저장소
```

핸드 평가기는 테스트에서 단순 무차별 평가기와 무작위 3000판을 비교해 검증한다.

## 다음 단계 아이디어

- 포스트플랍 퀴즈: [TexasSolver](https://github.com/bupticybee/TexasSolver) 콘솔로 자주 나오는 스팟을 미리 계산해 JSON으로 넣고, 스트리트별(플랍/턴/리버) 결정 퀴즈 + AI 해설
- 차트 편집/가져오기 화면
- 틀린 문제 복습 모드
