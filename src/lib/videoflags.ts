// 录像封面含旗 board 串 —— 纯函数工具（2026-10-31 张老师需求）
//
// 背景：video_info.board 原为纯雷位形态（`*`=雷 / `0-8`=数字，数字由 renderBoard
// 从雷位现算，是派生数据）。封面只显示雷格灰面，玩家旗不可见——FL 局与 NF 局
// 封面一模一样，打法信息丢失。
//
// 方案（张老师定：不另起一列，合并在 board 里等长编码）：
//   `*` 雷·未标 → 灰未开面（现状不变）
//   `F` 雷·玩家旗 → 红旗（对旗）
//   `X` 非雷格·玩家旗 → 错旗贴图（灰底红叉）
//   `0-8` 数字 → 数字（现状不变）
//
// ⚠️ 编码只存在于 DB 落库后的串里：avf/mvf/rmv/evf 解析器产出的 board 永远是
//    纯雷位形态（renderBoard 只产 `*`+数字），上传校验（judgeVideoOutcome）、
//    回放引擎（mines 数组只认 `*`）、雷达统计（replayEvents）等吃解析器输出的
//    链路天然不受 F/X 影响——F/X 字符在它们眼里等同非雷格（落到 else 分支），
//    唯一需要感知的是 Board 渲染层与封面写入链路。
//    仍提供 stripFlags 反纯化工具，供任何要从 DB 串恢复纯雷位形态的场合。
//
// 本文件必须是零依赖纯函数模块（与 replay-core 同律：客户端可能引用）。

/**
 * 合成含旗 board 串（等长替换，长度恒等于 board.length）。
 * @param board 纯雷位形态串（解析器直出：`*`/数字）
 * @param flagged 终态旗位图（replayCounts().flagged，1＝终局插旗）
 * @returns 含旗串：雷上旗→`F`、非雷旗→`X`、其余原样
 */
export function applyFlags(board: string, flagged: Uint8Array): string {
  if (flagged.length !== board.length) return board; // 防御：长度不符原样返回
  let out = "";
  for (let i = 0; i < board.length; i++) {
    if (flagged[i]) out += board[i] === "*" ? "F" : "X";
    else out += board[i];
  }
  return out;
}

/**
 * 反纯化：DB 含旗串 → 纯雷位形态（`F`→`*`、`X`→`0` 由调用方重算数字，
 * 此处给占位 0；需要真数字的场合走 renderBoard 语义重算）。
 * 纯雷位串原样透传（幂等）。
 */
export function stripFlags(board: string): string {
  if (board.indexOf("F") < 0 && board.indexOf("X") < 0) return board;
  return board.replace(/F/g, "*").replace(/X/g, "0");
}

/** 判断是否含旗编码（详情页/列表判断「这盘有没有玩家旗」用） */
export function hasFlagCode(board: string): boolean {
  return board.indexOf("F") >= 0 || board.indexOf("X") >= 0;
}
