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
      {/* 2026-11-02 张老师定稿文案：固定规则句 + 实时剩余（数字绿色，随上传递减） */}
      每账户每周最多上传100个录像，您现在还能上传{" "}
      <b style={{ color: "#a6e22e" }}>{remaining}</b> 个录像，对本站
      {/* 亮灰常态、hover 变绿（globals.css .upload_quota_sponsor） */}
      <Link href="/page/donate" className="upload_quota_sponsor">
        提供赞助
      </Link>
      可大大提升上传限额。
    </p>
  );
}
