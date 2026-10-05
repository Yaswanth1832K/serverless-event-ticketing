import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  status: 'loading' | 'success' | 'error';
  data: T | undefined;
  error: unknown;
  reload: () => void;
}

// Loads data when the page opens (and again whenever `deps` change or reload() is called).
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ status: 'loading' | 'success' | 'error'; data?: T; error?: unknown }>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller's `deps` list is the trigger, `tick` is reload()
  useEffect(() => {
    let alive = true;
    setState((s) => ({ status: 'loading', data: s.data }));
    fnRef
      .current()
      .then((data) => alive && setState({ status: 'success', data }))
      .catch((error) => alive && setState((s) => ({ status: 'error', data: s.data, error })));
    return () => {
      alive = false;
    };
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { status: state.status, data: state.data, error: state.error, reload };
}

export interface PollState<T> {
  data: T | undefined;
  error: unknown;
  /** true until the first answer (or first failure) arrives */
  loading: boolean;
  lastUpdated: Date | null;
  refresh: () => void;
}

// Near-real-time updates by asking again every few seconds (see docs/02-architecture.md for why this
// beats WebSockets here). It pauses while the tab is hidden, and a failed refresh keeps the last good
// numbers on screen instead of blanking the page.
export function usePolling<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[] = []): PollState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller's `deps` list is the trigger, `tick` is refresh()
  useEffect(() => {
    let alive = true;
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        const next = await fnRef.current();
        if (!alive) return;
        setData(next);
        setError(undefined);
        setLastUpdated(new Date());
      } catch (e) {
        if (alive) setError(e);
      } finally {
        running = false;
        if (alive) setLoading(false);
      }
    };
    setLoading(true);
    void run();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void run();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, tick, ...deps]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, lastUpdated, refresh };
}
