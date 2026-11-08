// EVF 导出语义闸门（2026-11-08，353969 漏 lc 致中段摘旗案）：
// 编码后必须重新解析字节，并同时做两层校验：
//   ① 逐事件等价：类型/顺序/时间/像素坐标没有被编码器漏写、错写或多写；
//   ② 独立重放等价：原始流与导出流的胜负、完成 3BV、终盘旗位完全一致。
// 只检查「最终是否胜局」不够——中段摘旗后又插回也会被漏掉，因此事件级检查是硬闸。
//
// validationEvents 用于保存转换前的权威原始流。正常调用与 events 相同；若未来导出前
// 又引入 canonicalize/repair 等转换，调用方必须传转换前事件，防止拿坏转换结果自证正确。

import type { OnlineEvent } from "./avfwrite";
import type { RankedEvfInput } from "./evfwrite";
import { parseEvf } from "./evf";
import { renderBoard } from "./rawvf";
import { judgeVideoOutcome, type VideoOutcome } from "./videowin";
import { MOUSE_CODE_TO_EV, replayCounts, type NormEvent } from "./replay-core";

export interface EvfExportValidationResult {
  ok: boolean;
  errors: string[];
  sourceOutcome?: VideoOutcome;
  exportedOutcome?: VideoOutcome;
}

export class EvfExportValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`EVF 导出语义校验失败（已自动重导 1 次）：${errors.join("；")}`);
    this.name = "EvfExportValidationError";
  }
}

const OUTPUT_MOUSE: Record<number, string> = {
  1: "mv", 3: "lc", 5: "lr", 9: "rc", 17: "rr", 33: "mc", 65: "mr", 11: "cc",
};
const CLICK_MOUSE = new Set([3, 5, 9, 17, 33, 65, 11]);
const REPLAY_EV = new Set(["mv", "lc", "lr", "rc", "rr", "mc", "mr", "sc", "mt"]);

function onlineNorm(events: OnlineEvent[]): NormEvent[] {
  return events.map((e) => {
    const ev = MOUSE_CODE_TO_EV[e.mouse];
    if (!ev) throw new Error(`不支持的原始鼠标事件码 ${e.mouse}`);
    return {
      ev,
      x: Math.floor(e.x / 16),
      y: Math.floor(e.y / 16),
      px: e.x,
      py: e.y,
    };
  });
}

function exportedNorm(events: ReturnType<typeof parseEvf>["events"]): NormEvent[] {
  const out: NormEvent[] = [];
  for (const e of events) {
    if (!e.mouse) continue;
    // EVF v4 的 cc 对应站内 sc（shift+左键），其余名称一致。
    const ev = e.mouse === "cc" ? "sc" : e.mouse;
    if (!REPLAY_EV.has(ev)) throw new Error(`导出流含不可重放事件 ${e.mouse}`);
    const px = e.x ?? 0, py = e.y ?? 0;
    out.push({
      ev: ev as NormEvent["ev"],
      x: Math.floor(px / 16), y: Math.floor(py / 16),
      px, py,
    });
  }
  return out;
}

function rawEventLines(events: OnlineEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const ev = MOUSE_CODE_TO_EV[e.mouse];
    if (!ev || ev === "mv") continue;
    const ms = e.ms ?? e.sec * 1000 + e.hun * 10;
    // judgeVideoOutcome 只读取事件名和括号内像素坐标；其余字段保持 RawVF 形态。
    out.push(`${(ms / 1000).toFixed(3)} ${ev} ${e.x} ${e.y} (${e.x} ${e.y})`);
  }
  return out;
}

function exportedEventLines(events: ReturnType<typeof parseEvf>["events"]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (!e.mouse || e.mouse === "mv") continue;
    const ev = e.mouse === "cc" ? "sc" : e.mouse;
    if (!REPLAY_EV.has(ev)) throw new Error(`导出流含不可判定事件 ${e.mouse}`);
    const x = e.x ?? 0, y = e.y ?? 0;
    out.push(`${e.time.toFixed(3)} ${ev} ${x} ${y} (${x} ${y})`);
  }
  return out;
}

function sourceBoard(input: RankedEvfInput): string {
  const rows: string[] = [];
  for (let y = 0; y < input.height; y++) {
    let row = "";
    for (let x = 0; x < input.width; x++) row += input.board[y * input.width + x] ? "*" : "0";
    rows.push(row);
  }
  return renderBoard(rows);
}

/** 按 EVF v4 编码约定计算应落盘的事件序列；与生成器分开持有，专门反向核对实际字节。 */
function expectedEvents(input: RankedEvfInput, events: OnlineEvent[]) {
  const out: { mouse: string; ms: number; x: number; y: number }[] = [];
  const sentinelX = input.width * 16, sentinelY = input.height * 16;
  let clampMs = 0;
  for (const e of events) {
    const mouse = OUTPUT_MOUSE[e.mouse];
    if (!mouse) throw new Error(`不支持的原始鼠标事件码 ${e.mouse}`);
    let x = e.x, y = e.y;
    if (CLICK_MOUSE.has(e.mouse) && (x >= sentinelX || y >= sentinelY || x < 0 || y < 0)) {
      x = sentinelX;
      y = sentinelY;
    }
    const ms = Math.max(e.ms ?? e.sec * 1000 + e.hun * 10, clampMs);
    clampMs = ms;
    out.push({ mouse, ms, x: x & 0xffff, y: y & 0xffff });
  }
  if (out.length) {
    const firstMs = out[0].ms;
    if (firstMs > 255) for (const e of out) e.ms -= firstMs;
    if (!["mv", "lc", "rc"].includes(out[0].mouse)) {
      out.unshift({ mouse: "mv", ms: 0, x: out[0].x, y: out[0].y });
    }
  }
  return out;
}

function compareEventStream(
  input: RankedEvfInput,
  sourceEvents: OnlineEvent[],
  decoded: ReturnType<typeof parseEvf>["events"],
): string[] {
  const errors: string[] = [];
  const expected = expectedEvents(input, sourceEvents);
  const actual = decoded.filter((e) => e.mouse);
  if (expected.length !== actual.length) {
    errors.push(`事件数不一致（原始 ${expected.length} / 导出 ${actual.length}）`);
  }
  const n = Math.min(expected.length, actual.length);
  for (let i = 0; i < n && errors.length < 8; i++) {
    const a = expected[i], b = actual[i];
    const mouse = b.mouse;
    const ms = Math.round(b.time * 1000);
    if (a.mouse !== mouse) {
      errors.push(`事件 ${i} 类型不一致（原始 ${a.mouse} / 导出 ${mouse}）`);
    }
    if (a.ms !== ms) {
      errors.push(`事件 ${i} 时间不一致（原始 ${a.ms}ms / 导出 ${ms}ms）`);
    }
    if (a.x !== b.x || a.y !== b.y) {
      errors.push(`事件 ${i} 坐标不一致（原始 ${a.x},${a.y} / 导出 ${b.x},${b.y}）`);
    }
  }
  return errors;
}

/**
 * 校验实际 EVF 字节是否忠实于原始事件。任何异常都返回失败，不把「校验器自己报错」
 * 当成无信号放行——这是发布闸，必须 fail closed。
 */
export function validateRankedEvfExport(
  input: RankedEvfInput,
  bytes: Uint8Array,
): EvfExportValidationResult {
  const errors: string[] = [];
  let sourceOutcome: VideoOutcome | undefined;
  let exportedOutcome: VideoOutcome | undefined;
  try {
    const sourceEvents = input.validationEvents ?? input.events;
    const video = parseEvf(bytes);
    errors.push(...compareEventStream(input, sourceEvents, video.events));

    const replayBoard = {
      width: input.width, height: input.height, mines: input.mines, board: input.board,
    };
    const sourceCounts = replayCounts(replayBoard, onlineNorm(sourceEvents), { marks: input.questionMarks });
    const exportedCounts = replayCounts(replayBoard, exportedNorm(video.events), { marks: input.questionMarks });
    sourceOutcome = judgeVideoOutcome({
      width: input.width, height: input.height, board: sourceBoard(input),
      events: rawEventLines(sourceEvents), marks: input.questionMarks,
    });
    exportedOutcome = judgeVideoOutcome({
      width: video.width, height: video.height, board: video.board,
      events: exportedEventLines(video.events), marks: video.useQuestion,
    });
    if (sourceOutcome !== exportedOutcome) {
      errors.push(`重放胜负不一致（原始 ${sourceOutcome} / 导出 ${exportedOutcome}）`);
    }
    if (sourceCounts.solvedBv !== exportedCounts.solvedBv) {
      errors.push(`完成 3BV 不一致（原始 ${sourceCounts.solvedBv} / 导出 ${exportedCounts.solvedBv}）`);
    }
    for (let i = 0; i < sourceCounts.flagged.length; i++) {
      if (sourceCounts.flagged[i] !== exportedCounts.flagged[i]) {
        const row = Math.floor(i / input.width) + 1, col = i % input.width + 1;
        errors.push(`终盘旗位不一致（第 ${row} 行第 ${col} 列：原始 ${sourceCounts.flagged[i]} / 导出 ${exportedCounts.flagged[i]}）`);
        if (errors.length >= 12) break;
      }
    }
  } catch (e) {
    errors.push(`校验重放异常：${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: errors.length === 0, errors, sourceOutcome, exportedOutcome };
}
