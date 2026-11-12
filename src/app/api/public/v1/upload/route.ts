// 公开 API · 用户侧录像上传（2026-11-12 元扫雷 APP）
// POST /api/public/v1/upload
// 鉴权（双闸）：
//   ① X-Api-Key：合作方 key（scope=upload；元扫雷 key 只授 upload/me，打包泄露也无法
//      借 /login 探测用户密码）；按 key 限速（元扫雷 30/分）。
//   ② Authorization: Bearer <token>：/connect 授权页签发的 90 天用户 token
//      （lib/usertoken.ts 校验，封禁联动）。
// 请求：multipart/form-data，字段 file=录像文件（evf/mvf/avf/rmv，≤500KB，同站内口径）。
//
// 设计口径：
// · 身份一律从 Bearer token 推导（ident.uid）——不收客户端自报的 userId，杜绝伪造
//   （传了也只做忽略）；调用方需要自检身份用 GET /api/public/v1/me；
// · 上传管线与站内网页上传完全同源（uploadVideo）：md5 去重、解析校验、签名注册、
//   每周上传限额（赞助加成制）、低信任限速、UGC 双闸门、称号快照、自动分拣全部继承；
// · from_site=api_key.id 落库（详情页「来自XX」小图标；from_id 不写——NULL 不参与
//   (from_site, from_id) 唯一约束，多条来自同一 APP 的上传互不冲突）；
// · 排名局不在此通道（rankedInternal 语义是站内 /online 服务端自动入库），
//   APP 传的 evf 属普通上传、占每周额度（口径与站内网页上传一致）。

import { NextResponse } from "next/server";
import {
  requirePartnerEx,
  unauthorized,
  rateLimited,
  partnerRateLimit,
  partnerScopeAllowed,
  forbiddenScope,
} from "@/lib/partner";
import { requireUserToken } from "@/lib/usertoken";
import { uploadVideo } from "@/app/api/video/upload/route";

export async function POST(req: Request) {
  // ① 合作方 key 鉴权（无/错 key 一律 401，不透露 key 是否存在）
  const partner = await requirePartnerEx(req);
  if (!partner) return unauthorized();
  // scope 闸：key 已验真但未授 upload → 403（明示缺什么权限）
  if (!partnerScopeAllowed(partner, "upload")) return forbiddenScope("upload");
  if (!partnerRateLimit(partner, "upload")) return rateLimited(partner.ratePerMin);

  // ② 用户 token 鉴权（身份从此推导，不收客户端 userId）
  const ident = await requireUserToken(req);
  if (!ident) {
    return NextResponse.json(
      { error: "unauthorized", message: "缺少、无效或已过期的 Bearer token，请到扫雷网授权页重新授权获取" },
      { status: 401 }
    );
  }

  // 上传管线（同源复用）：token 身份注入 + 来源合作方标记
  //（keyId=0 的 env 草案 key 不打 from_site 标——非正式合作方）
  return uploadVideo(req, {
    authUid: ident.uid,
    fromSite: partner.keyId > 0 ? partner.keyId : undefined,
  });
}
