// 忘记密码（申请重置链接）
import Link from "next/link";
import { ForgotForm } from "@/components/PasswordForms";

export const metadata = { title: "忘记密码" };

export default function ForgotPage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>忘记密码</h1>
        <p>输入注册时使用的邮箱，系统会发送一封含重置链接的邮件。</p>
        <p className="gray">
          如果您尚未绑定邮箱，请通过
          <Link href="/bbs/1187">QQ群</Link>
          向管理员求助。
        </p>
        <ForgotForm />
      </div>
    </div>
  );
}
