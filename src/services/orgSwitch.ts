/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What to do when an organization is about to become the one a device works
 * for.
 *
 * A device holds one organization's records at a time, so leaving another one
 * - or settling the first while the device may hold several's - clears it.
 * Clearing follows the rules of signing out, and this function is the only
 * place they are decided: never unless the person chose it, never while work
 * is unsent, and over parked work only once they have agreed.
 */
export type Activation =
  | 'activate'
  | 'activate-and-clear'
  | 'confirm-then-clear'
  | 'refuse-pending'
  | 'ignore';

export function decideActivation(input: {
  cachedOrgId: string | null;
  targetOrgId: string;
  /** The account's active memberships. */
  activeCount: number;
  /** Boreholes, pending or parked work on the device. */
  deviceHoldsData: boolean;
  pending: number;
  parked: number;
  /** The person picked it (organization screen or Settings). */
  chosen: boolean;
}): Activation {
  const mustClear =
    input.cachedOrgId !== null
      ? input.cachedOrgId !== input.targetOrgId
      : input.activeCount > 1 && input.deviceHoldsData;
  if (!mustClear) return 'activate';
  if (!input.chosen) return 'ignore';
  if (input.pending > 0) return 'refuse-pending';
  if (input.parked > 0) return 'confirm-then-clear';
  return 'activate-and-clear';
}
