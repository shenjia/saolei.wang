"use client";

// 行内「编辑」按钮（2026-10-30 张老师：赞助/支出记录支持编辑）
// 点编辑把该记录数据经 window CustomEvent 发给同页表单组件（DonateForm/ExpenseForm），
// 表单进入编辑模式回填后提交 donate.edit / expense.edit。
// 用事件而不是 props：清单行在 RSC 里，表单是独立客户端组件，二者无法直接传函数。

export function RowEditButton({
  event,
  detail,
  title,
}: {
  /** CustomEvent 名（如 "sl-donate-edit"） */
  event: string;
  /** 回填给表单的记录数据（金额为分、时间为秒） */
  detail: Record<string, unknown>;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="admin_btn sm"
      title={title ?? "编辑这条记录"}
      onClick={() => window.dispatchEvent(new CustomEvent(event, { detail }))}
    >
      编辑
    </button>
  );
}
