// /vs 竞技场即时预测接口（2026-11-11 十轮 14:38 张老师需求）：
// GET /api/vs/pre?l={id1}&r={id2}
//   → 双方就位后竞技场立刻调用，返回赛前预测评价 { text, tone }——
//     与对决页战前预测完全同源（getPreAssessment：STNB+录像量各半综合），
//     替代「请双方选手就位」金气泡（未就位/加载中仍显示金气泡）。
// 仅登录可用；l/r 缺失或相同 400。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getPreAssessment } from "@/lib/vs";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sp = new URL(req.url).searchParams;
  const l = parseInt(sp.get("l") ?? "", 10);
  const r = parseInt(sp.get("r") ?? "", 10);
  if (!l || !r || l === r) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const pre = await getPreAssessment(l, r);
  // 正文引号与对决页 preComment 同款（“”）
  return NextResponse.json({ text: `“${pre.text}”`, tone: pre.tone });
}
