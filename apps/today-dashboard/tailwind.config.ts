import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 브랜드 / 시맨틱 팔레트
        ink: {
          DEFAULT: "#16181d",
          soft: "#3b3f47",
          mute: "#6b7280",
          faint: "#9aa1ac",
        },
        brand: {
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
        },
        // 운영 상태색
        checkout: { bg: "#eff6ff", fg: "#1d4ed8", ring: "#bfdbfe" }, // 반출 = 파랑
        checkin: { bg: "#ecfdf5", fg: "#047857", ring: "#a7f3d0" }, // 반납 = 초록
        attention: { bg: "#fef2f2", fg: "#b91c1c", ring: "#fecaca" }, // 확인필요 = 빨강
        warn: { bg: "#fffbeb", fg: "#b45309", ring: "#fde68a" },
        // VILLAGE 시그니처 오렌지 (로고/브랜드 포인트)
        accent: { DEFAULT: "#ea5b36", 50: "#fff3ef", 100: "#ffe2d8", 600: "#d94b27", 700: "#b73d1f" },
      },
      borderRadius: {
        xl2: "1.125rem",
      },
      boxShadow: {
        card: "0 1px 2px rgba(16,18,29,0.04), 0 4px 16px rgba(16,18,29,0.06)",
        pop: "0 8px 30px rgba(16,18,29,0.14)",
      },
      fontFamily: {
        sans: [
          "Pretendard",
          "-apple-system",
          "BlinkMacSystemFont",
          "Apple SD Gothic Neo",
          "system-ui",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        village: ['"Big Shoulders Display"', "Helvetica Neue", "Arial Black", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
