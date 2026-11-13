// 后台写操作统一入口（2026-09-24 管理后台）
//
// 所有管理端写操作都收敛到 runOp(op, params, actor, ip)：
// · 权限按 op 声明式校验（OP_LEVELS），不信任前端传参；
// · 参数逐个白名单校验 + 类型转换，非法值直接拒绝；
// · 每个 op 成功后写一条 admin_log（谁、对谁、做了什么）。
//
// 接口层只管 JSON 解析与错误码，业务规则全在这里。

import { randomBytes } from "crypto";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import type { SessionUser } from "@/lib/auth";
import { USER_ROLE, VIDEO_STATUS, VIDEO_LEVELS, isManager, NEWS_TYPE, countsInTotal, RANK_BAN_DURATIONS, RANK_BAN_PERMANENT, AREA_LIST } from "@/lib/config";
import { decodeLegacyEntities, formatDate } from "@/lib/format";
import { CHINESE_NAME_RE, ENGLISH_NAME_RE } from "@/lib/register";
import { AVATAR_REVIEW_STATUS } from "@/lib/avatar";
import { generateAvatarSizes } from "@/lib/small-avatar-gen";
import { publishNews } from "@/lib/news";
import { reviewVideo, syncRecordNewsChain } from "@/lib/review";
import { banUntilFromKey, unbanUser } from "@/lib/ban";
import { broadcast, sendSystemMessage, retractReplyNotice, retractPostNotices, retractVideoCommentNotice } from "@/lib/message";
import { ensureTodaySnapshot } from "@/lib/ranksnap";
import { rankEnter, rankLeave, safeRankOp, applyRankAreaChange } from "@/lib/userrank";
import { refreshUserStnb, refreshUserStnbNf } from "@/lib/userstnb";
import { setMaintenance } from "@/lib/maintenance";
import { normalizeSiteUpdateDate } from "@/lib/site-updates";
import { genUniqueCompCode, addCompEvent, COMP_EVENT_JOIN_OPEN, COMP_EVENT_SCORE } from "@/lib/competition";

/** 收录录像级别参数解析（张老师 2026-11-13：可多选，默认初中高都有）。
 *  接受数组或逗号分隔串；非法键剔除，全空回退全级别。返回落库串（逗号分隔） */
function parseIncludeLevels(v: unknown): string {
  const VALID = ["beg", "int", "exp"];
  const raw = Array.isArray(v) ? v.map(String) : String(v ?? "").split(",");
  const picked = VALID.filter((k) => raw.map((s) => s.trim()).includes(k));
  return (picked.length ? picked : VALID).join(",");
}

/** 成绩计算方式落库校验（张老师 2026-11-13 四期）：返回 [mode, configJSON] 或 null=非法。
 *  sum_topn={"beg":n,"int":n,"exp":n}（n 0-99，至少一个>0）；target_diff={"target":秒>0}；
 *  mode=""（未配置）合法。 */
function parseScoreConf(
  v: unknown
): { mode: string; config: string } | { error: string } | null {
  const p = (v ?? {}) as Record<string, unknown>;
  const mode = String(p.scoreMode ?? "");
  const raw = p.scoreConfig;
  if (!mode) return { mode: "", config: "" };
  if (mode === "sum_topn") {
    const o = (raw ?? {}) as Record<string, unknown>;
    const conf: Record<string, number> = {};
    let any = false;
    for (const lv of ["beg", "int", "exp"]) {
      const n = Number(o[lv]);
      if (!Number.isInteger(n) || n < 0 || n > 99) return { error: "取局数应为 0-99 整数" };
      conf[lv] = n;
      if (n > 0) any = true;
    }
    if (!any) return { error: "成绩加总至少有一个级别取局数大于 0" };
    return { mode, config: JSON.stringify(conf) };
  }
  if (mode === "target_diff") {
    const t = Number((raw as Record<string, unknown>)?.target);
    if (!Number.isFinite(t) || t <= 0) return { error: "目标成绩应为正数（秒）" };
    return { mode, config: JSON.stringify({ target: t }) };
  }
  return { error: "未知的成绩计算方式" };
}
import { generateApiKey, sha256, invalidateApiKeyCache } from "@/lib/partner";
import { loadBlockedHistoryOf, lowTrustState } from "@/lib/lowtrust";
import { CHEAT_CONFIRM_NOTICE, CHEAT_DISMISS_NOTICE } from "@/lib/cheat-notice";
import { logAdmin } from "./log";
import type { AdminLevel } from "./guard";

// logDetail：落 admin_log 的说明与回显 message 不同时给（如签发 key / 重置密码——
// 日志页管理员（role≥10）可见，明文凭据只能出现在签发/操作人的响应里，不进日志）
export type OpResult = { ok: true; message: string; logDetail?: string; done?: number } | { ok: false; error: string };

/** 每个 op 的最低权限要求 */
export const OP_LEVELS: Record<string, AdminLevel> = {
  "user.setStatus": "administrator",
  "user.setRole": "administrator",
  "user.resetPassword": "administrator",
  "user.delete": "administrator",
  // 账户合并（2026-11-01 张老师需求）：全数据并入目标账户后注销源账户；不可逆重操作，超管专属
  "user.merge": "administrator",
  // 可信用户组（2026-10-24）：组内用户录像分拣不检查 STNB 触发器；超管把关
  "user.setTrusted": "administrator",
  "user.clearCheatPenalty": "administrator",
  "user.setLowTrust": "administrator",
  "cheat.confirm": "administrator",
  "cheat.dismiss": "administrator",
  "user.setRankBan": "administrator",
  // 编辑玩家资料（2026-11-02 张老师需求）：处置面板可改玩家填写的资料（中文名/英文名等），超管专属
  "user.editProfile": "administrator",
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
  // 赞助登记（2026-10-30）：收款线下到账后手动记账，管理员即可；删除笔误记录同权
  "donate.add": "manager",
  "donate.delete": "manager",
  // 编辑赞助（2026-10-30 张老师：防备写错日期/金额/人名，两边的记录都要能改）
  "donate.edit": "manager",
  // 支出登记（2026-10-30 收支管理）：用途+金额+凭据图（图先传 /api/admin/expense-evidence 拿 URL）
  "expense.add": "manager",
  "expense.delete": "manager",
  "expense.edit": "manager",
  // 更新历史维护（2026-11-02 /page/history 落库）：管理员即可增删改
  "siteupdate.add": "manager",
  "siteupdate.edit": "manager",
  "siteupdate.delete": "manager",
  // 比赛管理（2026-11-13 张老师需求：前台「比赛」页数据源）：发起/编辑/删除均管理员即可
  "competition.add": "manager",
  "competition.edit": "manager",
  "competition.delete": "manager",
  // 比赛批量收录像（2026-11-13 三期：清单行「收录像」弹窗输入多个录像 ID 一次性挂接）
  "competition.addVideos": "manager",
  // 录像挂接比赛（2026-11-13 二期：录像管理手动将录像加入比赛）
  "video.competition": "manager",
  "site.setMaintenance": "administrator",
  // API key 管理（2026-10-24 公开 API 体系）：签发/吊销都是超管权限——
  // key 即数据出口凭据，签发对象需张老师把关
  "apikey.create": "administrator",
  "apikey.revoke": "administrator",
  "apikey.restore": "administrator",
  "apikey.setRateLimit": "administrator",
};

// ---------- 参数工具 ----------

const toId = (v: unknown): number | null => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const toBool = (v: unknown): boolean => v === true || v === "1" || v === 1 || v === "true";
const toText = (v: unknown, max: number): string => String(v ?? "").trim().slice(0, max);

/** 「YYYY-MM-DD HH:mm」按北京时间解析为 Unix 秒（比赛起止时间用）；非法返回 null */
const resolveCstMinute = (raw: unknown): number | null => {
  const s = String(raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s.replace(" ", "T")}:00+08:00`);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
};

/** 登记日期 → 落库时间（2026-10-30 张老师：赞助/支出登记可选日期，默认今天）。
 *  不传或传今天 = 沿用当前时刻；历史日期 = 该日北京时间 12:00（前台按 Y-m-d 展示，
 *  正午保证同日多笔排序稳定）；拒绝未来日期与非法格式。 */
const resolveRegTime = (raw: unknown): { t: bigint } | { error: string } => {
  const s = String(raw ?? "").trim();
  const todayCst = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  if (!s || s === todayCst) return { t: BigInt(now()) };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T12:00:00+08:00`))) {
    return { error: "参数错误：日期格式应为 YYYY-MM-DD" };
  }
  const sec = Math.floor(Date.parse(`${s}T12:00:00+08:00`) / 1000);
  if (sec > Math.floor(Date.now() / 1000)) return { error: "参数错误：日期不能超过今天" };
  return { t: BigInt(sec) };
};

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
      // 日志留档脱敏版（2026-10-27）：有 logDetail 用 logDetail，防明文凭据落日志页
      detail: res.logDetail ?? res.message,
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

    case "user.setTrusted": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少玩家 ID" };
      const trusted = toBool(p.trusted);
      const user = await prisma.user.findUnique({ where: { id: BigInt(id) }, select: { chineseName: true, trusted: true } });
      if (!user) return { ok: false, error: "玩家不存在" };
      if (user.trusted === trusted) {
        return { ok: false, error: trusted ? "该玩家已在可信用户组" : "该玩家本就不在可信用户组" };
      }
      await prisma.user.update({ where: { id: BigInt(id) }, data: { trusted } });
      // 联动重分拣该用户全部待审录像（量小，逐盘跑同一 triageVideo 口径）：
      // 加入 → 清掉仅 STNB 命中的标记；移出 → 补回 STNB 检查，池子即时对齐新口径
      const pending = await prisma.video.findMany({ where: { user: BigInt(id), status: VIDEO_STATUS.NORMAL }, select: { id: true } });
      const { triageVideo } = await import("@/lib/video-triage");
      for (const { id: vid } of pending) await triageVideo(Number(vid));
      return {
        ok: true,
        message: `${user.chineseName}（#${id}）已${trusted ? "加入" : "移出"}可信用户组${pending.length ? `，已重分拣其待审录像 ${pending.length} 部` : ""}`,
      };
    }

    case "user.clearCheatPenalty": {
      /* 移出低信任用户组（2026-10-27 张老师定，列表与详情页共用同一 op）：
         ① 清 rank_ban_until（练习页排名模式禁用）+ low_trust_until（反作弊标记）；
         ② 记 low_trust_exempt = 本次时刻（屏蔽史豁免：早于此刻的屏蔽录像不再作为入组依据，
            之后再有录像被屏蔽时弹窗选择「加入」才会重新入组）；
         ③ 可选 restoreBlocked：同时把名下独立屏蔽的录像恢复为「通过」（成绩回榜、参与排名），
            封禁连坐（status_bak≠0）的不动——那些由解禁流程负责恢复；
         ④ 重分拣其待审录像（低信任硬规则解除后可回免核定池） */
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少玩家 ID" };
      const restoreBlocked = toBool(p.restoreBlocked);
      const user = await prisma.user.findUnique({
        where: { id: BigInt(id) },
        select: { chineseName: true, rankBanUntil: true, lowTrustUntil: true, lowTrustExempt: true },
      });
      if (!user) return { ok: false, error: "玩家不存在" };
      const t = now();
      const blockedHistory = await loadBlockedHistoryOf(id);
      const state = lowTrustState(user, blockedHistory, t);
      const rankBanned = Number(user.rankBanUntil) > t;
      if (!state.member && !rankBanned) {
        return { ok: false, error: "该玩家不在低信任用户组（无生效标记、无未豁免的屏蔽史）" };
      }

      await prisma.user.update({
        where: { id: BigInt(id) },
        data: { rankBanUntil: BigInt(0), lowTrustUntil: BigInt(0), lowTrustExempt: BigInt(t) },
      });

      // 同时解除屏蔽（可选）：只处理独立屏蔽的录像，封禁连坐交给解禁流程
      let restored = 0;
      if (restoreBlocked) {
        const blocked = await prisma.video.findMany({
          where: { user: BigInt(id), status: VIDEO_STATUS.BANNED, statusBak: 0 },
          select: { id: true },
          orderBy: { id: "asc" },
        });
        for (const v of blocked) {
          // 已在处置面板人工确认过，跳过「先看后审」闸（那条闸防的是批量盲过免核定池）
          const r = await reviewVideo(actor.uid, actor.role, Number(v.id), VIDEO_STATUS.REVIEWED, {
            skipWatchCheck: true,
          });
          if (r.ok) restored += 1;
        }
      }

      const pending = await prisma.video.findMany({ where: { user: BigInt(id), status: VIDEO_STATUS.NORMAL }, select: { id: true } });
      const { triageVideo } = await import("@/lib/video-triage");
      for (const { id: vid } of pending) await triageVideo(Number(vid));

      const parts = ["已移出低信任用户组", "排名模式已恢复"];
      if (restored) parts.push(`已恢复被屏蔽录像 ${restored} 部`);
      if (state.blockedCount > 0 && !restored) parts.push(`名下 ${state.blockedCount} 部屏蔽录像保持屏蔽`);
      return { ok: true, message: `${user.chineseName}（#${id}）${parts.join("，")}` };
    }

    case "cheat.confirm": {
      /* 作弊核实（2026-10-27 张老师定）：探测命中只禁排名；管理员核实后
         在此转低信任（7 天：上传限 5/日 + 全量人工审），rank_ban 同步改为
         7 天（核实即实锤，从复核时刻重计——不复用命中期的 24h，两档时长
         必须在写库与玩家可见文案上一致） */
      const id = toId(p.reportId);
      if (!id) return { ok: false, error: "参数错误：缺少上报 ID" };
      const report = await prisma.cheatReport.findUnique({ where: { id: BigInt(id) } });
      if (!report) return { ok: false, error: "上报记录不存在" };
      const user = await prisma.user.findUnique({
        where: { id: report.user },
        select: { chineseName: true },
      });
      const t = now();
      // 核实成立＝封 7 天：低信任与排名禁用同一窗口（2026-10-27 张老师定）
      const BAN_SEC = 7 * 24 * 3600;
      await prisma.user.update({
        where: { id: report.user },
        data: {
          rankBanUntil: BigInt(t + BAN_SEC),
          lowTrustUntil: BigInt(t + BAN_SEC),
        },
      });
      await prisma.cheatReport.update({
        where: { id: BigInt(id) },
        data: { resolved: 1, resolver: BigInt(actor.uid), resolvedTime: BigInt(t) },
      });
      /* 系统消息（2026-10-27 张老师定：恢复发送）——核实成立要给玩家一个明确
         结论，文案与复核页按钮气泡「发送：xxxx」共用 CHEAT_CONFIRM_NOTICE 常量，
         保证看到的和收到的逐字一致。失败不阻断处置 */
      try {
        await sendSystemMessage(Number(report.user), CHEAT_CONFIRM_NOTICE);
      } catch { /* 消息失败不阻断 */ }
      const pending = await prisma.video.findMany({ where: { user: report.user, status: VIDEO_STATUS.NORMAL }, select: { id: true } });
      const { triageVideo } = await import("@/lib/video-triage");
      for (const { id: vid } of pending) await triageVideo(Number(vid));
      return {
        ok: true,
        message: `已确认「${user?.chineseName ?? report.user}」作弊：转低信任用户组（7 天限流+全量人工审），排名模式禁用 7 天，已发系统消息告知${pending.length ? `，重分拣待审录像 ${pending.length} 部` : ""}`,
      };
    }

    case "cheat.dismiss": {
      /* 误报解除（2026-10-27）：核实为误报（扩展类等）——清除排名禁用，
         上报标记已复核；低信任不受影响（本就未自动转入） */
      const id = toId(p.reportId);
      if (!id) return { ok: false, error: "参数错误：缺少上报 ID" };
      const report = await prisma.cheatReport.findUnique({ where: { id: BigInt(id) } });
      if (!report) return { ok: false, error: "上报记录不存在" };
      const user = await prisma.user.findUnique({
        where: { id: report.user },
        select: { chineseName: true },
      });
      const t = now();
      /* 误报＝完全恢复（2026-10-27 张老师定）：排名禁用 + 低信任标记一并清除
         （低信任虽不自动转入，但可能经其它路径存在——统一清零兜底），并发
         系统消息告知玩家已恢复 */
      await prisma.user.update({
        where: { id: report.user },
        data: { rankBanUntil: BigInt(0), lowTrustUntil: BigInt(0) },
      });
      await prisma.cheatReport.update({
        where: { id: BigInt(id) },
        data: { resolved: 2, resolver: BigInt(actor.uid), resolvedTime: BigInt(t) },
      });
      try {
        await sendSystemMessage(Number(report.user), CHEAT_DISMISS_NOTICE);
      } catch { /* 消息失败不阻断 */ }
      const pending = await prisma.video.findMany({ where: { user: report.user, status: VIDEO_STATUS.NORMAL }, select: { id: true } });
      const { triageVideo } = await import("@/lib/video-triage");
      for (const { id: vid } of pending) await triageVideo(Number(vid));
      return {
        ok: true,
        message: `已判定「${user?.chineseName ?? report.user}」为误报：排名模式禁用与低信任标记均已解除，已发系统消息告知${pending.length ? `，重分拣待审录像 ${pending.length} 部` : ""}`,
      };
    }

    case "user.setRankBan": {
      /* 排名模式开关（2026-10-27 张老师定；2026-10-29 时长可选）：账号处置面板直接管理——
         on=禁用（四档时长：24小时/7天/一个月/永久，缺省 24h 与探测命中同款），
         off=手动解禁；不动低信任。永久用远期哨兵 RANK_BAN_PERMANENT（0=未禁用） */
      const id = toId(p.id);
      const on = p.on === 1 || p.on === true;
      if (!id) return { ok: false, error: "参数错误：缺少玩家 ID" };
      const user = await prisma.user.findUnique({
        where: { id: BigInt(id) },
        select: { chineseName: true, rankBanUntil: true },
      });
      if (!user) return { ok: false, error: "玩家不存在" };
      const t = now();
      if (on) {
        const key = toText(p.duration ?? "24h", 8) || "24h";
        const opt = RANK_BAN_DURATIONS.find(([k]) => k === key);
        if (!opt) return { ok: false, error: "参数错误：非法禁用时长" };
        const [, label, sec] = opt;
        const until = sec > 0 ? t + sec : RANK_BAN_PERMANENT;
        await prisma.user.update({ where: { id: BigInt(id) }, data: { rankBanUntil: BigInt(until) } });
        return { ok: true, message: `${user.chineseName}（#${id}）排名模式已禁用（${label}）` };
      }
      if (Number(user.rankBanUntil) <= t) {
        return { ok: false, error: "该玩家排名模式未被禁用" };
      }
      await prisma.user.update({ where: { id: BigInt(id) }, data: { rankBanUntil: BigInt(0) } });
      return { ok: true, message: `${user.chineseName}（#${id}）排名模式已解禁` };
    }

    case "user.setLowTrust": {
      /* 手动加入低信任组（2026-10-27 张老师定）：封 7 天——低信任（上传限 5/日 + 全量
         人工审核）与排名禁用同一 7 天窗口，与 cheat.confirm 核实口径保持一致 */
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少玩家 ID" };
      const user = await prisma.user.findUnique({
        where: { id: BigInt(id) },
        select: { chineseName: true, lowTrustUntil: true },
      });
      if (!user) return { ok: false, error: "玩家不存在" };
      const t = now();
      if (Number(user.lowTrustUntil) > t) {
        return { ok: false, error: "该玩家已在低信任用户组（标记生效中）" };
      }
      const BAN_SEC = 7 * 24 * 3600;
      await prisma.user.update({
        where: { id: BigInt(id) },
        data: { lowTrustUntil: BigInt(t + BAN_SEC), rankBanUntil: BigInt(t + BAN_SEC) },
      });
      try {
        await sendSystemMessage(id, "经系统检测，您在排行模式中存在作弊行为，已将您移入低信任用户组（7 天内上传录像每日限 5 部且需人工审核），排行模式禁用 7 天。如有异议请联系管理员。");
      } catch { /* 消息失败不阻断 */ }
      const pending = await prisma.video.findMany({ where: { user: BigInt(id), status: VIDEO_STATUS.NORMAL }, select: { id: true } });
      const { triageVideo } = await import("@/lib/video-triage");
      for (const { id: vid } of pending) await triageVideo(Number(vid));
      return {
        ok: true,
        message: `${user.chineseName}（#${id}）已加入低信任用户组，排行模式已禁用，已发系统消息告知`,
      };
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
      // 明文密码只回显给操作人（气泡提示）；日志只留事实，不落明文（2026-10-27 修复）
      return {
        ok: true,
        message: `重置 ${auth.username}（#${id}）密码为：${password}`,
        logDetail: `重置 ${auth.username}（#${id}）的密码`,
      };
    }

    case "user.editProfile": {
      /* 编辑玩家资料（2026-11-02 张老师需求）：后台处置面板可修改玩家填写的全部资料——
         中文名/英文名/性别/地区（user 表）+ 昵称/QQ/鼠标/鼠标垫/爱好/生日（user_info 表）。
         校验口径：姓名与注册同规（2~6 汉字 + 拼音格式/词数），文本字段长度与前台
         「编辑资料」同限，地区白名单同 /api/account/profile（历史遗留值视为不改）。
         地区变化时 user 与 user_rank 同事务搬位（applyRankAreaChange，口径同前台）；
         变更摘要只列有变化的字段，全部一致则不刷库不落日志。 */
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少玩家 ID" };
      const [user, info] = await Promise.all([
        prisma.user.findUnique({ where: { id: BigInt(id) } }),
        prisma.userInfo.findUnique({ where: { id: BigInt(id) } }),
      ]);
      if (!user) return { ok: false, error: "玩家不存在" };

      // 中文名/英文名：与注册同一套规则
      const chineseName = toText(p.chineseName, 12);
      const englishName = toText(p.englishName, 32);
      if (!CHINESE_NAME_RE.test(chineseName))
        return { ok: false, error: "参数错误：中文姓名不合法（2~6 个汉字）" };
      if (!ENGLISH_NAME_RE.test(englishName))
        return { ok: false, error: "参数错误：姓名拼音格式不合法（每词首字母大写，如 Chen Yi Ning）" };
      if (englishName.trim().split(/\s+/).length !== [...chineseName].length)
        return { ok: false, error: "参数错误：拼音词数与姓名字数不一致" };

      const sex = parseInt(String(p.sex ?? ""), 10);
      if (sex !== 0 && sex !== 1) return { ok: false, error: "参数错误：性别不合法" };

      // 地区：白名单内才可写；不在白名单但等于库中现值（历史遗留「xx&xx」）视为不修改
      const areaRaw = toText(p.area, 12);
      const areaLegal = (AREA_LIST as readonly string[]).includes(areaRaw);
      if (!areaLegal && areaRaw !== user.area) return { ok: false, error: "参数错误：地区不合法" };

      // user_info 文本字段：上限与前台「编辑资料」同口径
      const profileLimits = { nickname: 10, qq: 15, mouse: 30, pad: 30, interest: 50 } as const;
      const profileLabels = { nickname: "昵称", qq: "QQ", mouse: "鼠标", pad: "鼠标垫", interest: "爱好" };
      const profile: Record<string, string> = {};
      for (const [key, limit] of Object.entries(profileLimits)) {
        const v = toText(p[key], limit + 10);
        if ([...v].length > limit)
          return { ok: false, error: `参数错误：${profileLabels[key as keyof typeof profileLimits]} 不能超过 ${limit} 个字` };
        profile[key] = v;
      }

      // 生日：留空=不修改；填写须为合法且不晚于今天的日期
      let birthday: bigint | undefined;
      const birthdayRaw = toText(p.birthday, 10);
      if (birthdayRaw) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdayRaw))
          return { ok: false, error: "参数错误：生日格式应为 YYYY-MM-DD" };
        const d = new Date(`${birthdayRaw}T12:00:00+08:00`);
        if (Number.isNaN(d.getTime()) || d.getFullYear() !== parseInt(birthdayRaw.slice(0, 4), 10))
          return { ok: false, error: "参数错误：生日不是有效日期" };
        if (d.getTime() > Date.now()) return { ok: false, error: "参数错误：生日不能是将来的日期" };
        birthday = BigInt(Math.floor(d.getTime() / 1000));
      }

      // 变更摘要：只列有变化的字段；全部一致则不刷库不落日志
      const changes: string[] = [];
      const diff = (name: string, prev: string | number, next: string | number) => {
        if (String(prev) !== String(next)) changes.push(`${name}「${prev || "空"}」→「${next || "空"}」`);
      };
      diff("中文名", user.chineseName, chineseName);
      diff("英文名", user.englishName, englishName);
      diff("性别", user.sex ? "男" : "女", sex ? "男" : "女");
      diff("地区", user.area, areaRaw);
      diff("昵称", info?.nickname ?? "", profile.nickname);
      diff("QQ", info?.qq ?? "", profile.qq);
      diff("鼠标", info?.mouse ?? "", profile.mouse);
      diff("鼠标垫", info?.pad ?? "", profile.pad);
      diff("爱好", info?.interest ?? "", profile.interest);
      const prevBirthday = info?.birthday ?? BigInt(0);
      if (birthday !== undefined) {
        if (birthday === prevBirthday) birthday = undefined;
        else
          changes.push(
            `生日「${prevBirthday ? formatDate(Number(prevBirthday), "Y-m-d") : "空"}」→「${formatDate(Number(birthday), "Y-m-d")}」`
          );
      }
      if (!changes.length) return { ok: false, error: "提交内容与当前资料一致，无需保存" };

      const ts = BigInt(now());
      const areaChanged = areaLegal && areaRaw !== user.area;
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: BigInt(id) },
          data: {
            chineseName,
            englishName,
            sex,
            ...(areaChanged ? { area: areaRaw } : {}),
            updateTime: ts,
          },
        });
        await tx.userInfo.upsert({
          where: { id: BigInt(id) },
          create: {
            id: BigInt(id),
            nickname: profile.nickname,
            qq: profile.qq,
            mouse: profile.mouse,
            pad: profile.pad,
            interest: profile.interest,
            ...(birthday !== undefined ? { birthday } : {}),
            createTime: ts,
            updateTime: ts,
          },
          update: {
            nickname: profile.nickname,
            qq: profile.qq,
            mouse: profile.mouse,
            pad: profile.pad,
            interest: profile.interest,
            ...(birthday !== undefined ? { birthday } : {}),
            updateTime: ts,
          },
        });
        // 地区变化：user_rank 同事务搬位（名次落盘的 area/area_pos 跟着走，口径同前台改资料）
        if (areaChanged) await applyRankAreaChange(tx, id, user.area, areaRaw);
      });
      return { ok: true, message: `已更新 ${chineseName}（#${id}）的资料：${changes.join("、")}` };
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
      // 仅注销登录凭据（保留 user/成绩/录像，避免破坏排行与历史引用），并封禁；
      // 录像标识一并释放（2026-11-05 张老师要求）：user_sig.signature 唯一索引管归属，
      // 删掉后该标识文字即可被其他玩家重新注册
      const sigCount = await prisma.userSig.count({ where: { user: BigInt(id) } });
      await prisma.$transaction([
        prisma.userAuth.delete({ where: { id: BigInt(id) } }),
        prisma.user.update({ where: { id: BigInt(id) }, data: { status: -1, updateTime: BigInt(now()) } }),
        prisma.userOauth.deleteMany({ where: { userId: BigInt(id) } }),
        prisma.passwordToken.deleteMany({ where: { user: BigInt(id) } }),
        prisma.userSig.deleteMany({ where: { user: BigInt(id) } }),
      ]);
      return {
        ok: true,
        message: `注销账号 ${auth.username}（#${id}），账号数据保留、无法再登录；释放录像标识 ${sigCount} 条`,
      };
    }

    case "user.merge": {
      /* 账户合并（2026-11-01 张老师需求）：把源账户的全部数据并入目标账户，然后注销源账户。
         搬迁范围：录像（含 video_scores_* 六池成绩）、评论、论坛主题/回复、动态、
         站内信（收发双方）、赞助记录、每日一星及感言投票、扫雷历程、地盘人气、bbs 最后回复人指位、
         邮箱绑定（目标未绑时随迁；源未绑邮箱但登录名本身是邮箱时，随迁为未验证草稿——
         2026-11-09 张老师明确口径，35627→12699 实证：登录名邮箱不随迁会凭空丢失）、
         第三方绑定（按 provider 逐类随迁；目标已绑同类型则该类不迁，源行按注销口径删除）。
         可选步骤（弹窗勾选，默认不选）：登录凭据同步——勾选后目标账户改用源账户的
         登录名/密码/邮箱绑定登录（2026-11-09 张老师需求：用户忘记目标密码注册新号的场景）。
         衍生重算（各自口径对齐）：
         · user_scores(_nf) 六池：源行（含老站遗产无录像纪录）与目标行逐格取优合并，源行清零防双计；
         · 名次落盘：源账户出榜，目标账户出旧位后按合并成绩回榜（rankLeave/rankEnter 契约）；
         · STNB 榜：目标 3 级×flag/NF 重算，源行清除；
         · 纪录动态链：以合并后的 video_scores 为真相重放目标 flag 链（对齐 or/cr）；
         · user_stat 录像计数：按前台可见口径（status<>0）重算。
         最后与 user.delete 同口径注销源账户（删登录凭据/找回链接、置封禁、保留 user 行；
         录像标识 user_sig 随合并迁至目标账户，撞唯一键的源行删除）。 */
      const id = toId(p.id);
      const targetId = toId(p.targetId);
      // 登录凭据同步（2026-11-09 张老师需求）：弹窗勾选项，默认不选。勾选后目标账户改用
      // 源账户的登录名与密码登录（含邮箱绑定状态）——典型场景：用户忘记目标密码注册了新号
      const syncCred = toBool(p.syncCredentials);
      if (!id || !targetId) return { ok: false, error: "参数错误：缺少玩家 ID 或目标 ID" };
      if (id === targetId) return { ok: false, error: "目标账户不能是当前账户自己" };
      if (id === actor.uid) return { ok: false, error: "不能合并自己当前登录的账号" };
      const [srcUser, tgtUser, srcAuth, tgtAuth] = await Promise.all([
        prisma.user.findUnique({ where: { id: BigInt(id) } }),
        prisma.user.findUnique({ where: { id: BigInt(targetId) } }),
        prisma.userAuth.findUnique({ where: { id: BigInt(id) } }),
        prisma.userAuth.findUnique({ where: { id: BigInt(targetId) } }),
      ]);
      if (!srcUser) return { ok: false, error: "玩家不存在" };
      if (!tgtUser) return { ok: false, error: `目标玩家 #${targetId} 不存在` };
      if (!srcAuth) return { ok: false, error: "该玩家没有登录凭据（已注销），无需合并" };
      if (!tgtAuth) return { ok: false, error: `目标账户 #${targetId} 没有登录凭据，无法作为合并目标` };
      if (srcAuth.role >= USER_ROLE.MANAGER) return { ok: false, error: "管理员账号不能执行账户合并" };
      if (tgtUser.status !== 0) return { ok: false, error: "目标账户处于封禁状态，无法作为合并目标" };

      // 结果消息用计数（事务外并行取）
      const [videoCount, commentCount, postCount, replyCount, newsCount, srcOauthRows, tgtOauthRows] = await Promise.all([
        prisma.video.count({ where: { user: BigInt(id) } }),
        prisma.comment.count({ where: { user: BigInt(id) } }),
        prisma.bbsPost.count({ where: { user: BigInt(id) } }),
        prisma.bbsReply.count({ where: { user: BigInt(id) } }),
        prisma.news.count({ where: { user: BigInt(id) } }),
        prisma.userOauth.findMany({ where: { userId: BigInt(id) }, select: { provider: true } }),
        prisma.userOauth.findMany({ where: { userId: BigInt(targetId) }, select: { provider: true } }),
      ]);
      const oauthCount = srcOauthRows.length;
      const oauthDropped = srcOauthRows.filter((o) => tgtOauthRows.some((t) => t.provider === o.provider)).length;
      // 邮箱随迁判定（2026-11-09 张老师明确）：优先取绑定邮箱；未绑但登录名本身是邮箱
      // （老站口径：登录名=邮箱，找回密码同认）时按草稿随迁。目标已绑则一律不迁。
      const srcEmail = srcAuth.email ?? (EMAIL_RE.test(srcAuth.username) ? srcAuth.username : null);
      const emailNote = !srcEmail
        ? tgtAuth.email
          ? "源账户未绑邮箱"
          : "双方均未绑邮箱"
        : tgtAuth.email
          ? "目标已绑邮箱，源邮箱未迁"
          : srcAuth.email
            ? "邮箱已随迁"
            : "邮箱已随迁为未验证草稿（源登录名即邮箱）";

      const src = BigInt(id);
      const tgt = BigInt(targetId);
      const ts = BigInt(now());
      await prisma.$transaction(async (tx) => {
        // ① 名次：双方先出榜（源账户永久出榜；目标账户合并后按新成绩回榜）
        await rankLeave(tx, src);
        await rankLeave(tx, tgt);

        // ② 唯一键冲突预处理：扫雷历程（user+month 唯一）/ 感言投票（date+user 唯一）——
        //    与目标撞键的源行直接删除（目标保留自己的记录，源行无搬移价值），
        //    其余源行随后统一搬迁（下方 updateMany）
        const srcHistory = await tx.history.findMany({ where: { user: src }, select: { id: true, month: true } });
        for (const h of srcHistory) {
          const clash = await tx.history.findFirst({ where: { user: tgt, month: h.month }, select: { id: true } });
          if (clash) await tx.history.delete({ where: { id: h.id } });
        }
        const srcVotes = await tx.starVote.findMany({ where: { user: src }, select: { id: true, date: true } });
        for (const v of srcVotes) {
          const clash = await tx.starVote.findFirst({ where: { user: tgt, date: v.date }, select: { id: true } });
          if (clash) await tx.starVote.delete({ where: { id: v.id } });
        }
        //    地盘人气 click（user+ip+date 唯一）：同一人两账户常在同一天同 IP 访问过——撞键源行删除
        //    （目标保留自己的访问计数），其余行随 updateMany 搬迁（2026-11-01 生产 P2002 实证）
        const [srcClicks, tgtClicks] = await Promise.all([
          tx.click.findMany({ where: { user: src }, select: { ip: true, date: true } }),
          tx.click.findMany({ where: { user: tgt }, select: { ip: true, date: true } }),
        ]);
        const clickKeys = new Set(tgtClicks.map((c) => `${c.ip}|${c.date}`));
        const clickClashes = srcClicks.filter((c) => clickKeys.has(`${c.ip}|${c.date}`));
        if (clickClashes.length)
          await tx.click.deleteMany({ where: { user: src, OR: clickClashes.map((c) => ({ ip: c.ip, date: c.date })) } });

        // ③ 数据归属搬迁（video.reviewUser 审核人指位保留——那是后台审计事实，不随账户走）
        await tx.video.updateMany({ where: { user: src }, data: { user: tgt } });
        await tx.videoScoresBeg.updateMany({ where: { user: src }, data: { user: tgt } });
        await tx.videoScoresBegNf.updateMany({ where: { user: src }, data: { user: tgt } });
        await tx.videoScoresInt.updateMany({ where: { user: src }, data: { user: tgt } });
        await tx.videoScoresIntNf.updateMany({ where: { user: src }, data: { user: tgt } });
        await tx.videoScoresExp.updateMany({ where: { user: src }, data: { user: tgt } });
        await tx.videoScoresExpNf.updateMany({ where: { user: src }, data: { user: tgt } });
        await tx.comment.updateMany({ where: { user: src }, data: { user: tgt } });
        await tx.bbsPost.updateMany({ where: { user: src }, data: { user: tgt } });
        await tx.bbsReply.updateMany({ where: { user: src }, data: { user: tgt } });
        await tx.bbsPost.updateMany({ where: { lastReplyUser: src }, data: { lastReplyUser: tgt } });
        await tx.news.updateMany({ where: { user: src }, data: { user: tgt } });
        await tx.message.updateMany({ where: { fromUser: src }, data: { fromUser: tgt } });
        await tx.message.updateMany({ where: { toUser: src }, data: { toUser: tgt } });
        await tx.star.updateMany({ where: { user: src }, data: { user: tgt } });
        await tx.donate.updateMany({ where: { user: src }, data: { user: tgt } });
        await tx.click.updateMany({ where: { user: src }, data: { user: tgt } });
        // 第三方绑定随迁（2026-11-09 张老师明确）：按 provider 逐类判断——目标已绑该类
        // （如已绑 QQ）则该类源行不迁、按注销口径删除；未绑的类整类搬迁
        for (const provider of new Set(srcOauthRows.map((o) => o.provider))) {
          if (tgtOauthRows.some((t) => t.provider === provider)) {
            await tx.userOauth.deleteMany({ where: { userId: src, provider } });
          } else {
            await tx.userOauth.updateMany({ where: { userId: src, provider }, data: { userId: tgt } });
          }
        }
        // 历程 / 感言投票：冲突行已删，剩余行安全搬迁（不与目标撞唯一键）
        await tx.history.updateMany({ where: { user: src }, data: { user: tgt } });
        await tx.starVote.updateMany({ where: { user: src }, data: { user: tgt } });
        // 录像标识随迁（2026-11-05 张老师要求）：signature 唯一——与目标撞名的源行
        // 直接删除（目标已持有同名标识，无需重复注册），其余随 updateMany 搬迁
        const srcSigs = await tx.userSig.findMany({ where: { user: src }, select: { id: true, signature: true } });
        if (srcSigs.length) {
          const tgtSigSet = new Set(
            (await tx.userSig.findMany({ where: { user: tgt }, select: { signature: true } })).map((s) => s.signature)
          );
          const sigClash = srcSigs.filter((s) => tgtSigSet.has(s.signature));
          if (sigClash.length) await tx.userSig.deleteMany({ where: { id: { in: sigClash.map((s) => s.id) } } });
          await tx.userSig.updateMany({ where: { user: src }, data: { user: tgt } });
        }

        // ④ 邮箱绑定随迁（2026-11-09 张老师明确）：目标未绑邮箱时随迁（目标已绑则不覆盖，
        //    源邮箱随凭据注销释放）。源绑定邮箱按原验证状态迁；源未绑邮箱但登录名本身是
        //    邮箱时，随迁为未验证草稿（email_verified=0，找回密码不认草稿，用户可走正常
        //    流程验证——验证通过后登录名会同步换成邮箱）。
        //    email / emailToken 均 @unique——必须先清源行再设目标行，否则唯一键互撞（P2002）
        if (srcEmail && !tgtAuth.email) {
          await tx.userAuth.update({ where: { id: src }, data: { email: null, emailVerified: BigInt(0), emailToken: null } });
          await tx.userAuth.update({
            where: { id: tgt },
            data: srcAuth.email
              ? { email: srcAuth.email, emailVerified: srcAuth.emailVerified, emailToken: srcAuth.emailToken }
              : { email: srcEmail, emailVerified: BigInt(0), emailToken: null },
          });
        }

        // ⑤ 成绩六池 best-of 合并（flag + NF）：源行并入目标行、源行清零；返回目标 expTime 供纪录链快照
        const expSnapshot = await mergeUserScores(tx, false, id, targetId);
        await mergeUserScores(tx, true, id, targetId);

        // ⑥ 目标回榜（rankEnter 自查 status=0 与 sumTime>0，不满足即 no-op）
        await rankEnter(tx, tgt);

        // ⑦ STNB 榜落盘：目标按合并后的录像重算；源行清除（录像已全部迁走）
        for (const lv of VIDEO_LEVELS) {
          await refreshUserStnb(targetId, lv, tx);
          await refreshUserStnbNf(targetId, lv, tx);
        }
        await tx.userStnbBest.deleteMany({ where: { user: src } });
        await tx.userStnbBestNf.deleteMany({ where: { user: src } });

        // ⑧ user_stat 录像计数：目标按前台可见口径重算；源计数清零
        await recomputeUserStatVideos(tx, targetId);
        await tx.userStat.updateMany({ where: { id: src }, data: { begVideos: 0, intVideos: 0, expVideos: 0 } });

        // ⑨ 纪录动态链对齐：以合并后的 video_scores 为真相，重放目标三个级别的 flag 链
        for (const lv of VIDEO_LEVELS) {
          await syncRecordNewsChain(tx, targetId, lv, { expTime: expSnapshot });
        }

        // ⑩ 注销源账户（user.delete 同口径：删凭据/找回链接、置封禁、保留 user 行；
        //    user_sig 已随合并迁走，源账户不再持有任何标识）
        await tx.userAuth.delete({ where: { id: src } });
        // ⑪ 登录凭据同步（弹窗勾选，默认不选）：把源账户的登录名/密码/邮箱绑定整体
        //    同步给目标账户。必须在源凭据行删除之后执行——username/email 均 @unique，
        //    源行删除即释放两个唯一键，目标才可安全接管。
        if (syncCred) {
          await tx.userAuth.update({
            where: { id: tgt },
            data: {
              username: srcAuth.username,
              password: srcAuth.password,
              salt: srcAuth.salt,
              updateTime: ts,
              // 源有邮箱绑定（或登录名本身是邮箱）时连同绑定状态一起同步，覆盖目标原有绑定；
              // 源完全没有邮箱时保留目标自己的邮箱不动
              ...(srcEmail
                ? {
                    email: srcEmail,
                    emailVerified: srcAuth.email ? srcAuth.emailVerified : BigInt(0),
                    emailToken: srcAuth.emailToken,
                  }
                : {}),
            },
          });
        }
        await tx.passwordToken.deleteMany({ where: { user: src } });
        await tx.user.update({ where: { id: src }, data: { status: -1, updateTime: ts } });
      });

      // 知会目标账户（失败不阻断）
      try {
        await sendSystemMessage(
          targetId,
          `管理员已将账号「${srcUser.chineseName}」（#${id}）合并到你的账号，其全部数据（录像、成绩、文章、评论等）已归入你的名下。`
        );
      } catch { /* 通知失败不阻断 */ }

      return {
        ok: true,
        message:
          `已将 ${srcUser.chineseName}（#${id}）合并到 ${tgtUser.chineseName}（#${targetId}）：` +
          `录像 ${videoCount} 部、评论 ${commentCount} 条、主题 ${postCount} 篇 / 回复 ${replyCount} 条、` +
          `动态 ${newsCount} 条、第三方绑定 ${oauthCount - oauthDropped} 个` +
          (oauthDropped ? `（目标已绑同类型，${oauthDropped} 个未迁、随注销释放）` : "") +
          `；${emailNote}` +
          (syncCred ? "；登录凭据已同步（目标账户改用源账户的登录名与密码登录）" : ""),
      };
    }

    case "video.markWatched": {
      // 后台播放器看过即标记（2026-10-19）：防盲审口径认 admin_watched；
      // 幂等，重复上报无副作用。
      // 2026-10-27 修正：不再对已审过（status≠待审）早退——已通过录像重审
      // 屏蔽同样要求「先看过」（reviewVideo 防盲审），早退会让「播放过了却
      // 不能屏蔽」（实证：#347849 status=20 播放后 admin_watched 仍 0）。
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少录像 ID" };
      const video = await prisma.video.findUnique({ where: { id: BigInt(id) }, select: { id: true } });
      if (!video) return { ok: false, error: "录像不存在" };
      const now = BigInt(Math.floor(Date.now() / 1000));
      // upsert：老数据可能缺 video_stat 行，update 会 P2025 崩 500
      await prisma.videoStat.upsert({
        where: { id: BigInt(id) },
        create: { id: BigInt(id), adminWatched: 1, createTime: now, updateTime: now },
        update: { adminWatched: 1, updateTime: now },
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
      // 屏蔽 → 低信任分流（2026-10-28 张老师需求：录像处理与人处理分开）。
      // 前端屏蔽弹窗带「是否将上传者加入低信任用户组」勾选（2026-10-29 起默认不勾）：
      // 未传 lowTrust（脚本/内部路径）时维持旧行为（屏蔽史自动入组，从严）。
      const lowTrustParam = status === VIDEO_STATUS.BANNED && "lowTrust" in p ? toBool(p.lowTrust) : null;
      // 批量屏蔽该用户全部未审录像（2026-10-29 张老师需求）：选中后本次屏蔽 =
      // 对上传者名下全部待审录像（status=10，含当前这条）批量执行，全部跳过防盲审
      //（批量处置不再要求逐盘观看）。低信任勾选对整个用户只做一次 pre/post 分流。
      const banUserPending = status === VIDEO_STATUS.BANNED && "banUserPending" in p && toBool(p.banUserPending);
      if (banUserPending) {
        const self = await prisma.video.findUnique({
          where: { id: BigInt(id) },
          select: { user: true },
        });
        if (!self) return { ok: false, error: "录像不存在" };
        const uid = N(self.user);
        const pre = lowTrustParam !== null ? await preBanTrustUser(uid) : null;
        // 当前这条 + 名下其余全部待审（已通过/已屏蔽的不动）
        const rest = await prisma.video.findMany({
          where: { user: BigInt(uid), status: VIDEO_STATUS.NORMAL, id: { not: BigInt(id) } },
          select: { id: true },
          orderBy: { id: "asc" },
        });
        const targets = [id, ...rest.map((r) => Number(r.id))];
        let done = 0;
        const errors: string[] = [];
        for (const vid of targets) {
          const r = await reviewVideo(actor.uid, actor.role, vid, status, { skipWatchCheck: true });
          if (r.ok) done++;
          else errors.push(`#${vid}: ${r.error}`);
        }
        if (!done) return { ok: false, error: errors[0] ?? "全部失败" };
        const { note } =
          lowTrustParam !== null ? await postBanTrust(pre, lowTrustParam) : { note: "" };
        return {
          ok: true,
          message: `已批量屏蔽 ${done}/${targets.length} 条未审录像${errors.length ? `（${errors.length} 条失败：${errors[0]}）` : ""}${note}`,
        };
      }
      const pre = lowTrustParam !== null ? await preBanTrust(id) : null;
      /* 免核定单个通过同样跳过防盲审（2026-10-29 张老师报：批量能过、单个反被
         「先看后审」卡住）——口径对齐 video.batchReview：仅 autoFlag=1 且通过时跳过，
         需核定（0/2/-1）与屏蔽仍要求看过（下架是重动作）。动态导入同上方
         triageVideo 惯例：video-triage 连带 fs/videoradar 重依赖，不静态引。 */
      let skipWatch = false;
      if (status === VIDEO_STATUS.REVIEWED) {
        const { AUTO_FLAG } = await import("@/lib/video-triage");
        const row = await prisma.video.findUnique({ where: { id: BigInt(id) }, select: { autoFlag: true } });
        skipWatch = row?.autoFlag === AUTO_FLAG.EXEMPT;
      }
      const r = await reviewVideo(actor.uid, actor.role, id, status, { skipWatchCheck: skipWatch });
      if (!r.ok) return { ok: false, error: r.error ?? "审核失败" };
      const { note } =
        lowTrustParam !== null ? await postBanTrust(pre, lowTrustParam) : { note: "" };
      return { ok: true, message: `录像 #${id} → ${statusName(status)}${note}` };
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
      // 屏蔽 → 低信任分流（2026-10-28 张老师需求）：批量屏蔽弹窗同款勾选，语义同 video.review
      const lowTrustParam = status === VIDEO_STATUS.BANNED && "lowTrust" in p ? toBool(p.lowTrust) : null;
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
      // 屏蔽分流的预检：按上传者（去重）取屏蔽前低信任态，屏蔽完成后统一写豁免
      let preByUser: Map<number, BanTrustPre> | null = null;
      if (lowTrustParam !== null) {
        const rows = await prisma.video.findMany({
          where: { id: { in: targetIds.map(BigInt) } },
          select: { user: true },
        });
        preByUser = new Map();
        for (const uid of [...new Set(rows.map((r) => N(r.user)))]) {
          const pre = await preBanTrustUser(uid);
          if (pre) preByUser.set(uid, pre);
        }
      }
      let done = 0;
      const errors: string[] = [];
      /* 批量通过按成绩从优到劣过审（2026-11-01 张老师定：时间从快到慢）——
         同玩家同级别内「先优后劣」保证差成绩被 userScoresOnInsert 比较逻辑拦截不发纪录动态，
         从源头避免乱序审导致的纪录动态倒挂（or 链断裂/时间倒序）；跨玩家跨级别的相对顺序无关紧要，
         全局按 real_time 排序自动满足「同玩家同级别内成绩序」。3BV/s 链的交叉角落情形
         由 review.ts 的 syncRecordNewsChain（乱序触发重放）兜底。排序一次批量查询 + 内存排序，零额外审核开销。 */
      if (status === VIDEO_STATUS.REVIEWED) {
        const infos = await prisma.videoInfo.findMany({
          where: { id: { in: targetIds.map(BigInt) } },
          select: { id: true, realTime: true },
        });
        const rt = new Map(infos.map((r) => [Number(r.id), r.realTime]));
        targetIds = [...targetIds].sort((a, b) => (rt.get(a) ?? Infinity) - (rt.get(b) ?? Infinity));
      }
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
      // 屏蔽分流的写回（语义同单条）：勾选＝屏蔽史自然入组（零写入）；未勾选＝非成员写豁免
      let trustNote = "";
      if (lowTrustParam !== null && preByUser) {
        const added: string[] = [];
        const notAdded: string[] = [];
        for (const pre of preByUser.values()) {
          if (!pre) continue;
          if (lowTrustParam) {
            if (newlyJoined(pre)) added.push(pre.name);
          } else if ((await applyBanTrustExempt(pre)) !== "") {
            notAdded.push(pre.name);
          }
        }
        if (lowTrustParam) {
          if (added.length) trustNote = `（${namesBrief(added)}已加入低信任用户组）`;
        } else if (notAdded.length) {
          trustNote = `（${namesBrief(notAdded)}未加入低信任用户组）`;
        }
      }
      return {
        ok: true,
        // 实际成功条数（2026-11-09 首页一键过用：部分失败时气泡不虚报）
        done,
        message: `批量${statusName(status)} ${done}/${targetIds.length} 条${errors.length ? `（${errors.length} 条失败）` : ""}${trustNote}`,
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
      // 2026-10-29：物理删录像前先取评论行——录像删除后评论通知链接变死链，
      // 通知要按 (评论者, 评论id) 逐条撤回（锚点 ?comment=<cid>）
      const videoComments = await prisma.comment.findMany({
        where: { video: vid },
        select: { id: true, user: true },
      });
      await prisma.$transaction([
        prisma.video.delete({ where: { id: vid } }),
        prisma.videoInfo.deleteMany({ where: { id: vid } }),
        prisma.videoStat.deleteMany({ where: { id: vid } }),
        prisma.comment.deleteMany({ where: { video: vid } }),
        // 引用该录像的动态一并删除，避免详情页出现悬空链接
        prisma.news.deleteMany({ where: { reference: vid } }),
      ]);
      // 数组事务外逐条撤通知（物理删极少发生；失败仅留死链，不影响主流程）
      for (const c of videoComments) {
        await retractVideoCommentNotice(N(c.user), N(c.id));
      }
      return { ok: true, message: `彻底删除录像 #${id}（含解析信息 / 评论 / 引用动态）` };
    }

    // 录像挂接比赛（2026-11-13 二期张老师需求）：录像管理行内手动将录像加入某场比赛；
    // competitionId=0 表示解除。挂接成功写一条「玩家更新成绩」比赛动态
    //（同录像换挂同一场不重复写）。成绩口径＝video_info.real_time，前台排名/成绩
    // 全部按挂接录像聚合，见 lib/competition.ts getCompRanking。
    case "video.competition": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少录像 ID" };
      // 0=解除挂接（合法值，不能用 toId 滤掉）
      const rawComp = parseInt(String(p.competitionId ?? ""), 10);
      if (!Number.isInteger(rawComp) || rawComp < 0) {
        return { ok: false, error: "参数错误：缺少比赛 ID（0=解除挂接）" };
      }
      const video = await prisma.video.findUnique({
        where: { id: BigInt(id) },
        select: { id: true, user: true, competitionId: true, level: true },
      });
      if (!video) return { ok: false, error: "录像不存在" };
      if (rawComp === 0) {
        if (!video.competitionId) return { ok: false, error: "该录像未挂接比赛" };
        await prisma.video.update({ where: { id: BigInt(id) }, data: { competitionId: null } });
        return { ok: true, message: `已解除录像 #${id} 的比赛挂接` };
      }
      const comp = await prisma.competition.findUnique({
        where: { id: BigInt(rawComp) },
        select: { id: true, name: true, includeLevels: true },
      });
      if (!comp) return { ok: false, error: `比赛 #${rawComp} 不存在` };
      // 收录级别校验（张老师 2026-11-13：比赛设定可收录的录像级别，级别不符拒绝挂接）
      if (!comp.includeLevels.split(",").map((s) => s.trim()).includes(video.level)) {
        return { ok: false, error: `录像 #${id} 级别不符：「${comp.name}」只收录 ${comp.includeLevels.split(",").map((s) => ({ beg: "初级", int: "中级", exp: "高级" })[s] ?? s).join("、")} 录像` };
      }
      const changed = video.competitionId !== BigInt(rawComp);
      await prisma.video.update({
        where: { id: BigInt(id) },
        data: { competitionId: BigInt(rawComp) },
      });
      if (changed) await addCompEvent(rawComp, COMP_EVENT_SCORE, Number(video.user));
      return {
        ok: true,
        message: changed
          ? `录像 #${id} 已挂接到「${comp.name}」`
          : `录像 #${id} 本就挂在「${comp.name}」，未变更`,
      };
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
          // 2026-10-29：删除态联动撤回录像评论通知（口径同前台 comment/delete）
          await retractVideoCommentNotice(N(row.user), id, tx);
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
            // 补发动态：时间回填评论原发时间（不冒充当下）。
            // 2026-10-24 自评守卫（同 addComment）：楼主自评不补发，只恢复他人评论的动态
            if (N(video?.user ?? 0) !== N(row.user)) {
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
      // 2026-10-27：删帖级联撤动态 + 撤指向该帖的通知消息（口径同 lib/bbs.ts deletePost）
      const replyAuthors = await prisma.bbsReply.findMany({
        where: { post: BigInt(id) },
        select: { user: true },
        distinct: ["user"],
      });
      await prisma.$transaction(async (tx) => {
        await tx.bbsPost.update({ where: { id: BigInt(id) }, data: { status: -1, updateTime: BigInt(now()) } });
        await tx.bbsReply.updateMany({ where: { post: BigInt(id) }, data: { status: -1, updateTime: BigInt(now()) } });
        await tx.news.deleteMany({ where: { type: NEWS_TYPE.ARTICLE, user: post.user, reference: BigInt(id) } });
        await tx.news.deleteMany({
          where: { type: NEWS_TYPE.COMMENT, reference: BigInt(id), detailsData: { contains: '"kind":"bbs"' } },
        });
        for (const a of replyAuthors) {
          await retractPostNotices(N(a.user), id, tx);
        }
      });
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
        // 2026-10-27 张老师要求：删回复联动撤通知消息
        await retractReplyNotice(N(reply.user), id, tx);
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
          // 2026-10-27 张老师要求：删除态联动撤通知消息
          await retractReplyNotice(N(reply.user), id, tx);
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
            // 2026-10-27 张老师要求：恢复通过时补发楼主通知消息（AI 转待审曾把它撤下）——
            // 与动态补发对称，否则误判通过的评论楼主永远失去线索。锚点格式同发帖通知；
            // 幂等：仅当该回复的锚点通知不存在时补（避免重复通过/待审循环刷屏）
            const noticeExists = await tx.message.findFirst({
              where: {
                fromUser: reply.user,
                isSystem: false,
                OR: [
                  { content: { startsWith: "我评论了你的文章", contains: `?reply=${id}#reply-${id}` } },
                  { content: { startsWith: "我回复了你在", contains: `?reply=${id}#reply-${id}` } },
                ],
              },
              select: { id: true },
            });
            if (!noticeExists) {
              const now = BigInt(Math.floor(Date.now() / 1000));
              await tx.message.create({
                data: {
                  fromUser: reply.user,
                  toUser: post!.user,
                  content: `我评论了你的文章[url /bbs/${N(reply.post)}?reply=${id}#reply-${id}]《${decodeLegacyEntities(post!.title)}》[/url]`.slice(0, 200),
                  isRead: false,
                  isSystem: false,
                  createTime: now,
                  updateTime: now,
                },
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

    // ---------- 赞助登记（2026-10-30 后台赞助管理） ----------
    // 款项线下到账（微信/支付宝收款码）后手动记账；ID 留空 = 匿名（user=0）。
    // amount 单位为元（输入框），落库转分（donate.amount BigInt），与 2013 版分口径一致。
    case "donate.add": {
      const idRaw = toText(p.id, 12);
      let uid = 0;
      if (idRaw) {
        const n = toId(idRaw);
        if (!n) return { ok: false, error: "参数错误：玩家 ID 必须是正整数" };
        uid = n;
      }
      if (uid) {
        const u = await prisma.user.findUnique({ where: { id: BigInt(uid) }, select: { id: true } });
        if (!u) return { ok: false, error: `玩家 #${uid} 不存在，请核对 ID（留空则为匿名赞助）` };
      }
      const cents = Math.round(parseFloat(String(p.amount ?? "").replace(/[,，\s]/g, "")) * 100);
      if (!Number.isFinite(cents) || cents <= 0 || cents > 100_000_000) {
        return { ok: false, error: "参数错误：金额必须是 0.01 ~ 1000000 元之间的数值" };
      }
      const rt = resolveRegTime(p.date);
      if ("error" in rt) return { ok: false, error: rt.error };
      const t = rt.t;
      await prisma.donate.create({ data: { user: BigInt(uid), amount: BigInt(cents), createTime: t, updateTime: t } });
      // 实名赞助给本人发系统通知（2026-11-02 张老师）：金额按元口语化（去尾零）；
      // 「账户设置」用站内信链接标记（MSG_LINK_RE 渲染可点击跳 /account）；匿名赞助不发
      if (uid) {
        const yuan = (cents / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
        await sendSystemMessage(
          uid,
          `已收到您的赞助款${yuan}元，感谢您支持扫雷网！您的个人资料页已展示赞助金额，如您不想展示金额，可到[url /account]账户设置[/url]中关闭。`
        );
      }
      const rowUser = uid
        ? await prisma.user.findUnique({ where: { id: BigInt(uid) }, select: { chineseName: true } })
        : null;
      const name = uid ? rowUser?.chineseName ?? `#${uid}` : "匿名雷友";
      return {
        ok: true,
        message: `已登记赞助：${name}${uid ? `（#${uid}）` : ""} ¥${(cents / 100).toFixed(2)}`,
      };
    }

    // 编辑赞助（2026-10-30 张老师）：ID 留空 = 改为匿名；金额/日期同人名一样可改
    case "donate.edit": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少赞助记录 ID" };
      const row = await prisma.donate.findUnique({ where: { id: BigInt(id) } });
      if (!row) return { ok: false, error: "赞助记录不存在" };
      const idRaw = toText(p.idText, 12);
      let uid = 0;
      if (idRaw) {
        const n = toId(idRaw);
        if (!n) return { ok: false, error: "参数错误：玩家 ID 必须是正整数" };
        uid = n;
      }
      if (uid) {
        const u = await prisma.user.findUnique({ where: { id: BigInt(uid) }, select: { id: true } });
        if (!u) return { ok: false, error: `玩家 #${uid} 不存在，请核对 ID（留空则为匿名赞助）` };
      }
      const cents = Math.round(parseFloat(String(p.amount ?? "").replace(/[,，\s]/g, "")) * 100);
      if (!Number.isFinite(cents) || cents <= 0 || cents > 100_000_000) {
        return { ok: false, error: "参数错误：金额必须是 0.01 ~ 1000000 元之间的数值" };
      }
      const rt = resolveRegTime(p.date);
      if ("error" in rt) return { ok: false, error: rt.error };
      const t = rt.t;
      await prisma.donate.update({
        where: { id: BigInt(id) },
        data: { user: BigInt(uid), amount: BigInt(cents), createTime: t, updateTime: BigInt(now()) },
      });
      const rowUser = uid
        ? await prisma.user.findUnique({ where: { id: BigInt(uid) }, select: { chineseName: true } })
        : null;
      const name = uid ? rowUser?.chineseName ?? `#${uid}` : "匿名雷友";
      return { ok: true, message: `已修改赞助记录 #${id}：${name} ¥${(cents / 100).toFixed(2)}` };
    }

    case "donate.delete": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少赞助记录 ID" };
      const row = await prisma.donate.findUnique({ where: { id: BigInt(id) } });
      if (!row) return { ok: false, error: "赞助记录不存在" };
      await prisma.donate.delete({ where: { id: BigInt(id) } });
      const name =
        Number(row.user) > 0
          ? (await prisma.user.findUnique({ where: { id: row.user }, select: { chineseName: true } }))?.chineseName ??
            `#${Number(row.user)}`
          : "匿名雷友";
      return { ok: true, message: `已删除赞助记录 #${id}（${name} ¥${(Number(row.amount) / 100).toFixed(2)}）` };
    }

    // ---------- 支出登记（2026-10-30 收支管理） ----------
    // evidence 为先经 /api/admin/expense-evidence 上传返回的站内 URL（/uploads/expense/…）；
    // 这里只收白名单前缀，防止把外链/任意路径写进前台 img src。
    case "expense.add": {
      const purpose = toText(p.purpose, 100);
      if (!purpose) return { ok: false, error: "参数错误：请填写支出用途" };
      const cents = Math.round(parseFloat(String(p.amount ?? "").replace(/[,，\s]/g, "")) * 100);
      if (!Number.isFinite(cents) || cents <= 0 || cents > 100_000_000) {
        return { ok: false, error: "参数错误：金额必须是 0.01 ~ 1000000 元之间的数值" };
      }
      const evidence = toText(p.evidence, 200);
      if (evidence && !evidence.startsWith("/uploads/expense/")) {
        return { ok: false, error: "参数错误：凭据必须是本站上传的图片" };
      }
      const rt = resolveRegTime(p.date);
      if ("error" in rt) return { ok: false, error: rt.error };
      const t = rt.t;
      await prisma.donateExpense.create({
        data: { purpose, amount: BigInt(cents), evidence, createTime: t, updateTime: t },
      });
      return { ok: true, message: `已登记支出：${purpose} ¥${(cents / 100).toFixed(2)}${evidence ? "（含凭据）" : ""}` };
    }

    // 编辑支出（2026-10-30 张老师）：用途/金额/日期/凭据均可改；evidence 不传则保留原凭据
    case "expense.edit": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少支出记录 ID" };
      const row = await prisma.donateExpense.findUnique({ where: { id: BigInt(id) } });
      if (!row) return { ok: false, error: "支出记录不存在" };
      const purpose = toText(p.purpose, 100);
      if (!purpose) return { ok: false, error: "参数错误：请填写支出用途" };
      const cents = Math.round(parseFloat(String(p.amount ?? "").replace(/[,，\s]/g, "")) * 100);
      if (!Number.isFinite(cents) || cents <= 0 || cents > 100_000_000) {
        return { ok: false, error: "参数错误：金额必须是 0.01 ~ 1000000 元之间的数值" };
      }
      const evidence = toText(p.evidence, 200);
      if (evidence && !evidence.startsWith("/uploads/expense/")) {
        return { ok: false, error: "参数错误：凭据必须是本站上传的图片" };
      }
      const rt = resolveRegTime(p.date);
      if ("error" in rt) return { ok: false, error: rt.error };
      const t = rt.t;
      await prisma.donateExpense.update({
        where: { id: BigInt(id) },
        data: { purpose, amount: BigInt(cents), evidence, createTime: t, updateTime: BigInt(now()) },
      });
      return { ok: true, message: `已修改支出记录 #${id}：${purpose} ¥${(cents / 100).toFixed(2)}` };
    }

    case "expense.delete": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少支出记录 ID" };
      const row = await prisma.donateExpense.findUnique({ where: { id: BigInt(id) } });
      if (!row) return { ok: false, error: "支出记录不存在" };
      await prisma.donateExpense.delete({ where: { id: BigInt(id) } });
      return { ok: true, message: `已删除支出记录 #${id}（${row.purpose} ¥${(Number(row.amount) / 100).toFixed(2)}）` };
    }

    // ---------- 更新历史（2026-11-02 /page/history 落库，后台可编辑）----------
    case "siteupdate.add": {
      const date = normalizeSiteUpdateDate(String(p.date ?? ""));
      if (!date) return { ok: false, error: "参数错误：日期格式应为 YYYY-MM-DD 或 Y.M.D" };
      const content = toText(p.content, 500);
      if (!content) return { ok: false, error: "参数错误：请填写更新内容" };
      const t = BigInt(now());
      await prisma.siteUpdate.create({ data: { date, content, createTime: t, updateTime: t } });
      return { ok: true, message: `已登记更新历史：${date} ${content}` };
    }

    case "siteupdate.edit": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少更新历史 ID" };
      const date = normalizeSiteUpdateDate(String(p.date ?? ""));
      if (!date) return { ok: false, error: "参数错误：日期格式应为 YYYY-MM-DD 或 Y.M.D" };
      const content = toText(p.content, 500);
      if (!content) return { ok: false, error: "参数错误：请填写更新内容" };
      const row = await prisma.siteUpdate.findUnique({ where: { id: BigInt(id) } });
      if (!row) return { ok: false, error: "更新历史记录不存在" };
      await prisma.siteUpdate.update({
        where: { id: BigInt(id) },
        data: { date, content, updateTime: BigInt(now()) },
      });
      return { ok: true, message: `已修改更新历史 #${id}：${date} ${content}` };
    }

    case "siteupdate.delete": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少更新历史 ID" };
      const row = await prisma.siteUpdate.findUnique({ where: { id: BigInt(id) } });
      if (!row) return { ok: false, error: "更新历史记录不存在" };
      await prisma.siteUpdate.delete({ where: { id: BigInt(id) } });
      return { ok: true, message: `已删除更新历史 #${id}（${row.date} ${row.content}）` };
    }

    // ---------- 比赛（2026-11-13 张老师需求：前台「比赛」页数据源）----------
    // 发起：全名/简称/起止(北京时间 YYYY-MM-DD HH:mm)/规则/发起人ID/总奖金/分配方案；
    // 比赛标识 code 创建时即生成（前台开始前显示「待定」）。

    case "competition.add": {
      const name = toText(p.name, 100);
      const shortName = toText(p.shortName, 10);
      const start = resolveCstMinute(p.startTime);
      const end = resolveCstMinute(p.endTime);
      const rules = toText(p.rules, 1000);
      const creatorId = toId(p.creatorId);
      const prizeTotal = Number(p.prizeTotal);
      const prizePlan = toText(p.prizePlan, 500);
      if (!name) return { ok: false, error: "参数错误：请填写比赛全名" };
      if (!shortName) return { ok: false, error: "参数错误：请填写比赛简称（3-4 字）" };
      if (start === null || end === null) {
        return { ok: false, error: "参数错误：起止时间格式应为 YYYY-MM-DD HH:mm（北京时间）" };
      }
      if (end <= start) return { ok: false, error: "参数错误：结束时间必须晚于开始时间" };
      if (!rules) return { ok: false, error: "参数错误：请填写比赛规则" };
      if (!creatorId) return { ok: false, error: "参数错误：请填写发起人 ID" };
      if (!Number.isInteger(prizeTotal) || prizeTotal < 0) {
        return { ok: false, error: "参数错误：总奖金应为非负整数（元）" };
      }
      const creator = await prisma.user.findUnique({ where: { id: BigInt(creatorId) }, select: { id: true } });
      if (!creator) return { ok: false, error: `发起人不存在（UID ${creatorId}）` };
      const sc = parseScoreConf(p);
      if (sc && "error" in sc) return { ok: false, error: `参数错误：${sc.error}` };
      const code = await genUniqueCompCode();
      const created = await prisma.competition.create({
        data: {
          name,
          shortName,
          startTime: BigInt(start),
          endTime: BigInt(end),
          rules,
          creatorId: BigInt(creatorId),
          prizeTotal,
          prizePlan,
          code,
          includeLevels: parseIncludeLevels(p.levels),
          scoreMode: sc?.mode ?? "",
          scoreConfig: sc?.config ?? "",
          createTime: BigInt(now()),
        },
      });
      // 「报名开始」动态（2026-11-13 二期：详情页动态板块首条事件）
      await addCompEvent(Number(created.id), COMP_EVENT_JOIN_OPEN);
      return { ok: true, message: `已发起比赛「${name}」，比赛标识 ${code}` };
    }

    case "competition.edit": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少比赛 ID" };
      const name = toText(p.name, 100);
      const shortName = toText(p.shortName, 10);
      const start = resolveCstMinute(p.startTime);
      const end = resolveCstMinute(p.endTime);
      const rules = toText(p.rules, 1000);
      const creatorId = toId(p.creatorId);
      const prizeTotal = Number(p.prizeTotal);
      const prizePlan = toText(p.prizePlan, 500);
      if (!name) return { ok: false, error: "参数错误：请填写比赛全名" };
      if (!shortName) return { ok: false, error: "参数错误：请填写比赛简称（3-4 字）" };
      if (start === null || end === null) {
        return { ok: false, error: "参数错误：起止时间格式应为 YYYY-MM-DD HH:mm（北京时间）" };
      }
      if (end <= start) return { ok: false, error: "参数错误：结束时间必须晚于开始时间" };
      if (!rules) return { ok: false, error: "参数错误：请填写比赛规则" };
      if (!creatorId) return { ok: false, error: "参数错误：请填写发起人 ID" };
      if (!Number.isInteger(prizeTotal) || prizeTotal < 0) {
        return { ok: false, error: "参数错误：总奖金应为非负整数（元）" };
      }
      const row = await prisma.competition.findUnique({ where: { id: BigInt(id) } });
      if (!row) return { ok: false, error: "比赛不存在" };
      const creator = await prisma.user.findUnique({ where: { id: BigInt(creatorId) }, select: { id: true } });
      if (!creator) return { ok: false, error: `发起人不存在（UID ${creatorId}）` };
      const scEdit = parseScoreConf(p);
      if (scEdit && "error" in scEdit) return { ok: false, error: `参数错误：${scEdit.error}` };
      await prisma.competition.update({
        where: { id: BigInt(id) },
        data: {
          name,
          shortName,
          startTime: BigInt(start),
          endTime: BigInt(end),
          rules,
          creatorId: BigInt(creatorId),
          prizeTotal,
          prizePlan,
          includeLevels: parseIncludeLevels(p.levels),
          scoreMode: scEdit?.mode ?? "",
          scoreConfig: scEdit?.config ?? "",
        },
      });
      return { ok: true, message: `已修改比赛 #${id}「${name}」` };
    }

    case "competition.delete": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少比赛 ID" };
      const row = await prisma.competition.findUnique({ where: { id: BigInt(id) } });
      if (!row) return { ok: false, error: "比赛不存在" };
      // 报名记录与动态一并清掉（无成绩/奖金挂接，级联安全）
      await prisma.competitionEvent.deleteMany({ where: { competitionId: BigInt(id) } });
      await prisma.competitionEntry.deleteMany({ where: { competitionId: BigInt(id) } });
      // 挂接在本场比赛的录像解挂（比赛没了，video.competition_id 置回 NULL）
      await prisma.video.updateMany({ where: { competitionId: BigInt(id) }, data: { competitionId: null } });
      await prisma.competition.delete({ where: { id: BigInt(id) } });
      return { ok: true, message: `已删除比赛 #${id}「${row.name}」（含报名记录）` };
    }

    // 批量收录像（2026-11-13 三期张老师需求）：清单行「收录像」弹窗输入多个录像 ID
    // 一次性挂接到本比赛。已挂其他比赛的静默转入（张老师原话口径）；本就在本比赛的不动
    // 不写动态；变更的逐条写「玩家更新成绩」比赛动态（同单条 video.competition 口径）。
    case "competition.addVideos": {
      const compId = toId(p.id);
      if (!compId) return { ok: false, error: "参数错误：缺少比赛 ID" };
      const comp = await prisma.competition.findUnique({
        where: { id: BigInt(compId) },
        select: { id: true, name: true, includeLevels: true },
      });
      if (!comp) return { ok: false, error: `比赛 #${compId} 不存在` };
      // 支持逗号/空格/换行等任意分隔，去重；单次上限 500 条防误粘大段文本
      const ids = [
        ...new Set(
          String(p.ids ?? "")
            .split(/[^\d]+/)
            .filter(Boolean),
        ),
      ].slice(0, 500);
      if (ids.length === 0) return { ok: false, error: "请输入至少一个录像 ID" };
      const found = await prisma.video.findMany({
        where: { id: { in: ids.map((s) => BigInt(s)) } },
        select: { id: true, user: true, competitionId: true, level: true },
      });
      const missing = ids.filter((s) => !found.some((v) => v.id.toString() === s));
      // 收录级别过滤（张老师 2026-11-13：比赛设定可收录的录像级别，级别不符不收录）
      const levelSet = new Set(comp.includeLevels.split(",").map((s) => s.trim()));
      const levelRejected = found.filter((v) => !levelSet.has(v.level));
      const matched = found.filter((v) => levelSet.has(v.level));
      const compBig = BigInt(compId);
      let moved = 0;
      let already = 0;
      for (const v of matched) {
        if (v.competitionId === compBig) {
          already++;
          continue;
        }
        await prisma.video.update({ where: { id: v.id }, data: { competitionId: compBig } });
        if (v.competitionId) moved++;
        await addCompEvent(compId, COMP_EVENT_SCORE, Number(v.user));
      }
      const parts: string[] = [`已收录 ${matched.length - already} 条录像`];
      if (moved) parts.push(`${moved} 条从其他比赛转入`);
      if (already) parts.push(`${already} 条本就在本比赛`);
      if (levelRejected.length) parts.push(`级别不符未收录：${levelRejected.map((v) => v.id.toString()).join("、")}`);
      if (missing.length) parts.push(`未找到：${missing.join("、")}`);
      return { ok: true, message: `「${comp.name}」${parts.join("，")}` };
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
        // 三档小图补生成（2026-11-10 全站头像 WebP 化）：QQ 导入的头像在送审时已生成过；
        // 这里兜底覆盖「上传时生成失败」的场景。失败不影响审核主流程（前端回退原图）
        try {
          await generateAvatarSizes(path.join(process.cwd(), "public", row.filepath));
        } catch {
          /* 小图失败不阻塞审核 */
        }
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
      // 明文 key 只随接口响应回传给签发人弹窗展示（ApiKeyDialog）；
      // admin_log 留档脱敏版——日志页管理员（role≥10）可见，不能落明文（2026-10-27 修复）
      return {
        ok: true,
        logDetail: `已为「${name}」签发 API key（#${row.id}），明文已在签发弹窗显示`,
        message: `已为「${name}」签发 API key（#${row.id}）：${key} —— 请立即复制保存，明文不再显示`,
      };
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

    // 手动个别限速（2026-11-07）：每分钟请求上限，0=不限速；变更最迟 30 秒生效（鉴权缓存）
    case "apikey.setRateLimit": {
      const id = toId(p.id);
      if (!id) return { ok: false, error: "参数错误：缺少 key ID" };
      const limit = Math.floor(Number(p.ratePerMin));
      if (!Number.isFinite(limit) || limit < 0 || limit > 6000) {
        return { ok: false, error: "限速值需为 0–6000 的整数（0=不限速）" };
      }
      const row = await prisma.apiKey.findUnique({ where: { id: BigInt(id) } });
      if (!row) return { ok: false, error: "key 不存在" };
      await prisma.apiKey.update({
        where: { id: BigInt(id) },
        data: { ratePerMin: limit, updateTime: BigInt(now()) },
      });
      invalidateApiKeyCache();
      const desc = limit === 0 ? "不限速" : `${limit} 次/分钟`;
      return {
        ok: true,
        logDetail: `已将「${row.name}」（#${id}）的 API 限速设为 ${desc}`,
        message: `已将「${row.name}」限速设为 ${desc}，最迟 30 秒生效`,
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

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

/** 事务客户端类型（与 userstnb.ts 同款推导） */
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// ---------- 账户合并：成绩六池 best-of 合并（user.merge 专用） ----------

// 登录名是否本身是邮箱（与 src/app/api/account/email/route.ts 同一口径）
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MERGE_LEVELS = ["beg", "int", "exp"] as const;
const sField = (lv: string, order: "Time" | "3bvs", suffix = "") => `${lv}${order}${suffix}`;

/** user_scores(_nf) 委托联合的公共面（TS2349 → cast 委托接口，见 MEMORY 铁律） */
interface ScoresTbl {
  findUnique(args: { where: { id: bigint } }): Promise<Record<string, bigint | number | null> | null>;
  upsert(args: {
    where: { id: bigint };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
  update(args: { where: { id: bigint }; data: Record<string, unknown> }): Promise<unknown>;
}

/** 行 → 数值视图（去 id，BigInt→Number） */
function scoreRowNums(row: Record<string, bigint | number | null> | null): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (row) {
    for (const [k, v] of Object.entries(row)) {
      if (k === "id" || k === "createTime" || k === "updateTime") continue;
      out[k] = v == null ? null : Number(v);
    }
  }
  return out;
}

/** review.ts withSum 同款：时间三级齐全才合计；3BV/s 允许「有初级成绩但未达限界」按 0 参与合计 */
function withScoreSum(row: Record<string, number | null>): void {
  const hasBeg = (row[sField("beg", "Time")] ?? 0) > 0;
  if (hasBeg && row[sField("beg", "3bvs")] == null) row[sField("beg", "3bvs")] = 0;
  if (!hasBeg && row[sField("beg", "3bvs")] === 0) row[sField("beg", "3bvs")] = null;
  const t = MERGE_LEVELS.map((l) => row[sField(l, "Time")] ?? 0);
  const b = MERGE_LEVELS.map((l) => row[sField(l, "3bvs")] ?? 0);
  row.sumTime = t.every((x) => x > 0) ? t.reduce((a, c) => a + c, 0) : 0;
  row.sum3bvs = hasBeg && b[1] > 0 && b[2] > 0 ? b.reduce((a, c) => a + c, 0) : 0;
}

/** 数值视图 → 写库 data（BigInt 转换；时间戳列不写） */
function scoreData(row: Record<string, number | null>): Record<string, bigint | number | null> {
  const data: Record<string, bigint | number | null> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v == null) {
      data[k] = null;
      continue;
    }
    data[k] = k.endsWith("Video") || k.endsWith("Date") ? BigInt(v) : v;
  }
  return data;
}

/** user_scores(_nf) 六池 best-of 合并：源行并入目标行（逐格取优）后源行清零，返回目标合并后 expTime。
 *  比较语义与 review.ts userScoresOnInsert 完全一致：时间更小 / 3BV/s 更大才覆盖；
 *  源行的老站遗产无录像纪录（无指针）同样参与取优——真值来源以行值为准，与
 *  repair-user-scores.ts「保留优于录像真值的遗产值」口径兼容。 */
async function mergeUserScores(tx: Tx, nf: boolean, srcId: number, tgtId: number): Promise<number> {
  const table = (nf ? tx.userScoresNf : tx.userScores) as unknown as ScoresTbl;
  const a = scoreRowNums(await table.findUnique({ where: { id: BigInt(srcId) } }));
  const b = scoreRowNums(await table.findUnique({ where: { id: BigInt(tgtId) } }));
  const merged: Record<string, number | null> = b ?? {};
  for (const lv of MERGE_LEVELS) {
    for (const order of ["Time", "3bvs"] as const) {
      const f = sField(lv, order);
      const av = a[f] ?? 0;
      if (av <= 0) continue;
      const cur = merged[f] ?? 0;
      const better = order === "Time" ? cur === 0 || av < cur : cur === 0 || av > cur;
      if (!better) continue;
      merged[f] = av;
      merged[sField(lv, order, "Video")] = a[sField(lv, order, "Video")] ?? null;
      merged[sField(lv, order, "Date")] = a[sField(lv, order, "Date")] ?? null;
    }
  }
  withScoreSum(merged);
  const ts = BigInt(now());
  await table.upsert({
    where: { id: BigInt(tgtId) },
    create: { id: BigInt(tgtId), ...scoreData(merged), createTime: ts, updateTime: ts },
    update: { ...scoreData(merged), updateTime: ts },
  });
  // 源行清零防双计：值格与指针格全部置空、合计归零（行不存在则无事发生）
  if (Object.keys(a).length) {
    const blank: Record<string, bigint | number | null> = {};
    for (const lv of MERGE_LEVELS) {
      for (const order of ["Time", "3bvs"] as const) {
        blank[sField(lv, order)] = null;
        blank[sField(lv, order, "Video")] = null;
        blank[sField(lv, order, "Date")] = null;
      }
    }
    blank.sumTime = 0;
    blank.sum3bvs = 0;
    await table.update({ where: { id: BigInt(srcId) }, data: blank });
  }
  return merged.expTime ?? 0;
}

/** user_stat 录像计数重算（前台可见口径 status<>0：待审 10 + 通过 20 计，屏蔽 0 不计）。
 *  upsert：行可能缺失（review.ts syncUserStatVideoCount 同款兜底） */
async function recomputeUserStatVideos(tx: Tx, userId: number): Promise<void> {
  const rows = await tx.video.groupBy({
    by: ["level"],
    where: { user: BigInt(userId), status: { not: VIDEO_STATUS.BANNED } },
    _count: { _all: true },
  });
  const c: Record<string, number> = { beg: 0, int: 0, exp: 0 };
  for (const r of rows) c[r.level] = r._count._all;
  const ts = BigInt(now());
  await tx.userStat.upsert({
    where: { id: BigInt(userId) },
    create: {
      id: BigInt(userId),
      begVideos: c.beg,
      intVideos: c.int,
      expVideos: c.exp,
      createTime: ts,
      updateTime: ts,
    },
    update: { begVideos: c.beg, intVideos: c.int, expVideos: c.exp, updateTime: ts },
  });
}

/* ---------- 屏蔽 → 低信任分流（2026-10-28 张老师需求：录像处理与人处理分开） ----------
 *
 * 后台屏蔽录像弹窗新增「是否将上传者加入低信任用户组」勾选（2026-10-29 起默认不勾）：
 * · 勾选 → 屏蔽史自然生效，上传者经 lowtrust.ts 既有推导自动入组（零写入，列表可溯源）；
 * · 不勾 → 屏蔽完成后写 low_trust_exempt=now，把「时刻早于本次屏蔽」的屏蔽史整体豁免，
 *   上传者不进组。判定端（lib/lowtrust.ts / 分拣 / 上传限流）零改动——豁免就是既有
 *   「人工移出」机制的字段复用，语义完全一致。
 * · 只对「屏蔽前还不是成员」的用户新写豁免：已在组的成员不受本次选择影响
 *  （在组是因为更早的屏蔽/反作弊标记，不该被本次「不加入」顺手移出）。
 * · 未传 lowTrust 参数的调用方（脚本 / user.clearCheatPenalty 恢复 / video.delete
 *   预屏蔽）维持旧行为：屏蔽史自动入组（从严），不打扰既有链路。
 */

interface BanTrustPre {
  userId: number;
  name: string;
  /** 屏蔽前是否已是低信任组成员（封禁账号恒 false——本就不入组） */
  member: boolean;
  /** 账号是否处于封禁状态（封禁不入组、组列表也不显示，提示省略） */
  accountBanned: boolean;
  /** 屏蔽前 low_trust_exempt 值（不加入路径只在非成员时整体前移，成员不动） */
  exemptAt: number;
}

/** 屏蔽前取上传者低信任态（单条 video.review 用） */
async function preBanTrust(videoId: number): Promise<BanTrustPre | null> {
  const video = await prisma.video.findUnique({
    where: { id: BigInt(videoId) },
    select: { user: true },
  });
  if (!video) return null;
  return preBanTrustUser(N(video.user));
}

async function preBanTrustUser(uid: number): Promise<BanTrustPre | null> {
  const user = await prisma.user.findUnique({
    where: { id: BigInt(uid) },
    select: { chineseName: true, status: true, lowTrustUntil: true, lowTrustExempt: true },
  });
  if (!user) return null;
  const blocked = await loadBlockedHistoryOf(uid);
  const state = lowTrustState(user, blocked, now());
  return {
    userId: uid,
    name: user.chineseName,
    member: state.member,
    accountBanned: user.status === -1,
    exemptAt: state.exemptAt,
  };
}

/** 「屏蔽后新入组」判定：原本不是成员、且不是封禁账号（封禁不入组），
 *  本次屏蔽经屏蔽史推导让其成为成员 */
function newlyJoined(pre: BanTrustPre): boolean {
  return !pre.member && !pre.accountBanned;
}

/** 屏蔽后写回（单条 video.review 用）：返回 note 供 message 拼接
 *  · 勾选加入 → 零写入，屏蔽史自然入组；新入组给提示
 *  · 不加入   → 非成员写 exempt=now 豁免本次屏蔽；已在组保持不动 */
async function postBanTrust(pre: BanTrustPre | null, lowTrust: boolean): Promise<{ note: string }> {
  if (!pre) return { note: "" };
  if (lowTrust) {
    return newlyJoined(pre) ? { note: `，${pre.name}（#${pre.userId}）已加入低信任用户组` } : { note: "" };
  }
  const applied = await applyBanTrustExempt(pre);
  return { note: applied ? `，${applied}` : "" };
}

/** 写豁免（不加入低信任组的路径）：非成员才写；返回 message 片段（空=无需动作） */
async function applyBanTrustExempt(pre: BanTrustPre): Promise<string> {
  if (pre.member || pre.accountBanned) return "";
  await prisma.user.update({
    where: { id: BigInt(pre.userId) },
    data: { lowTrustExempt: BigInt(now()) },
  });
  return `${pre.name}（#${pre.userId}）未加入低信任用户组`;
}

/** 批量消息用名列表：≤3 个全列，超过给「N 名玩家」 */
function namesBrief(names: string[]): string {
  if (!names.length) return "";
  if (names.length <= 3) return `${names.join("、")} `;
  return `${names.length} 名玩家 `;
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
