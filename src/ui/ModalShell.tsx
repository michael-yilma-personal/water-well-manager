import React, { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { SPRING_SHEET, CROSSFADE } from './springs';
import { useReducedMotion, useReducedTransparency } from './prefs';

interface ModalShellProps {
  isOpen: boolean;
  onClose: () => void;
  sunlightMode: boolean;
  children: React.ReactNode;
  /** Tailwind max-width class for the surface. */
  maxWidth?: string;
  /** Stacking order, for the modals that open on top of other modals. */
  zIndex?: number;
  /** Accessible name, announced when the dialog takes focus. */
  label?: string;
}

/**
 * The chrome every modal in the app shares: a dimming scrim, a surface that
 * arrives as a material, Escape to leave, and a locked background.
 *
 * Two things this fixes. The modals used to appear and vanish on a single
 * frame, which gives the eye nothing to follow - you cannot tell whether a
 * panel replaced the screen or the screen jumped. And a modal is a blocking
 * task, so it earns a scrim and a pushed-back background; the surface enters
 * and leaves along the same path, so it returns to where it came from.
 */
export const ModalShell: React.FC<ModalShellProps> = ({
  isOpen,
  onClose,
  sunlightMode,
  children,
  maxWidth = 'max-w-md',
  zIndex = 50,
  label,
}) => {
  const reducedMotion = useReducedMotion();
  const reducedTransparency = useReducedTransparency() || sunlightMode;

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // The sheet scrolls; the rig screen behind it must not scroll with it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [isOpen, onClose]);

  const surface = reducedMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: CROSSFADE,
      }
    : {
        // Scale and blur move together so the panel reads as a material
        // arriving, not a picture being faded up. It leaves the same way.
        initial: { opacity: 0, scale: 0.94, y: 12, filter: 'blur(8px)' },
        animate: { opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' },
        exit: { opacity: 0, scale: 0.96, y: 8, filter: 'blur(6px)' },
        transition: SPRING_SHEET,
      };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 flex items-center justify-center p-3 sm:p-4"
          style={{
            zIndex,
            // Room for the Android gesture bar and notch.
            paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
            paddingTop: 'max(0.75rem, env(safe-area-inset-top))',
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reducedMotion ? CROSSFADE : { duration: 0.22 }}
        >
          <div
            className="absolute inset-0"
            onClick={onClose}
            style={
              reducedTransparency
                ? { background: 'rgba(0,0,0,0.92)' }
                : {
                    background: 'rgba(0,0,0,0.72)',
                    backdropFilter: 'blur(6px)',
                    WebkitBackdropFilter: 'blur(6px)',
                  }
            }
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className={`relative w-full ${maxWidth} max-h-full flex flex-col`}
            {...surface}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
