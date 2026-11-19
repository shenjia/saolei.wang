// 同步脚本用的 Node ESM 解析补丁：把「相对路径且无扩展名」的 import 解析到 .ts
// 背景：scripts/sync/*.ts 里写的是 node 原生 TS 剥离要求显式 .ts 扩展名，但脚本内部
// import ../../src/lib/mvf 是无扩展名写法（Next 打包器能解析，Node ESM 不能）。
// 用本 loader 即可直接跑，无需改脚本、无需 tsconfig 的 allowImportingTsExtensions。
//
// 用法: env -u NODE_OPTIONS node --experimental-transform-types \
//         --import ./scripts/sync/ts-extension-loader.mjs scripts/sync/parse-videos.ts ...
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// tsconfig 的 "@/*" → "src/*" 别名：Node 不认，脚本链上只要 import 到 src/lib 里
// 用了 "@/core/..." 的模块（如 video-triage-limits → @/core/src/lib/triage-secret）
// 就 ERR_MODULE_NOT_FOUND（2026-10-27 ranked-retriage.ts 实证）。此处补上解析。
const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const base = path.join(SRC_ROOT, specifier.slice(2));
      for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
    }
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return nextResolve(specifier + ".ts", context);
      } catch {
        /* 落回原样 */
      }
    }
    // Node ESM 要求显式扩展名：裸包名子路径（如 next/cache）补 .js
    // （2026-10-22 rank-snapshot-refresh.ts 引入链上的 queries.ts 带 next/cache，实证 1064 同款 ERR_MODULE_NOT_FOUND）
    if (!specifier.startsWith(".") && !specifier.startsWith("node:") && /\w\/\w/.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return nextResolve(specifier + ".js", context);
      } catch {
        /* 落回原样 */
      }
    }
    return nextResolve(specifier, context);
  },
});
