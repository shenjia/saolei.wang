// ms-toollib 子路径导入的最小类型声明（npm 包只带主入口 ms_toollib.d.ts，
// 我们绕开入口直接用 ms_toollib_bg.js 手工实例化 wasm，见 src/lib/msvalid.ts 头注）
declare module "ms-toollib/ms_toollib_bg.js" {
  export class EvfVideo {
    constructor(data: Uint8Array, file_name: string);
    parse(): void;
    analyse(): void;
    is_valid(): number;
    free(): void;
    readonly software: string;
    readonly is_completed: boolean;
    readonly bbbv: number;
    readonly rtime: number;
  }
  /** 注入手工实例化的 wasm exports（配合 WebAssembly.instantiate 使用） */
  export function __wbg_set_wasm(val: object): void;
}
