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
  authGate.includes('bg-paper') &&
    globals.includes('background: #f5f3ef') &&
    /paper:\s*"#F5F3EF"/.test(tailwind),
  'login screen background must use the shared warm paper token matching the app/homepage base tone'
);

console.log('today-dashboard login redesign static checks passed');
