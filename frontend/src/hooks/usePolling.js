import { useEffect, useRef } from 'react';

/**
 * Runs pollFn every intervalMs when enabled is true.
 * Cleans up interval on unmount or when enabled becomes false.
 *
 * @param {() => Promise<void>} pollFn - Async function to call each interval.
 * @param {number} intervalMs - Polling interval in milliseconds.
 * @param {boolean} enabled - Whether polling is active.
 */
export function usePolling(pollFn, intervalMs, enabled) {
  const pollRef = useRef(pollFn);
  pollRef.current = pollFn;

  useEffect(() => {
    if (!enabled) return;

    const id = setInterval(() => {
      pollRef.current().catch(err => {
        console.error('usePolling error:', err);
      });
    }, intervalMs);

    return () => clearInterval(id);
  }, [enabled, intervalMs]);
}
