// 每日一星感言 API（2026-10-25 八轮张老师定；九轮加管理员删除）
// POST action=speech：当日当选者本人写感言（≤28 字，一次性 + 删两次封禁重发，前置敏感词 + 后置 AI 复审）
// POST action=delete：管理员删除今日感言（speechDel+1；删两次本人永久不能再发）
// POST action=vote：感言赞/踩（2026-10-27 张老师定；二轮收紧）——仅登录用户，
//   服务端按用户硬去重（star_vote 同日同人唯一键），堵隐身浏览器无限刷
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { getSession } from "@/lib/auth";
import { setStarSpeech, deleteStarSpeech, voteStarSpeech } from "@/lib/star";
import { prisma } from "@/lib/db";
import { moderateText, textModerationEnabled } from "@/lib/text-moderate";
import { isManager } from "@/lib/config";

/** 与 star.ts 同款本地日期（+08:00 站点时区口径——toISOString 是 UTC，凌晨会差一天） */
function todayStr(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  // 感言赞/踩（2026-10-27 二轮）：与 speech/delete 一样要求登录；
  // 未登录游客点击 → 前端弹登录浮窗，不发请求
  if (action === "vote") {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const dir = body.dir === "down" ? "down" : body.dir === "up" ? "up" : "";
    if (!dir) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    const r = await voteStarSpeech(session.uid, dir);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true, up: r.up, down: r.down, myVote: r.myVote });
  }

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  if (action === "speech") {
    const speech = String(body.speech ?? "");
    const r = await setStarSpeech(session.uid, speech);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });

    // 后置 AI 复审（UGC 双闸门铁律）：判 review → 清空撤下（感言单行无动态可撤，
    // 置空即隐藏；AI 判 pass / 调用失败不动，与全局口径一致）
    const saved = (r as { speech?: string }).speech ?? "";
    const day = todayStr();
    after(async () => {
      if (!textModerationEnabled() || !saved) return;
      try {
        const result = await moderateText(saved);
        if (result.verdict === "review") {
          await prisma.star.updateMany({ where: { date: day }, data: { speech: "" } });
        }
      } catch {
        // 复审失败不动
      }
    });
    return NextResponse.json({ ok: true });
  }

  // 管理员删除今日感言（九轮）：删两次后本人永久不能再发；
  // 十五轮：删除后以管理员私人名义发提醒消息（deleteStarSpeech 内处理）
  if (action === "delete") {
    if (!isManager(session.role)) {
      return NextResponse.json({ error: "只有管理员可以删除感言" }, { status: 403 });
    }
    await deleteStarSpeech(session.uid);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}

