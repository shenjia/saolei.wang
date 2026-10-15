// 首页邮箱绑定提醒条（2026-10-15）：登录且未绑定已验证邮箱时显示。
// 老用户登录名非邮箱，忘记密码无法自助找回——提醒条一直挂到完成验证为止（不可关闭，
// 这是账号安全兜底而非营销位；验证成功后自然消失）。

import Link from "next/link";

export function EmailBindNotice() {
  return (
    <div className="email_bind_notice">
      <span className="text">
        您的账号尚未绑定邮箱，忘记密码时将<b>无法自助找回</b>。
      </span>
      <Link href="/account/email" className="go">
        立即绑定 →
      </Link>
    </div>
  );
}
