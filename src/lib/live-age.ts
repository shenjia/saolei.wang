// 练习状态公开发布年龄闸（2026-11-28，合规改造：未保法第 76 条「网络直播服务提供者
// 不得为未满十六周岁的未成年人提供网络直播发布者账号注册服务」）。
//
// 背景：排行局的「旁观」功能让其他用户看到本人的练习过程，形态上接近内容发布。
// 为不落入未成年人内容发布的监管红线，对**已填生日且未满 16 周岁**的用户强制关闭
// 「允许旁观」。**客户端与服务端共用本文件判定**（禁单边漂移）。
//
// 口径（张老师 2026-11-28 02:37 定）：
//   · 已填生日且未满 16 周岁 → 强制关闭，开关禁用，hover 文案说明法律依据
//   · 无法确定年龄（未填生日，全站 94% 用户）/ 已满 16 → **不拦**，开关按用户偏好
//     （默认开）
// 不采用「本人确认年满 16」的方案：会让绝大多数未填生日的老用户被默认挡住，
// 体验代价大而合规收益有限（自填确认本身也核验不了真实年龄）。
// 生日随时间增长，未满 16 的用户到期自动放行，不落任何「禁止」标记。

import { ageOf } from "./birth";

/** 16 周岁门槛（未保法第 76 条）。调整法规口径时只改这里 */
export const LIVE_AGE_MIN = 16;

/**
 * 是否已填生日且未满 16 周岁（＝必须强制关闭「允许旁观」）。
 * 未填生日 / 旧站默认 / 异常值一律 false（＝不拦）。
 * @param birthday  user_info.birthday（Unix 秒；ageOf 内已处理未填与异常）
 * @param now       可注入时钟（测试用）
 */
export function isUnder16(birthday: bigint | number | null | undefined, now = new Date()): boolean {
  const age = ageOf(birthday, now);
  return age !== null && age < LIVE_AGE_MIN;
}

/** 心跳路由用：一次主键查询取生日并判定 */
export async function liveUnder16Of(uid: number): Promise<boolean> {
  const { prisma } = await import("./db");
  const info = await prisma.userInfo.findUnique({ where: { id: BigInt(uid) }, select: { birthday: true } });
  return isUnder16(info?.birthday);
}
