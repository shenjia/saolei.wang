// 上传页每日剩余额度行（2026-11-02 张老师定文案）：初始值由服务端算好传入，
// UploadForm 每传完一个文件广播 upload-remaining 事件，这里实时递减刷新。

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export const UPLOAD_REMAINING_EVENT = "upload-remaining";

export function UploadQuota({ initialRemaining }: { initialRemaining: number }) {
  const [remaining, setRemaining] = useState(initialRemaining);

  useEffect(() => {
    const onRemaining = (e: Event) => {
      const n = (e as CustomEvent<number>).detail;
      if (typeof n === "number" && n >= 0) setRemaining(n);
    };
    window.addEventListener(UPLOAD_REMAINING_EVENT, onRemaining);
    return () => window.removeEventListener(UPLOAD_REMAINING_EVENT, onRemaining);
  }, []);

  return (
    <p>
      您今天还能上传{" "}
      {/* 剩余数字绿色（2026-11-02 张老师要求）——站内活跃绿 */}
      <b style={{ color: "#a6e22e" }}>{remaining}</b> 个录像，对本站
      {/* 绿色沿用站内活跃绿（globals.css .tp_row b.green 同源） */}
      <Link href="/page/donate" style={{ color: "#a6e22e" }}>
        提供赞助
      </Link>
      可大大提升上传限额。
    </p>
  );
}
