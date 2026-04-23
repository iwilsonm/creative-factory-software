import { useEffect, useState } from 'react';

/**
 * SSR-safe media-query hook. Use sparingly — prefer CSS `md:hidden` / `md:block`
 * for layout hiding. Reserve this hook for behavior-specific branches
 * (e.g., attaching a touch listener only below `md:`).
 *
 * Example:
 *   const isMobile = useMediaQuery('(max-width: 767px)');
 */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    setMatches(mql.matches);
    // Safari <14 compat: addListener is deprecated but still present.
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, [query]);

  return matches;
}
