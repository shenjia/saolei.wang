// 图形验证码（2026-10-19 防小号系列）：零依赖自实现 SVG captcha
// 服务端生成 4 位干扰码，内存 Map 存答案（5 分钟过期，一次性），前端拿 id + svg 展示
// 注册接口提交 captchaId + captchaText 校验； Map 容量靠「过期即清」控制

import { randomBytes, randomInt } from "crypto";

const TTL_MS = 5 * 60 * 1000;
const MAX_STORE = 5000;

// 去掉易混淆字符（0/O、1/l/I、2/Z 等）
const CHARS = "3456789ABCDEFGHJKMNPQRSTUVWXYZ";

const store = new Map<string, { code: string; expires: number }>();

function sweep() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expires < now) store.delete(k);
  }
}

export interface Captcha {
  id: string;
  svg: string;
}

export function makeCaptcha(): Captcha {
  if (store.size > MAX_STORE) sweep();
  const code = Array.from({ length: 4 }, () => CHARS[randomInt(CHARS.length)]).join("");
  const id = randomBytes(16).toString("hex");
  store.set(id, { code, expires: Date.now() + TTL_MS });

  const w = 120;
  const h = 40;
  const parts: string[] = [];
  // 每个字符独立随机旋转/位移/颜色
  for (let i = 0; i < code.length; i++) {
    const x = 14 + i * 26 + randomInt(-3, 4);
    const y = 28 + randomInt(-4, 5);
    const rot = randomInt(-25, 26);
    const hue = ["#4a6785", "#7a5c8f", "#3d7a5c", "#8f5c3d"][randomInt(4)];
    parts.push(
      `<text x="${x}" y="${y}" fill="${hue}" font-size="26" font-weight="bold" ` +
        `font-family="Georgia, serif" transform="rotate(${rot} ${x} ${y})">${code[i]}</text>`,
    );
  }
  // 干扰线 4 条
  for (let i = 0; i < 4; i++) {
    parts.push(
      `<path d="M ${randomInt(w)} ${randomInt(h)} Q ${randomInt(w)} ${randomInt(h)} ${randomInt(w)} ${randomInt(h)}" ` +
        `stroke="#b8c4d0" stroke-width="1" fill="none" opacity="0.7"/>`,
    );
  }
  // 干扰点 30 个
  for (let i = 0; i < 30; i++) {
    parts.push(`<circle cx="${randomInt(w)}" cy="${randomInt(h)}" r="1" fill="#c9d2da"/>`);
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="#f4f6f8"/>${parts.join("")}</svg>`;
  return { id, svg };
}

/** 校验并销毁（一次性）；忽略大小写 */
export function verifyCaptcha(id: string, text: string): boolean {
  const rec = store.get(id);
  if (!rec) return false;
  store.delete(id); // 无论对错都销毁，防重放
  return rec.expires >= Date.now() && rec.code.toLowerCase() === text.trim().toLowerCase();
}

/** 换一张时作废旧图，防堆积 */
export function invalidateCaptcha(id: string): void {
  store.delete(id);
}
