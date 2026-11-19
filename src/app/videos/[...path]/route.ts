// MVF 录像文件服务：对应 2013 版的 VIDEO_PATH（/videos）+ video_info.filepath
// 文件存放在项目根目录 videos/（已从旧服务器同步，gitignore），
// 例：/videos/2007/01/05/xxx.mvf → <root>/videos/2007/01/05/xxx.mvf
// 本地缺失时按 VIDEO_FALLBACK_ORIGIN 反代主站同名文件（见 lib/videofile.ts），
// 开发环境不带 55 万录像文件也能播放/分析。

import { openVideoStream } from "@/lib/videofile";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params;
  const relPath = "/" + segments.map(decodeURIComponent).join("/");
  const file = await openVideoStream(relPath);
  if (!file) {
    return new Response("Not Found", { status: 404 });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  };
  if (file.size !== null) headers["Content-Length"] = String(file.size);
  return new Response(file.stream, { headers });
}
