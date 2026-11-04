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

  /** Returns false if the value could not be written to localStorage (quota exceeded, blocked storage). */
  function set(next: T | ((prev: T) => T)): boolean {
    value = typeof next === "function" ? (next as (p: T) => T)(value) : next;
    let saved = true;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      saved = false;
    }
    listeners.forEach((l) => l());
    return saved;
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
