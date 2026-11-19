// 每日一星感言 API（2026-10-25 八轮张老师定；九轮加管理员删除）
// 2026-11-11 预写制（张老师定）：感言存 user.star_speech 每人一份、一次性，当选当日
//   提取展示（镜像到当日 star 行）；AI 预检前置，调用失败才由 after() 后置复审兜底
// POST action=speech：登录用户撰写感言（≤30 字 + 删两次封嘴，前置敏感词 + AI 预检）
// POST action=delete：管理员删除今日感言（user/star 双清 + 双计数；删两次永久不能再写）
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

    // 后置 AI 复审兜底（UGC 双闸门铁律）：仅当预检阶段 AI 调用失败/超时（aiBackstop）
    // 才走——判 review → 双清撤下（user.star_speech 命中原文才清 + 当日 star 行命中才清）；
    // 预检已过（source=ai）或 AI 未启用（disabled）不需要兜底
    const saved = r.speech ?? "";
    if (saved && r.aiBackstop) {
      const day = todayStr();
      after(async () => {
        try {
          const result = await moderateText(saved);
          if (result.verdict === "review") {
            await prisma.user.updateMany({
              where: { starSpeech: saved },
              data: { starSpeech: "" },
            });
            await prisma.star.updateMany({
              where: { date: day, speech: saved },
              data: { speech: "" },
            });
          }
        } catch {
          // 复审失败不动
        }
      });
    }
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

