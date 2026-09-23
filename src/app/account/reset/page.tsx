// 重置密码（邮件链接落地页）
import Link from "next/link";
import { ResetForm } from "@/components/PasswordForms";

export const metadata = { title: "重置密码 | 扫雷网" };

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const token = sp.token ?? "";
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>重置密码</h1>
        {token ? (
          <ResetForm token={token} />
        ) : (
          <p>
            链接无效。
            <Link href="/account/forgot">重新申请</Link>
          </p>
        )}
      </div>
    </div>
  );
}
