import Anthropic from "@anthropic-ai/sdk";
import { MODEL_OPTIONS, type Settings } from "../../state/settings";
import { buildSystem } from "./prompt";

export type CoachMessage = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

export interface CoachReply {
  /** Content to append to history as the assistant turn. */
  content: ContentBlock[];
  text: string;
  refused: boolean;
}

function makeClient(apiKey: string) {
  // 개인용 PWA라서 사용자가 입력한 키로 브라우저에서 직접 호출한다.
  // 마켓 출시 시에는 서버(프록시)로 옮겨야 한다.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
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
  const client = makeClient(settings.apiKey);
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

/** Validate a key without spending tokens. */
export async function testApiKey(apiKey: string, model: string): Promise<string> {
  const info = await makeClient(apiKey).models.retrieve(model);
  return info.display_name ?? info.id;
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIUserAbortError) return "중단했어요.";
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
