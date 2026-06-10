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
        // 브랜드 / 시맨틱 팔레트 — village-homepage 디자인 시스템과 동일 톤 (크림+먹+오렌지)
        ink: {
          DEFAULT: "#1A1A1A", // 홈페이지 text-primary
          soft: "#404040",
          mute: "#666666", // 홈페이지 text-secondary
          faint: "#999999", // 홈페이지 text-muted
        },
        // 앱 공통 바탕(크림)과 구분선 — 홈페이지 bg-primary / divider
        paper: "#F5F3EF",
        line: "#DEDBD5",
        // 브랜드 = 홈페이지 액센트 오렌지 (인터랙션 강조색 전체를 이 톤으로 통일)
        brand: {
          50: "#FDF1ED",
          100: "#FBDED5",
          200: "#F6C0AF",
          300: "#F09B80",
          400: "#EC7457",
          500: "#E8593C", // 홈페이지 --color-accent
          600: "#D04A2E", // 홈페이지 --color-accent-dark
          700: "#A93B24",
        },
        // 운영 상태색 — 의미(반출 파랑/반납 초록/확인 빨강/주의 노랑)는 유지, 채도만 홈페이지 웜톤에 맞춤
        checkout: { bg: "#EDF3FA", fg: "#41699C", ring: "#C9DCEE" }, // 반출 = 파랑 (홈페이지 tag-blue 계열)
        checkin: { bg: "#ECF2E8", fg: "#4A7A44", ring: "#CDDFC5" }, // 반납 = 초록 (세이지)
        attention: { bg: "#FAEDEA", fg: "#B23A28", ring: "#F1CEC5" }, // 확인필요 = 빨강
        warn: { bg: "#F9F2E2", fg: "#95661C", ring: "#EAD8AC" }, // 주의/메모 = 모래 노랑
        // VILLAGE 시그니처 오렌지 (로고/네비 — brand와 동일 톤)
        accent: { DEFAULT: "#E8593C", 50: "#FDF1ED", 100: "#FBDED5", 600: "#D04A2E", 700: "#A93B24" },
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
