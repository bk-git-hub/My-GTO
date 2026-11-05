# PubAZ 서버 설계

> 상태: **설계 + 뼈대 (Phase 0)**. 서버는 아직 연결돼 있지 않다. `api/v1.ts`는 설정이 없으면 모든 요청에 503 `서버 준비 중`을 돌려준다. 앱은 지금처럼 서버 없이 전부 동작한다.
>
> **2026-11-05 회원 시스템 결정**: 익명 시작, 카카오·애플·구글·이메일 인증코드 로그인, 관리형 Supabase(Auth + Postgres), 가입·AI는 만 19세 이상(잠정). 이 결정으로 4장(스택)과 5장(인증) 일부가 바뀐다. 무엇이 바뀌는지와 데이터별 관리 구분은 [`data-inventory.md`](data-inventory.md)에 있고, 둘이 다르면 그 문서가 우선한다.

이 문서는 PubAZ를 나중에 서비스로 만들 때의 서버 구조를 정리한 것이다. 계정, 기록 동기화, AI 코치 사용량, 결제, 솔버 콘텐츠 팩, 오늘의 문제를 다룬다. 코드로 이미 있는 부분과 설계만 있는 부분을 2장에서 구분한다.

## 1. 목표와 원칙

- **로컬 우선(local-first)**: 앱은 오프라인에서 전부 동작한다. 퀴즈, 차트, 계산기, 기록 보기는 서버 없이 된다. 서버는 "다른 기기와 기록 공유", "AI 코치 키 보관", "결제 권한 확인"만 맡는다. 서버가 죽어도 앱은 그대로 쓸 수 있어야 한다.
- **익명 우선 계정**: 처음 열면 가입 화면 없이 기기 하나 = 익명 계정 하나다. 이메일·Apple·Google 연결은 나중에 사용자가 원할 때만 한다. 그래서 회원가입 때문에 떠나는 사람이 없다.
- **추가만 하는 기록(append-only)**: 답 하나 = `Attempt` 하나(`shared/contracts.ts`). 한 번 쓰면 바꾸지 않는다. 동기화는 "id로 합집합"만 하면 되므로 충돌이 생기지 않는다. 수정·삭제 동기화, 마지막 쓰기 우선(last-write-wins) 같은 문제를 처음부터 없앤다.
- **얇은 서버**: 숫자 계산(에퀴티, 차트 채점, EV)은 앱이 한다. 서버는 저장·인증·한도 관리만 한다. 서버 비용과 버그 표면이 작아진다.
- **실패 시 닫힘(fail closed)**: 비밀값이 없거나 짧으면, 저장소 설정이 없으면, 서버는 동작하지 않고 503을 돌려준다. "설정이 빠졌는데 열려 있는" 상태를 만들지 않는다.
- **개인정보 최소화**: 이름·이메일 없이 시작한다. Anthropic에는 사용자 식별자를 보내지 않는다. 통계는 동의한 사용자의 집계만 쓴다.

## 2. 현재 코드에 있는 것 / 아직 설계만 있는 것

| 항목 | 상태 | 위치 |
|---|---|---|
| 데이터 계약 (`Attempt`, `LIMITS`, 동기화 요청/응답 타입) | 코드 있음 | `shared/contracts.ts`, `shared/ids.ts` |
| 기기 안의 답 기록 + 기록 화면 | 코드 있음 (같은 변경의 다른 작업) | `src/state/attempts.ts`, `src/features/records/` |
| HTTP 도우미 (JSON 응답, ApiError, 크기 제한 본문 읽기, CORS) | 코드 + 테스트 | `server/http.ts` |
| 토큰 발급·검증 (HMAC-SHA256) | 코드 + 테스트 | `server/auth.ts` |
| Attempt 서버 검증 | 코드 + 테스트 | `server/validate.ts` |
| 저장소 인터페이스, 메모리 저장소 | 코드 + 테스트 | `server/store.ts`, `server/store.memory.ts` |
| Postgres 저장소 (SQL만, 드라이버 없음) | 코드 + 가짜 SqlClient 테스트. 실제 DB에서는 아직 안 돌려 봄 | `server/store.postgres.ts` |
| DB 스키마 | SQL 파일 있음, 적용한 DB 없음 | `server/db/migrations/001_init.sql` |
| AI 코치 일일 한도 계산 | 코드 + 테스트 (`/me`에서 읽기만) | `server/quota.ts` |
| `/api/v1` 라우터 (health, 익명 인증, push, pull, me) | 코드 + 테스트 | `server/router.ts` |
| Vercel 진입점 (기본 503, 개발용 메모리 모드) | 코드 + 테스트 | `api/v1.ts`, `vercel.json` |
| 앱 쪽 동기화 클라이언트·엔진·백오프 | 코드 + 테스트. 앱에서 아직 부르지 않음 | `src/sync/api.ts`, `src/sync/engine.ts` |
| Postgres 드라이버 연결 (`@neondatabase/serverless`) | 설계만 | 6장, 15장 |
| 기기 비밀값 (deviceId 탈취 대비) | 설계만 | 5.3 |
| AI 코치를 토큰 + 한도로 보호 (`api/anthropic.ts` 변경) | 설계만 (Phase 1) | 7장 |
| 계정 연결·기기 병합, 계정 삭제 | 설계만 (테이블만 있음) | 5.4 |
| 결제·권한 웹훅 | 설계만 (`entitlements` 테이블만 있음) | 8장 |
| 솔버 콘텐츠 팩, 오늘의 문제, 문제 레이팅, 인구 데이터 | 설계만 | 9~11장 |
| 요청 횟수 제한(rate limit) | 설계만 | 12장 |

## 3. 구조

```
 ┌──────────────────────── 휴대폰 / 브라우저 (PWA) ────────────────────────┐
 │  퀴즈·플레이·차트 ──▶ attempts 로그 (localStorage, 최대 5,000개)        │
 │                          │  unsynced()                                   │
 │                          ▼                                               │
 │                     src/sync/engine.ts ── syncOnce / pullAll / backoff   │
 │                          │  src/sync/api.ts (fetch)                      │
 │  콘텐츠 팩 캐시 (Cache Storage, sha256 확인) ◀──────────────┐            │
 └──────────────────────────┼──────────────────────────────────┼────────────┘
                            │ HTTPS, Bearer 토큰               │ 정적 파일
                            ▼                                  │
 ┌──────────────── Vercel (같은 프로젝트, 같은 도메인) ─────────┼────────────┐
 │  api/v1.ts ──▶ server/router.ts                             │            │
 │                 ├─ auth.ts     토큰 서명/검증 (AUTH_SECRET)  │            │
 │                 ├─ validate.ts 입력 검증 (LIMITS)            │            │
 │                 ├─ quota.ts    코치 일일 한도 (KST)          │            │
 │                 └─ store.ts ──▶ PostgresStore ──SqlClient──┐ │            │
 │  api/anthropic.ts (코치 중계) ──────────────────────────┐  │ │            │
 │  public/packs/  manifest.json + 시나리오 파일 (CDN) ─────┼──┼─┘            │
 └──────────────────────────────────────────────────────────┼──┼──────────────┘
                                                            │  │
                     Anthropic API ◀────────────────────────┘  ▼
                     (사용자 식별자 없이)              Neon Postgres
                                                       (users, devices, attempts,
 결제: RevenueCat / 토스페이먼츠 ──웹훅──▶ /api/v1/webhooks/* ──▶ entitlements)
 솔버: 우리 PC에서 오프라인 실행 ──▶ 결과 JSON ──▶ public/packs/ (코드 배포 없음)
```

## 4. 스택 선택

- **Vercel Functions (Node 런타임, Web 표준 `Request`/`Response`)**: PWA와 같은 프로젝트·같은 도메인에 둔다. 같은 출처라서 CORS가 필요 없고, 배포가 한 번에 끝난다. 이미 `api/anthropic.ts`가 같은 방식으로 돌고 있다. 함수 리전은 사용자와 DB에 가까운 곳으로 맞춘다(서울 `icn1` 등).
- **Postgres, Neon 추천**: 서버리스 드라이버(HTTP/WebSocket)가 있어 함수에서 연결 풀 문제가 적고, 쉬면 자동으로 멈춰서 초기 비용이 거의 없다. 미리보기 배포마다 DB 브랜치를 만들 수 있다. 리전은 함수와 같은 곳(또는 가장 가까운 아시아 리전)으로 고른다. 다른 Postgres(Supabase, RDS)로 바꿔도 코드는 그대로다.
- **ORM 없음, 작은 `SqlClient` 인터페이스**: `server/store.postgres.ts`는 `query(text, params) → { rows }` 하나만 받는다. 드라이버는 진입점에서 주입한다. 쿼리는 전부 매개변수(`$1`)로만 넘기고, 사용자 입력이 SQL 문자열에 들어가지 않는다. 테스트는 가짜 `SqlClient`로 한다.
- **마이그레이션은 SQL 파일**: `server/db/migrations/NNN_*.sql`을 번호 순서로 한 번씩 적용하고 `schema_migrations`에 기록한다. 도구 의존이 없다.
- **인증은 직접**: 익명 계정 + HMAC 토큰이면 Firebase Auth나 Supabase Auth 없이 충분하다. 외부 로그인(Apple/Google)은 그 공급자의 ID 토큰만 검증하면 된다. 특정 BaaS에 묶이지 않는다.
- **ESM 주의**: `package.json`이 `"type": "module"`이라 Vercel에서 상대 경로 import에 확장자가 필요하다. 그래서 `server/`와 `api/v1.ts`는 `./auth.js`처럼 `.js`를 붙여 쓴다(TypeScript·Vite가 `.ts`로 찾아 준다).

## 5. 인증

### 5.1 익명 기기 계정

1. 앱이 처음 켜질 때 `deviceId`를 만든다(`shared/ids.ts`의 `newId()`, 이미 `src/state/attempts.ts`가 만든다).
2. 동기화를 켜면 `POST /api/v1/auth/anonymous { deviceId }`.
3. 서버는 `devices`에서 그 기기의 사용자를 찾고, 없으면 사용자와 기기를 함께 만든다. 같은 기기는 항상 같은 사용자다.
4. 응답 `{ userId, token, expiresAt }`. 토큰 수명은 30일(`TOKEN_TTL_MS`)이다. 만료되거나 401을 받으면 앱이 2번을 다시 한다.

### 5.2 토큰 형식

```
base64url({"sub":"<userId>","exp":<epoch ms>,"v":1}) + "." + base64url(HMAC-SHA256(AUTH_SECRET, 앞부분))
```

- WebCrypto(`crypto.subtle`)로 서명한다. 의존성이 없다.
- 검증 순서: 모양 확인 → 서명 비교(상수 시간) → JSON 파싱 → `v`·`exp` 확인 → 저장소에서 사용자 존재 확인.
- `AUTH_SECRET`이 32자보다 짧으면 "설정 안 됨"으로 보고 503을 준다.
- 상태가 없는(stateless) 토큰이라 서버에 세션 테이블이 없다. 비밀값을 바꾸면 전원이 로그아웃되고, 앱은 조용히 다시 익명 인증을 한다. 정기 교체가 쉽다.
- 개별 토큰 폐기가 필요해지면 `users.token_version` 열을 추가해 `v`와 비교한다.

### 5.3 기기 비밀값 (Phase 1 시작 전에 필요)

지금 계약(`AnonymousAuthRequest`)은 `deviceId`만 보낸다. `deviceId`는 무작위 80비트라 추측은 불가능하지만, **모든 Attempt에 들어 있고 기록 내보내기 파일에도 들어간다.** 사용자가 내보내기 파일을 공유하면 그 파일로 남의 계정 토큰을 받을 수 있다. 그래서 실제 서비스 전에 다음을 넣는다.

- 앱이 `deviceSecret`(무작위 32바이트)을 따로 만들어 기기에만 보관한다. 내보내기 파일에는 넣지 않는다.
- `AnonymousAuthRequest`에 `deviceSecret?: string`을 추가한다(추가만 하는 계약 변경).
- 서버는 처음 본 기기의 `SHA-256(deviceSecret)`을 `devices.secret_hash`에 저장하고(이미 열이 있다), 그 뒤로는 일치할 때만 토큰을 준다.
- 비밀값을 잃은 기기(앱 데이터 삭제)는 새 익명 계정이 된다. 기록을 되찾으려면 5.4의 계정 연결이 필요하다.

### 5.4 계정 연결과 기기 병합 (Phase 1)

- Apple/Google: 앱이 받은 ID 토큰을 서버가 공급자 공개키(JWKS)로 검증하고 `auth_identities(provider, subject) → user_id`를 만든다. 이메일은 매직 링크(일회용 코드)로 한다.
- 이미 그 identity에 연결된 사용자가 있으면 **병합**한다: 현재 익명 사용자의 `devices`와 `attempts`를 대상 사용자로 옮긴다. Attempt id가 사용자 안에서 유일하므로 `INSERT … SELECT … ON CONFLICT DO NOTHING` 후 원래 행을 지우면 된다. append-only라 병합에도 충돌이 없다.
- 병합 후 옮겨 간 기기는 새 토큰을 받는다. 옮긴 기록은 새 `seq`를 받으므로 다른 기기의 pull에 자연스럽게 나타난다.
- 계정 삭제: `users.deleted_at`을 찍고(바로 로그인 불가), 30일 뒤 하드 삭제한다. `ON DELETE CASCADE`로 기기·기록·사용량·권한이 함께 지워진다. 앱 안 기록은 그대로 남는다(로컬 우선).

## 6. 동기화 프로토콜

### 6.1 push — `POST /api/v1/sync/push`

- 요청 `{ attempts: Attempt[] }`, 최대 `LIMITS.pushBatch`(200)개. 넘으면 400. 본문은 2.5MB까지(최대 길이 문자열 200개 기준 약 2MB).
- 항목마다 `validateAttempt`로 검사한다. 하나가 틀려도 나머지는 저장한다.
- 응답:
  - `accepted`: 새로 저장한 id
  - `duplicates`: 서버에 이미 있던 id, 그리고 같은 요청 안에서 반복된 id. 앱은 이것도 동기화 완료로 본다.
  - `rejected`: `{ id, reason }`. 앱은 같은 내용으로 다시 보내지 않는다(`markRejected`). id가 없거나 문자열이 아니면 `id: ""`.
- 멱등성: 저장은 `(user_id, id)` 유일 제약 + `ON CONFLICT DO NOTHING`이다. 네트워크가 끊겨서 같은 배치를 다시 보내도 결과는 `duplicates`일 뿐이다.
- 같은 사용자의 push는 사용자 행 `FOR UPDATE` 잠금으로 줄을 세운다. 그래서 `seq`가 커밋 순서대로 보이고, 동시에 도는 pull이 중간 번호를 건너뛰지 않는다.

### 6.2 pull — `GET /api/v1/sync/pull?after=<cursor>&limit=<n>`

- 커서는 **서버가 매긴 순번(`attempts.seq`)**이다. Attempt id가 아니다. id는 기기 시계로 만들어지므로, 오래 오프라인이던 기기가 나중에 올린 기록은 다른 기기가 이미 지나간 id보다 작을 수 있다. id로 페이지를 넘기면 그 기록을 영영 못 받는다(테스트 `pull pages by cursor` 참고).
- `limit`은 1~500(`LIMITS.pullPage`), 크면 500으로 줄인다. `after`는 숫자 문자열만 받는다.
- 응답 `cursor`는 마지막으로 돌려준 기록의 순번이다. 빈 페이지면 `null`이다. 앱은 **null이 아닌 마지막 커서를 저장**해 두고 다음 동기화 때 그 뒤부터 받는다.
- 자기 기기에서 올린 기록도 함께 내려온다. 앱은 id로 합치므로(`mergeAttempts`) 문제없다.

### 6.3 검증 규칙 (`server/validate.ts`)

| 필드 | 규칙 |
|---|---|
| `id`, `deviceId` | `isId()` (26자 Crockford base32) |
| `v` | `SCHEMA_VERSION`과 같아야 함 |
| `at` | 정수(ms, Postgres bigint), 2024-01-01 이후, 서버 시각 + 24시간 이전 |
| `kind` | `QUIZ_KINDS` 중 하나 |
| `keys` | 문자열 배열, 최대 8개, 각 1~80자 |
| `spot` | 1~120자 |
| `title` | 0~120자 |
| `chosen`, `correct` | 0~80자 |
| `grade` | `correct` / `mixed` / `wrong` |
| `evLossBB` | 있으면 유한한 수, 0 이상, 10,000 이하 |
| `detail` | 있으면 0~2,000자 |
| 공통 | 모든 문자열에 NUL(`\u0000`)과 짝 없는 서로게이트(잘못된 UTF-16) 금지 (Postgres가 저장 못 함, 하나만 있어도 배치 전체가 500으로 실패), 모르는 필드는 버림 |

### 6.4 앱 쪽 엔진 (`src/sync/engine.ts`)

- `syncOnce({ api, outbox, getToken, now })`: `outbox.unsynced(200)`을 보내고, `accepted + duplicates`는 `markSynced`, `rejected`는 `markRejected`. 빌 때까지 반복한다. 응답에 그 배치에 없던 id가 오면 무시한다.
- 401이면 `getToken(true)`로 한 번만 재인증하고 같은 배치를 다시 보낸다.
- 네트워크 오류·서버 오류에서는 멈추고 `{ pushed, duplicates, rejected, batches, error }`를 돌려준다. 보내지 못한 기록은 그대로 outbox에 남는다.
- 서버가 답은 했는데 아무것도 처리하지 않으면 같은 배치를 무한히 보내지 않도록 `no_progress`로 멈춘다.
- `nextBackoffMs(failures, error)`: 5초에서 시작해 두 배씩, 최대 15분, 지터 포함. `Retry-After`가 더 길면 그것을 따른다. `isRetryable`은 400·403 같은 "요청 자체가 틀린" 오류를 재시도하지 않는다.
- `pullAll`: 페이지마다 `onPage(attempts, cursor)`를 부른다. 앱은 기록을 저장한 **뒤에** 커서를 저장한다.
- 호출 시점(Phase 1): 앱 시작, 화면이 숨겨질 때(`visibilitychange`), 답 20개마다. 설정에 "기록 동기화" 스위치를 둔다.

### 6.5 스키마 버전

`SCHEMA_VERSION`을 올릴 때는 이 문서에 이전 메모를 남긴다. 서버는 한동안 두 버전을 모두 받고, 저장 전에 최신 버전으로 바꾼다. `payload`는 받은 그대로가 아니라 검증 후 다시 만든 객체를 저장하므로 오래된 필드가 섞이지 않는다.

## 7. AI 코치 (서버 경유)

### 7.1 지금

`api/anthropic.ts`는 서버 키로 `v1/messages`와 `v1/models/*`만 중계하고, `APP_PASSCODE`가 있으면 비밀번호를 확인한다. 혼자 또는 지인끼리 쓰기에는 충분하지만, 비밀번호 하나를 모두가 공유하고 사용량 한도가 없다.

### 7.2 Phase 1: 토큰 + 일일 한도

- `AUTH_SECRET`이 설정된 배포에서만 `api/anthropic.ts`가 `Authorization: Bearer` 토큰을 요구한다. 없으면 지금과 똑같이 동작한다(기존 테스트 유지). 이번 변경에서는 넣지 않았다. 앱이 아직 토큰을 보내지 않아서, 미리보기에서 `AUTH_SECRET`만 켜도 코치가 막히기 때문이다.
- 한도는 `server/quota.ts`: 무료 하루 5회(`COACH_DAILY_LIMIT_FREE`), Pro 하루 100회(`COACH_DAILY_LIMIT_PRO`). 기간 키는 KST 날짜(`2026-11-05`)이고 자정(KST)에 초기화된다. `/me`가 `{ used, limit, resetsAt }`을 알려 준다.
- 확인과 증가는 SQL 한 문장으로 원자적으로 한다(`INSERT … ON CONFLICT DO UPDATE … WHERE count < limit`). 동시에 여러 요청이 와도 한도를 넘지 않는다.
- 업스트림이 응답을 시작하기 전에 실패하면(5xx, 네트워크) 1회를 되돌린다.

### 7.3 Phase 1 후반: 서버가 프롬프트를 소유

범용 중계는 우리 키를 "아무 질문이나 되는 Claude"로 쓸 수 있게 한다. 그래서 `POST /api/v1/coach/messages`로 옮긴다.

- 앱은 `{ spotDetail, question, history }`만 보낸다. 시스템 프롬프트(`knowledge.md`), 모델, `max_tokens`, 대화 길이 제한은 서버가 정한다.
- **모델 등급**: 무료는 Haiku 5.5, Pro는 기본 Opus 5.5(설정에서 Sonnet 5.5). 짧은 후속 질문은 더 싼 모델로 보낼 수 있다.
- **프롬프트 캐싱**: 해설집 블록은 모든 사용자에게 똑같으므로 `cache_control`로 캐시하면 사용자 사이에서도 적중한다. 사용자별 노트는 그 뒤에 붙인다.
- **식별자 미전송**: `userId`, `deviceId`, 이메일, IP를 Anthropic 요청에 넣지 않는다. `detail`에는 카드·보드·스택 같은 스팟 정보만 들어간다.
- **주제 제한**: 입력 길이 상한(질문 1,000자, 대화 10턴), 시스템 프롬프트에 "홀덤 공부 밖의 요청은 정중히 거절" 지시, 응답 `max_tokens` 상한. 분류용 모델 호출은 남용이 실제로 보이면 그때 넣는다.
- 대화 내용은 서버에 저장하지 않는다. 대화 저장은 지금처럼 기기에서 한다.

## 8. 결제와 권한 (설계만)

- **스토어 앱(iOS/Android)**: RevenueCat. 애플·구글 영수증 검증, 갱신, 환불을 대신 처리하고 웹훅을 보낸다. iOS 앱 안의 디지털 상품은 인앱결제가 원칙이다.
- **웹 PWA**: 토스페이먼츠 또는 포트원(PortOne). 국내 카드·간편결제, 정기결제(빌링키)를 지원한다. 포트원은 여러 PG를 한 API로 묶어 주고, 토스페이먼츠는 단일 PG라 연동이 단순하다.
- **흐름**: 결제사 웹훅 → `/api/v1/webhooks/<provider>` → 서명 확인 → `webhook_events(provider, event_id)`에 기록(같은 이벤트 두 번 처리 방지) → `entitlements(user_id, 'pro', source, expires_at)` upsert.
- **권한 확인**: 매 요청마다 `getPlan()`이 `entitlements`를 인덱스로 한 번 읽는다. 토큰에 plan을 넣지 않는다(환불·만료가 바로 반영되도록).
- 결제 사용자 식별: 결제 시작 전에 앱이 서버에서 받은 `userId`를 결제사의 고객 키(RevenueCat `appUserID`, 토스 `customerKey`)로 쓴다. 그래서 익명 계정도 결제할 수 있고, 기기를 바꾸려면 5.4의 계정 연결이 필요하다고 안내한다.
- 마이그레이션 `002_payments.sql`에서 `webhook_events`를 추가한다.

## 9. 솔버 콘텐츠 팩

- **솔버는 우리 PC에서만 돌린다.** TexasSolver·postflop-solver는 AGPL이다. 앱이나 서버에 솔버 코드를 넣지 않고, 계산 결과(빈도·EV 숫자 JSON)만 배포한다. 결과 데이터는 프로그램 코드가 아니다(법률 자문이 아니므로 유료화 전에 한 번 확인한다).
- **형식**: 정적 파일 + 매니페스트.

```
packs/manifest.json
{ "v": 1, "packs": [ { "id": "srp-btn-bb-100", "title": "BTN vs BB 싱글 레이즈드 팟", "version": 3, "tier": "free",
    "files": [ { "path": "srp-btn-bb-100/v3/flop-AhKd7c.json", "sha256": "…", "bytes": 18234 } ] } ] }
```

- 파일 경로에 버전이 들어가므로 파일은 바뀌지 않고, `Cache-Control: immutable`로 오래 캐시한다. 매니페스트만 짧게 캐시한다.
- **필요한 시나리오만 받는다**: 퀴즈가 쓰는 보드 파일만 내려받고, WebCrypto로 sha256을 확인한 뒤 Cache Storage(또는 IndexedDB)에 넣는다. 한 번 받으면 오프라인에서도 쓴다.
- 처음에는 Vercel 정적 파일(`public/packs/`)로 충분하다. 커지면 Cloudflare R2 같은 저장소 + CDN으로 옮긴다.
- Pro 전용 팩은 서버가 짧게 유효한 서명 URL(HMAC, 10분)을 준다. 받은 파일을 기기에서 꺼내는 것까지 막을 수는 없다는 점은 받아들인다.

## 10. 오늘의 문제

- **문제 풀**: 미리 만든 문제 목록. 문제마다 바뀌지 않는 id(`dq-0001`)와 스팟·정답·해설이 있다. 콘텐츠 팩처럼 정적 파일로 배포한다.
- **결정적 선택**: 시드 = KST 날짜(`kstDateKey`, 예: `2026-11-05`). 날짜 문자열 해시로 시드한 의사 난수로 풀에서 **공통 3문제**를 고른다. 모든 사용자가 같은 날 같은 문제를 풀어서 비교·공유할 수 있다. 서버 없이 기기에서 계산된다.
- **개인 2문제**: 기기의 기록에서 약점(같은 `spot`의 오답률·`evLossBB`가 높은 것, 최근에 틀린 것)을 골라 비슷한 문제 2개를 더한다. 이것도 오프라인으로 된다.
- 기록은 `kind: "daily"`, `spot: "daily:dq-0001"`로 남긴다.
- **레이팅(Phase 3)**: 서버가 동의한 사용자의 `daily` 기록을 밤마다 모아, 답 하나를 "사용자 vs 문제" 한 판으로 보고 Glicko-2(간단히는 ELO)로 문제 난이도와 사용자 실력을 갱신한다. 문제 난이도는 다음 날 문제 선택에 쓰고, 사용자 레이팅은 본인에게만 보여 준다.

## 11. 인구 데이터 (나중에)

- "펍에서 실제로 얼마나 자주 콜하나" 같은 집계는 설정에서 **따로 동의한 사용자**의 기록만 쓴다. 동의는 언제든 철회할 수 있고, 철회하면 다음 집계부터 빠진다.
- 집계만 공개한다. 한 묶음에 사용자 20명 미만이면 보여 주지 않는다.
- **실명 인물 프로필을 만들지 않는다.** 상대 메모 기능이 생겨도 이름·닉네임·매장명을 서버로 보내지 않는다. 특정인의 성향 데이터는 개인정보이자 분쟁거리다.
- 개인정보 보호법(PIPA): 처리방침에 수집 항목·목적·보관 기간을 쓰고, 목적 외로 쓰지 않으며, 삭제 요청에 응한다(5.4 계정 삭제). 국외 이전(미국 리전 서버, Anthropic)이 있으면 처리방침에 적는다.

## 12. 보안

- **입력 검증**: 모든 본문은 크기 제한(인증 4KB, push 2.5MB)과 `content-type: application/json`을 확인한 뒤 파싱한다. JSON이 아니면 400, 너무 크면 413. Attempt는 6.3 규칙으로 검사하고 모르는 필드는 버린다.
- **오류 응답**: 항상 `{ error: { code, message } }`. 예상 못 한 오류는 500 + 일반 메시지만 주고 SQL 오류·스택은 로그에만 남긴다.
- **요청 횟수 제한 (Phase 1)**: Vercel 방화벽(WAF) 규칙으로 IP당 `/api/v1/auth/*` 분당 10회, 나머지 분당 120회. 사용자 단위로는 `usage_counters`에 분 단위 키(`push:2026-11-05T12:30`)로 센다. 익명 계정을 무한히 만드는 것을 막는 첫 장치다.
- **CORS**: 기본은 같은 출처만. 다른 출처는 `ALLOWED_ORIGINS` 목록에 있을 때만 허용하고, 목록에 없는 `Origin`이 오면 403. 토큰은 쿠키가 아니라 `Authorization` 헤더라서 CSRF 대상이 아니다.
- **비밀값**: `AUTH_SECRET`, `ANTHROPIC_API_KEY`, `DATABASE_URL`은 Vercel 환경 변수에 Sensitive로 둔다. 코드·로그·앱 번들에 넣지 않는다. `AUTH_SECRET`은 `openssl rand -base64 48`로 만든다.
- **기기 증명 (스토어 앱일 때)**: iOS App Attest, Android Play Integrity로 "진짜 우리 앱"인지 확인한 뒤에만 익명 계정을 만든다. 봇 계정·코치 남용을 줄인다. PWA에는 같은 수단이 없으므로 한도와 WAF로 막는다.
- **최소 수집**: 로그에 토큰·본문·`detail`을 남기지 않는다.
- **개발용 메모리 모드**: `SERVER_MODE=memory`는 함수 인스턴스마다 따로 있고 콜드 스타트 때 사라진다. `VERCEL_ENV=production`에서는 켜도 503이다.

## 13. 데이터 모델 요약 (`001_init.sql`)

| 테이블 | 키 | 주요 열 | 용도 |
|---|---|---|---|
| `users` | `id` | `created_at`, `deleted_at` | 계정 (익명으로 시작) |
| `devices` | `device_id` | `user_id`, `secret_hash`, `platform`, `last_seen_at` | 앱 설치 하나 |
| `auth_identities` | `(provider, subject)` | `user_id` | Apple/Google/이메일 연결 (Phase 1) |
| `attempts` | `seq` (identity), 유일 `(user_id, id)` | `kind`, `at`, `grade`, `spot`, `device_id`, `payload jsonb`, `received_at` | 답 기록 (추가만) |
| `usage_counters` | `(user_id, metric, period)` | `count` | 코치 일일 사용량, 분당 제한 |
| `entitlements` | `(user_id, entitlement)` | `source`, `external_id`, `expires_at` | Pro 권한 |
| `schema_migrations` | `version` | `applied_at` | 적용한 마이그레이션 |

인덱스: `attempts(user_id, seq)`는 pull 페이지, `attempts(user_id, kind, at)`는 종류별·날짜별 통계, `attempts(user_id, spot, at desc)`는 같은 스팟 복습과 약점 선택. 자주 묶는 열(`kind`, `at`, `grade`, `spot`)은 열로 꺼내고, 나머지는 `payload`에 그대로 둔다.

## 14. API

모든 경로는 `/api/v1` 아래에 있다. `vercel.json`이 `/api/v1/<path>`를 `/api/v1?path=<path>`로 바꿔 한 함수가 받는다.

| 메서드 | 경로 | 인증 | 요청 | 응답 | 상태 |
|---|---|---|---|---|---|
| GET | `/health` | 없음 | - | `{ ok, schemaVersion, serverTime }` | 구현 |
| POST | `/auth/anonymous` | 없음 | `AnonymousAuthRequest` | `AuthResponse` | 구현 |
| POST | `/sync/push` | Bearer | `SyncPushRequest` | `SyncPushResponse` | 구현 |
| GET | `/sync/pull?after=&limit=` | Bearer | - | `SyncPullResponse` | 구현 |
| GET | `/me` | Bearer | - | `MeResponse` | 구현 |
| POST | `/auth/link` | Bearer | `{ provider, idToken }` | `AuthResponse` | Phase 1 |
| DELETE | `/me` | Bearer | - | 204 | Phase 1 |
| POST | `/coach/messages` | Bearer | `{ spotDetail, question, history }` | SSE 스트림 | Phase 1 |
| GET | `/packs/url?file=` | Bearer | - | `{ url, expiresAt }` | Phase 2 |
| POST | `/webhooks/revenuecat`, `/webhooks/toss` | 서명 | 결제사 형식 | 200 | Phase 2 |

오류 상태: 400 잘못된 요청(405 메서드, 413 크기, 415 형식도 `bad_request`), 401 토큰 없음·무효·만료, 403 허용 안 된 출처, 404 없는 경로, 429 한도, 500 내부 오류, 503 서버 준비 중.

## 15. 환경 변수

| 이름 | 쓰는 곳 | 설명 |
|---|---|---|
| `ANTHROPIC_API_KEY` | `api/anthropic.ts` | 지금 그대로 |
| `APP_PASSCODE` | `api/anthropic.ts` | 지금 그대로. Phase 1에서 토큰으로 대체 |
| `SERVER_MODE` | `api/v1.ts` | 없음 = 503. `memory` = 개발용 메모리 저장소(프로덕션에서는 거부). `postgres` = Phase 1 |
| `AUTH_SECRET` | `api/v1.ts` | 토큰 서명 비밀값, 32자 이상. 없으면 503 |
| `ALLOWED_ORIGINS` | `api/v1.ts` | 쉼표로 구분한 추가 허용 출처(예: 별도 도메인 웹앱). 기본은 같은 출처만 |
| `DATABASE_URL` | Phase 1 | Neon 연결 문자열 |
| `REVENUECAT_WEBHOOK_SECRET`, `TOSS_SECRET_KEY` | Phase 2 | 결제 웹훅 검증 |

Phase 1에서 Postgres를 붙이는 방법: `npm i @neondatabase/serverless` → `api/v1.ts`에서 `SERVER_MODE=postgres`이고 `DATABASE_URL`이 있을 때 `new PostgresStore({ query: (text, params) => pool.query(text, params) })`를 만든다. 라우터와 테스트는 바뀌지 않는다.

## 16. 비용 관리

- **AI 코치가 비용의 대부분이다.** 일일 한도, 무료는 작은 모델, `max_tokens` 상한, 대화 길이 제한, 해설집 프롬프트 캐싱으로 막는다. Claude Console에서 월 지출 한도와 알림을 건다.
- **동기화는 싸다**: 한 번에 200개씩 묶고, 답마다 보내지 않는다(6.4 호출 시점). 기록 하나는 1KB 안팎이라 사용자 1만 명 × 하루 50문제여도 하루 수백 MB 수준이다. 오래된 `detail`은 서버에서도 1년 뒤 비울 수 있다.
- **DB**: Neon은 쉬면 멈추므로 초기 사용자 수에서는 무료 또는 최저 요금으로 충분하다. 통계 쿼리는 인덱스가 있는 열만 쓴다.
- **함수**: 응답이 짧은 JSON이라 실행 시간이 짧다. 코치 스트리밍만 길다.
- **콘텐츠 팩**: 정적 파일 + 불변 캐시라 전송량 외 비용이 없다. 필요한 시나리오만 받으므로 전송량도 작다.

## 17. 단계별 출시

| 단계 | 내용 | 끝났다는 기준 |
|---|---|---|
| **Phase 0 (이번 변경)** | 기기 안의 답 기록 + 기록 화면, 데이터 계약, 잠들어 있는 서버 뼈대(`server/`, `api/v1.ts`), 동기화 엔진(`src/sync/`), 이 문서 | 앱이 서버 없이 그대로 동작, `/api/v1/*`는 503, 서버·엔진 테스트 통과 |
| **Phase 1 베타** | Neon 연결, 기기 비밀값, 설정의 "기록 동기화", 여러 기기 pull, 코치 토큰 + 일일 한도, 계정 연결(Apple/Google/이메일), 계정 삭제, WAF 규칙 | 두 기기에서 같은 기록이 보임, 무료 한도 초과 시 429 + 안내 |
| **Phase 2 결제 + 스토어** | Pro 구독(웹: 토스/포트원, 앱: RevenueCat), 권한 웹훅, Pro 콘텐츠 팩, 스토어 앱 포장(Capacitor 등) + App Attest/Play Integrity | 결제 → 몇 초 안에 `/me`가 `pro`, 환불 → `free` |
| **Phase 3 데이터** | 오늘의 문제 + 문제 레이팅(Glicko-2), 동의 기반 인구 데이터 집계 | 문제 난이도가 매일 갱신, 20명 미만 묶음은 비공개 |

## 18. 주인이 정할 것

1. **라이선스**: 지금은 AGPL-3.0이다. 이대로 서비스하면 서버 코드를 포함해 수정한 소스를 사용자에게 공개해야 한다. 오픈소스로 가도 콘텐츠 팩(솔버 결과 데이터)과 브랜드는 따로 보호할 수 있다. 비공개 서비스로 가려면 저작권자가 라이선스를 바꿔야 하고, 외부 기여 코드가 있으면 그 동의가 필요하다. 의존 라이브러리는 MIT·Apache·ISC라 어느 쪽이든 문제없다.
2. **PWA만 vs 스토어 앱**: PWA는 심사·수수료가 없고 지금 바로 된다. 스토어 앱은 검색 노출과 기기 증명이 장점이지만 인앱결제 수수료와 심사(도박 관련 분류 주의)가 있다. 추천: Phase 1까지 PWA, Phase 2에서 스토어.
3. **웹 결제사**: 토스페이먼츠(단순, 단일 PG) vs 포트원(여러 PG·해외 카드 확장). 사업자 등록과 통신판매업 신고가 먼저 필요하다.
4. **무료 한도 숫자**: 코치 무료 하루 5회 / Pro 100회는 임시값이다(`server/quota.ts`).
5. **데이터 리전**: 서울(지연 짧음) vs 해외 리전(선택지·가격). 해외면 처리방침에 국외 이전을 적는다.
