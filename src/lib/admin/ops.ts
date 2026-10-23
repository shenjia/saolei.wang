// 后台写操作统一入口（2026-09-24 管理后台）
//
// 所有管理端写操作都收敛到 runOp(op, params, actor, ip)：
// · 权限按 op 声明式校验（OP_LEVELS），不信任前端传参；
// · 参数逐个白名单校验 + 类型转换，非法值直接拒绝；
// · 每个 op 成功后写一条 admin_log（谁、对谁、做了什么）。
//
// 接口层只管 JSON 解析与错误码，业务规则全在这里。

import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
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
import { rankLeave, safeRankOp } from "@/lib/userrank";
import { setMaintenance } from "@/lib/maintenance";
import { generateApiKey, sha256, invalidateApiKeyCache } from "@/lib/partner";
import { logAdmin } from "./log";
import type { AdminLevel } from "./guard";

export type OpResult = { ok: true; message: string } | { ok: false; error: string };

/** 每个 op 的最低权限要求 */
export const OP_LEVELS: Record<string, AdminLevel> = {
  "user.setStatus": "administrator",
  "user.setRole": "administrator",
  "user.resetPassword": "administrator",
  "user.delete": "administrator",
  // 给单个玩家发系统消息（2026-10-23）：manager 可用——与头像审核通知同级触达能力；
  // 全站广播 message.broadcast 仍是超管专属
  "user.sendSystemMessage": "manager",
  "video.review": "manager",
  "video.batchReview": "manager",
  "video.markWatched": "manager",
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
  "site.setMaintenance": "administrator",
  // API key 管理（2026-10-24 公开 API 体系）：签发/吊销都是超管权限——
  // key 即数据出口凭据，签发对象需张老师把关
  "apikey.create": "administrator",
  "apikey.revoke": "administrator",
  "apikey.restore": "administrator",
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

/** 撤下 BBS 回复的评论动态（type=52，kind=bbs）——含无 cid 存量行退避（口径同 lib/bbs.ts commentNewsWhere） */
async function deleteReplyNews(tx: Prisma.TransactionClient, replyUser: bigint, postId: bigint, replyId: number) {
  await tx.news.deleteMany({
    where: {
      type: NEWS_TYPE.COMMENT,
      OR: [
        { user: replyUser, reference: postId, detailsData: { contains: `"cid":${replyId}}` } },
        { user: replyUser, reference: postId, detailsData: { contains: '"kind":"bbs"', not: { contains: '"cid"' } } },
      ],
    },
  });
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
      // 名次落盘（2026-10-22 张老师定）：上榜用户被封 → 出榜，位次在后者前移；
      // 失败不阻断封禁，读取侧自愈兜底（未上榜用户 leave 为 no-op）
      await safeRankOp(() => rankLeave(prisma, BigInt(id)), `ban leave #${id}`);
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

    case "video.markWatched": {
      // 后台播放器看过即标记（2026-10-19）：防盲审口径认 admin_watched；
      // 幂等，重复上报无副作用。仅待审录像需要（已审过的不影响）。
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少录像 ID" };
      const video = await prisma.video.findUnique({ where: { id: BigInt(id) }, select: { status: true } });
      if (!video) return { ok: false, error: "录像不存在" };
      if (video.status !== VIDEO_STATUS.NORMAL) return { ok: true, message: "已审过，无需标记" };
      const now = BigInt(Math.floor(Date.now() / 1000));
      await prisma.videoStat.update({
        where: { id: BigInt(id) },
        data: { adminWatched: 1, updateTime: now },
      });
      return { ok: true, message: `#${id} 已标记观看` };
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
      /* 免核定批量通过跳过防盲审（2026-10-19 张老师报：免核池一键过被 2013 版
         「必须先下载」卡死 73 条）——能走到这里的通过请求必为全免核定：
         poolAll 服务端只取 autoFlag=1；ids 模式非免核定已被上面闸门整体拒绝。
         批量屏蔽不跳过（下架是重动作，仍要求看过）。 */
      const skipWatch = status === VIDEO_STATUS.REVIEWED;
      for (const id of targetIds) {
        const r = await reviewVideo(actor.uid, actor.role, id, status, { skipWatchCheck: skipWatch });
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
        // 2026-10-22 张老师要求：评论删除（-1）动态一并撤下；
        // 恢复正常（→0）时若动态缺失则补发（AI 转待审时撤下过）——
        // 补发行带录像信息快照（lv/tm/nf/vn，同 addComment 写入口径；cid 尾置）
        if (status === -1) {
          await tx.news.deleteMany({
            where: {
              type: NEWS_TYPE.COMMENT,
              user: row.user,
              reference: row.video,
              detailsData: { contains: `"cid":${id}}` },
            },
          });
        } else if (status === 0 && row.status !== 0) {
          const exists = await tx.news.findFirst({
            where: {
              type: NEWS_TYPE.COMMENT,
              user: row.user,
              reference: row.video,
              detailsData: { contains: `"cid":${id}}` },
            },
            select: { id: true },
          });
          if (!exists) {
            // 事务内顺序查询（不能 Promise.all 并行 tx——P2028，同 addComment 修复）
            const video = await tx.video.findUnique({ where: { id: row.video }, select: { level: true, user: true } });
            const info = await tx.videoInfo.findUnique({ where: { id: row.video }, select: { noflag: true, realTime: true } });
            const ownerName =
              (await tx.user.findUnique({
                where: { id: video?.user ?? BigInt(0) },
                select: { chineseName: true },
              }))?.chineseName ?? "";
            // 补发动态：时间回填评论原发时间（不冒充当下）
            await publishNews({
              tx,
              type: NEWS_TYPE.COMMENT,
              userId: N(row.user),
              reference: N(row.video),
              details: {
                kind: "video",
                lv: video?.level ?? "",
                tm: N(info?.realTime ?? 0),
                nf: info?.noflag ? 1 : 0,
                vn: ownerName.slice(0, 20),
                vid: N(video?.user ?? 0),
                cid: id,
              },
              createTime: N(row.createTime),
              expTimeOverride: N(row.expTime),
            });
          }
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
      // 2026-10-23（张老师）：取消论坛高亮设定——isTop 不再接受写入（历史值仅留库备查）
      if ("isNice" in p) { data.isNice = toBool(p.isNice); changed.push(`精华=${toBool(p.isNice) ? "是" : "否"}`); }
      if ("isLocked" in p) { data.isLocked = toBool(p.isLocked); changed.push(`锁定=${toBool(p.isLocked) ? "是" : "否"}`); }
      if ("board" in p) {
        const board = parseInt(String(p.board ?? ""), 10);
        if (![0, 1, 2, 3].includes(board)) return { ok: false, error: "参数错误：板块只能为 0-3" };
        data.board = board;
        changed.push(`板块=${board}`);
      }
      // 审核状态（2026-10-13）：0 通过 / 5 待审 / -1 删除；主题本身无冗余计数，故只改 status
      let st = 0;
      if ("status" in p) {
        st = parseInt(String(p.status ?? ""), 10);
        if (st !== 0 && st !== 5 && st !== -1) {
          return { ok: false, error: "参数错误：状态只能为 0（正常）/ 5（待审）/ -1（删除）" };
        }
        data.status = st;
        changed.push(`状态=${st === 0 ? "通过" : st === 5 ? "待审" : "删除"}`);
      }
      if (!changed.length) return { ok: false, error: "没有需要修改的属性" };
      const before = await prisma.bbsPost.findUnique({ where: { id: BigInt(id) }, select: { status: true, user: true } });
      await prisma.$transaction(async (tx) => {
        await tx.bbsPost.update({ where: { id: BigInt(id) }, data });
        // 2026-10-22 张老师要求：主题状态流转联动动态——
        // 删（→-1）：撤楼主 ARTICLE 动态 + 全部楼层 bbs 评论动态（口径同 lib/bbs.ts deletePost）；
        // 恢复（→0）：补发 ARTICLE 动态（缺失时；时间回填主题原发时间）
        if ("status" in p && st !== before?.status) {
          if (st === -1) {
            await tx.news.deleteMany({
              where: { type: NEWS_TYPE.ARTICLE, user: before!.user, reference: BigInt(id) },
            });
            await tx.news.deleteMany({
              where: { type: NEWS_TYPE.COMMENT, reference: BigInt(id), detailsData: { contains: '"kind":"bbs"' } },
            });
          } else if (st === 0 && before?.status !== 0) {
            const exists = await tx.news.findFirst({
              where: { type: NEWS_TYPE.ARTICLE, user: before!.user, reference: BigInt(id) },
              select: { id: true },
            });
            if (!exists) {
              const full = await tx.bbsPost.findUnique({
                where: { id: BigInt(id) },
                select: { title: true, createTime: true },
              });
              if (full) {
                await publishNews({
                  tx,
                  type: NEWS_TYPE.ARTICLE,
                  userId: N(before!.user),
                  reference: id,
                  details: { t: full.title.slice(0, 50), cid: id },
                  createTime: N(full.createTime),
                  expTimeOverride: undefined,
                });
              }
            }
          }
        }
      });
      return { ok: true, message: `主题 #${id} ${changed.join("，")}` };
    }

    case "bbs.deletePost": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少主题 ID" };
      const post = await prisma.bbsPost.findUnique({ where: { id: BigInt(id) }, select: { title: true, user: true } });
      if (!post) return { ok: false, error: "主题不存在" };
      await prisma.$transaction([
        prisma.bbsPost.update({ where: { id: BigInt(id) }, data: { status: -1, updateTime: BigInt(now()) } }),
        prisma.bbsReply.updateMany({ where: { post: BigInt(id) }, data: { status: -1, updateTime: BigInt(now()) } }),
        // 2026-10-22 张老师要求：删帖联动撤动态（口径同 lib/bbs.ts deletePost）
        prisma.news.deleteMany({ where: { type: NEWS_TYPE.ARTICLE, user: post.user, reference: BigInt(id) } }),
        prisma.news.deleteMany({
          where: { type: NEWS_TYPE.COMMENT, reference: BigInt(id), detailsData: { contains: '"kind":"bbs"' } },
        }),
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
        // 2026-10-22 张老师要求：删回复联动撤评论动态（见 deleteReplyNews）
        await deleteReplyNews(tx, reply.user, reply.post, id);
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
        // 2026-10-22 张老师要求：回复状态流转联动动态——删除撤下；恢复正常补发（缺失时，
        // 时间回填回复原发时间；标题从主题行取，恢复 t 字段口径）
        // 自评自己文章的楼层不补发（口径同 createReply：楼主本人的评论动态本就不产生）
        if (status === -1) {
          await deleteReplyNews(tx, reply.user, reply.post, id);
        } else if (status === 0 && reply.status !== 0) {
          const post = await tx.bbsPost.findUnique({
            where: { id: reply.post },
            select: { title: true, user: true },
          });
          const isSelfReply = post ? N(post.user) === N(reply.user) : false;
          if (!isSelfReply) {
            const exists = await tx.news.findFirst({
              where: {
                type: NEWS_TYPE.COMMENT,
                user: reply.user,
                reference: reply.post,
                detailsData: { contains: `"cid":${id}}` },
              },
              select: { id: true },
            });
            if (!exists) {
              await publishNews({
                tx,
                type: NEWS_TYPE.COMMENT,
                userId: N(reply.user),
                reference: N(reply.post),
                details: { kind: "bbs", t: (post?.title ?? "").slice(0, 50), cid: id },
                createTime: N(reply.createTime),
                expTimeOverride: N(reply.expTime),
              });
            }
          }
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
    case "user.sendSystemMessage": {
      // 给单个玩家发系统通知（2026-10-23 张老师需求）：后台用户详情页入口，
      // is_system=1 无真实寄件人，收件人以「系统消息」呈现
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少玩家 ID" };
      const content = toText(p.content, 200);
      if (!content) return { ok: false, error: "请填写消息内容" };
      const user = await prisma.user.findUnique({
        where: { id: BigInt(id) },
        select: { chineseName: true },
      });
      if (!user) return { ok: false, error: "玩家不存在" };
      await sendSystemMessage(id, content);
      return {
        ok: true,
        message: `已向 ${user.chineseName}（#${id}）发送系统消息：「${content.slice(0, 30)}${content.length > 30 ? "…" : ""}」`,
      };
    }

    case "message.broadcast": {
      const content = toText(p.content, 200);
      if (!content) return { ok: false, error: "请填写广播内容" };
      const sent = await broadcast(actor.uid, content);
      return { ok: true, message: `已向 ${sent} 名玩家广播：「${content.slice(0, 30)}${content.length > 30 ? "…" : ""}」` };
    }

    // ---------- 排行 / 荣誉 ----------
    case "rank.snapshot": {
      // 2026-10-22 JSON 重构：force 重算当日名次并重写 delta（每人一行，ranks 滚动 31 天）
      await ensureTodaySnapshot(true);
      const c = await prisma.rankSnapshot.count();
      return { ok: true, message: `已重算排行快照（库内 ${c} 名玩家，30 天窗口名次已刷新）` };
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

    // ---------- 站点开关 ----------
    case "site.setMaintenance": {
      const on = toBool(p.on);
      await setMaintenance(on);
      return { ok: true, message: on ? "维护模式已开启：注册/上传/发帖/评论/私信已停" : "维护模式已关闭，站点恢复正常" };
    }

    // ---------- 公开 API key（2026-10-24） ----------
    case "apikey.create": {
      const name = toText(p.name, 50);
      const note = toText(p.note, 200);
      if (!name) return { ok: false, error: "参数错误：需提供合作方名称" };
      const dup = await prisma.apiKey.findFirst({ where: { name } });
      if (dup) return { ok: false, error: `已存在同名合作方「${name}」（#${dup.id}），请换名或复用原 key` };
      const key = generateApiKey();
      const ts = BigInt(now());
      const row = await prisma.apiKey.create({
        data: { name, note, keyHash: sha256(key), status: 1, createTime: ts, updateTime: ts },
      });
      invalidateApiKeyCache();
      // 明文 key 只在 message 里出现这一次（admin_log 会留档这条 message；
      // 与「重置密码回显」同款先例——后台本身是超管可见面，可接受）
      return { ok: true, message: `已为「${name}」签发 API key（#${row.id}）：${key} —— 请立即复制保存，明文不再显示` };
    }

    case "apikey.revoke": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少 key ID" };
      const row = await prisma.apiKey.findUnique({ where: { id: BigInt(id) } });
      if (!row) return { ok: false, error: "key 不存在" };
      if (row.status === 0) return { ok: false, error: "该 key 已是吊销状态" };
      await prisma.apiKey.update({
        where: { id: BigInt(id) },
        data: { status: 0, updateTime: BigInt(now()) },
      });
      invalidateApiKeyCache();
      return { ok: true, message: `已吊销「${row.name}」的 API key（#${id}），最迟 30 秒内生效` };
    }

    case "apikey.restore": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少 key ID" };
      const row = await prisma.apiKey.findUnique({ where: { id: BigInt(id) } });
      if (!row) return { ok: false, error: "key 不存在" };
      if (row.status === 1) return { ok: false, error: "该 key 已是启用状态" };
      await prisma.apiKey.update({
        where: { id: BigInt(id) },
        data: { status: 1, updateTime: BigInt(now()) },
      });
      invalidateApiKeyCache();
      return { ok: true, message: `已恢复「${row.name}」的 API key（#${id}）` };
    }

    default:
      return { ok: false, error: `未实现的操作：${op}` };
  }
}

// ---------- 工具 ----------

function now(): number {
  return Math.floor(Date.now() / 1000);
}

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

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
