/**
 * The motion vocabulary for the whole app.
 *
 * Apple describes springs with two designer-facing numbers instead of the
 * physics triplet: `damping` (how much it overshoots) and `response` (how
 * quickly it reaches the target, in seconds). Motion's spring takes `bounce`
 * and `duration`, which map onto those directly - bounce is the overshoot that
 * damping suppresses, so `bounce = 1 - damping`.
 *
 * A spring has no fixed duration. `duration` here is the response time; the
 * settle time emerges from the parameters. That is the point: a spring can be
 * re-targeted mid-flight and stays continuous, which a keyframe animation
 * cannot. Everything a finger can touch uses one of these.
 */

export interface Spring {
  type: 'spring';
  bounce: number;
  duration: number;
}

function spring(damping: number, response: number): Spring {
  return { type: 'spring', bounce: 1 - damping, duration: response };
}

/**
 * Critically damped, no overshoot. The default for anything that simply moves
 * to a new place - tab indicators, repositioning, state changes. Overshoot on
 * something the user did not throw reads as decoration.
 */
export const SPRING_DEFAULT = spring(1.0, 0.35);

/**
 * Fast and flat. Press feedback and other sub-100ms acknowledgements, where
 * the only job is to prove the tap registered.
 */
export const SPRING_SNAP = spring(1.0, 0.18);

/**
 * Slight overshoot, for motion the user's own gesture put energy into - a
 * flicked sheet, a dragged card released. Bounce is earned by momentum.
 */
export const SPRING_MOMENTUM = spring(0.8, 0.35);

/** Drawers and sheets: Apple ships damping 0.8 / response 0.3 here. */
export const SPRING_SHEET = spring(0.8, 0.3);

/**
 * Momentum projection - where a flick would come to rest, using the same
 * exponential decay as scroll deceleration. Snap to the target nearest the
 * *projected* point, not the release point; that is what makes a flick throw
 * something rather than nudge it.
 */
export function projectMomentum(
  velocity: number,
  decelerationRate = 0.998
): number {
  return (velocity / 1000) * decelerationRate / (1 - decelerationRate);
}

/**
 * Progressive resistance past a boundary. A hard stop reads as frozen; a
 * surface that keeps responding but gives less reads as "there is nothing
 * more here". Used at the top of a sheet's drag range.
 */
export function rubberband(
  overshoot: number,
  dimension: number,
  constant = 0.55
): number {
  return (
    (overshoot * dimension * constant) /
    (dimension + constant * Math.abs(overshoot))
  );
}

/**
 * Reduced motion does not mean no feedback - it means a non-vestibular
 * equivalent. Callers swap slides and springs for a short cross-fade and keep
 * the opacity changes that carry meaning.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const CROSSFADE = { duration: 0.2, ease: 'easeOut' } as const;

/** The transition to use for `t`, degraded to a cross-fade when asked. */
export function motionSafe(t: Spring, reduced: boolean) {
  return reduced ? CROSSFADE : t;
}
