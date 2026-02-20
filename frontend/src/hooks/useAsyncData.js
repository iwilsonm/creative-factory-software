import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Fetches data on mount and when deps change.
 *
 * @param {() => Promise<any>} fetchFn - Async function that returns data.
 * @param {Array} deps - Dependency array (triggers re-fetch on change).
 * @param {object} [options]
 * @param {any} [options.initialData=[]] - Initial value for data.
 * @param {boolean} [options.enabled=true] - When false, skip the fetch and set loading to false.
 * @returns {{ data: any, setData: Function, loading: boolean, refetch: () => Promise<void>, silentRefetch: () => Promise<void> }}
 */
export function useAsyncData(fetchFn, deps = [], options = {}) {
  const { initialData = [], enabled = true } = options;
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(enabled);

  // Store fetchFn in a ref so refetch/silentRefetch never go stale
  const fetchRef = useRef(fetchFn);
  fetchRef.current = fetchFn;

  // Track whether the component is mounted
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  const doFetch = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      const result = await fetchRef.current();
      if (mountedRef.current) setData(result);
    } catch (err) {
      console.error('useAsyncData fetch error:', err);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const refetch = useCallback(() => doFetch(false), [doFetch]);
  const silentRefetch = useCallback(() => doFetch(true), [doFetch]);

  // Fetch on mount / deps change
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    doFetch(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  return { data, setData, loading, refetch, silentRefetch };
}
