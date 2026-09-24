// 注册：字段校验 + 创建用户
// 流程参考 2008 ASP 版（Player/Register*.asp），校验规则移植 2013 PHP 版 RegisterForm：
// - username=邮箱（新站登录/找回密码同口径），全站唯一
// - 密码 6~20 位，落库 md5(密码+salt)，兼容全部老账号
// - 中文姓名 2~6 汉字；姓名拼音每字首字母大写、词数须与姓名字数一致
// 建表与扫码注册（api/auth/oauth/register）同构：事务内 user/user_auth/user_stat 同 id

import { randomBytes, createHash } from "crypto";
import { prisma } from "./db";
import { hashPassword } from "./auth";
import { AREA_LIST } from "./config";

export interface RegisterInput {
  email: string;
  password: string;
  confirm: string;
  chineseName: string;
  englishName: string;
  sex: number;
  area: string;
}

const EMAIL_RE = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;
const CHINESE_NAME_RE = /^[\u4e00-\u9fa5]{2,6}$/;
// 2013 版：([A-Z][a-z]{0,5}\s?){2,6}，每词首字母大写，词间单个空格
const ENGLISH_NAME_RE = /^([A-Z][a-z]{0,5} ?){2,6}$/;

/** 逐字段校验，返回 field → 错误文案（空对象=通过）；顺序与设计稿表格一致 */
export function validateRegister(input: RegisterInput): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!input.email) errors.email = "请输入电子邮箱！";
  else if (input.email.length > 50 || !EMAIL_RE.test(input.email))
    errors.email = "您输入的电子邮箱不合法！";

  if (!input.password) errors.password = "请输入登录密码！";
  else if (input.password.length < 6 || input.password.length > 20)
    errors.password = "密码长度须为 6~20 位！";

  if (!input.confirm) errors.confirm = "请再次输入密码！";
  else if (input.password && input.confirm !== input.password)
    errors.confirm = "两次输入的密码不一致！";

  if (!input.chineseName) errors.chineseName = "请输入中文姓名！";
  else if (!CHINESE_NAME_RE.test(input.chineseName))
    errors.chineseName = "您输入的中文姓名不合法（2~6 个汉字）！";

  if (!input.englishName) errors.englishName = "请输入姓名拼音！";
  else if (!ENGLISH_NAME_RE.test(input.englishName))
    errors.englishName = "姓名拼音格式不合法，请参考示范拼音！";
  else if (input.chineseName && CHINESE_NAME_RE.test(input.chineseName)) {
    const words = input.englishName.trim().split(/\s+/).length;
    if (words !== [...input.chineseName].length)
      errors.englishName = "拼音和姓名字数不同！";
  }

  if (input.sex !== 0 && input.sex !== 1) errors.sex = "请选择性别！";

  if (!AREA_LIST.includes(input.area as (typeof AREA_LIST)[number]))
    errors.area = "请选择所在地区！";

  return errors;
}

/** 创建用户（事务内 user/user_auth/user_stat 同 id），返回新用户 id */
export async function createRegisteredUser(input: RegisterInput): Promise<number> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const salt = createHash("md5").update(randomBytes(16)).digest("hex");

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        chineseName: input.chineseName,
        englishName: input.englishName.trim(),
        sex: input.sex,
        area: input.area,
        createTime: now,
        updateTime: now,
      },
    });
    await tx.userAuth.create({
      data: {
        id: u.id, // 旧站约束：user_auth.id == user.id
        username: input.email,
        password: hashPassword(input.password, salt),
        salt,
        role: 0,
        createTime: now,
        updateTime: now,
      },
    });
    await tx.userStat.create({
      data: { id: u.id, loginTimes: 1, loginTime: now, createTime: now, updateTime: now },
    });
    return u;
  });

  return Number(user.id);
}
