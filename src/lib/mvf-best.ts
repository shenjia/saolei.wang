// MVF 择优解析（2026-10-16 张老师拍板）：快照式格式的按键歧义消解
//
// Clone 0.97/2007 的 mvf 不是逐事件记录，而是定时快照：每个采样只存「按键状态位 + 光标
// 位置」，按下/松开靠相邻快照差分推断。快速操作下「松开 A + 按下 B」会挤进同一采样，
// 先后顺序信息永久丢失，只能约定一种解释顺序（flop 官方＝按下优先）。
//
// 73304 实证（张老师定位、位级 dump 确认）：27.09s 单一快照同时含「左键松开 + 右键按下」，
// 玩家本意是先松左、再按右插旗；按下优先把右键解释成 chord 手势 → 旗丢失 → 后续 7 次
// chord 全部无效、3BV 卡 40/62——而 mvf 文件头 Solved3BV=62（Clone 只在胜利时保存，
// 头部即保存瞬间的盘面自证）证明该局完整获胜。
//
// 全库双口径对比（57,094 个 mvf）：210 条判定随口径改变（182 未完成→胜、27 败局→胜、
// 1 胜→败），210 条的文件头全部 Solved3BV==3BV（Clone 自证完整胜局）。
//
// 择优规则（两头都不伤）：
//   1. 按下优先（=flop 官方）判胜 → 直接采用（99.6% 录像，与 flop 零分叉）；
//   2. 判非胜 → 松开优先重判，判胜且文件头自证完整（0.97 有 Solved3BV 时要求
//      solved≥3BV，防弃局被侥幸救回）才采信；
//   3. 仍非胜 → 维持按下优先口径（真弃局/真败局，与 flop 一致）。
// 唯一已知代价：个别「按下优先恰好判胜」的录像（如 3134）不受影响，无倒退。

import { mvfToRawvf } from "./mvf";
import { formatRawvf } from "./rawvf";
import { judgeVideoOutcome } from "./videowin";

function judgeLines(lines: string[]): "win" | "loss" | "incomplete" {
  const v = formatRawvf(lines);
  return judgeVideoOutcome({
    width: v.width,
    height: v.height,
    board: v.board,
    events: v.events,
    marks: v.marks,
  });
}

/** 头部自证完整（0.97 的 3BV/Solved3BV 行；2007 及更早版本无该头，返回 true 放行） */
function headClaimsComplete(lines: string[]): boolean {
  const get = (k: string) => {
    const l = lines.find((x) => x.startsWith(k + ":"));
    return l ? parseInt(l.slice(k.length + 1).trim(), 10) : null;
  };
  const bbbv = get("3BV");
  const solved = get("Solved3BV");
  if (bbbv === null || solved === null) return true;
  return solved >= bbbv;
}

/** mvf → RawVF 行（择优口径）；解析失败返回 null。
 *  releaseFixed=true 表示该文件靠「松开优先」口径救回（判定与回放事件流都用松开优先版）。 */
export function mvfToRawvfBest(buf: Uint8Array): { lines: string[]; releaseFixed: boolean } | null {
  const press = mvfToRawvf(buf, "press");
  if (!press) return null;
  if (judgeLines(press) === "win") return { lines: press, releaseFixed: false };
  const release = mvfToRawvf(buf, "release");
  if (release && judgeLines(release) === "win" && headClaimsComplete(release)) {
    return { lines: release, releaseFixed: true };
  }
  return { lines: press, releaseFixed: false };
}
