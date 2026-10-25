// 注册页：注册必读（2008 版六条）+ 注册表单（2013 版 RegisterForm 字段）
// 已登录用户直接回首页；表单行为见 components/RegisterForm.tsx

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import RegisterForm from "@/components/RegisterForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "注册" };

export default async function RegisterPage() {
  const session = await getSession();
  if (session) redirect("/");

  return (
    <div id="page" className="main">
      <div id="account_register" className="box">
        <h1>注册</h1>

        {/* 注册必读：2008 版 Player/Register.asp，2026-10-25 删录像格式/审核两条 */}
        <div className="rules">
          <ol>
            <li>
              <b>必须使用</b>
              <em>真实姓名</em>
              <b>注册，每人只能注册一个用户。</b>
            </li>
            <li>
              <b>未用实名注册者所上传录像，一律不审核通过。</b>
            </li>
            <li>如发现注册信息不实，管理员有权封停或删除该用户。</li>
            <li>如发现用户伪造录像，将立刻删除该用户所有信息。</li>
          </ol>
        </div>

        <RegisterForm />
      </div>
    </div>
  );
}
