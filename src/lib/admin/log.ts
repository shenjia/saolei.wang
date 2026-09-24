// 后台操作日志（2026-09-24）：管理端一切写操作留痕，落 admin_log 表

import { prisma } from "@/lib/db";

export interface AdminLogInput {
  /** 操作人 user.id */
  user: number;
  /** 动作标识，见 OP_LABELS */
  action: string;
  /** 目标类型：user / video / comment / bbs_post / bbs_reply / news / message / rank / star */
  target?: string;
  targetId?: number;
  /** 人类可读描述（日志列表直接展示） */
  detail?: string;
  ip?: string;
}

/** 动作 → 中文名（日志页展示；未登记的动作用原始标识兜底） */
export const OP_LABELS: Record<string, string> = {
  "user.ban": "封禁玩家",
  "user.unban": "解封玩家",
  "user.setRole": "调整玩家角色",
  "user.resetPassword": "重置玩家密码",
  "user.delete": "删除玩家",
  "video.review": "审核录像",
  "video.batchReview": "批量审核录像",
  "video.delete": "删除录像",
  "comment.setStatus": "处理评论",
  "bbs.setPost": "调整主题属性",
  "bbs.deletePost": "删除主题",
  "bbs.deleteReply": "删除回复",
  "news.delete": "删除动态",
  "message.broadcast": "群发站内信",
  "rank.snapshot": "生成排行快照",
  "star.set": "指定每日一星",
};

export function opLabel(action: string): string {
  return OP_LABELS[action] ?? action;
}

/** 写日志（失败不阻断主流程——日志永远不该把正常操作带崩） */
export async function logAdmin(input: AdminLogInput): Promise<void> {
  try {
    await prisma.adminLog.create({
      data: {
        user: BigInt(input.user),
        action: input.action,
        target: input.target ?? "",
        targetId: BigInt(input.targetId ?? 0),
        detail: (input.detail ?? "").slice(0, 500),
        ip: (input.ip ?? "").slice(0, 39),
        createTime: BigInt(Math.floor(Date.now() / 1000)),
      },
    });
  } catch {
    /* 忽略 */
  }
}
