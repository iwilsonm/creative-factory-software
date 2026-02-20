import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Manages the lifecycle of a Server-Sent Event stream.
 *
 * @returns {{
 *   streaming: boolean,
 *   startStream: (factory: () => { abort: Function, done: Promise }) => Promise<void>,
 *   cancelStream: () => void
 * }}
 */
export function useSSEStream() {
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef(null);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current();
    };
  }, []);

  const startStream = useCallback((factory) => {
    setStreaming(true);
    const { abort, done } = factory();
    abortRef.current = abort;

    return done.finally(() => {
      setStreaming(false);
      abortRef.current = null;
    });
  }, []);

  const cancelStream = useCallback(() => {
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
    }
    setStreaming(false);
  }, []);

  return { streaming, startStream, cancelStream };
}
