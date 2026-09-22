// 录像上传（移植 VideoController::actionUpload + logic/Video::upload + helpers/Parser）
// 流程：大小/格式校验 → md5 去重 → 解析(mvf|avf) → 版本/级别/模式/完成度/3BV 校验
//      → 签名注册校验 → 存文件 videos/Y/M/D/hash.ext → 事务写 video/video_info/video_stat

import { createHash } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { avfToRawvf } from "@/lib/avf";
import { mvfToRawvf } from "@/lib/mvf";
import { formatRawvf } from "@/lib/rawvf";
import { LEVEL_MIN_3BV, VIDEO_STATUS, type VideoLevel } from "@/lib/config";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");
const MAX_SIZE = 500 * 1024; // 旧版 plupload max_file_size: 500kb

function fail(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return fail("请先登录", 401);

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
  if (ext !== "mvf" && ext !== "avf") return fail("只支持 mvf / avf 格式的录像");

  // md5 去重（移植 Video::hashExists）
  const hash = createHash("md5").update(buf).digest("hex");
  const dup = await prisma.video.findFirst({ where: { hash }, select: { id: true } });
  if (dup) return fail("此录像已被上传过");

  // 解析（移植 Parser::parse 的全部校验分支）
  let lines: string[] | null = null;
  try {
    lines = ext === "avf" ? avfToRawvf(buf) : mvfToRawvf(buf);
  } catch {
    return fail("录像文件解析失败");
  }
  if (!lines) return fail("录像文件解析失败");
  const parsed = formatRawvf(lines);

  if (parsed.version === "<=0.96") return fail("软件版本过低");
  if (!(parsed.level in LEVEL_MIN_3BV)) return fail("只支持初级/中级/高级录像");
  if (parsed.mode !== "classic") return fail("只支持经典模式录像");
  if (parsed.solved3bv !== null && parsed.solved3bv < (parsed.bbbv ?? 0)) {
    return fail("该录像尚未完成");
  }
  const level = parsed.level as VideoLevel;
  const minBbbv = LEVEL_MIN_3BV[level];
  if ((parsed.bbbv ?? 0) < minBbbv) return fail(`该录像的3BV小于${minBbbv}`);

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

  try {
    await prisma.$transaction(async (tx) => {
      if (!sig) {
        await tx.userSig.create({
          data: { user: BigInt(session.uid), signature: parsed.player, createTime: nowSec },
        });
      }
      const video = await tx.video.create({
        data: {
          level,
          user: BigInt(session.uid),
          hash,
          status: VIDEO_STATUS.NORMAL,
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
          createTime: nowSec,
          updateTime: nowSec,
        },
      });
      await tx.videoStat.create({
        data: { id: video.id, clicks: 0, downloads: 0, comments: 0, createTime: nowSec, updateTime: nowSec },
      });
    });
  } catch {
    return fail("录像保存失败", 500);
  }
  return NextResponse.json({ ok: true });
}
