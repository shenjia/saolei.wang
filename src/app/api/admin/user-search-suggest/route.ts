// 玩家搜索推荐（2026-11-11 后台玩家管理，张老师需求：搜索输入后与前台一样出推荐）
// 返回各搜索类型（ID / 姓名 / 账号 / 昵称 / 录像标识）的命中数与前 3 个样本，
// 供 AdminFilters 推荐下拉展示「姓名包含「xx」的玩家 · N 人 · 样本」；
// 点击类型项以 ?q=xx&qtype=name 等回列表页按该类型筛选。只读、管理员权限。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminApi } from "@/lib/admin/guard";
import { likeContains } from "@/lib/sqlguard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guard = await requireAdminApi("manager");
  if ("error" in guard) return guard.error;

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (!q || q.length > 50) return NextResponse.json({ ok: true, items: [] });
  const like = likeContains(q);
  const isInt = /^\d+$/.test(q);

  // 计数一条聚合（user 30 万行 LIKE 全扫，后台低频可接受）；SUM 返回 DECIMAL，Number() 归一
  const [cnt] = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT
      COALESCE(SUM(u.chinese_name LIKE ? OR u.english_name LIKE ?), 0) name_c,
      COALESCE(SUM(a.username LIKE ?), 0) username_c,
      COALESCE(SUM(i.nickname LIKE ?), 0) nickname_c,
      COALESCE(SUM(u.id IN (SELECT user FROM user_sig WHERE signature LIKE ?)), 0) sig_c
    FROM user u
    LEFT JOIN user_auth a ON a.id = u.id
    LEFT JOIN user_info i ON i.id = u.id`,
    like, like, like, like, like
  );
  const nameC = Number(cnt?.name_c ?? 0);
  const usernameC = Number(cnt?.username_c ?? 0);
  const nicknameC = Number(cnt?.nickname_c ?? 0);
  const sigC = Number(cnt?.sig_c ?? 0);

  // 各类型样本（前 3 个），与计数并行
  const [nameS, usernameS, nicknameS, sigS, idRow] = await Promise.all([
    prisma.$queryRawUnsafe<{ chinese_name: string; english_name: string }[]>(
      `SELECT u.chinese_name, u.english_name FROM user u
       WHERE u.chinese_name LIKE ? OR u.english_name LIKE ? ORDER BY u.id LIMIT 3`,
      like, like
    ),
    prisma.$queryRawUnsafe<{ username: string }[]>(
      `SELECT a.username FROM user_auth a WHERE a.username LIKE ? ORDER BY a.id LIMIT 3`,
      like
    ),
    prisma.$queryRawUnsafe<{ nickname: string }[]>(
      `SELECT i.nickname FROM user_info i WHERE i.nickname LIKE ? ORDER BY i.id LIMIT 3`,
      like
    ),
    prisma.$queryRawUnsafe<{ signature: string }[]>(
      `SELECT s.signature FROM user_sig s WHERE s.signature LIKE ? ORDER BY s.id LIMIT 3`,
      like
    ),
    isInt
      ? prisma.user.findUnique({
          where: { id: BigInt(q) },
          select: { chineseName: true, englishName: true },
        })
      : Promise.resolve(null),
  ]);

  const items: { key: string; label: string; count: number; samples: string[] }[] = [];
  if (idRow)
    items.push({
      key: "id",
      label: `ID 等于 ${q} 的玩家`,
      count: 1,
      samples: [idRow.englishName ? `${idRow.chineseName} ${idRow.englishName}` : idRow.chineseName],
    });
  if (nameC > 0)
    items.push({
      key: "name",
      label: `姓名包含「${q}」的玩家`,
      count: nameC,
      samples: nameS.map((r) => (r.english_name ? `${r.chinese_name} ${r.english_name}` : r.chinese_name)),
    });
  if (usernameC > 0)
    items.push({ key: "username", label: `账号包含「${q}」的玩家`, count: usernameC, samples: usernameS.map((r) => r.username) });
  if (nicknameC > 0)
    items.push({ key: "nickname", label: `昵称包含「${q}」的玩家`, count: nicknameC, samples: nicknameS.map((r) => r.nickname) });
  if (sigC > 0)
    items.push({ key: "sig", label: `录像标识包含「${q}」的玩家`, count: sigC, samples: sigS.map((r) => r.signature) });
  // 非纯数字时补「不限类型」项（回车默认行为=全字段模糊；纯数字回车=ID 精确+标识模糊，无需此项）
  if (!isInt) items.push({ key: "all", label: `全部字段包含「${q}」的玩家`, count: 0, samples: ["不限类型"] });

  return NextResponse.json({ ok: true, items });
}
