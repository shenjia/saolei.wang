// 同步脚本用的 Node ESM 解析补丁：把「相对路径且无扩展名」的 import 解析到 .ts
// 背景：scripts/sync/*.ts 里写的是 node 原生 TS 剥离要求显式 .ts 扩展名，但脚本内部
// import ../../src/lib/mvf 是无扩展名写法（Next 打包器能解析，Node ESM 不能）。
// 用本 loader 即可直接跑，无需改脚本、无需 tsconfig 的 allowImportingTsExtensions。
//
// 用法: env -u NODE_OPTIONS node --experimental-transform-types \
//         --import ./scripts/sync/ts-extension-loader.mjs scripts/sync/parse-videos.ts ...
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return nextResolve(specifier + ".ts", context);
      } catch {
        /* 落回原样 */
      }
    }
    return nextResolve(specifier, context);
  },
});
