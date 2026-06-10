const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const authGatePath = path.join(root, 'apps/today-dashboard/components/AuthGate.tsx');
const authGate = fs.readFileSync(authGatePath, 'utf8');

assert(
  authGate.includes('import { VillageLogo } from "@/components/VillageLogo";'),
  'login screen must reuse the shared VILLAGE image logo'
);

assert(
  authGate.includes('<VillageLogo size="lg" />'),
  'login screen must show the large VILLAGE wordmark instead of Korean text'
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
  authGate.includes('운영 대시보드') && authGate.includes('직원 로그인'),
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
  authGate.includes('bg-[#f6f5f2]'),
  'login screen background must keep the same warm app/homepage base tone'
);

console.log('today-dashboard login redesign static checks passed');
