// UGC 内容 AI 复审调度（2026-10-13；2026-10-27 语义简化）
//
// 调用时机：论坛发主题/回复、录像评论「发表成功之后」异步触发（route 里用 next/server 的 after()）。
// 处理规则（2026-10-27 张老师定：敏感词前置拦截，AI/人审一律后置）：
//   AI 判 review → 只把该条置为「待审」（status=5，写 ai_reason）进后台人工队列。
//   内容前台保持公开展示、计数不回退、动态/通知不撤——人审删除（→-1）才真正下架。
//   AI 判 pass / 调用失败 → 不动。
//
// 幂等：只处理 status 仍为 NORMAL 的记录；重复调用、内容已被删除/编辑过都会安全跳过。

import { prisma } from "./db";
import { CONTENT_STATUS } from "./config";
import { moderateText, textModerationEnabled, TEXT_CATEGORY_NAMES } from "./text-moderate";
import type { TextModerationResult } from "./text-moderate";

export type ContentKind = "comment" | "bbs_post" | "bbs_reply";

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

/**
 * 存库的判定摘要：`类别：理由`，供管理后台在待审行上直接展示。
 * 长度对齐 ai_reason 列 varchar(200)。
 * AI 的 reason 有时直接就是类别名（如「广告推广」），此时不重复拼前缀，避免「广告推广：广告推广」。
 */
function pendingNote(result: TextModerationResult): string {
  const name = TEXT_CATEGORY_NAMES[result.category] ?? "可疑内容";
  const reason = (result.reason ?? "").trim();
  const note = !reason || reason === name || reason.startsWith(name)
    ? reason || name
    : `${name}：${reason}`;
  return note.slice(0, 200);
}

/**
 * 对一条已发布内容做 AI 复审。设计为「发后执行」，调用方不 await 结果即可（用 after 包裹）。
 */
export async function runContentReview(kind: ContentKind, id: number, text: string): Promise<void> {
  if (!textModerationEnabled()) return;
  try {
    const result = await moderateText(text);
    if (result.verdict !== "review") return;
    const note = pendingNote(result);
    const changed = await markPending(kind, id, note);
    if (changed) {
      console.warn(`[content-review] AI 转待审 kind=${kind} id=${id} cat=${result.category} note=${note}`);
    }
  } catch (err) {
    // 复审链路自身出错绝不能影响已成功的发布——只记日志
    console.warn(
      `[content-review] 复审异常 kind=${kind} id=${id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// 三表字段结构一致（status/aiReason/updateTime），收敛统一委托类型——
// prisma delegate union（三元）TS2349 不可调用，必须 cast（同 queries.ts UserScoresDelegate 解法）
interface ContentTableDelegate {
  findUnique(args: {
    where: { id: bigint };
    select: { status: true };
  }): Promise<{ status: number } | null>;
  update(args: {
    where: { id: bigint };
    data: { status: number; aiReason: string; updateTime: bigint };
  }): Promise<unknown>;
}

function contentTable(kind: ContentKind): ContentTableDelegate {
  return (
    kind === "comment" ? prisma.comment : kind === "bbs_post" ? prisma.bbsPost : prisma.bbsReply
  ) as unknown as ContentTableDelegate;
}

/** 把内容置为待审（仅改 status + ai_reason，进后台人工队列；前台展示/计数/动态/通知均不动）。
 *  返回是否真的发生了状态变更。 */
async function markPending(kind: ContentKind, id: number, note: string): Promise<boolean> {
  const table = contentTable(kind);
  const row = await table.findUnique({
    where: { id: BigInt(id) },
    select: { status: true },
  });
  if (!row || row.status !== CONTENT_STATUS.NORMAL) return false;
  await table.update({
    where: { id: BigInt(id) },
    data: { status: CONTENT_STATUS.PENDING, aiReason: note, updateTime: nowSec() },
  });
  return true;
}
