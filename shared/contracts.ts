/**
 * Data contracts shared by the app (src/) and the future server (server/, api/).
 *
 * Principle: local-first. Every answer is recorded on the device as an immutable
 * `Attempt`. The server, when it exists, only receives copies of those attempts
 * (idempotent by `id`) — the app never needs the server to work.
 *
 * Bump SCHEMA_VERSION only with a migration note in docs/server-design.md.
 */

export const SCHEMA_VERSION = 1 as const;

/** Which part of the app produced the attempt. */
export type QuizKind = "preflop" | "stack" | "odds" | "equity" | "play" | "postflop" | "daily";

export const QUIZ_KINDS: readonly QuizKind[] = ["preflop", "stack", "odds", "equity", "play", "postflop", "daily"];

export const QUIZ_KIND_LABEL: Record<QuizKind, string> = {
  preflop: "프리플랍 퀴즈",
  stack: "레인지 암기",
  odds: "팟 오즈·EV",
  equity: "에퀴티",
  play: "핸드 플레이",
  postflop: "포스트플랍",
  daily: "오늘의 문제",
};

/** "mixed" = a mixed-frequency hand where the chosen action is also played sometimes. */
export type AttemptGrade = "correct" | "mixed" | "wrong";

/** One answered question. Immutable once written. */
export interface Attempt {
  /** Sortable unique id (see shared/ids.ts). Also the idempotency key for sync. */
  id: string;
  /** Schema version of this record. */
  v: typeof SCHEMA_VERSION;
  /** Epoch ms when the user answered. */
  at: number;
  kind: QuizKind;
  /** Stats keys this attempt counted toward — the same keys as `statsStore.byKey` (e.g. "preflop", "preflop:pub-deep-rfi-BTN"). */
  keys: string[];
  /**
   * Spot identity for grouping and review, without the random parts.
   * e.g. "preflop:pub-deep-rfi-BTN:A5s", "odds:팟 오즈", "play:deep:flop".
   * Attempts with the same spot are "the same kind of question".
   */
  spot: string;
  /** Short Korean title shown in the history list, e.g. "BTN 오픈 · 딥 · A5s". */
  title: string;
  /** Label of what the user chose, e.g. "레이즈 2.2bb", "33%". */
  chosen: string;
  /** Label of the best answer, e.g. "폴드 (레이즈 25%)". */
  correct: string;
  grade: AttemptGrade;
  /** EV given up versus the best option, in big blinds, when the app knows it. */
  evLossBB?: number;
  /** Plain-text facts about the spot (cards, board, stacks, frequencies). Used for review and the AI coach. Keep under ~1,000 chars. */
  detail?: string;
  /** Device that recorded it (see shared/ids.ts). */
  deviceId: string;
}

/** Limits enforced by both client and server. */
export const LIMITS = {
  /** Max attempts kept on the device before old (already synced, then oldest) ones are dropped. */
  localAttemptCap: 5000,
  /** Max attempts per sync push request. */
  pushBatch: 200,
  /** Max attempts per sync pull page. */
  pullPage: 500,
  maxKeys: 8,
  maxKeyLength: 80,
  maxSpotLength: 120,
  maxTitleLength: 120,
  maxLabelLength: 80,
  maxDetailLength: 2000,
} as const;

// ───────────────────────── Sync API (server not connected yet) ─────────────────────────
// All endpoints live under /api/v1 and use JSON. Auth is `Authorization: Bearer <token>`.

/** POST /api/v1/auth/anonymous — create (or resume) an anonymous account for this device. */
export interface AnonymousAuthRequest {
  deviceId: string;
}
export interface AuthResponse {
  userId: string;
  token: string;
  /** Epoch ms. The app re-runs anonymous auth after this. */
  expiresAt: number;
}

/** POST /api/v1/sync/push — upload attempts. Idempotent: re-sending an id is a no-op ("duplicate"). */
export interface SyncPushRequest {
  attempts: Attempt[];
}
export interface SyncPushResponse {
  /** Newly stored ids. */
  accepted: string[];
  /** Ids the server already had. The client treats these as synced too. */
  duplicates: string[];
  /** Ids that failed validation, with a reason. The client should not retry these unchanged. */
  rejected: { id: string; reason: string }[];
  serverTime: number;
}

/** GET /api/v1/sync/pull?after=<cursor>&limit=<n> — download attempts recorded on other devices. */
export interface SyncPullResponse {
  attempts: Attempt[];
  /** Pass as `after` to get the next page; null when there is nothing more. */
  cursor: string | null;
}

/** GET /api/v1/me — account, plan and AI coach quota. */
export type Plan = "free" | "pro";
export interface MeResponse {
  userId: string;
  plan: Plan;
  coach: {
    /** Coach requests used in the current period. */
    used: number;
    limit: number;
    /** Epoch ms when `used` resets. */
    resetsAt: number;
  };
}

/** Error body for every /api/v1 endpoint. */
export interface ApiError {
  error: { code: "bad_request" | "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "quota_exceeded" | "unavailable" | "internal"; message: string };
}

// ───────────────────────── Client outbox (implemented by src/state/attempts.ts) ─────────────────────────

/** What the sync engine (src/sync) needs from the local attempt log. */
export interface AttemptOutbox {
  /** Oldest-first attempts that were never synced and were not rejected by the server. */
  unsynced(limit: number): Attempt[];
  /** Mark attempts as stored on the server (accepted or duplicate). */
  markSynced(ids: string[], at: number): void;
  /** Mark attempts the server rejected; they are not retried. */
  markRejected(ids: string[]): void;
}
