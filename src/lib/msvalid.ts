// EVF 录像合法性校验 —— ms-toollib（Rust 扫雷算法库 → WASM）封装（2026-10-24）
//
// 库：npm ms-toollib@1.5.20（https://github.com/eee555/ms-toollib）。
// 用其中 EvfVideo::is_valid() 按「排名网站自动审核规则」校验 evf 录像合法性。
// 调用顺序：new EvfVideo(data, name) → parse() → analyse() → is_valid()，
// 返回 u8：0=通过 / 1=不通过 / 3=可疑。
//
// is_valid 检查项（上游文档 2026-10-24 版）：
//   ① 软件白名单：Arbiter / Viennasweeper / 0.97 beta / 元3.1.9 / 元3.1.11~3.3.4
//      ——白名单外的 software 一律返回 1（不通过）
//   ② 元系列专项：校验和全部相等（测试用校验和）→1；is_fair=false（软件判定辅助手段）→1；
//      游戏模式不在白名单 →3
//   ③ 操作细节密度：动作数/3BV < 10 →3（缺少鼠标移动细节）
//   ④ 完成性：未完成 →1（本站上传线已先拦，此处冗余兜底）
//   ⑤ 鼠标轨迹特征：重复移动（≥20 步同签名且占 75%）/按住时长中位数 <30ms →1，
//      30~40ms →3；极短按 >10 次 →1、4~10 次 →3；轨迹方向熵/转向熵过低 →3
//
// ⚠️ 已知边界（决定本结果只作分拣信号、不做上传硬拒的原因）：
//   白名单止于元3.3.4，而本站上传线允许元3.3.4+（rawvf.checkProgramVersion）——
//   若元出 3.3.5+ 新版本，真录像也会因「白名单外」返回 1。故结果只进需核定池人工复核。
//
// 加载方式（重要，勿改回直接 import "ms-toollib"）：
//   npm 包入口 ms_toollib.js 依赖「wasm ESM 集成」（import * as wasm from
//   './ms_toollib_bg.wasm'）——打包器对该特性的支持不可靠，蓝绿构建产物追踪 wasm
//   资产还有坑。这里绕开入口，直接 import ms_toollib_bg.js，用 WebAssembly.instantiate
//   手工链接（wasm 侧导入模块名固定为 './ms_toollib_bg.js'，须把 bg.js 的全部 __w*
//   导出函数作为导入对象传入），wasm 二进制运行时从 node_modules 读（pnpm symlink 直达）。
//   Node 端零打包器配置、零 next.config 改动，dev/build/蓝绿部署行为一致。

import { readFileSync } from "fs";
import path from "path";
import { createRequire } from "module";
import type * as MsToolBg from "ms-toollib/ms_toollib_bg.js";

let initPromise: Promise<typeof MsToolBg | null> | null = null;

/** 单例初始化：手工实例化 wasm 并注入 bg.js。任何一步失败返回 null（调用方按「无信号」处理） */
function ensureInit(): Promise<typeof MsToolBg | null> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const mod = await import("ms-toollib/ms_toollib_bg.js");
        let wasmPath: string;
        try {
          wasmPath = createRequire(import.meta.url).resolve("ms-toollib/ms_toollib_bg.wasm");
        } catch {
          wasmPath = path.join(process.cwd(), "node_modules/ms-toollib/ms_toollib_bg.wasm");
        }
        const IMPORT_NAME = "./ms_toollib_bg.js";
        const imports: WebAssembly.Imports = { [IMPORT_NAME]: {} };
        const wbgImports = imports[IMPORT_NAME];
        for (const [k, v] of Object.entries(mod)) {
          if (k.startsWith("__w") && typeof v === "function") wbgImports[k] = v as WebAssembly.ImportValue;
        }
        const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), imports);
        mod.__wbg_set_wasm(instance.exports);
        (instance.exports as { __wbindgen_start(): void }).__wbindgen_start();
        return mod;
      } catch {
        return null;
      }
    })();
  }
  return initPromise;
}

export interface EvfValidResult {
  /** 0=通过 1=不通过 3=可疑（ms-toollib is_valid 原始返回值） */
  verdict: 0 | 1 | 3;
  /** 录像软件自报标识（如 元3.3.4）——复核 bit12 时先看这里 */
  software: string;
  completed: boolean;
  bbbv: number;
  /** 用时（秒，evf 自报） */
  rtimeSec: number;
}

/**
 * 校验一段 evf 二进制的合法性（parse + analyse + is_valid 全链）。
 * 返回 null = 库初始化失败或录像解析异常——调用方按「无信号」保守处理，绝不要当成不通过。
 */
export async function evfIsValid(data: Uint8Array, fileName = "video.evf"): Promise<EvfValidResult | null> {
  const mod = await ensureInit();
  if (!mod) return null;
  let video: MsToolBg.EvfVideo | null = null;
  try {
    video = new mod.EvfVideo(data, fileName);
    video.parse();
    video.analyse();
    const raw = video.is_valid();
    return {
      verdict: raw === 1 || raw === 3 ? raw : 0,
      software: video.software,
      completed: video.is_completed,
      bbbv: video.bbbv,
      rtimeSec: video.rtime,
    };
  } catch {
    return null;
  } finally {
    try {
      video?.free();
    } catch {
      /* swallow */
    }
  }
}
