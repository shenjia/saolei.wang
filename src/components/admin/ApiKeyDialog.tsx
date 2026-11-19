"use client";

// API key 签发结果弹窗（2026-10-24 张老师反馈）
// 明文 key 只出现这一次，toast 几秒自动消失来不及复制——改为模态弹窗展示：
// key 大字展示 + 「复制 key」按钮（clipboard API，失败降级选中全文）+
// 「我已保存，关闭」确认按钮才能关；点遮罩/ESC 不关闭（防手滑丢 key）。
// 视觉复用封禁弹窗的暗玻璃（.ban_overlay/.ban_dialog 同款类）。

import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/Toast";

export function ApiKeyDialog({ name, keyText, onClose }: { name: string; keyText: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const keyRef = useRef<HTMLDivElement>(null);

  // ESC 不关闭（与封禁弹窗语义相反：这颗 key 关了就再也看不见，必须显式确认）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(keyText);
      setCopied(true);
      toast("已复制到剪贴板", "success");
    } catch {
      // 剪贴板不可用（非 https/权限拒绝）：全选文本让用户手动 Ctrl+C
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(keyRef.current!);
      sel?.removeAllRanges();
      sel?.addRange(range);
      toast("自动复制失败，已全选——请按 Ctrl/Cmd+C 手动复制", "error");
    }
  };

  return (
    <div className="ban_overlay" style={{ cursor: "default" }}>
      <div className="ban_dialog" onClick={(e) => e.stopPropagation()}>
        <h1>API key 已签发</h1>
        <p className="ban_desc">
          合作方「{name}」的 key 如下。<b style={{ color: "#f92672" }}>这是明文唯一一次显示</b>
          ，库里只存哈希，关闭后任何人都无法再查看；请立即复制并妥善保管。
        </p>
        <div className="apikey_value" ref={keyRef} onClick={copy} title="点击复制">
          {keyText}
        </div>
        <div className="ban_ops" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <button type="button" className="admin_btn" onClick={copy}>
            {copied ? "已复制 ✓ 再点一次" : "复制 key"}
          </button>
          <button type="button" className="admin_btn primary" onClick={onClose}>
            我已保存，关闭
          </button>
        </div>
      </div>
    </div>
  );
}
