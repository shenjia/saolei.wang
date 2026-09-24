// 后台写操作统一入口（2026-09-24 管理后台）
//
// 所有管理端写操作都收敛到 runOp(op, params, actor, ip)：
// · 权限按 op 声明式校验（OP_LEVELS），不信任前端传参；
// · 参数逐个白名单校验 + 类型转换，非法值直接拒绝；
// · 每个 op 成功后写一条 admin_log（谁、对谁、做了什么）。
//
// 接口层只管 JSON 解析与错误码，业务规则全在这里。

import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import type { SessionUser } from "@/lib/auth";
import { USER_ROLE, VIDEO_STATUS, isManager } from "@/lib/config";
import { reviewVideo } from "@/lib/review";
import { broadcast } from "@/lib/message";
import { ensureTodaySnapshot } from "@/lib/ranksnap";
import { logAdmin } from "./log";
import type { AdminLevel } from "./guard";

export type OpResult = { ok: true; message: string } | { ok: false; error: string };

/** 每个 op 的最低权限要求 */
export const OP_LEVELS: Record<string, AdminLevel> = {
  "user.setStatus": "administrator",
  "user.setRole": "administrator",
  "user.resetPassword": "administrator",
  "user.delete": "administrator",
  "video.review": "manager",
  "video.batchReview": "manager",
  "video.delete": "administrator",
  "comment.setStatus": "manager",
  "bbs.setPost": "manager",
  "bbs.deletePost": "manager",
  "bbs.deleteReply": "manager",
  "news.delete": "manager",
  "message.broadcast": "administrator",
  "rank.snapshot": "manager",
  "star.set": "manager",
};

// ---------- 参数工具 ----------

const toId = (v: unknown): number | null => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const toBool = (v: unknown): boolean => v === true || v === "1" || v === 1 || v === "true";
const toText = (v: unknown, max: number): string => String(v ?? "").trim().slice(0, max);

const ROLE_NAMES: Record<number, string> = { 0: "普通玩家", 10: "管理员", 100: "超级管理员" };

// ---------- 主入口 ----------

export async function runOp(
  op: string,
  params: Record<string, unknown>,
  actor: SessionUser,
  ip: string
): Promise<OpResult> {
  const level = OP_LEVELS[op];
  if (!level) return { ok: false, error: `未知操作：${op}` };
  const allowed = level === "administrator" ? actor.role === USER_ROLE.ADMINISTRATOR : isManager(actor.role);
  if (!allowed) return { ok: false, error: "权限不足：该操作仅超级管理员可用" };

  const res = await dispatch(op, params, actor);
  if (res.ok) {
    await logAdmin({
      user: actor.uid,
      action: op,
      target: op.split(".")[0],
      targetId: toId(params.id) ?? 0,
      detail: res.message,
      ip,
    });
  }
  return res;
}

async function dispatch(
  op: string,
  p: Record<string, unknown>,
  actor: SessionUser
): Promise<OpResult> {
  switch (op) {
    // ---------- 玩家 ----------
    case "user.setStatus": {
      const id = toId(p.id);
      const status = parseInt(String(p.status ?? ""), 10);
      if (!id) return { ok: false, error: "参数错误：缺少玩家 ID" };
      if (status !== 0 && status !== -1) return { ok: false, error: "参数错误：状态只能为 0（正常）或 -1（封禁）" };
      if (id === actor.uid) return { ok: false, error: "不能封禁自己" };
      const user = await prisma.user.findUnique({ where: { id: BigInt(id) } });
      if (!user) return { ok: false, error: "玩家不存在" };
      await prisma.user.update({ where: { id: BigInt(id) }, data: { status, updateTime: BigInt(now()) } });
      return { ok: true, message: `${status === -1 ? "封禁" : "解封"}玩家 ${user.chineseName}（#${id}）` };
    }

    case "user.setRole": {
      const id = toId(p.id);
      const role = parseInt(String(p.role ?? ""), 10);
      if (!id) return { ok: false, error: "参数错误：缺少玩家 ID" };
      if (![USER_ROLE.PLAYER, USER_ROLE.MANAGER, USER_ROLE.ADMINISTRATOR].includes(role as 0 | 10 | 100)) {
        return { ok: false, error: "参数错误：角色只能为 0 / 10 / 100" };
      }
      if (id === actor.uid) return { ok: false, error: "不能修改自己的角色（防止误操作锁死后台）" };
      const auth = await prisma.userAuth.findUnique({ where: { id: BigInt(id) } });
      if (!auth) return { ok: false, error: "该玩家没有账号记录，无法调整角色" };
      await prisma.userAuth.update({
        where: { id: BigInt(id) },
        data: { role, updateTime: BigInt(now()) },
      });
      return { ok: true, message: `将 ${auth.username}（#${id}）角色改为「${ROLE_NAMES[role]}」` };
    }

    case "user.resetPassword": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少玩家 ID" };
      const auth = await prisma.userAuth.findUnique({ where: { id: BigInt(id) } });
      if (!auth) return { ok: false, error: "该玩家没有账号记录" };
      const given = toText(p.password, 32);
      // 未指定则生成 10 位随机密码（去掉易混字符 0/O/1/l/I）
      const password = given || randomPassword(10);
      if (password.length < 6) return { ok: false, error: "密码至少 6 位" };
      await prisma.userAuth.update({
        where: { id: BigInt(id) },
        data: { password: hashPassword(password, auth.salt), updateTime: BigInt(now()) },
      });
      await prisma.passwordToken.deleteMany({ where: { user: BigInt(id) } });
      return { ok: true, message: `重置 ${auth.username}（#${id}）密码为：${password}` };
    }

    case "user.delete": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少玩家 ID" };
      if (id === actor.uid) return { ok: false, error: "不能删除自己的账号" };
      const auth = await prisma.userAuth.findUnique({ where: { id: BigInt(id) } });
      if (!auth) return { ok: false, error: "该玩家没有账号记录" };
      // 仅注销登录凭据（保留 user/成绩/录像，避免破坏排行与历史引用），并封禁
      await prisma.$transaction([
        prisma.userAuth.delete({ where: { id: BigInt(id) } }),
        prisma.user.update({ where: { id: BigInt(id) }, data: { status: -1, updateTime: BigInt(now()) } }),
        prisma.userOauth.deleteMany({ where: { userId: BigInt(id) } }),
        prisma.passwordToken.deleteMany({ where: { user: BigInt(id) } }),
      ]);
      return { ok: true, message: `注销账号 ${auth.username}（#${id}），账号数据保留、无法再登录` };
    }

    // ---------- 录像 ----------
    case "video.review": {
      const id = toId(p.id);
      const status = parseInt(String(p.status ?? ""), 10);
      if (!id) return { ok: false, error: "参数错误：缺少录像 ID" };
      if (![VIDEO_STATUS.BANNED, VIDEO_STATUS.NORMAL, VIDEO_STATUS.REVIEWED].includes(status as 0 | 10 | 20)) {
        return { ok: false, error: "参数错误：非法状态" };
      }
      const r = await reviewVideo(actor.uid, actor.role, id, status);
      if (!r.ok) return { ok: false, error: r.error ?? "审核失败" };
      return { ok: true, message: `录像 #${id} → ${statusName(status)}` };
    }

    case "video.batchReview": {
      const ids = (Array.isArray(p.ids) ? p.ids : []).map(toId).filter((x): x is number => !!x);
      const status = parseInt(String(p.status ?? ""), 10);
      if (!ids.length) return { ok: false, error: "请先勾选录像" };
      if (![VIDEO_STATUS.BANNED, VIDEO_STATUS.REVIEWED].includes(status as 0 | 20)) {
        return { ok: false, error: "批量只能「通过」或「屏蔽」" };
      }
      let done = 0;
      const errors: string[] = [];
      for (const id of ids) {
        const r = await reviewVideo(actor.uid, actor.role, id, status);
        if (r.ok) done++;
        else errors.push(`#${id}: ${r.error}`);
      }
      if (!done) return { ok: false, error: errors[0] ?? "全部失败" };
      return {
        ok: true,
        message: `批量${statusName(status)} ${done}/${ids.length} 条${errors.length ? `（${errors.length} 条失败）` : ""}`,
      };
    }

    case "video.delete": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少录像 ID" };
      const video = await prisma.video.findUnique({ where: { id: BigInt(id) } });
      if (!video) return { ok: false, error: "录像不存在" };
      // 先按屏蔽回退成绩（复用审核管线，保证 user_scores 一致），再清理实体
      if (video.status !== VIDEO_STATUS.BANNED) {
        const r = await reviewVideo(actor.uid, actor.role, id, VIDEO_STATUS.BANNED);
        if (!r.ok) return { ok: false, error: `成绩回退失败：${r.error}` };
      }
      const vid = BigInt(id);
      await prisma.$transaction([
        prisma.video.delete({ where: { id: vid } }),
        prisma.videoInfo.deleteMany({ where: { id: vid } }),
        prisma.videoStat.deleteMany({ where: { id: vid } }),
        prisma.comment.deleteMany({ where: { video: vid } }),
        // 引用该录像的动态一并删除，避免详情页出现悬空链接
        prisma.news.deleteMany({ where: { reference: vid } }),
      ]);
      return { ok: true, message: `彻底删除录像 #${id}（含解析信息 / 评论 / 引用动态）` };
    }

    // ---------- 评论 ----------
    case "comment.setStatus": {
      const id = toId(p.id);
      const status = parseInt(String(p.status ?? ""), 10);
      if (!id) return { ok: false, error: "参数错误：缺少评论 ID" };
      if (status !== 0 && status !== -1) return { ok: false, error: "参数错误：状态只能为 0 或 -1" };
      const row = await prisma.comment.findUnique({ where: { id: BigInt(id) } });
      if (!row) return { ok: false, error: "评论不存在" };
      await prisma.$transaction(async (tx) => {
        await tx.comment.update({ where: { id: BigInt(id) }, data: { status, updateTime: BigInt(now()) } });
        // 同步录像评论计数（video_stat.comments）
        const delta = status === -1 && row.status !== -1 ? -1 : status === 0 && row.status === -1 ? 1 : 0;
        if (delta) {
          await tx.videoStat.updateMany({
            where: { id: row.video },
            data: { comments: { increment: delta }, updateTime: BigInt(now()) },
          });
        }
      });
      return { ok: true, message: `${status === -1 ? "删除" : "恢复"}评论 #${id}` };
    }

    // ---------- 论坛 ----------
    case "bbs.setPost": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少主题 ID" };
      const data: Record<string, unknown> = { updateTime: BigInt(now()) };
      const changed: string[] = [];
      if ("isTop" in p) { data.isTop = toBool(p.isTop); changed.push(`置顶=${toBool(p.isTop) ? "是" : "否"}`); }
      if ("isNice" in p) { data.isNice = toBool(p.isNice); changed.push(`精华=${toBool(p.isNice) ? "是" : "否"}`); }
      if ("isLocked" in p) { data.isLocked = toBool(p.isLocked); changed.push(`锁定=${toBool(p.isLocked) ? "是" : "否"}`); }
      if ("board" in p) {
        const board = parseInt(String(p.board ?? ""), 10);
        if (![0, 1, 2, 3].includes(board)) return { ok: false, error: "参数错误：板块只能为 0-3" };
        data.board = board;
        changed.push(`板块=${board}`);
      }
      if (!changed.length) return { ok: false, error: "没有需要修改的属性" };
      await prisma.bbsPost.update({ where: { id: BigInt(id) }, data });
      return { ok: true, message: `主题 #${id} ${changed.join("，")}` };
    }

    case "bbs.deletePost": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少主题 ID" };
      const post = await prisma.bbsPost.findUnique({ where: { id: BigInt(id) }, select: { title: true } });
      if (!post) return { ok: false, error: "主题不存在" };
      await prisma.$transaction([
        prisma.bbsPost.update({ where: { id: BigInt(id) }, data: { status: -1, updateTime: BigInt(now()) } }),
        prisma.bbsReply.updateMany({ where: { post: BigInt(id) }, data: { status: -1, updateTime: BigInt(now()) } }),
      ]);
      return { ok: true, message: `删除主题 #${id}「${post.title}」及其全部回复` };
    }

    case "bbs.deleteReply": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少回复 ID" };
      const reply = await prisma.bbsReply.findUnique({ where: { id: BigInt(id) } });
      if (!reply) return { ok: false, error: "回复不存在" };
      await prisma.$transaction(async (tx) => {
        await tx.bbsReply.update({ where: { id: BigInt(id) }, data: { status: -1, updateTime: BigInt(now()) } });
        if (reply.status !== -1) {
          await tx.bbsPost.update({
            where: { id: reply.post },
            data: { replies: { decrement: 1 }, updateTime: BigInt(now()) },
          });
        }
      });
      return { ok: true, message: `删除回复 #${id}` };
    }

    // ---------- 动态 ----------
    case "news.delete": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少动态 ID" };
      const row = await prisma.news.findUnique({ where: { id: BigInt(id) } });
      if (!row) return { ok: false, error: "动态不存在" };
      await prisma.news.delete({ where: { id: BigInt(id) } });
      return { ok: true, message: `删除动态 #${id}（玩家 #${Number(row.user)}）` };
    }

    // ---------- 站内信 ----------
    case "message.broadcast": {
      const content = toText(p.content, 200);
      if (!content) return { ok: false, error: "请填写广播内容" };
      const sent = await broadcast(actor.uid, content);
      return { ok: true, message: `已向 ${sent} 名玩家广播：「${content.slice(0, 30)}${content.length > 30 ? "…" : ""}」` };
    }

    // ---------- 排行 / 荣誉 ----------
    case "rank.snapshot": {
      await ensureTodaySnapshot(true);
      const c = await prisma.rankSnapshot.count();
      return { ok: true, message: `已重算今日排行快照（库内累计 ${c} 条）` };
    }

    case "star.set": {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date ?? "")) ? String(p.date) : todayStr();
      const userId = toId(p.userId);
      if (!userId) return { ok: false, error: "参数错误：缺少玩家 ID" };
      const user = await prisma.user.findUnique({ where: { id: BigInt(userId) } });
      if (!user) return { ok: false, error: "玩家不存在" };
      if (toBool(p.clear)) {
        await prisma.star.deleteMany({ where: { date } });
        return { ok: true, message: `已清除 ${date} 的每日一星` };
      }
      await prisma.star.upsert({
        where: { date },
        create: { user: BigInt(userId), date, createTime: BigInt(now()), updateTime: BigInt(now()) },
        update: { user: BigInt(userId), updateTime: BigInt(now()) },
      });
      return { ok: true, message: `指定 ${date} 每日一星为 ${user.chineseName}（#${userId}）` };
    }

    default:
      return { ok: false, error: `未实现的操作：${op}` };
  }
}

// ---------- 工具 ----------

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function statusName(status: number): string {
  return status === VIDEO_STATUS.REVIEWED ? "已通过" : status === VIDEO_STATUS.BANNED ? "已屏蔽" : "待审核";
}

/** 随机密码：排除 0/O/1/l/I 等易混字符 */
function randomPassword(len: number): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const buf = randomBytes(len);
  return Array.from(buf, (b) => chars[b % chars.length]).join("");
}
