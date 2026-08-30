import React, { useCallback, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { SPRING_SNAP, SPRING_DEFAULT } from './springs';
import { useReducedMotion } from './prefs';
import { triggerVibration } from '../utils/audio';

type ButtonProps = React.ComponentPropsWithoutRef<'button'>;

export interface PressableProps extends Omit<ButtonProps, 'onAnimationStart' | 'onDragStart' | 'onDragEnd' | 'onDrag'> {
  /** How far it compresses under the finger. Large surfaces want less. */
  pressScale?: number;
  /** Haptic on press-down. `true` for a light tick, or an explicit pattern. */
  haptic?: boolean | number[];
}

/**
 * A button that acknowledges the finger the instant it lands.
 *
 * Feedback belongs on pointer-down, not on click. Waiting for touch-up - or
 * worse, for the handler to finish - is the single thing that makes an
 * interface feel dead, and this app is used in gloves where a tap that looks
 * unregistered gets tapped again.
 *
 * Press is held while the finger is down, released when it drags away, and
 * restored if it comes back, so a slip is recoverable. Commit stays on the
 * native click, which means a release outside the bounds cancels for free and
 * keyboard and screen-reader activation are untouched.
 */
export const Pressable = React.forwardRef<HTMLButtonElement, PressableProps>(
  ({ pressScale = 0.97, haptic = false, children, style, ...rest }, ref) => {
    const [pressed, setPressed] = useState(false);
    const pointerDown = useRef(false);
    const reduced = useReducedMotion();

    const press = useCallback(() => {
      setPressed(true);
      if (haptic) triggerVibration(Array.isArray(haptic) ? haptic : [12]);
    }, [haptic]);

    const handlePointerDown = useCallback(
      (e: React.PointerEvent<HTMLButtonElement>) => {
        pointerDown.current = true;
        press();
        rest.onPointerDown?.(e);
      },
      [press, rest]
    );

    const release = useCallback(() => {
      pointerDown.current = false;
      setPressed(false);
    }, []);

    return (
      <motion.button
        ref={ref}
        {...(rest as React.ComponentPropsWithoutRef<typeof motion.button>)}
        onPointerDown={handlePointerDown}
        onPointerUp={release}
        // The browser fires this when it claims the gesture for a scroll. The
        // press must let go, or a flick down a list leaves a lit button behind.
        onPointerCancel={release}
        onPointerLeave={() => setPressed(false)}
        onPointerEnter={() => {
          if (pointerDown.current) setPressed(true);
        }}
        onBlur={(e) => {
          release();
          rest.onBlur?.(e);
        }}
        animate={
          reduced
            ? { opacity: pressed ? 0.72 : 1 }
            : { scale: pressed ? pressScale : 1, opacity: pressed ? 0.92 : 1 }
        }
        transition={pressed ? SPRING_SNAP : SPRING_DEFAULT}
        style={{
          // No tap-delay, no long-press callout, no text selection on a
          // control that is going to be jabbed with a work glove.
          touchAction: 'manipulation',
          WebkitTapHighlightColor: 'transparent',
          ...style,
        }}
      >
        {children}
      </motion.button>
    );
  }
);

Pressable.displayName = 'Pressable';
