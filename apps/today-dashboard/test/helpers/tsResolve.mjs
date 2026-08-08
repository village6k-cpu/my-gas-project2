// Next.js 소스는 확장자 없는 상대 경로(import "../data/equipmentCatalog")를 쓴다.
// node --test 의 타입 스트리핑은 확장자를 스스로 못 채우므로 해석 훅으로 .ts/.tsx 를 붙여준다.
// 이 모듈을 import 한 뒤 대상 모듈은 반드시 동적 import 로 불러야 훅이 먼저 등록된다.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Next 가 알아서 제공하는 마커 패키지. node --test 에는 없으므로 빈 모듈로 대체한다.
    if (specifier === "server-only") {
      return { format: "module", shortCircuit: true, url: "data:text/javascript,export {};" };
    }
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      for (const ext of EXTENSIONS) {
        try {
          const url = new URL(specifier + ext, context.parentURL);
          if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
        } catch {
          // 해석 불가한 specifier 는 기본 해석기로 넘긴다
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
