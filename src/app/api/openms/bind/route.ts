// 绑定协议 v2 · 雷网侧绑定操作（2026-11-09，需登录）
// POST /api/openms/bind  { action, ... }
//   create  { consent }            → 发起申请（雷网→开源网方向），返回 token 与开源扫雷网授权页地址
//   settle  { token }              → 回来核销：查开源扫雷网状态 API，confirmed 则落绑定
//   confirm { token, consent }     → 确认开源扫雷网发起的申请（雷网授权页确认模式）
//   update  { consent }            → 已绑定用户调整同步开关
//
// 开关口径（2026-11-09 张老师定）：本站唯一开关「开源网→扫雷网」（consent），默认勾选；
// 「扫雷网→开源网」的开关在开源扫雷网（其 AccountSaolei.auto_sync），本站不收不发。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  createBindRequest,
  settleBindByToken,
  confirmOpenmsRequest,
  setOpenmsPrefs,
  OpenmsBindError,
  OPENMS_AUTH_PAGE,
} from "@/lib/openms";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    action?: string;
    token?: string;
    consent?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    if (body.action === "create") {
      const token = await createBindRequest(session.uid, body.consent !== false);
      return NextResponse.json({
        ok: true,
        token,
        authUrl: `${OPENMS_AUTH_PAGE}?token=${token}`,
      });
    }
    if (body.action === "settle") {
      const token = String(body.token ?? "");
      if (!/^[0-9a-f]{48}$/.test(token)) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      const { profile } = await settleBindByToken(token, session.uid);
      return NextResponse.json({ ok: true, profile });
    }
    if (body.action === "update") {
      // 已绑定用户调整同步开关
      const ok = await setOpenmsPrefs(session.uid, body.consent !== false);
      if (!ok) return NextResponse.json({ error: "not_bound" }, { status: 404 });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "confirm") {
      const token = String(body.token ?? "");
      if (!/^[0-9a-f]{48}$/.test(token)) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      const { profile } = await confirmOpenmsRequest(
        session.uid,
        token,
        body.consent !== false
      );
      return NextResponse.json({ ok: true, profile });
    }
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  } catch (e) {
    if (e instanceof OpenmsBindError) {
      return NextResponse.json({ error: e.code }, { status: 409 });
    }
    throw e;
  }
}
