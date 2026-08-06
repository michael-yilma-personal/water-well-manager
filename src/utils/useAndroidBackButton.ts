/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

/**
 * Give Android's Back gesture the behaviour a phone user expects.
 *
 * Capacitor registers no back handler of its own, so by default Back finishes
 * the activity outright — with a modal open, a driller tapping Back to correct
 * a typo gets thrown out of the app instead of back to the form. The web build
 * never shows this because a browser has no hardware Back button.
 *
 * Precedence, innermost first: close a modal, then fall back to the Rig Control
 * tab, and only exit when already at the root.
 */
export function useAndroidBackButton(handlers: {
  closeTopModal: () => boolean;
  goToRootTab: () => boolean;
}): void {
  // Held in a ref-like closure via the effect dependency below so the listener
  // always sees current state without being torn down on every render.
  const { closeTopModal, goToRootTab } = handlers;

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let remove: (() => void) | undefined;
    let cancelled = false;

    CapacitorApp.addListener('backButton', () => {
      if (closeTopModal()) return;
      if (goToRootTab()) return;
      CapacitorApp.exitApp();
    }).then((handle) => {
      if (cancelled) {
        handle.remove();
        return;
      }
      remove = () => handle.remove();
    });

    return () => {
      cancelled = true;
      remove?.();
    };
  }, [closeTopModal, goToRootTab]);
}
