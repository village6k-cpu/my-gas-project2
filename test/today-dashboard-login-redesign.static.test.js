const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const authGatePath = path.join(root, 'apps/today-dashboard/components/AuthGate.tsx');
const globalsPath = path.join(root, 'apps/today-dashboard/app/globals.css');
const tailwindPath = path.join(root, 'apps/today-dashboard/tailwind.config.ts');
const authGate = fs.readFileSync(authGatePath, 'utf8');
const globals = fs.readFileSync(globalsPath, 'utf8');
const tailwind = fs.readFileSync(tailwindPath, 'utf8');

assert(
  authGate.includes('function LoginWordmark()') &&
    authGate.includes('src="/village-wordmark.png"') &&
    authGate.includes('alt="VILLAGE"'),
  'login screen must reuse the shared VILLAGE wordmark image'
);

assert(
  authGate.includes('<LoginWordmark />') && authGate.includes('운영 대시보드'),
  'login screen must show the VILLAGE wordmark lockup instead of Korean text'
);

assert(
  !authGate.includes('text-2xl font-black tracking-tight text-brand-700">빌리지</div>'),
  'login screen must not render the old Korean text logo'
);

assert(
  authGate.includes('max-w-[420px]'),
  'login form should be wider than the old max-w-xs compact form'
);

assert(
  authGate.includes('운영 대시보드') && authGate.includes('{busy ? "로그인 중..." : "로그인"}'),
  'login screen must keep the operational login context'
);

assert(
  authGate.includes('bg-brand-600') && authGate.includes('disabled:cursor-not-allowed'),
  'login CTA must stay brand-orange and expose a disabled state'
);

assert(
  authGate.includes('aria-live="polite"'),
  'login failure message should be announced politely to assistive tech'
);

assert(
  /const AUTH_SESSION_TIMEOUT_MS = 3500/.test(authGate) &&
    /setTimeout\(\(\) => resolve\("timeout"\), AUTH_SESSION_TIMEOUT_MS\)/.test(authGate) &&
    /\.catch\(\(\) => null\)/.test(authGate) &&
    /if \(cancelled\) return/.test(authGate),
  'AuthGate must leave the loading splash even when Supabase session restore hangs or fails'
);

assert(
  authGate.includes('const sessionPromise = sb.auth') &&
    authGate.includes('sessionPromise.then((restoredSession) => {') &&
    authGate.includes('if (cancelled || !restoredSession) return;') &&
    authGate.includes('setSession(restoredSession);'),
  'AuthGate must still accept a late existing session after the splash timeout'
);

assert(
  authGate.includes('supabase.auth.signInWithPassword({ email: email.trim(), password: pw })') &&
    authGate.includes('const { data, error } = loginResult;') &&
    authGate.includes('setSession(data.session);'),
  'successful password login must immediately update the active session'
);

assert(
  /const AUTH_LOGIN_TIMEOUT_MS = 12000/.test(authGate) &&
    /setTimeout\(\(\) => resolve\("timeout"\), AUTH_LOGIN_TIMEOUT_MS\)/.test(authGate) &&
    authGate.includes('로그인 서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해주세요.'),
  'password login must leave the busy state when Supabase Auth does not respond'
);

assert(
  authGate.includes('bg-paper') &&
    globals.includes('background: #f5f3ef') &&
    /paper:\s*"#F5F3EF"/.test(tailwind),
  'login screen background must use the shared warm paper token matching the app/homepage base tone'
);

console.log('today-dashboard login redesign static checks passed');
