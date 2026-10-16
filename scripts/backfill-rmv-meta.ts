// 回填 RMV 录像的 software/version/signature（2026-10-16 张老师需求：能提取就应显示）
// 老站当年同样没解析 RMV，三字段全部空串；现解析器已可提取。
// 口径（对齐库内惯例）：
//   software = "Vienna"（库内是 Clone/Arbiter 短名；RawVF 里是全称 "Vienna Minesweeper"）
//   version  = 从版权串提取 "Release X" 的版本号（3.0H / 3.0.2H / 4.0.0b2）
//   signature = 文件内玩家标识（kiraa96 / Pu Tian Yi(Hu Bei)G98263 等，与 user_sig 语义同源）
// 幂等：只补空字段，已有值不动。
import { readFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { rmvToRawvf } from "../src/lib/rmv";

const ROOT = path.join(process.cwd(), "videos");

async function main() {
  const infos = await prisma.videoInfo.findMany({
    where: { filepath: { endsWith: ".rmv" }, OR: [{ software: "" }, { version: "" }, { signature: "" }] },
    select: { id: true, filepath: true, software: true, version: true, signature: true },
  });
  console.log(`待回填：${infos.length} 条`);

  let ok = 0, skip = 0;
  for (const info of infos) {
    try {
      const full = path.resolve(ROOT, "." + info.filepath);
      if (!full.startsWith(ROOT + path.sep)) throw new Error("path");
      const lines = rmvToRawvf(new Uint8Array(readFileSync(full)));
      if (!lines) { skip++; continue; }
      const program = lines.find((l) => l.startsWith("Program:"))?.slice(9).trim() ?? "";
      const versionRaw = lines.find((l) => l.startsWith("Version:"))?.slice(9).trim() ?? "";
      const player = lines.find((l) => l.startsWith("Player:"))?.slice(8).trim() ?? "";
      // 软件名：全称 "Vienna Minesweeper" → 短名 "Vienna"（对齐 Clone/Arbiter 惯例）
      const software = program === "Vienna Minesweeper" ? "Vienna" : program;
      // 版本：版权串 "Home Edition - Release 3.0H Copyright..." → "3.0H"
      const m = /Release\s+([\w.]+)/.exec(versionRaw);
      const version = m ? m[1] : versionRaw;
      if (!software || !player) { skip++; continue; }
      await prisma.videoInfo.update({
        where: { id: info.id },
        data: {
          ...(info.software === "" ? { software } : {}),
          ...(info.version === "" ? { version } : {}),
          ...(info.signature === "" ? { signature: player } : {}),
        },
      });
      ok++;
    } catch {
      skip++;
    }
  }
  console.log(`回填完成：${ok} 成功 / ${skip} 跳过（文件缺失或解析失败）`);
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error("FAIL", e);
  await prisma.$disconnect();
  process.exit(1);
});
