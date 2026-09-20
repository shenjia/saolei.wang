// 退出登录

import { NextResponse } from "next/server";
import { clearSession } from "@/lib/auth";
import { siteUrl } from "@/lib/oauth";

export async function GET() {
  await clearSession();
  return NextResponse.redirect(`${siteUrl()}/account/login`, 302);
}
