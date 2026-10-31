import Anthropic from "@anthropic-ai/sdk";
import { MODEL_OPTIONS, type KeyMode, type Settings } from "../../state/settings";
import { buildSystem } from "./prompt";

export type CoachMessage = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

export interface CoachReply {
  /** Content to append to history as the assistant turn. */
  content: ContentBlock[];
  text: string;
  refused: boolean;
}

function makeClient(settings: Settings) {
  if (settings.keyMode === "server") {
    // api/anthropic.ts (Vercel Function) relays the call with the server-side key.
    return new Anthropic({
      apiKey: "server-managed", // placeholder; the relay sets the real key
      baseURL: `${location.origin}/api/anthropic`,
      defaultHeaders: settings.passcode ? { "x-app-passcode": settings.passcode } : undefined,
      dangerouslyAllowBrowser: true,
    });
  }
  // 이 기기에 저장한 키로 브라우저에서 직접 호출한다 (개인용).
  return new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
}

/**
 * After a mid-output server-side fallback, only text blocks before the last
 * `fallback` block may be echoed back; everything after it echoes normally.
 */
export function contentForHistory(content: ContentBlock[]): ContentBlock[] {
  const types = content.map((b) => (b as { type: string }).type);
  const boundary = types.lastIndexOf("fallback");
  if (boundary < 0) return content;
  return content.filter((b, i) => i > boundary || b.type === "text");
}

export async function streamCoachReply(opts: {
  settings: Settings;
  history: CoachMessage[];
  onText: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<CoachReply> {
  const { settings, history, onText, signal } = opts;
  const client = makeClient(settings);
  const model = MODEL_OPTIONS.find((m) => m.id === settings.model);

  const stream = client.beta.messages.stream(
    {
      model: settings.model,
      max_tokens: 64000,
      system: buildSystem(settings.userNotes),
      messages: history,
      // Auto-cache the growing conversation; the system block has its own breakpoint.
      cache_control: { type: "ephemeral" },
      output_config: { effort: settings.effort },
      ...(model?.fallback
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
    },
    { signal },
  );
  stream.on("text", (delta) => onText(delta));
  const message = await stream.finalMessage();

  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return {
    content: contentForHistory(message.content),
    text,
    refused: message.stop_reason === "refusal",
  };
}

/** Validate the connection without spending tokens. */
export async function testConnection(settings: Settings): Promise<string> {
  const info = await makeClient(settings).models.retrieve(settings.model);
  return info.display_name ?? info.id;
}

export function describeError(err: unknown, mode: KeyMode = "own"): string {
  if (err instanceof Anthropic.APIUserAbortError) return "중단했어요.";
  // Errors raised by the relay itself carry a readable message.
  if (err instanceof Anthropic.APIError && (err.type as string | null) === "proxy_error") {
    return (err.error as { error?: { message?: string } } | undefined)?.error?.message ?? err.message;
  }
  if (mode === "server") {
    if (err instanceof Anthropic.AuthenticationError) return "서버에 등록된 API 키가 올바르지 않아요. Vercel의 ANTHROPIC_API_KEY를 확인해 주세요.";
    if (err instanceof Anthropic.NotFoundError)
      return "서버 중계 함수를 찾을 수 없어요. 배포된 사이트에서 쓰거나, 로컬 개발 중이면 '내 API 키' 방식을 쓰세요.";
  }
  if (err instanceof Anthropic.AuthenticationError) return "API 키가 올바르지 않아요. 설정에서 키를 확인해 주세요.";
  if (err instanceof Anthropic.PermissionDeniedError) return "이 API 키로는 선택한 모델을 쓸 수 없어요.";
  if (err instanceof Anthropic.NotFoundError) return "모델을 찾을 수 없어요. 설정에서 모델을 확인해 주세요.";
  if (err instanceof Anthropic.RateLimitError) return "요청 한도에 걸렸어요. 잠시 후 다시 시도해 주세요.";
  if (err instanceof Anthropic.BadRequestError) return `요청 오류: ${err.message} (크레딧 잔액이 부족한 경우에도 이 오류가 나요)`;
  if (err instanceof Anthropic.InternalServerError) return "Anthropic 서버 오류예요. 잠시 후 다시 시도해 주세요.";
  if (err instanceof Anthropic.APIConnectionError) return "네트워크 연결을 확인해 주세요.";
  if (err instanceof Anthropic.APIError) return `API 오류 (${err.status}): ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export function isAbort(err: unknown): boolean {
  return err instanceof Anthropic.APIUserAbortError;
}
