import assert from 'node:assert/strict';
import test from 'node:test';
import { decideActivation, type Activation } from './orgSwitch';

const A = '99999999-0000-4000-8000-00000000000a';
const B = '99999999-0000-4000-8000-00000000000b';

type Input = Parameters<typeof decideActivation>[0];

/** A device working for A, holding synced records, asked to activate B by the person. */
const base: Input = {
  cachedOrgId: A, targetOrgId: B, activeCount: 2,
  deviceHoldsData: true, pending: 0, parked: 0, chosen: true,
};

// Criterion 9: never clear unless the person chose it, never while work is
// unsent, over parked work only after confirmation.
const cases: [string, Partial<Input>, Activation][] = [
  ['the organization already cached activates with no clear, whatever the device holds',
    { targetOrgId: A, chosen: false, pending: 2, parked: 1 }, 'activate'],
  ['a different organization the person did not choose is ignored',
    { chosen: false }, 'ignore'],
  ['a different organization nobody chose is ignored even on a device with nothing unsent or parked',
    { chosen: false, deviceHoldsData: false }, 'ignore'],
  ['a chosen switch is refused while work is unsent',
    { pending: 1 }, 'refuse-pending'],
  ['unsent work refuses the switch even when parked work could be confirmed away',
    { pending: 1, parked: 3 }, 'refuse-pending'],
  ['a chosen switch over parked work asks for confirmation first',
    { parked: 1 }, 'confirm-then-clear'],
  ['a chosen switch with nothing unsent or parked clears and activates',
    {}, 'activate-and-clear'],
  ['a first settlement with one membership keeps what the device holds',
    { cachedOrgId: null, activeCount: 1, chosen: false, pending: 2, parked: 1 }, 'activate'],
  ['a first settlement with several memberships on an empty device needs no clear',
    { cachedOrgId: null, deviceHoldsData: false, chosen: false }, 'activate'],
  ['a first settlement with several memberships on a device holding data is ignored unless chosen',
    { cachedOrgId: null, chosen: false }, 'ignore'],
  ['a chosen first settlement with several memberships on a device holding data clears it',
    { cachedOrgId: null }, 'activate-and-clear'],
  ['a chosen first settlement is still refused while work is unsent',
    { cachedOrgId: null, pending: 1 }, 'refuse-pending'],
];

for (const [name, over, expected] of cases) {
  test(name, () => assert.equal(decideActivation({ ...base, ...over }), expected));
}
