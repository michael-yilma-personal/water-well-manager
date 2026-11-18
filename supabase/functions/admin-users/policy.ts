/**
 * Who may call admin-users, and which accounts it may act on.
 *
 * admin-users is the crew function of the FOUNDING organization. It bans and
 * deletes whole accounts with the service-role key, so both answers are given
 * from memberships and from nothing else:
 *
 *   - the caller must be an active Administrator of the founding organization;
 *   - the target must be a member of the founding organization, and of no
 *     other: a ban or a deletion reaches every organization the account is in.
 *
 * Pure on purpose: no imports and nothing of the runtime, so the gate's unit
 * tests run these exact functions (src/admin/adminUsersPolicy.test.ts).
 */

export type Membership = {
  orgId: string;
  role: string;
  status: string;
};

export type TargetDecision = 'ok' | 'not-found' | 'other-organization';

/**
 * True only for an ACTIVE membership with the role Administrator in the
 * founding organization. With no founding organization nobody passes.
 */
export function callerMayAdminister(
  foundingOrgId: string | null,
  callerMemberships: readonly Membership[],
): boolean {
  if (!foundingOrgId) return false;
  return callerMemberships.some(
    (m) => m.orgId === foundingOrgId && m.role === 'Administrator' && m.status === 'active',
  );
}

/**
 * 'not-found' for an account with no membership in the founding organization,
 * whether it exists elsewhere or not at all: the answer must not tell the two
 * apart. 'other-organization' when it is a founding member and also a member
 * somewhere else, whatever the statuses. Otherwise 'ok'.
 */
export function targetDecision(
  foundingOrgId: string | null,
  targetMemberships: readonly Membership[],
): TargetDecision {
  if (!foundingOrgId) return 'not-found';
  if (!targetMemberships.some((m) => m.orgId === foundingOrgId)) return 'not-found';
  if (targetMemberships.some((m) => m.orgId !== foundingOrgId)) return 'other-organization';
  return 'ok';
}
