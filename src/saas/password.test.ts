import assert from 'node:assert/strict';
import test from 'node:test';

// P5-1 (change your own password) and P5-2 (password reset), D5-1 and D5-2.
// Assumed, in src/saas/password.ts (the project's minimum length is assumed to be 8):
//   validateNewPassword(current: string | null, next: string, repeat: string, min = 8): string | null
//     a sentence when refused, null when acceptable; `current` null skips the "same as current" rule.
//   changePassword(client, email: string, current: string, next: string, repeat: string): Promise<void>
//     checks `current` with auth.signInWithPassword({ email, password: current }), then auth.updateUser({ password: next });
//     rejects with a sentence.
//   requestReset(client, email: string, redirectTo: string): Promise<string>
//     calls auth.resetPasswordForEmail(email, { redirectTo }); resolves with the sentence to show.
//   setRecoveredPassword(client, next: string, repeat: string): Promise<void>
//     auth.updateUser({ password: next }) after the same rules, no current password; rejects with a sentence.
// `client` is a Supabase client; only its `auth` is used.

type Mod = {
  validateNewPassword: (current: string | null, next: string, repeat: string, min?: number) => string | null;
  changePassword: (client: unknown, email: string, current: string, next: string, repeat: string) => Promise<void>;
  requestReset: (client: unknown, email: string, redirectTo: string) => Promise<string>;
  setRecoveredPassword: (client: unknown, next: string, repeat: string) => Promise<void>;
};
// The specifier is computed so that the type check passes before the module exists.
const load = async () => (await import(['.', 'password'].join('/'))) as Mod;

type Err = { message: string; status?: number; code?: string } | null;
function fake(o: { signIn?: Err; update?: Err; reset?: Err } = {}) {
  const calls: [string, ...unknown[]][] = [];
  const client = {
    auth: {
      signInWithPassword: async (creds: unknown) => (calls.push(['signIn', creds]), { data: { user: o.signIn ? null : { id: 'u1' } }, error: o.signIn ?? null }),
      updateUser: async (attrs: unknown) => (calls.push(['updateUser', attrs]), { data: { user: { id: 'u1' } }, error: o.update ?? null }),
      resetPasswordForEmail: async (email: string, opts: unknown) => (calls.push(['reset', email, opts]), { data: {}, error: o.reset ?? null }),
      signOut: async (opts?: unknown) => (calls.push(['signOut', opts]), { error: null }),
    },
  };
  return { client, calls };
}

const sentence = (s: unknown) => typeof s === 'string' && /^[^.!?]+[.!?]$/.test(s.trim());
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

// --- P5-1 -----------------------------------------------------------------------

test('a new password that does not match, is shorter than 8 or equals the current one is refused; 8 characters is accepted', async () => {
  const { validateNewPassword } = await load();
  for (const [cur, next, rep] of [['old-pass-1', 'new-pass-1', 'new-pass-2'], ['old-pass-1', 'short-7', 'short-7'], ['old-pass-1', 'old-pass-1', 'old-pass-1']]) {
    assert.ok(sentence(validateNewPassword(cur, next, rep)), `${cur} / ${next} / ${rep}`);
  }
  assert.equal(validateNewPassword('old-pass-1', 'eight-ch', 'eight-ch'), null);
  assert.equal(validateNewPassword(null, 'eight-ch', 'eight-ch'), null);
  assert.ok(sentence(validateNewPassword(null, 'short-7', 'short-7')));
});

test('changing the password with a refused new password calls nothing on the server', async () => {
  const { changePassword, validateNewPassword } = await load();
  const { client, calls } = fake();
  for (const [next, rep] of [['new-pass-1', 'new-pass-2'], ['short-7', 'short-7'], ['old-pass-1', 'old-pass-1']]) {
    await assert.rejects(changePassword(client, 'a@example.com', 'old-pass-1', next, rep), (e) => reason(e) === validateNewPassword('old-pass-1', next, rep));
  }
  assert.deepEqual(calls, []);
});

test('changing the password checks the current one by signing in with the same email, then sets the new one; the app itself signs nothing out', async () => {
  const { changePassword } = await load();
  const { client, calls } = fake();
  await changePassword(client, 'a@example.com', 'old-pass-1', 'new-pass-1', 'new-pass-1');
  assert.deepEqual(calls, [['signIn', { email: 'a@example.com', password: 'old-pass-1' }], ['updateUser', { password: 'new-pass-1' }]]);
});

test('a wrong current password gives one plain sentence and changes nothing', async () => {
  const { changePassword } = await load();
  const { client, calls } = fake({ signIn: { message: 'Invalid login credentials', status: 400, code: 'invalid_credentials' } });
  await assert.rejects(changePassword(client, 'a@example.com', 'wrong-pass', 'new-pass-1', 'new-pass-1'),
    (e) => sentence(reason(e)) && reason(e) !== 'Invalid login credentials');
  assert.deepEqual(calls.map((c) => c[0]), ['signIn']);
});

test('a refusal to set the new password is not swallowed', async () => {
  const { changePassword } = await load();
  const { client } = fake({ update: { message: 'Password is known to be weak', status: 422, code: 'weak_password' } });
  await assert.rejects(changePassword(client, 'a@example.com', 'old-pass-1', 'new-pass-1', 'new-pass-1'), (e) => sentence(reason(e)));
});

// --- P5-2 -----------------------------------------------------------------------

const REDIRECT = 'https://dashboard.test/reset.html';

test('a reset request sends the email with the redirect and shows the same sentence whether or not the address has an account', async () => {
  const { requestReset } = await load();
  const answers: string[] = [];
  for (const reset of [null, { message: 'User not found', status: 400 }, { message: 'Error sending recovery email', status: 500 }]) {
    const { client, calls } = fake({ reset });
    answers.push(await requestReset(client, 'a@example.com', REDIRECT));
    assert.deepEqual(calls, [['reset', 'a@example.com', { redirectTo: REDIRECT }]]);
  }
  assert.ok(sentence(answers[0]));
  assert.deepEqual(answers, [answers[0], answers[0], answers[0]]);
});

test('a rate-limited reset request shows the same sentence as every other answer (criterion 2 as changed)', async () => {
  const { requestReset } = await load();
  const same = await requestReset(fake().client, 'a@example.com', REDIRECT);
  const got = await requestReset(fake({ reset: { message: 'email rate limit exceeded', status: 429, code: 'over_email_send_rate_limit' } }).client, 'a@example.com', REDIRECT);
  assert.equal(got, same);
});

test('the recovery page refuses non-matching or short passwords without calling the server, then sets the new one alone', async () => {
  const { setRecoveredPassword } = await load();
  const { client, calls } = fake();
  await assert.rejects(setRecoveredPassword(client, 'new-pass-1', 'new-pass-2'), (e) => sentence(reason(e)));
  await assert.rejects(setRecoveredPassword(client, 'short-7', 'short-7'), (e) => sentence(reason(e)));
  assert.deepEqual(calls, []);
  await setRecoveredPassword(client, 'new-pass-1', 'new-pass-1');
  assert.deepEqual(calls, [['updateUser', { password: 'new-pass-1' }]]);
});

test('the recovery page does not swallow a refusal to set the password', async () => {
  const { setRecoveredPassword } = await load();
  const { client } = fake({ update: { message: 'Auth session missing!', status: 401 } });
  await assert.rejects(setRecoveredPassword(client, 'new-pass-1', 'new-pass-1'), (e) => sentence(reason(e)));
});
