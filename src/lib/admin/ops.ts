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
import { USER_ROLE, VIDEO_STATUS, isManager, NEWS_TYPE, countsInTotal } from "@/lib/config";
import { decodeLegacyEntities, formatDate } from "@/lib/format";
import { AVATAR_REVIEW_STATUS } from "@/lib/avatar";
import { publishNews } from "@/lib/news";
import { reviewVideo } from "@/lib/review";
import { banUntilFromKey, unbanUser } from "@/lib/ban";
import { broadcast, sendSystemMessage } from "@/lib/message";
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
  "bbs.setReplyStatus": "manager",
  "news.delete": "manager",
  "message.broadcast": "administrator",
  "rank.snapshot": "manager",
  // （star.set 每日一星指定已随功能于 2026-10-13 移除）
  "avatar.review": "manager",
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
      targetId: toId(params.id) ?? toId(params.userId) ?? 0,
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

      if (status === 0) {
        // 解封：连坐封禁的录像按 status_bak 精确恢复（2026-10-16 张老师拍板）
        const restored = await unbanUser(id);
        return {
          ok: true,
          message: `解封玩家 ${user.chineseName}（#${id}）${restored > 0 ? `，恢复连坐录像 ${restored} 部` : ""}`,
        };
      }

      // 封禁：时长（duration key，缺省永久）+ 可选连坐录像（banVideos）
      const duration = toText(p.duration ?? "0", 8) || "0";
      const banUntil = banUntilFromKey(duration);
      if (banUntil === null) return { ok: false, error: "参数错误：非法封禁时长" };
      const ts = BigInt(now());
      let bannedVideos = 0;
      if (toBool(p.banVideos)) {
        // 连坐：待审(10)/已通过(20) → 0，status_bak 记原值供解禁恢复；单独屏蔽(0) 的不动
        const r = await prisma.$executeRaw`
          UPDATE video SET status_bak = status, status = ${VIDEO_STATUS.BANNED}, update_time = ${ts}
          WHERE user = ${BigInt(id)} AND status IN (${VIDEO_STATUS.NORMAL}, ${VIDEO_STATUS.REVIEWED})`;
        bannedVideos = Number(r);
      }
      await prisma.user.update({
        where: { id: BigInt(id) },
        data: { status: -1, banUntil: BigInt(banUntil), updateTime: ts },
      });
      const durLabel = banUntil === 0 ? "永久" : `至 ${formatDate(banUntil, "Y-m-d H:i")}`;
      return {
        ok: true,
        message: `封禁玩家 ${user.chineseName}（#${id}），时长${durLabel}${bannedVideos > 0 ? `，同步封禁录像 ${bannedVideos} 部` : "，录像不动"}`,
      };
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
      // 只有没有任何录像和论坛主题的玩家才能注销（2026-10-13 张老师定）；有内容的请改用封禁
      const [videoCount, postCount] = await Promise.all([
        prisma.video.count({ where: { user: BigInt(id) } }),
        prisma.bbsPost.count({ where: { user: BigInt(id) } }),
      ]);
      if (videoCount > 0 || postCount > 0) {
        return {
          ok: false,
          error: `不能注销：该玩家已有 ${videoCount} 部录像、${postCount} 篇论坛主题；请改用「封禁账号」`,
        };
      }
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
      // pool 模式（2026-10-19 张老师需求）：ids=["all"] 时对「当前待审的全部免核定」执行——
      // 全选跨页：勾选框不再是本页 25 条，而是整个免核定池
      const poolAll = String(p.pool ?? "") === "exempt" && Array.isArray(p.ids) && p.ids.length === 1 && p.ids[0] === "all";
      if (!ids.length && !poolAll) return { ok: false, error: "请先勾选录像" };
      if (![VIDEO_STATUS.BANNED, VIDEO_STATUS.REVIEWED].includes(status as 0 | 20)) {
        return { ok: false, error: "批量只能「通过」或「屏蔽」" };
      }
      // 自动分拣闸门（2026-10-19 方案 v2）：需核定录像（auto_flag=0/2/-1）只能逐条手审，
      // 拒绝批量通过（批量屏蔽仍放行——下架不受限）。机器只分拣不审批，铁闸在服务端。
      let targetIds = ids;
      if (poolAll) {
        const rows = await prisma.video.findMany({
          where: { status: VIDEO_STATUS.NORMAL, autoFlag: 1 },
          select: { id: true },
          orderBy: { id: "asc" },
        });
        targetIds = rows.map((r) => Number(r.id));
        if (!targetIds.length) return { ok: false, error: "当前没有免核定录像" };
      } else if (status === VIDEO_STATUS.REVIEWED) {
        const flagged = await prisma.video.findMany({
          where: { id: { in: ids.map(BigInt) }, autoFlag: { not: 1 } },
          select: { id: true },
        });
        if (flagged.length) {
          const bad = flagged.map((f) => `#${Number(f.id)}`).join("、");
          return {
            ok: false,
            error: `以下 ${flagged.length} 条为「需核定」录像，只能逐条手审，不能批量通过：${bad}`,
          };
        }
      }
      let done = 0;
      const errors: string[] = [];
      for (const id of targetIds) {
        const r = await reviewVideo(actor.uid, actor.role, id, status);
        if (r.ok) done++;
        else errors.push(`#${id}: ${r.error}`);
      }
      if (!done) return { ok: false, error: errors[0] ?? "全部失败" };
      return {
        ok: true,
        message: `批量${statusName(status)} ${done}/${targetIds.length} 条${errors.length ? `（${errors.length} 条失败）` : ""}`,
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
      // 0 正常 / 5 AI 待审 / -1 删除（2026-10-13 引入待审，见 config.CONTENT_STATUS）
      if (status !== 0 && status !== 5 && status !== -1) {
        return { ok: false, error: "参数错误：状态只能为 0（正常）/ 5（待审）/ -1（删除）" };
      }
      const row = await prisma.comment.findUnique({ where: { id: BigInt(id) } });
      if (!row) return { ok: false, error: "评论不存在" };
      await prisma.$transaction(async (tx) => {
        await tx.comment.update({ where: { id: BigInt(id) }, data: { status, updateTime: BigInt(now()) } });
        // 同步录像评论计数：只有「正常」计入，待审与删除都不计入
        const delta = (countsInTotal(status) ? 1 : 0) - (countsInTotal(row.status) ? 1 : 0);
        if (delta) {
          await tx.videoStat.updateMany({
            where: { id: row.video },
            data: { comments: { increment: delta }, updateTime: BigInt(now()) },
          });
        }
      });
      return {
        ok: true,
        message: `${status === -1 ? "删除" : status === 5 ? "标记待审" : "通过"}评论 #${id}`,
      };
    }

    // ---------- 论坛 ----------
    case "bbs.setPost": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少主题 ID" };
      const data: Record<string, unknown> = { updateTime: BigInt(now()) };
      const changed: string[] = [];
      if ("isPinned" in p) { data.isPinned = toBool(p.isPinned); changed.push(`置顶=${toBool(p.isPinned) ? "是" : "否"}`); }
      if ("isTop" in p) {
        // 公告板块一律强制高亮（展示层判定）——后台也不允许对公告手动取消/设置高亮
        if (toBool(p.isTop) === false) {
          const cur = await prisma.bbsPost.findUnique({ where: { id: BigInt(id) }, select: { board: true } });
          if (cur?.board === 0) return { ok: false, error: "公告板块主题始终高亮，无需手动设置" };
        }
        data.isTop = toBool(p.isTop);
        changed.push(`高亮=${toBool(p.isTop) ? "是" : "否"}`);
      }
      if ("isNice" in p) { data.isNice = toBool(p.isNice); changed.push(`精华=${toBool(p.isNice) ? "是" : "否"}`); }
      if ("isLocked" in p) { data.isLocked = toBool(p.isLocked); changed.push(`锁定=${toBool(p.isLocked) ? "是" : "否"}`); }
      if ("board" in p) {
        const board = parseInt(String(p.board ?? ""), 10);
        if (![0, 1, 2, 3].includes(board)) return { ok: false, error: "参数错误：板块只能为 0-3" };
        data.board = board;
        changed.push(`板块=${board}`);
      }
      // 审核状态（2026-10-13）：0 通过 / 5 待审 / -1 删除；主题本身无冗余计数，故只改 status
      if ("status" in p) {
        const st = parseInt(String(p.status ?? ""), 10);
        if (st !== 0 && st !== 5 && st !== -1) {
          return { ok: false, error: "参数错误：状态只能为 0（正常）/ 5（待审）/ -1（删除）" };
        }
        data.status = st;
        changed.push(`状态=${st === 0 ? "通过" : st === 5 ? "待审" : "删除"}`);
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
      return { ok: true, message: `删除主题 #${id}「${decodeLegacyEntities(post.title)}」及其全部回复` };
    }

    case "bbs.deleteReply": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少回复 ID" };
      const reply = await prisma.bbsReply.findUnique({ where: { id: BigInt(id) } });
      if (!reply) return { ok: false, error: "回复不存在" };
      await prisma.$transaction(async (tx) => {
        await tx.bbsReply.update({ where: { id: BigInt(id) }, data: { status: -1, updateTime: BigInt(now()) } });
        // 只有「正常」态计入主题回复数；待审态此前已扣减过，这里不再扣
        if (countsInTotal(reply.status)) {
          await tx.bbsPost.update({
            where: { id: reply.post },
            data: { replies: { decrement: 1 }, updateTime: BigInt(now()) },
          });
        }
      });
      return { ok: true, message: `删除回复 #${id}` };
    }

    // 回复审核状态（2026-10-13）：0 通过 / 5 待审 / -1 删除，同步维护主题回复数
    case "bbs.setReplyStatus": {
      const id = toId(p.id);
      const status = parseInt(String(p.status ?? ""), 10);
      if (!id) return { ok: false, error: "参数错误：缺少回复 ID" };
      if (status !== 0 && status !== 5 && status !== -1) {
        return { ok: false, error: "参数错误：状态只能为 0（正常）/ 5（待审）/ -1（删除）" };
      }
      const reply = await prisma.bbsReply.findUnique({ where: { id: BigInt(id) } });
      if (!reply) return { ok: false, error: "回复不存在" };
      await prisma.$transaction(async (tx) => {
        await tx.bbsReply.update({ where: { id: BigInt(id) }, data: { status, updateTime: BigInt(now()) } });
        const delta = (countsInTotal(status) ? 1 : 0) - (countsInTotal(reply.status) ? 1 : 0);
        if (delta) {
          await tx.bbsPost.update({
            where: { id: reply.post },
            data: { replies: { increment: delta }, updateTime: BigInt(now()) },
          });
        }
      });
      return {
        ok: true,
        message: `${status === -1 ? "删除" : status === 5 ? "标记待审" : "通过"}回复 #${id}`,
      };
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

    // ---------- 头像审核（2026-09-24）----------
    // approve：把待审图写进 user.avatar 生效
    // reject ：标记驳回；**若这张图正在生效**（AI 自动放行过），一并回滚到上传前的头像
    case "avatar.review": {
      const id = toId(p.id);
      const action = String(p.action ?? "");
      if (!id) return { ok: false, error: "参数错误：缺少审核记录 ID" };
      if (action !== "approve" && action !== "reject") {
        return { ok: false, error: "参数错误：动作只能为 approve 或 reject" };
      }
      const row = await prisma.avatarReview.findUnique({ where: { id: BigInt(id) } });
      if (!row) return { ok: false, error: "审核记录不存在" };

      const target = await prisma.user.findUnique({
        where: { id: row.user },
        select: { chineseName: true, avatar: true },
      });
      const name = target?.chineseName ?? `#${row.user}`;
      // 只有「这张图当前正在对外展示」时才允许回滚，否则会把用户后来换上的新头像冲掉
      const isLive = !!target && target.avatar === row.filepath;
      const ts = BigInt(now());
      const reason = toText(p.reason, 100);

      if (action === "approve") {
        if (row.status === AVATAR_REVIEW_STATUS.APPROVED) {
          return { ok: false, error: "该头像已是通过状态" };
        }
        await prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: row.user },
            data: { avatar: row.filepath, updateTime: ts },
          });
          await tx.avatarReview.update({
            where: { id: row.id },
            data: {
              status: AVATAR_REVIEW_STATUS.APPROVED,
              reviewer: BigInt(actor.uid),
              reviewTime: ts,
              // AI 的初审说明保留在 reason 里会给用户看到，人工通过时清掉更干净
              reason: "管理员已通过",
            },
          });
          // 「更换头像」动态（与 AI 自动放行同口径，仅个人主页可见）
          await publishNews({ tx, type: NEWS_TYPE.AVATAR, userId: Number(row.user) });
        });
        await notifyAvatar(row.user, "你上传的头像已通过审核，已更新。");
        return { ok: true, message: `通过 ${name}（#${Number(row.user)}）的头像` };
      }

      // reject
      const revert = row.status === AVATAR_REVIEW_STATUS.APPROVED && isLive;
      const data = {
        status: AVATAR_REVIEW_STATUS.REJECTED,
        reviewer: BigInt(actor.uid),
        reviewTime: ts,
        reason: reason || "不符合头像要求",
      };
      await prisma.$transaction([
        ...(revert
          ? [
              prisma.user.update({
                where: { id: row.user },
                data: { avatar: row.prevAvatar, updateTime: ts },
              }),
            ]
          : []),
        prisma.avatarReview.update({ where: { id: row.id }, data }),
      ]);
      await notifyAvatar(
        row.user,
        `你上传的头像未通过审核（${data.reason}），请重新上传本人真实照片。`,
      );
      return {
        ok: true,
        message: `驳回 ${name}（#${Number(row.user)}）的头像${revert ? "，并已回滚到上一张" : ""}`,
      };
    }

    default:
      return { ok: false, error: `未实现的操作：${op}` };
  }
}

// ---------- 工具 ----------

function now(): number {
  return Math.floor(Date.now() / 1000);
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

/** 头像审核结果通知用户（站内信）。发信失败不阻断审核——结果已落库，不影响主流程。 */
async function notifyAvatar(userId: bigint, content: string): Promise<void> {
  try {
    await sendSystemMessage(Number(userId), content);
  } catch (e) {
    console.warn("[ops] 头像通知发送失败", e);
  }
}
