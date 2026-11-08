/**
 * The app's menu and routes: the drawer's items, which item a route lights, the header title, and the
 * old routes that moved (정보 수집 and quick record are gone).
 */

export interface NavItem {
  route: string;
  label: string;
  icon: string;
  indent?: boolean;
}

/** A section title, one item, or two items side by side on one row. */
export type NavEntry = NavItem | { section: string } | { pair: [NavItem, NavItem] };

export const NAV: NavEntry[] = [
  { pair: [{ route: "charts", label: "펍아재 차트", icon: "▦" }, { route: "solver", label: "솔버 차트", icon: "◆" }] },
  { pair: [{ route: "log", label: "핸드 복기", icon: "✎" }, { route: "log/list", label: "지난 기록 보기", icon: "☰" }] },
  { route: "log/fast", label: "빠른 기록", icon: "⚡" },
  { section: "퀴즈" },
  { route: "quiz/stack", label: "레인지 암기", icon: "◎", indent: true },
  { route: "quiz/preflop", label: "프리플랍 퀴즈", icon: "?", indent: true },
  { route: "quiz/odds", label: "팟 오즈·EV", icon: "÷", indent: true },
  { route: "quiz/equity", label: "에퀴티", icon: "%", indent: true },
  { section: "그외 도구" },
  { route: "home", label: "홈", icon: "⌂", indent: true },
  { route: "play", label: "핸드 플레이", icon: "♠", indent: true },
  { route: "calc", label: "계산기", icon: "∑", indent: true },
  { route: "settings", label: "설정", icon: "⚙", indent: true },
];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((n) => ("pair" in n ? n.pair : "route" in n ? [n] : []));

/**
 * Where an old route lives now, or null when it hasn't moved: 정보 수집 ("scout…") became 남의 핸드 기록,
 * quick record ("log/quick") the new hand, and a quick hand ("log/quick/<id>") opens in the table flow.
 */
export function redirectRoute(route: string): string | null {
  if (route === "scout" || route.startsWith("scout/")) return "log/other";
  if (route === "log/quick") return "log";
  if (route.startsWith("log/quick/")) {
    const id = route.slice("log/quick/".length);
    return id ? `log/${id}` : "log";
  }
  return null;
}

/** 남의 핸드 기록 (another player's hand): reached from 빠른 기록's "내 핸드 | 남의 핸드" toggle, so that item is lit there. */
const isOtherHand = (route: string) => route === "log/other" || route.startsWith("log/other/");

/** The hand-log item a "log…" route belongs to: the new hand, 빠른 기록 (another player's hand too), or the past hands (a saved hand too). */
function logItem(route: string): string {
  if (route === "log" || route === "log/new") return "log";
  if (route === "log/fast" || isOtherHand(route)) return "log/fast";
  return "log/list";
}

/** The menu item `item` is lit for `route`. Each hand-log item is lit for its own screens only. */
export function isActive(item: string, route: string): boolean {
  if (route === "log" || route.startsWith("log/")) return logItem(route) === item;
  if (item === "home") return route === "home";
  if (item === "quiz/stack" && route === "quiz") return true;
  return route === item || route.startsWith(item + "/");
}

/** The header title for a route ("" on the home screen). */
export function titleOf(route: string): string {
  if (route === "home") return "";
  if (route === "log" || route.startsWith("log/")) {
    if (isOtherHand(route)) return "남의 핸드 기록";
    const item = logItem(route);
    // A saved hand opened from the list: neither new nor the list itself.
    if (item === "log/list" && route !== "log/list" && !route.startsWith("log/list/") && route !== "log/players") return "핸드 기록";
    return NAV_ITEMS.find((i) => i.route === item)!.label;
  }
  const exact = NAV_ITEMS.find((i) => i.route === route);
  if (exact) return exact.label;
  return NAV_ITEMS.find((i) => route.startsWith(i.route + "/"))?.label ?? (route.startsWith("quiz") ? "퀴즈" : "PubAJ");
}
