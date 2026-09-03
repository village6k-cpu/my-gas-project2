import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function validateSecretRef(value, { optional = false } = {}) {
  const ref = String(value || '').trim();
  if (!ref && optional) return '';
  if (!ref) throw codedError('MISSING_SECRET_REF');
  if (!ref.startsWith('op://') || ref.length <= 'op://'.length) {
    throw codedError('INVALID_SECRET_REF');
  }
  return ref;
}

export function createStdinSecretReader(payload = {}, refs = {}) {
  const values = new Map([
    [String(refs.usernameRef || ''), String(payload.username || '')],
    [String(refs.passwordRef || ''), String(payload.password || '')]
  ]);
  if (refs.otpRef) values.set(String(refs.otpRef), String(payload.otp || ''));
  const reader = async (ref) => {
    const key = String(ref || '');
    if (!key || !values.has(key)) throw codedError('STDIN_SECRET_REF_REJECTED');
    const value = values.get(key);
    if (!value) throw codedError('STDIN_SECRET_MISSING');
    return value;
  };
  reader.describe = () => ({ source: 'stdin', secretValuesExposed: false });
  return reader;
}

async function readStdinSecretPayload(limit = 65_536) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > limit) throw codedError('STDIN_SECRET_PAYLOAD_TOO_LARGE');
  }
  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed;
  } catch {
    throw codedError('STDIN_SECRET_PAYLOAD_INVALID');
  }
}

export function readSecret(ref, {
  opPath = 'op.exe',
  spawnImpl = spawn,
  timeoutMs = 30_000
} = {}) {
  const validatedRef = validateSecretRef(ref);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let settled = false;
    let child;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    try {
      child = spawnImpl(opPath, ['read', '--no-newline', validatedRef], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch {
      reject(codedError('OP_UNAVAILABLE'));
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(reject, codedError('OP_AUTH_REQUIRED'));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 16_384) {
        stdout = '';
        try { child.kill(); } catch {}
        finish(reject, codedError('OP_OUTPUT_INVALID'));
      }
    });
    child.stderr?.resume?.();
    child.on('error', () => finish(reject, codedError('OP_UNAVAILABLE')));
    child.on('close', (code) => {
      if (code !== 0) {
        stdout = '';
        finish(reject, codedError('OP_AUTH_REQUIRED'));
        return;
      }
      const value = stdout.replace(/[\r\n]+$/, '');
      stdout = '';
      if (!value) {
        finish(reject, codedError('OP_OUTPUT_INVALID'));
        return;
      }
      finish(resolve, value);
    });
  });
}

export function classifyLoginDocument(snapshot = {}) {
  let challengeType = null;
  if (snapshot.captcha) challengeType = 'captcha';
  else if (snapshot.sms) challengeType = 'sms';
  else if (snapshot.deviceApproval) challengeType = 'device';
  else if (Number(snapshot.otpCount || 0) === 1) challengeType = 'otp';
  if (challengeType) return { state: 'second_factor_required', challengeType };
  if (snapshot.rejected) return { state: 'credential_rejected', challengeType: null };
  if (
    Number(snapshot.newAccountLoginCount || 0) === 1
    && Number(snapshot.usernameCount || 0) === 0
    && Number(snapshot.passwordCount || 0) === 0
  ) {
    return { state: 'account_selection_required', challengeType: null };
  }
  if (Number(snapshot.usernameCount || 0) === 1 && Number(snapshot.passwordCount || 0) === 1) {
    return { state: 'login_required', challengeType: null };
  }
  return { state: 'degraded', challengeType: null };
}

function result(state, values = {}) {
  return {
    ok: state === 'authenticated',
    state,
    attempted: false,
    primarySubmitted: false,
    otpSubmitted: false,
    secretValuesExposed: false,
    ...values
  };
}

function safeTargetOrigin(target) {
  try {
    const parsed = new URL(String(target?.url || ''));
    return parsed.protocol === 'https:' && parsed.hostname === 'accounts.kakao.com';
  } catch {
    return false;
  }
}

export function isAuthenticatedKakaoChatUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['business.kakao.com', 'center-pf.kakao.com'].includes(parsed.hostname)
      && (/^(?:\/space\/[^/]+\/channel)?\/_[^/]+\/chats(?:\/[^/]+)?\/?$/.test(parsed.pathname) || /^\/_chats\/?$/.test(parsed.pathname));
  } catch {
    return false;
  }
}

export async function recoverKakaoLogin({
  credentialMode = 'chrome_saved_autofill',
  usernameRef,
  passwordRef,
  otpRef = '',
  opPath = 'op.exe',
  timeoutMs = 30_000,
  readSecretImpl = readSecret,
  cdpClient = createCdpClient({ timeoutMs })
} = {}) {
  const normalizedCredentialMode = String(credentialMode || '').trim().toLowerCase();
  if (!['chrome_saved_autofill', 'onepassword'].includes(normalizedCredentialMode)) {
    return result('credential_configuration_required');
  }
  let validatedUsernameRef;
  let validatedPasswordRef;
  let validatedOtpRef;
  try {
    if (normalizedCredentialMode === 'onepassword') {
      validatedUsernameRef = validateSecretRef(usernameRef);
      validatedPasswordRef = validateSecretRef(passwordRef);
    }
    validatedOtpRef = validateSecretRef(otpRef, { optional: true });
  } catch {
    return result('credential_configuration_required');
  }

  let target;
  try {
    target = await cdpClient.findLoginTarget();
  } catch {
    return result('cdp_unavailable');
  }
  if (!safeTargetOrigin(target)) return result('degraded');

  let inspected;
  try {
    inspected = classifyLoginDocument(await cdpClient.inspect(target));
  } catch {
    return result('degraded');
  }
  if (inspected.state === 'account_selection_required') {
    if (normalizedCredentialMode === 'chrome_saved_autofill') {
      let selection;
      try {
        selection = await cdpClient.selectSavedAccount(target);
      } catch {
        return result('saved_account_unavailable');
      }
      if (!selection?.clicked) {
        return result(Number(selection?.candidateCount || 0) > 1
          ? 'saved_account_ambiguous'
          : 'saved_account_unavailable');
      }
      let accountOutcome;
      try {
        accountOutcome = await cdpClient.waitForOutcome(target, timeoutMs);
      } catch {
        accountOutcome = { state: 'degraded' };
      }
      return result(String(accountOutcome?.state || 'degraded'), {
        attempted: true,
        primarySubmitted: false,
        ...(accountOutcome?.challengeType ? { challengeType: accountOutcome.challengeType } : {})
      });
    }
    try {
      await cdpClient.openPrimaryLogin(target, timeoutMs);
      inspected = classifyLoginDocument(await cdpClient.inspect(target));
    } catch {
      return result('degraded');
    }
  }
  if (inspected.state !== 'login_required') {
    return result(inspected.state, { challengeType: inspected.challengeType });
  }

  if (normalizedCredentialMode === 'chrome_saved_autofill') {
    try {
      const filled = await cdpClient.selectSavedAutofill(target);
      if (!filled?.usernameFilled || !filled?.passwordFilled) throw codedError('SAVED_AUTOFILL_NOT_FILLED');
      await cdpClient.submitAutofilledPrimary(target);
    } catch {
      return result('saved_credential_unavailable');
    }
  } else {
    let username = '';
    let password = '';
    try {
      username = await readSecretImpl(validatedUsernameRef, { opPath, timeoutMs });
      password = await readSecretImpl(validatedPasswordRef, { opPath, timeoutMs });
    } catch (error) {
      username = '';
      password = '';
      return result(error?.code === 'OP_UNAVAILABLE' ? 'credential_configuration_required' : 'vault_unlock_required');
    }

    try {
      await cdpClient.submitPrimary(target, username, password);
    } catch {
      username = '';
      password = '';
      return result('degraded');
    }
    username = '';
    password = '';
  }

  let outcome;
  try {
    outcome = await cdpClient.waitForOutcome(target, timeoutMs);
  } catch {
    return result('degraded', { attempted: true, primarySubmitted: true });
  }
  if (outcome?.state !== 'second_factor_required' || outcome?.challengeType !== 'otp') {
    return result(String(outcome?.state || 'degraded'), {
      attempted: true,
      primarySubmitted: true,
      ...(outcome?.challengeType ? { challengeType: outcome.challengeType } : {})
    });
  }
  if (!validatedOtpRef) {
    return result('second_factor_required', {
      attempted: true,
      primarySubmitted: true,
      challengeType: 'otp'
    });
  }

  let otp = '';
  try {
    otp = await readSecretImpl(validatedOtpRef, { opPath, timeoutMs });
    if (!/^\d{6}$/.test(otp)) throw codedError('OP_OUTPUT_INVALID');
    await cdpClient.submitOtp(target, otp);
  } catch (error) {
    otp = '';
    return result(error?.code?.startsWith('OP_') ? 'vault_unlock_required' : 'degraded', {
      attempted: true,
      primarySubmitted: true,
      challengeType: 'otp'
    });
  }
  otp = '';
  let otpOutcome;
  try {
    otpOutcome = await cdpClient.waitForOutcome(target, timeoutMs);
  } catch {
    otpOutcome = { state: 'degraded' };
  }
  return result(String(otpOutcome?.state || 'degraded'), {
    attempted: true,
    primarySubmitted: true,
    otpSubmitted: true,
    ...(otpOutcome?.challengeType ? { challengeType: otpOutcome.challengeType } : {})
  });
}

function validateLoopbackWebSocket(url, port) {
  const parsed = new URL(String(url || ''));
  if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1' || Number(parsed.port) !== Number(port)) {
    throw codedError('CDP_ENDPOINT_REJECTED');
  }
  return parsed.href;
}

function createWebSocketCaller(webSocketUrl, port, timeoutMs) {
  const safeUrl = validateLoopbackWebSocket(webSocketUrl, port);
  const socket = new WebSocket(safeUrl);
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(codedError('CDP_CALL_FAILED'));
    else waiter.resolve(message.result || {});
  });
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(codedError('CDP_TIMEOUT')), timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(codedError('CDP_UNAVAILABLE')); }, { once: true });
  });
  return {
    async call(method, params = {}) {
      await opened;
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(codedError('CDP_TIMEOUT'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    }
  };
}

const INSPECT_EXPRESSION = String.raw`(() => {
  const visible = (element) => !!element && !element.disabled && element.getClientRects().length > 0;
  const count = (selector) => [...document.querySelectorAll(selector)].filter(visible).length;
  const body = (document.body?.innerText || '').toLowerCase();
  return {
    usernameCount: count('input[name="loginId"],input[type="email"],input[autocomplete="username"]'),
    passwordCount: count('input[type="password"]'),
    otpCount: count('input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="verification" i]'),
    captcha: !!document.querySelector('iframe[src*="captcha" i],[class*="captcha" i],[id*="captcha" i]'),
    sms: body.includes('sms') || body.includes('문자 인증'),
    deviceApproval: body.includes('기기 승인') || body.includes('다른 기기'),
    rejected: !!document.querySelector('[aria-invalid="true"],.error_message,.txt_error'),
    newAccountLoginCount: [...document.querySelectorAll('a,button,[role="button"]')]
      .filter(visible)
      .filter((element) => (element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ') === '새로운 계정으로 로그인')
      .length
  };
})()`;

async function callOnDocument(target, port, functionDeclaration, args = [], timeoutMs = 30_000) {
  const caller = createWebSocketCaller(target.webSocketDebuggerUrl, port, timeoutMs);
  try {
    const evaluated = await caller.call('Runtime.evaluate', { expression: 'document' });
    const objectId = evaluated?.result?.objectId;
    if (!objectId) throw codedError('CDP_DOCUMENT_MISSING');
    return await caller.call('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true
    });
  } finally {
    caller.close();
  }
}

export function createCdpClient({ port = 9223, timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  const baseUrl = `http://127.0.0.1:${Number(port)}`;
  async function listPages() {
    const response = await fetchImpl(`${baseUrl}/json/list`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 3_000)) });
    if (!response.ok) throw codedError('CDP_UNAVAILABLE');
    const pages = await response.json();
    if (!Array.isArray(pages)) throw codedError('CDP_INVALID_RESPONSE');
    return pages.filter((page) => page?.type === 'page');
  }
  return {
    async findLoginTarget() {
      const pages = await listPages();
      const target = pages.find((page) => safeTargetOrigin(page));
      if (!target) throw codedError('LOGIN_TARGET_MISSING');
      validateLoopbackWebSocket(target.webSocketDebuggerUrl, port);
      return target;
    },
    async inspect(target) {
      const caller = createWebSocketCaller(target.webSocketDebuggerUrl, port, timeoutMs);
      try {
        const response = await caller.call('Runtime.evaluate', {
          expression: INSPECT_EXPRESSION,
          returnByValue: true
        });
        return response?.result?.value || {};
      } finally {
        caller.close();
      }
    },
    async selectSavedAccount(target) {
      const response = await callOnDocument(target, port, `function() {
        const visible = (element) => !!element && !element.disabled && element.getClientRects().length > 0;
        const textOf = (element) => (element.innerText || element.getAttribute('aria-label') || '')
          .trim().replace(/\\s+/g, ' ');
        const genericText = /^(로그인|회원가입|도움말|고객센터|QR(?: 코드로)? 로그인)$/i;
        const genericHref = /(help|support|signup|join|terms|privacy|policy|qr)/i;
        const controls = [...this.querySelectorAll('a,button,[role="button"]')].filter(visible);
        const candidates = controls.filter((element) => {
          const text = textOf(element);
          if (!text || text === '새로운 계정으로 로그인' || genericText.test(text)) return false;
          const href = element.getAttribute('href') || '';
          if (genericHref.test(href)) return false;
          const metadata = [
            element.className,
            element.id,
            element.getAttribute('data-tiara-action-name'),
            element.getAttribute('data-account-id'),
            element.getAttribute('data-email')
          ].filter(Boolean).join(' ');
          return text.includes('@')
            || /account|profile|recent|saved/i.test(metadata)
            || !!element.querySelector('img,[class*="profile" i],[class*="account" i]')
            || !!element.closest('[class*="account" i],[data-tiara-action-name*="account" i]');
        });
        if (candidates.length !== 1) return { clicked: false, candidateCount: candidates.length };
        candidates[0].click();
        return { clicked: true, candidateCount: 1 };
      }`, [], timeoutMs);
      return response?.result?.value || { clicked: false, candidateCount: 0 };
    },
    async openPrimaryLogin(target, waitMs = timeoutMs) {
      await callOnDocument(target, port, `function() {
        const visible = (element) => !!element && !element.disabled && element.getClientRects().length > 0;
        const controls = [...this.querySelectorAll('a,button,[role="button"]')]
          .filter(visible)
          .filter((element) => (element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ') === '새로운 계정으로 로그인');
        if (controls.length !== 1) throw new Error('NEW_ACCOUNT_CONTROL_COUNT_CHANGED');
        controls[0].click();
        return true;
      }`, [], timeoutMs);
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const snapshot = await this.inspect(target);
        if (Number(snapshot.usernameCount || 0) === 1 && Number(snapshot.passwordCount || 0) === 1) return;
      }
      throw codedError('PRIMARY_LOGIN_FORM_TIMEOUT');
    },
    async submitPrimary(target, username, password) {
      await callOnDocument(target, port, `function(username, password) {
        const visible = (element) => !!element && !element.disabled && element.getClientRects().length > 0;
        const users = [...this.querySelectorAll('input[name="loginId"],input[type="email"],input[autocomplete="username"]')].filter(visible);
        const passwords = [...this.querySelectorAll('input[type="password"]')].filter(visible);
        if (users.length !== 1 || passwords.length !== 1) throw new Error('FIELD_COUNT_CHANGED');
        const setValue = (element, value) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(element, value);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setValue(users[0], username);
        setValue(passwords[0], password);
        const form = passwords[0].form || users[0].form;
        if (!form) throw new Error('FORM_MISSING');
        form.requestSubmit();
        return true;
      }`, [username, password], timeoutMs);
    },
    async selectSavedAutofill(target) {
      await callOnDocument(target, port, `function() {
        const visible = (element) => !!element && !element.disabled && element.getClientRects().length > 0;
        const users = [...this.querySelectorAll('input[name="loginId"],input[type="email"],input[autocomplete="username"]')].filter(visible);
        const passwords = [...this.querySelectorAll('input[type="password"]')].filter(visible);
        if (users.length !== 1 || passwords.length !== 1) throw new Error('FIELD_COUNT_CHANGED');
        users[0].focus();
        users[0].click();
        return true;
      }`, [], timeoutMs);

      await new Promise((resolve) => setTimeout(resolve, 500));
      const caller = createWebSocketCaller(target.webSocketDebuggerUrl, port, timeoutMs);
      try {
        const press = async (key, code, virtualKeyCode) => {
          const params = { key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode };
          await caller.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
          await caller.call('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
        };
        await press('ArrowDown', 'ArrowDown', 40);
        await press('Enter', 'Enter', 13);
      } finally {
        caller.close();
      }

      await new Promise((resolve) => setTimeout(resolve, 750));
      const response = await callOnDocument(target, port, `function() {
        const visible = (element) => !!element && !element.disabled && element.getClientRects().length > 0;
        const users = [...this.querySelectorAll('input[name="loginId"],input[type="email"],input[autocomplete="username"]')].filter(visible);
        const passwords = [...this.querySelectorAll('input[type="password"]')].filter(visible);
        if (users.length !== 1 || passwords.length !== 1) throw new Error('FIELD_COUNT_CHANGED');
        return {
          usernameFilled: !!users[0].value,
          passwordFilled: !!passwords[0].value
        };
      }`, [], timeoutMs);
      return response?.result?.value || { usernameFilled: false, passwordFilled: false };
    },
    async submitAutofilledPrimary(target) {
      await callOnDocument(target, port, `function() {
        const visible = (element) => !!element && !element.disabled && element.getClientRects().length > 0;
        const users = [...this.querySelectorAll('input[name="loginId"],input[type="email"],input[autocomplete="username"]')].filter(visible);
        const passwords = [...this.querySelectorAll('input[type="password"]')].filter(visible);
        if (users.length !== 1 || passwords.length !== 1) throw new Error('FIELD_COUNT_CHANGED');
        if (!users[0].value || !passwords[0].value) throw new Error('SAVED_AUTOFILL_NOT_FILLED');
        const form = passwords[0].form || users[0].form;
        if (!form) throw new Error('FORM_MISSING');
        const submitters = [...form.querySelectorAll('button[type="submit"],input[type="submit"],button:not([type])')].filter(visible);
        if (submitters.length === 1) submitters[0].click();
        else form.requestSubmit();
        return { filled: true, submitted: true };
      }`, [], timeoutMs);
    },
    async submitOtp(target, otp) {
      await callOnDocument(target, port, `function(otp) {
        const visible = (element) => !!element && !element.disabled && element.getClientRects().length > 0;
        const fields = [...this.querySelectorAll('input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="verification" i]')].filter(visible);
        if (fields.length !== 1) throw new Error('OTP_FIELD_COUNT_CHANGED');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(fields[0], otp);
        fields[0].dispatchEvent(new Event('input', { bubbles: true }));
        fields[0].dispatchEvent(new Event('change', { bubbles: true }));
        const form = fields[0].form;
        if (!form) throw new Error('FORM_MISSING');
        form.requestSubmit();
        return true;
      }`, [otp], timeoutMs);
    },
    async waitForOutcome(target, waitMs = timeoutMs) {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        const pages = await listPages();
        const authenticated = pages.some((page) => isAuthenticatedKakaoChatUrl(page?.url));
        if (authenticated) return { state: 'authenticated' };
        const loginTarget = pages.find((page) => safeTargetOrigin(page));
        if (loginTarget) {
          target = loginTarget;
          const classification = classifyLoginDocument(await this.inspect(target));
          if (classification.state === 'second_factor_required' || classification.state === 'credential_rejected') {
            return classification;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return { state: 'degraded' };
    }
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name.startsWith('--') || value === undefined) throw codedError('INVALID_ARGUMENTS');
    options[name.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port || process.env.KAKAO_REMOTE_DEBUGGING_PORT || 9223);
  const timeoutMs = Number(args['timeout-ms'] || 30_000);
  const credentialMode = args['credential-mode'] || process.env.KAKAO_LOGIN_CREDENTIAL_MODE || 'chrome_saved_autofill';
  const usernameRef = args['username-ref'] || process.env.KAKAO_1PASSWORD_USERNAME_REF;
  const passwordRef = args['password-ref'] || process.env.KAKAO_1PASSWORD_PASSWORD_REF;
  const otpRef = args['otp-ref'] || process.env.KAKAO_1PASSWORD_OTP_REF || '';
  let readSecretImpl = readSecret;
  if (args['secrets-stdin'] === '1') {
    const stdinPayload = await readStdinSecretPayload();
    readSecretImpl = createStdinSecretReader(stdinPayload, { usernameRef, passwordRef, otpRef });
  }
  const outcome = await recoverKakaoLogin({
    credentialMode,
    usernameRef,
    passwordRef,
    otpRef,
    opPath: args['op-path'] || process.env.OP_CLI_PATH || 'op.exe',
    timeoutMs,
    readSecretImpl,
    cdpClient: createCdpClient({ port, timeoutMs })
  });
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  process.exitCode = outcome.ok ? 0 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify(result('degraded'))}\n`);
    process.exitCode = 2;
  });
}
