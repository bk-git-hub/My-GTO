/**
 * iOS Safari zooms into a focused field whose text is under 16px and doesn't zoom back out, which leaves
 * the page wider than the screen (a sideways drag after asking the AI coach, for example).
 * maximum-scale=1 stops that zoom. iOS still lets people pinch-zoom (it ignores maximum-scale for
 * gestures), so this is applied on iOS only: on Android it would block pinch zoom.
 */
export interface ZoomEnv {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  viewport: { content: string } | null;
}

export function isIOS(env: Pick<ZoomEnv, "userAgent" | "platform" | "maxTouchPoints">): boolean {
  // iPadOS reports itself as a Mac, but with touch.
  return /iP(hone|ad|od)/.test(env.userAgent) || (env.platform === "MacIntel" && env.maxTouchPoints > 1);
}

/** Adds maximum-scale=1 to the viewport meta on iOS. Returns whether it changed anything. */
export function stopFocusZoom(env: ZoomEnv): boolean {
  const meta = env.viewport;
  if (!meta || !isIOS(env) || /maximum-scale/.test(meta.content)) return false;
  meta.content = `${meta.content}, maximum-scale=1`;
  return true;
}

export function stopFocusZoomHere(): boolean {
  if (typeof document === "undefined" || typeof navigator === "undefined") return false;
  return stopFocusZoom({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    viewport: document.querySelector<HTMLMetaElement>('meta[name="viewport"]'),
  });
}
