import { useEffect, useState } from 'react';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Slides, springs and parallax become short cross-fades. */
export const useReducedMotion = () =>
  useMediaQuery('(prefers-reduced-motion: reduce)');

/**
 * Translucent surfaces go frosty or solid.
 *
 * Sunlight mode counts as this signal too, and that is not a shortcut: a
 * blurred surface on a rig floor in direct sun loses the contrast that makes
 * it readable, which is the same reason the OS setting exists. Callers pass
 * `sunlightMode || useReducedTransparency()`.
 */
export const useReducedTransparency = () =>
  useMediaQuery('(prefers-reduced-transparency: reduce)');

/** Near-solid backgrounds with a defined, contrasting border. */
export const useHighContrast = () => useMediaQuery('(prefers-contrast: more)');
