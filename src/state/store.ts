import { useSyncExternalStore } from "react";

/** Tiny localStorage-backed store with React subscription. */
export function createStore<T>(key: string, initial: T) {
  let value: T = load();
  const listeners = new Set<() => void>();

  function load(): T {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return { ...initial, ...JSON.parse(raw) };
    } catch {
      /* ignore broken storage */
    }
    return initial;
  }

  function get() {
    return value;
  }

  function set(next: T | ((prev: T) => T)) {
    value = typeof next === "function" ? (next as (p: T) => T)(value) : next;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota exceeded etc. */
    }
    listeners.forEach((l) => l());
  }

  function subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  }

  function use(): T {
    return useSyncExternalStore(subscribe, get, get);
  }

  return { get, set, use, subscribe };
}
