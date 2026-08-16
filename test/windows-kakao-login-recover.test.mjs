import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const {
  classifyLoginDocument,
  createStdinSecretReader,
  isAuthenticatedKakaoChatUrl,
  readSecret,
  recoverKakaoLogin,
  validateSecretRef
} = await import('../scripts/windows/kakao-login-recover.mjs');

test('authenticated Kakao chat URLs include list and detail pages but not login pages', () => {
  assert.equal(isAuthenticatedKakaoChatUrl('https://business.kakao.com/_xhPMls/chats'), true);
  assert.equal(isAuthenticatedKakaoChatUrl('https://business.kakao.com/_xhPMls/chats/4845268282772547'), true);
  assert.equal(isAuthenticatedKakaoChatUrl('https://accounts.kakao.com/login/'), false);
});

function fakeSpawn({ stdout = '', stderr = '', code = 0 } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = Readable.from([stdout]);
    child.stderr = Readable.from([stderr]);
    child.kill = () => true;
    setImmediate(() => child.emit('close', code, null));
    return child;
  };
  return { calls, spawnImpl };
}

test('1Password reads use exact op refs without shell and never return stderr metadata', async () => {
  const secret = 'not-for-logs';
  const ref = 'op://vault-id/item-id/password';
  const fake = fakeSpawn({ stdout: secret, stderr: `item metadata ${secret}` });
  const value = await readSecret(ref, {
    opPath: 'C:\\Program Files\\1Password CLI\\op.exe',
    spawnImpl: fake.spawnImpl,
    timeoutMs: 1_000
  });

  assert.equal(value, secret);
  assert.deepEqual(fake.calls[0].args, ['read', '--no-newline', ref]);
  assert.equal(fake.calls[0].options.shell, false);
  assert.equal(fake.calls[0].options.windowsHide, true);

  const failed = fakeSpawn({ stderr: `vault title ${secret}`, code: 1 });
  await assert.rejects(
    readSecret(ref, { spawnImpl: failed.spawnImpl, timeoutMs: 1_000 }),
    (error) => error.code === 'OP_AUTH_REQUIRED' && !String(error.message).includes(secret)
  );
});

test('secret refs accept only op URIs and allow an empty optional OTP ref', () => {
  assert.equal(validateSecretRef('op://vault/item/username'), 'op://vault/item/username');
  assert.equal(validateSecretRef('', { optional: true }), '');
  assert.throws(() => validateSecretRef('https://example.com/password'), /INVALID_SECRET_REF/);
  assert.throws(() => validateSecretRef('', { optional: false }), /MISSING_SECRET_REF/);
});

test('stdin secret reader maps only the configured refs and never serializes values', async () => {
  const refs = {
    usernameRef: 'op://vault/item/username',
    passwordRef: 'op://vault/item/password',
    otpRef: 'op://vault/item/otp'
  };
  const reader = createStdinSecretReader({
    username: 'stdin-user-secret',
    password: 'stdin-password-secret',
    otp: '123456'
  }, refs);

  assert.equal(await reader(refs.usernameRef), 'stdin-user-secret');
  assert.equal(await reader(refs.passwordRef), 'stdin-password-secret');
  assert.equal(await reader(refs.otpRef), '123456');
  await assert.rejects(reader('op://vault/item/unknown'), /STDIN_SECRET_REF_REJECTED/);
  assert.deepEqual(reader.describe(), { source: 'stdin', secretValuesExposed: false });
});

test('login document classification requires one primary field pair and rejects human challenges', () => {
  assert.deepEqual(classifyLoginDocument({ usernameCount: 1, passwordCount: 1 }), {
    state: 'login_required',
    challengeType: null
  });
  assert.deepEqual(classifyLoginDocument({ usernameCount: 2, passwordCount: 1 }), {
    state: 'degraded',
    challengeType: null
  });
  assert.deepEqual(classifyLoginDocument({ otpCount: 1, captcha: true }), {
    state: 'second_factor_required',
    challengeType: 'captcha'
  });
  assert.deepEqual(classifyLoginDocument({ otpCount: 1 }), {
    state: 'second_factor_required',
    challengeType: 'otp'
  });
});

test('primary credentials are submitted once and never appear in the result', async () => {
  const username = 'kakao-user-secret';
  const password = 'kakao-password-secret';
  const submissions = [];
  const reads = [];
  const cdpClient = {
    async findLoginTarget() {
      return { id: 'login', url: 'https://accounts.kakao.com/login/simple/' };
    },
    async inspect() {
      return { usernameCount: 1, passwordCount: 1 };
    },
    async submitPrimary(target, userValue, passwordValue) {
      submissions.push({ target, userValue, passwordValue });
    },
    async waitForOutcome() {
      return { state: 'authenticated' };
    }
  };

  const result = await recoverKakaoLogin({
    credentialMode: 'onepassword',
    usernameRef: 'op://vault/item/username',
    passwordRef: 'op://vault/item/password',
    readSecretImpl: async (ref) => {
      reads.push(ref);
      return ref.endsWith('/username') ? username : password;
    },
    cdpClient
  });

  assert.equal(submissions.length, 1);
  assert.deepEqual(reads, ['op://vault/item/username', 'op://vault/item/password']);
  assert.deepEqual(result, {
    ok: true,
    state: 'authenticated',
    attempted: true,
    primarySubmitted: true,
    otpSubmitted: false,
    secretValuesExposed: false
  });
  assert.equal(JSON.stringify(result).includes(username), false);
  assert.equal(JSON.stringify(result).includes(password), false);
});

test('saved-account login opens the primary form once before reading secrets', async () => {
  const events = [];
  let inspectCount = 0;
  const cdpClient = {
    async findLoginTarget() {
      return { id: 'login', url: 'https://accounts.kakao.com/login/simple/' };
    },
    async inspect() {
      inspectCount += 1;
      return inspectCount === 1
        ? { usernameCount: 0, passwordCount: 0, newAccountLoginCount: 1 }
        : { usernameCount: 1, passwordCount: 1, newAccountLoginCount: 0 };
    },
    async openPrimaryLogin() {
      events.push('open-primary-login');
    },
    async submitPrimary() {
      events.push('submit-primary');
    },
    async waitForOutcome() {
      return { state: 'authenticated' };
    }
  };

  const result = await recoverKakaoLogin({
    credentialMode: 'onepassword',
    usernameRef: 'op://vault/item/username',
    passwordRef: 'op://vault/item/password',
    readSecretImpl: async (ref) => {
      events.push(ref.endsWith('/username') ? 'read-username' : 'read-password');
      return 'secret';
    },
    cdpClient
  });

  assert.deepEqual(events, [
    'open-primary-login',
    'read-username',
    'read-password',
    'submit-primary'
  ]);
  assert.equal(inspectCount, 2);
  assert.equal(result.state, 'authenticated');
  assert.equal(result.primarySubmitted, true);
});

test('Chrome saved-account mode clicks the only saved account tile without opening a credential form', async () => {
  const events = [];
  const cdpClient = {
    async findLoginTarget() {
      return { id: 'login', url: 'https://accounts.kakao.com/login/simple/' };
    },
    async inspect() {
      return { usernameCount: 0, passwordCount: 0, newAccountLoginCount: 1 };
    },
    async selectSavedAccount(target) {
      events.push(['select-saved-account', target.id]);
      return { clicked: true, candidateCount: 1 };
    },
    async waitForOutcome() {
      events.push(['wait-for-outcome']);
      return { state: 'authenticated' };
    }
  };

  const result = await recoverKakaoLogin({
    credentialMode: 'chrome_saved_autofill',
    readSecretImpl: async () => { throw new Error('must not read secrets'); },
    cdpClient
  });

  assert.deepEqual(events, [
    ['select-saved-account', 'login'],
    ['wait-for-outcome']
  ]);
  assert.deepEqual(result, {
    ok: true,
    state: 'authenticated',
    attempted: true,
    primarySubmitted: false,
    otpSubmitted: false,
    secretValuesExposed: false
  });
});

test('Chrome saved-account mode leaves an ambiguous account chooser untouched', async () => {
  let waited = false;
  const cdpClient = {
    async findLoginTarget() {
      return { id: 'login', url: 'https://accounts.kakao.com/login/simple/' };
    },
    async inspect() {
      return { usernameCount: 0, passwordCount: 0, newAccountLoginCount: 1 };
    },
    async selectSavedAccount() {
      return { clicked: false, candidateCount: 2 };
    },
    async waitForOutcome() {
      waited = true;
      return { state: 'authenticated' };
    }
  };

  const result = await recoverKakaoLogin({
    credentialMode: 'chrome_saved_autofill',
    readSecretImpl: async () => { throw new Error('must not read secrets'); },
    cdpClient
  });

  assert.equal(waited, false);
  assert.equal(result.state, 'saved_account_ambiguous');
  assert.equal(result.attempted, false);
  assert.equal(result.primarySubmitted, false);
});

test('Chrome saved autofill selects the stored account and submits once without reading secrets', async () => {
  const events = [];
  const cdpClient = {
    async findLoginTarget() {
      return { id: 'login', url: 'https://accounts.kakao.com/login/' };
    },
    async inspect() {
      return { usernameCount: 1, passwordCount: 1 };
    },
    async selectSavedAutofill(target) {
      events.push(['select-saved-autofill', target.id]);
      return { usernameFilled: true, passwordFilled: true };
    },
    async submitAutofilledPrimary(target) {
      events.push(['submit-autofilled-primary', target.id]);
    },
    async waitForOutcome() {
      events.push(['wait-for-outcome']);
      return { state: 'authenticated' };
    }
  };

  const result = await recoverKakaoLogin({
    credentialMode: 'chrome_saved_autofill',
    readSecretImpl: async () => { throw new Error('must not read secrets'); },
    cdpClient
  });

  assert.deepEqual(events, [
    ['select-saved-autofill', 'login'],
    ['submit-autofilled-primary', 'login'],
    ['wait-for-outcome']
  ]);
  assert.deepEqual(result, {
    ok: true,
    state: 'authenticated',
    attempted: true,
    primarySubmitted: true,
    otpSubmitted: false,
    secretValuesExposed: false
  });
});

test('recognized OTP is read and submitted once while captcha is handed to the user', async () => {
  const otpSubmissions = [];
  const otpClient = {
    async findLoginTarget() {
      return { id: 'login', url: 'https://accounts.kakao.com/login/simple/' };
    },
    async inspect() {
      return { usernameCount: 1, passwordCount: 1 };
    },
    async submitPrimary() {},
    async waitForOutcome() {
      return otpSubmissions.length ? { state: 'authenticated' } : { state: 'second_factor_required', challengeType: 'otp' };
    },
    async submitOtp(target, otp) {
      otpSubmissions.push({ target, otp });
    }
  };
  const result = await recoverKakaoLogin({
    credentialMode: 'onepassword',
    usernameRef: 'op://vault/item/username',
    passwordRef: 'op://vault/item/password',
    otpRef: 'op://vault/item/otp',
    readSecretImpl: async (ref) => ref.endsWith('/otp') ? '123456' : 'primary-secret',
    cdpClient: otpClient
  });
  assert.equal(otpSubmissions.length, 1);
  assert.equal(JSON.stringify(result).includes('123456'), false);
  assert.equal(result.otpSubmitted, true);
  assert.equal(result.state, 'authenticated');

  const captchaClient = {
    ...otpClient,
    async inspect() {
      return { usernameCount: 1, passwordCount: 1, captcha: true };
    }
  };
  const captcha = await recoverKakaoLogin({
    credentialMode: 'onepassword',
    usernameRef: 'op://vault/item/username',
    passwordRef: 'op://vault/item/password',
    otpRef: 'op://vault/item/otp',
    readSecretImpl: async () => { throw new Error('must not read'); },
    cdpClient: captchaClient
  });
  assert.equal(captcha.state, 'second_factor_required');
  assert.equal(captcha.attempted, false);
});
