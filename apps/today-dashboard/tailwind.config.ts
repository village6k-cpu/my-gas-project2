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
        // 브랜드 = VILLAGE 로고 오렌지 (인터랙션 강조색 전체를 로고 톤으로 통일)
        brand: {
          50: "#fef3ee",
          100: "#fcdfd2",
          200: "#f8c3ae",
          300: "#f39b79",
          400: "#ee7647",
          500: "#ea5b36", // 로고 색
          600: "#d2440f",
          700: "#ae360d",
        },
        // 운영 상태색
        checkout: { bg: "#eff6ff", fg: "#1d4ed8", ring: "#bfdbfe" }, // 반출 = 파랑
        checkin: { bg: "#ecfdf5", fg: "#047857", ring: "#a7f3d0" }, // 반납 = 초록
        attention: { bg: "#fef2f2", fg: "#b91c1c", ring: "#fecaca" }, // 확인필요 = 빨강
        warn: { bg: "#fffbeb", fg: "#b45309", ring: "#fde68a" },
        // VILLAGE 시그니처 오렌지 (로고/네비 — brand와 동일 톤)
        accent: { DEFAULT: "#ea5b36", 50: "#fef3ee", 100: "#fcdfd2", 600: "#d2440f", 700: "#ae360d" },
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
