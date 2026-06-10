const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const logoPath = path.join(root, 'apps/today-dashboard/components/VillageLogo.tsx');
const headerPath = path.join(root, 'apps/today-dashboard/components/ViewHeader.tsx');
const shellPath = path.join(root, 'apps/today-dashboard/components/AppShell.tsx');
const publicLogoPath = path.join(root, 'apps/today-dashboard/public/village-wordmark.png');

const logo = fs.readFileSync(logoPath, 'utf8');
const header = fs.readFileSync(headerPath, 'utf8');
const shell = fs.readFileSync(shellPath, 'utf8');

assert(
  fs.existsSync(publicLogoPath),
  'today-dashboard must ship the provided VILLAGE image as public/village-wordmark.png'
);

assert(
  logo.includes('/village-wordmark.png'),
  'VillageLogo must render the provided image asset'
);

assert(
  logo.includes('alt="VILLAGE"'),
  'VillageLogo image must keep an accessible VILLAGE alt label'
);

assert(
  logo.includes('import Link from "next/link";') && logo.includes('href="/"') && logo.includes('aria-label="홈으로 이동"'),
  'VillageLogo must be a link back to the today-dashboard home'
);

assert.match(
  shell,
  /useEffect\(\(\) => \{\s*setView\(initial\);\s*\}, \[initial\]\);/,
  'AppShell must sync route-driven initial view changes so logo home navigation works on iPhone/PWA client transitions'
);

assert(
  !logo.includes('font-village') && !logo.includes('<span>illage</span>'),
  'VillageLogo must not fall back to the old CSS text wordmark'
);

assert(
  header.includes('sr-only') && header.includes('{title}'),
  'ViewHeader must keep the view title available to screen readers only'
);

assert(
  !header.includes('truncate text-[15px] font-black tracking-tight text-accent-700">{title}</span>'),
  'ViewHeader must not render the current menu name visibly next to the logo'
);

console.log('today-dashboard header logo static checks passed');
