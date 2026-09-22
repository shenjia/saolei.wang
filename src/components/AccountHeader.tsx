// 账号中心页头（移植 views/account/_header）：标题 + 子导航

import Link from "next/link";

export function AccountHeader() {
  return (
    <>
      <div className="nav">
        <Link href="/account">
          <h1>账号中心</h1>
        </Link>
        <ul id="box_nav">
          <li>
            <Link href="/account/profile">修改资料</Link>
          </li>
          <li>
            <Link href="/account/password">修改密码</Link>
          </li>
        </ul>
      </div>
      <hr />
    </>
  );
}
