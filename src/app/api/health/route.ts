import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// 部署后健康检查端点，供 server-deploy.sh 探活
export const GET = () =>
  NextResponse.json({ status: "ok", app: "saolei", timestamp: new Date().toISOString() });
