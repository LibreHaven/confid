import { useCallback, useState } from 'react';

// Debug mode surfaces protocol/ICE diagnostics in the UI (DebugPanel).
// Off by default (observability: debug detail must not burden normal use);
// enabled via ?debug=1 in the URL or the toggle on the home screen, and
// persisted in localStorage so one switch sticks for the whole session.
const STORAGE_KEY = 'confid.debug';

export function isDebugMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDebugMode(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    // localStorage unavailable (private mode): the in-memory state still
    // applies for this page load.
  }
}

/** URL ?debug=1 counts as an explicit opt-in for the current load. */
function urlAsksForDebug(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('debug') === '1';
  } catch {
    return false;
  }
}

export function useDebugMode(): { debug: boolean; toggle: () => void } {
  const [debug, setDebug] = useState(() => urlAsksForDebug() || isDebugMode());
  const toggle = useCallback(() => {
    setDebug((prev) => {
      setDebugMode(!prev);
      return !prev;
    });
  }, []);
  return { debug, toggle };
}
