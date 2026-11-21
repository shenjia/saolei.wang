// /uploads/ 静态图 404 兜底通道（2026-11-21，21275 头像案）
//
// 背景：头像三档小图由 sharp 在上传时生成，生产 sharp 原生依赖被打包产物
// 破坏期间（2026-11-10 ~ 11-21）生成的所有小图缺档，前端 onError 回退原图
// 但 hover 气泡等 <img> 无回退的位直接破图。nginx 对 ^~ /uploads/ 直读磁盘，
// 缺档即 404。本路由承接 nginx try_files 的 miss 分流（@uploads_fallback）：
//
//   ① 请求形态：/api/uploads-fallback/avatar/{small|mid|big}/{name}.webp
//      （nginx rewrite 剥掉 /uploads/ 前缀后 break 转发进来）
//   ② 找同名原图（jpg/png/webp 依次探测）→ 命中则同步吐原图（短缓存 300s，
//      重建完成后 CDN/浏览器自然切回 nginx 直读的 7d 正版小图）
//   ③ 同时 after() 起后台任务重建该图全部三档（in-flight Set 去重，
//      多人同时 miss 同一张图只起一次重建）
//   ④ 原图也缺失 → 404（真不存在，无兜底可言）
//
// 安全：路径段白名单（avatar + 三档尺寸名）+ 文件名字符白名单 + resolve 前
// 缀断言，杜绝目录穿越；不查库、不登录，纯静态文件语义。

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { after } from "next/server";
import { generateAvatarSizes } from "@/lib/small-avatar-gen";

export const dynamic = "force-dynamic";

const UPLOADS_DIR = path.join(process.cwd(), "public", "uploads");

/** 目前只有头像有三档子目录；后续新增图型在此扩表 */
const KIND_DIRS = new Set(["avatar"]);
const SIZE_WHITELIST = new Set(["small", "mid", "big"]);

/** 原图扩展名探测顺序（webp 源也兜——旧批处理产物可能被当源） */
const ORIG_EXTS = [".jpg", ".jpeg", ".png", ".webp"];

const CONTENT_TYPE: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** in-flight 去重：同一小图绝对路径的重建任务不叠加 */
const inflightRebuilds = new Set<string>();

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segs } = await params;

  // 形态：avatar/{size}/{name}.ext —— 三段，段名全部白名单
  if (segs.length !== 3) return notFound();
  const [kind, size, file] = segs;
  if (!KIND_DIRS.has(kind) || !SIZE_WHITELIST.has(size)) return notFound();
  // 文件名白名单：uid-ts / uid-qq-ts 等安全字符，杜绝穿越与特殊字符
  if (!/^[A-Za-z0-9._-]+\.(webp|jpe?g|png)$/i.test(file)) return notFound();

  // 前缀断言（join 后必须仍落在 uploads 树内，双保险）
  const baseName = file.replace(/\.[^.]+$/, "");
  const dirAbs = path.join(UPLOADS_DIR, kind, size);
  const sizedAbs = path.join(dirAbs, file);
  if (
    !path.resolve(sizedAbs).startsWith(path.resolve(UPLOADS_DIR) + path.sep) ||
    !path.resolve(dirAbs).startsWith(path.resolve(UPLOADS_DIR) + path.sep)
  ) {
    return notFound();
  }

  // 找原图：同名不同扩展名
  let origAbs: string | null = null;
  for (const ext of ORIG_EXTS) {
    const cand = path.join(UPLOADS_DIR, kind, baseName + ext);
    if (existsSync(cand)) {
      origAbs = cand;
      break;
    }
  }
  if (!origAbs) return notFound();

  // 后台重建三档（服务响应后执行；重复请求靠 Set 去重）
  after(async () => {
    // 重建前复查：窗口期内可能已被并发请求补齐
    if (existsSync(sizedAbs)) return;
    const key = path.resolve(sizedAbs);
    if (inflightRebuilds.has(key)) return;
    inflightRebuilds.add(key);
    try {
      await generateAvatarSizes(origAbs!);
    } catch (e) {
      console.error("[uploads-fallback] 小图重建失败:", origAbs, e instanceof Error ? e.message : e);
    } finally {
      inflightRebuilds.delete(key);
    }
  });

  const ext = path.extname(origAbs).toLowerCase();
  // 竞态兜底：探测与读取之间原图可能被删（换头像清理），失败落 404 不 500
  let body: ArrayBuffer;
  let size_bytes: number;
  try {
    const buf = readFileSync(origAbs);
    size_bytes = buf.length;
    // BodyInit 不收 Node Buffer 类型，转标准 ArrayBuffer（头像原图 ≤2MB，拷贝代价可忽略）
    body = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  } catch {
    return notFound();
  }
  return new Response(body, {
    headers: {
      "Content-Type": CONTENT_TYPE[ext] ?? "application/octet-stream",
      "Content-Length": String(size_bytes),
      // 短缓存：重建完成后让 CDN/浏览器尽快切回 nginx 直读的正版小图（7d）
      "Cache-Control": "public, max-age=300",
    },
  });
}

function notFound() {
  return new NextResponse(null, { status: 404 });
}
