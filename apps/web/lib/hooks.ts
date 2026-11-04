"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Load data once and then re-poll every `intervalMs` while `shouldPoll(data)` is true.
 * Polling is the MVP transport for job progress; SSE can replace it later.
 */
export function usePolling<T>(
  load: () => Promise<T>,
  { intervalMs = 2500, shouldPoll = () => false, deps = [] as unknown[] }: {
    intervalMs?: number;
    shouldPoll?: (data: T) => boolean;
    deps?: unknown[];
  } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const shouldPollRef = useRef(shouldPoll);
  shouldPollRef.current = shouldPoll;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      const next = await loadRef.current();
      if (!alive.current) return;
      setData(next);
      setError(null);
      if (shouldPollRef.current(next)) timer.current = setTimeout(refresh, intervalMs);
    } catch (e) {
      if (!alive.current) return;
      setError(e as Error);
      // Back off on errors but keep trying (transient network blips).
      timer.current = setTimeout(refresh, intervalMs * 3);
    }
  }, [intervalMs]);

  useEffect(() => {
    alive.current = true;
    refresh();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, refresh, setData };
}
