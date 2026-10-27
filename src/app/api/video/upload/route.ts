// 录像上传（移植 VideoController::actionUpload + logic/Video::upload + helpers/Parser）
// 流程：大小/格式校验 → md5 去重 → 解析(mvf|avf) → 版本/级别/模式/完成度/3BV 校验
//      → 签名注册校验 → 存文件 videos/Y/M/D/hash.ext → 事务写 video/video_info/video_stat

import { createHash } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { avfToRawvf } from "@/lib/avf";
import { mvfToRawvfBest } from "@/lib/mvf-best";
import { evfToRawvf } from "@/lib/evf";
import { formatRawvf, checkProgramVersion } from "@/lib/rawvf";
import { judgeVideoOutcome } from "@/lib/videowin";
import { ONLINE_PROGRAM_MARKER } from "@/lib/avfwrite";
import { RANKED_SOFTWARE } from "@/lib/evfwrite";
import { evfSignature } from "@/core/src/lib/evf-sign";
import { ensureVideoTriage } from "@/lib/videometrics";
import { LEVEL_MIN_3BV, VIDEO_STATUS, type VideoLevel } from "@/lib/config";
import { checkSensitive, logSensitiveHit, sensitiveRejectMessage } from "@/lib/sensitive";
import { userTitleSnapshot } from "@/lib/queries";
import { isMaintenanceOn, maintenanceReject } from "@/lib/maintenance";
import { getRankPenalty, countRecentUploads, LOW_TRUST_UPLOAD_LIMIT } from "@/core/src/lib/anticheat";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");
const MAX_SIZE = 500 * 1024; // 旧版 plupload max_file_size: 500kb

function fail(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: Request) {
  return uploadVideo(req);
}

export async function uploadVideo(
  req: Request,
  options?: {
    rankedInternal?: boolean;
    /** 排名局行为审计（调用方已重放事件流）：本局决策点击数与盲区点击数，
     *  透传给分拣做盲区率触发器（<10% 需核定，张老师 2026-10-27 指令） */
    audit?: { clicks: number; blindClicks: number };
  }
) {
  if (await isMaintenanceOn()) return maintenanceReject() as unknown as NextResponse;
  const session = await getSession();
  if (!session) return fail("请先登录", 401);

  // 低信任上传限速（2026-10-27 反作弊）：标记未到期用户 24h 滚动窗口内 ≤5 个录像。
  // 排在格式校验前，伪造请求也吃同一限额。
  const penalty = await getRankPenalty(session.uid);
  if (penalty.lowTrust) {
    const recent = await countRecentUploads(session.uid);
    if (recent >= LOW_TRUST_UPLOAD_LIMIT) {
      return fail(`低信任用户 24 小时内最多上传 ${LOW_TRUST_UPLOAD_LIMIT} 个录像`, 429);
    }
  }

  let file: File | null;
  try {
    const form = await req.formData();
    file = form.get("file") as File | null;
  } catch {
    return fail("请求格式错误");
  }
  if (!file || typeof file.arrayBuffer !== "function") return fail("请选择要上传的录像文件");

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX_SIZE) return fail("文件大小不能超过 500KB");

  const ext = path.extname(file.name ?? "").slice(1).toLowerCase();
  if (ext !== "mvf" && ext !== "avf" && ext !== "evf") return fail("只支持 mvf / avf / evf 格式的录像");

  // md5 去重（移植 Video::hashExists）
  const hash = createHash("md5").update(buf).digest("hex");
  const dup = await prisma.video.findFirst({ where: { hash }, select: { id: true } });
  if (dup) return fail("此录像已被上传过");

  // 解析（移植 Parser::parse 的全部校验分支）
  let lines: string[] | null = null;
  try {
    // mvf 走择优口径（mvf-best.ts：按下优先判胜即用，非胜时松开优先救场）
    lines =
      ext === "avf"
        ? avfToRawvf(buf)
        : ext === "evf"
          ? evfToRawvf(buf) // evf（元扫雷）：转换器内部完成 16px 口径折算与非标准码消歧
          : (mvfToRawvfBest(buf)?.lines ?? null);
  } catch {
    return fail("录像文件解析失败");
  }
  if (!lines) return fail("录像文件解析失败");
  const parsed = formatRawvf(lines);

  if (parsed.version === "<=0.96") return fail("软件版本过低");
  // 最低软件版本（2026-10-24 张老师定稿）：Arbiter 0.52.3（avf 头版本字节只到 0.52，系列内全放）、
  // 元扫雷 3.3.4（evf Software 自报全版本号，精确比较）；低于即拦，共享检查在 rawvf.checkProgramVersion
  const tooOld = checkProgramVersion(parsed.program, parsed.version);
  if (tooOld) return fail(tooOld);
  /* 在线玩生成的录像拒绝上传（2026-10-14 五期）：avfwrite 在 Program 字段写入
     ONLINE_PROGRAM_MARKER 标识，命中即拒——在线玩是纯前端娱乐局，成绩不入排行 */
  if (parsed.program.includes(ONLINE_PROGRAM_MARKER)) {
    return fail("在线玩的录像不能上传（成绩不计入排行）");
  }
  // 排名模式 EVF 只经专用入口生成后内部调用本函数；普通文件上传不能冒充该来源。
  if (parsed.program === RANKED_SOFTWARE && !options?.rankedInternal) {
    return fail("在线排行模式录像只允许服务器生成，不允许手动上传");
  }
  if (!(parsed.level in LEVEL_MIN_3BV)) return fail("只支持初级/中级/高级录像");
  if (parsed.mode !== "classic") return fail("只支持经典模式录像");
  /* 完成度校验（2026-10-15 张老师要求：只有完成的录像才能上传，堵败局/半截局漏网）：
     MVF 头部自带 Solved3BV，沿用旧版比较；AVF 无该字段（parsed.solved3bv 为 null，
     旧版此分支直接放行——败局正是从这里漏进来的），改为事件流模拟判定胜负 */
  if (parsed.solved3bv !== null) {
    if (parsed.solved3bv < (parsed.bbbv ?? 0)) return fail("该录像尚未完成");
  } else {
    const outcome = judgeVideoOutcome(parsed);
    if (outcome === "loss") return fail("该录像未完成（踩雷败局不能上传）");
    if (outcome === "incomplete") return fail("该录像未完成");
  }
  const level = parsed.level as VideoLevel;
  const minBbbv = LEVEL_MIN_3BV[level];
  if ((parsed.bbbv ?? 0) < minBbbv) return fail(`该录像的3BV小于${minBbbv}`);

  // 录像标识文字会公开展示在录像页，并写入 user_sig。命中则不注册签名、不落文件
  const sigHit = checkSensitive(parsed.player);
  if (!sigHit.ok) {
    logSensitiveHit("video.signature", session.uid, sigHit);
    return fail(sensitiveRejectMessage(sigHit, "上传"));
  }

  // 签名注册（移植 UserSig::register：已存在则必须是本人）
  const sig = await prisma.userSig.findFirst({ where: { signature: parsed.player } });
  if (sig && Number(sig.user) !== session.uid) return fail("该录像标示已被他人注册");

  // 存文件：videos/Y/M/D/hash.ext（旧版存 videos/Y/m/d/hash.avf，新版按真实扩展名）
  const now = new Date();
  const nowSec = BigInt(Math.floor(now.getTime() / 1000));
  const dir = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
  const filepath = `/${dir}/${hash}.${ext}`;
  const absDir = path.join(VIDEOS_ROOT, dir);
  try {
    if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });
    writeFileSync(path.join(VIDEOS_ROOT, dir, `${hash}.${ext}`), buf);
  } catch {
    return fail("录像保存失败", 500);
  }

  let videoId = 0;
  try {
    await prisma.$transaction(async (tx) => {
      if (!sig) {
        await tx.userSig.create({
          data: { user: BigInt(session.uid), signature: parsed.player, createTime: nowSec },
        });
      }
      // 2026-10-17 称号快照制：上传时刻作者高级成绩 + 是否在榜，内嵌 video 行
      const snap = await userTitleSnapshot(session.uid, tx);
      const video = await tx.video.create({
        data: {
          level,
          user: BigInt(session.uid),
          hash,
          status: VIDEO_STATUS.NORMAL,
          expTime: BigInt(snap.expTime),
          ranked: snap.ranked ? BigInt(1) : BigInt(0),
          createTime: nowSec,
          updateTime: nowSec,
        },
      });
      await tx.videoInfo.create({
        data: {
          id: video.id,
          filepath,
          signature: parsed.player,
          software: parsed.program,
          version: parsed.version,
          noflag: parsed.noflag,
          board: parsed.board,
          board3bv: parsed.bbbv ?? 0,
          realTime: parsed.timeMs,
          // 排名局录像签名（2026-10-27 张老师要求）：对实际存储字节算 HMAC 存库，
          // 之后分拣/巡检可随时比对——文件被篡改即验出。普通上传为 null
          ...(options?.rankedInternal
            ? { evfSig: evfSignature(buf) }
            : {}),
          createTime: nowSec,
          updateTime: nowSec,
        },
      });
      await tx.videoStat.create({
        data: { id: video.id, clicks: 0, downloads: 0, comments: 0, createTime: nowSec, updateTime: nowSec },
      });
      // user_stat 录像计数（2026-10-26 补）：上传即 status=10 待审，按前台可见性
      // 口径（status<>0 计数）立即 +1；后续审核通过/屏蔽由 review.ts 按差值调整
      await tx.userStat.upsert({
        where: { id: BigInt(session.uid) },
        create: { id: BigInt(session.uid), createTime: nowSec, updateTime: nowSec, ...(level === "beg" ? { begVideos: 1 } : level === "int" ? { intVideos: 1 } : { expVideos: 1 }) },
        update: {
          ...(level === "beg"
            ? { begVideos: { increment: 1 } }
            : level === "int"
              ? { intVideos: { increment: 1 } }
              : { expVideos: { increment: 1 } }),
          updateTime: nowSec,
        },
      });
      videoId = Number(video.id);
    });
  } catch {
    return fail("录像保存失败", 500);
  }

  // 自动分拣后置钩子（2026-10-19 方案 v2）：事务提交后异步跑触发器组，
  // 写 auto_flag（免核定/需核定）+ auto_reason（位码）。只打标不动 status——
  // 通过永远由管理员手动执行（免核定池批量一键过 / 需核定逐条手审）。
  if (videoId > 0) {
    const triageExtra = options?.audit
      ? { auditClicks: options.audit.clicks, auditBlindClicks: options.audit.blindClicks }
      : undefined;
    try {
      after(() => ensureVideoTriage(videoId, triageExtra));
    } catch {
      void ensureVideoTriage(videoId, triageExtra);
    }
  }
  return NextResponse.json({ ok: true });
}
