import type { Access, Membership } from './api';

type ActiveOrg =
  | { kind: 'active'; orgId: string }
  | { kind: 'choose' }
  | { kind: 'none'; reason: 'no-membership' | 'invited-only' | 'deactivated' };

// Only what the server returned as active can ever become the active organization.
export function mayActivate(orgId: string, memberships: Membership[]): boolean {
  return memberships.some((m) => m.orgId === orgId && m.status === 'active');
}

export function resolveActiveOrg(memberships: Membership[], rememberedOrgId: string | null): ActiveOrg {
  const active = memberships.filter((m) => m.status === 'active');
  if (rememberedOrgId && mayActivate(rememberedOrgId, memberships)) return { kind: 'active', orgId: rememberedOrgId };
  if (active.length === 1) return { kind: 'active', orgId: active[0].orgId };
  if (active.length > 1) return { kind: 'choose' };
  if (memberships.length === 0) return { kind: 'none', reason: 'no-membership' };
  const invited = memberships.some((m) => m.status === 'invited');
  return { kind: 'none', reason: invited ? 'invited-only' : 'deactivated' };
}

/**
 * The invitations to offer, in the order given, whether or not an organization
 * is active: answering one never changes which organization is active.
 */
export function invitationsToOffer(memberships: Membership[], _activeOrgId: string | null): Membership[] {
  return memberships.filter((m) => m.status === 'invited');
}

// Keyed by user, so the next person signing in on this browser starts without a choice.
const key = (userId: string) => `saas.activeOrg.${userId}`;

export function rememberOrg(storage: Pick<Storage, 'setItem'>, userId: string, orgId: string): void {
  storage.setItem(key(userId), orgId);
}

export function rememberedOrg(storage: Pick<Storage, 'getItem'>, userId: string): string | null {
  return storage.getItem(key(userId));
}

/**
 * What to tell the person about the organization's subscription. No access
 * level read yet counts as full: nothing to tell.
 */
export function subscriptionNotice(
  access: Access | null | undefined,
  endsAt: string | null | undefined,
  now: number
): 'grace' | 'expired' | 'inactive' | null {
  if (access === 'none') return 'inactive';
  if (access === 'read_only') return 'expired';
  return access === 'full' && endsAt && Date.parse(endsAt) < now ? 'grace' : null;
}
