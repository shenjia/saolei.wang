// MVF 录像文件服务：对应 2013 版的 VIDEO_PATH（/videos）+ video_info.filepath
// 文件存放在项目根目录 videos/（已从旧服务器同步，gitignore），
// 例：/videos/2007/01/05/xxx.mvf → <root>/videos/2007/01/05/xxx.mvf

import { createReadStream, existsSync, statSync } from "fs";
import path from "path";
import { Readable } from "stream";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params;
  // 防目录穿越：解析后必须仍在 videos/ 内
  const filePath = path.resolve(VIDEOS_ROOT, ...segments.map(decodeURIComponent));
  if (!filePath.startsWith(VIDEOS_ROOT + path.sep) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return new Response("Not Found", { status: 404 });
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(statSync(filePath).size),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
