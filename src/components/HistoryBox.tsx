// 历程区块（移植 2008 版 History_List + Add/Edit）：本人可增删改
// 2026-09-24 张老师要求：板块标题「扫雷历程」→「历程」→ 二轮改「纪事」；日期颜色沿用动态口径
// （一年内亮 / 一年以上暗）；正文提亮；底部行内表单改为标题右上角「+」按钮，
// 点击弹出浮窗选月份写内容，编辑复用同一浮窗；编辑/删除按钮 hover 才显示。
// 二轮：日期/正文分两列（表格），长正文折行不再串到日期列。

"use client";

import { useEffect, useState } from "react";
import { USER_HISTORY_NUMBER } from "@/lib/config";
import type { HistoryItem } from "@/lib/history";
import { isRecent } from "@/lib/format";
import { noFocusJump } from "./useKeepScroll";
import { TotalCount } from "./TotalCount";
import { useDraft, useHydrated } from "./useDraft";
import { confirmDialog } from "./Confirm";

export function HistoryBox({
  userId,
  items: initial,
  editable,
}: {
  userId: number;
  items: HistoryItem[];
  editable: boolean;
}) {
  const [items, setItems] = useState(initial);
  const [visible, setVisible] = useState(USER_HISTORY_NUMBER);
  // 浮窗：null=关闭；{id:null}=新增；{id:number}=编辑该条
  const [dialog, setDialog] = useState<{ id: number | null } | null>(null);

  async function call(body: Record<string, unknown>): Promise<boolean> {
    const res = await fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  }

  async function onDelete(id: number) {
    if (!(await confirmDialog({ title: "删除纪事", message: "确定删除这条纪事吗？", danger: true, confirmText: "删除" }))) return;
    if (!(await call({ action: "delete", id }))) return;
    setItems((list) => list.filter((it) => it.id !== id));
  }

  // 浮窗打开时：锁页面滚动 + ESC 关闭
  useEffect(() => {
    if (!dialog) return;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setDialog(null);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [dialog]);

  const dialogItem = dialog?.id != null ? items.find((it) => it.id === dialog.id) : undefined;

  return (
    <div className="box" id="history">
      <div className="history_head">
        {/* 2026-09-27 张老师要求：与其他板块同款 26px 大字（.gray 灰次级样式） */}
        <h1 className="gray">纪事</h1>
        {editable && (
          <a
            href="#"
            className="history_add_btn"
            title="写纪事"
            aria-label="写纪事"
            onClick={(e) => {
              e.preventDefault();
              setDialog({ id: null });
            }}
          >
            +
          </a>
        )}
      </div>
      {items.length === 0 && <p className="text">还没有记录。</p>}
      <table className="history_table" cellPadding={0} cellSpacing={0}>
        <tbody>
          {items.slice(0, visible).map((it) => (
            <tr key={it.id} className="history_item">
              <td className="history_month_col">
                <em className={isRecent(monthToUnix(it.month)) ? "time--recent" : "time--old"}>
                  {it.month}
                </em>
              </td>
              <td className="history_content_col">
                {/* 2026-10-16 修复：纪事正文支持换行分段（对齐老站 NoHtml 的 CRLF→<br> 语义），
                    归一化后交给 CSS pre-wrap 渲染；纯文本节点无 XSS 面 */}
                <span className="history_text">{normalizeHistoryText(it.content)}</span>
                {editable && (
                  <span className="ops">
                    {" "}
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setDialog({ id: it.id });
                      }}
                    >
                      编辑
                    </a>{" "}
                    <a href="#" onClick={(e) => (e.preventDefault(), onDelete(it.id))}>
                      删除
                    </a>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length > visible && (
        <div className="more_loader">
          <button
            type="button"
            className="button small"
            onMouseDown={noFocusJump}
            onClick={() => setVisible((n) => n + USER_HISTORY_NUMBER)}
          >
            加载更多
          </button>
          {/* 2026-09-26 张老师要求：显示剩余条数而非总数（本区块全部加载后整行隐藏） */}
          <TotalCount total={items.length} loaded={visible} unit="条" />
        </div>
      )}
      {dialog && (
        <HistoryDialog
          item={dialogItem}
          authorId={userId}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            if (dialog.id == null) {
              setItems((list) => [saved, ...list].sort((a, b) => (a.month < b.month ? 1 : -1)));
            } else {
              setItems((list) => list.map((it) => (it.id === saved.id ? saved : it)));
            }
            setDialog(null);
          }}
        />
      )}
      <input type="hidden" value={userId} readOnly />
    </div>
  );
}

/** 当前月份 "YYYY-MM"（客户端本地时区） */
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "YYYY-MM" → 该月 15 号的 Unix 秒（仅供 isRecent 判断新鲜度，取月中避免时区偏差） */
function monthToUnix(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return Math.floor(new Date(y, m - 1, 15).getTime() / 1000);
}

/** 纪事正文换行归一化：CRLF/CR → LF；老站个别条目存的字面 <br> 也视为换行（如 id=1353）。
 *  渲染端做（而非入库端清洗），存量 5005 条无需回洗，编辑回显时同一函数反向一致。 */
export function normalizeHistoryText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/<br\s*\/?>/gi, "\n");
}

/** 写纪事 / 编辑纪事浮窗（新增与编辑复用同一设计） */
function HistoryDialog({
  item,
  authorId,
  onClose,
  onSaved,
}: {
  item?: HistoryItem;
  /** 纪事属主用户 id（草稿按属主隔离；本浮窗仅 editable=true 即本人可开） */
  authorId: number;
  onClose: () => void;
  onSaved: (item: HistoryItem) => void;
}) {
  const isEdit = !!item;
  const [month, setMonth] = useState(item?.month ?? "");
  // 草稿秒级备份：新增按属主 uid、编辑按属主 uid + 纪事 id 隔离
  const draft = useDraft(isEdit && item ? `history:${authorId}:${item.id}` : `history:${authorId}`);
  const [content, setContent] = useState(item?.content ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // 水合后一次性合并草稿（渲染期调整 state——React 官方模式）：
  // 新增态恢复上次未保存草稿；编辑态回落已保存内容（不被旧草稿覆盖）
  const hydrated = useHydrated();
  const [merged, setMerged] = useState(false);
  if (hydrated && !merged) {
    setMerged(true);
    if (!isEdit && draft.value) setContent(draft.value);
  }

  // 合并后键入即写盘（秒级备份）
  useEffect(() => {
    if (!merged) return;
    draft.set(content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merged, content]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(""), 3000);
    return () => clearTimeout(t);
  }, [error]);

  // 新增态默认选中当前月份（2026-10-27 张老师要求）。
  // 挂载后设置而非 useState 初值：SSR 预渲染与客户端可能时区/跨月不一致，避免 hydration 冲突。
  useEffect(() => {
    if (!isEdit) setMonth((m) => m || currentMonth());
  }, [isEdit]);

  async function submit() {
    if (!month) return setError("请选择月份");
    if (!content.trim()) return setError("内容不能为空");
    setBusy(true);
    const res = await fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        isEdit ? { action: "update", id: item!.id, content } : { action: "add", month, content }
      ),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data.error ?? "操作失败");
    if (isEdit) onSaved({ ...item!, content: content.trim() });
    else onSaved({ id: data.id, month, content: content.trim() });
    draft.clear(); // 保存成功清空草稿
  }

  return (
    <div className="history_overlay" onClick={onClose}>
      <div className="history_dialog box" onClick={(e) => e.stopPropagation()}>
        <a
          className="login_close"
          href="#"
          aria-label="关闭"
          onClick={(e) => (e.preventDefault(), onClose())}
        >
          ×
        </a>
        <h1>{isEdit ? "编辑纪事" : "写纪事"}</h1>
        <div className="history_form">
          <label className="history_month">
            月份
            <input
              type="month"
              value={month}
              disabled={isEdit}
              onChange={(e) => setMonth(e.target.value)}
            />
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            maxLength={500}
            placeholder="这个月有什么值得记录的？"
            autoFocus
          />
          <div className="history_form_ops">
            <button className="button active" disabled={busy || !month || !content.trim()} onClick={submit}>
              {busy ? "保存中…" : isEdit ? "保存" : "添加"}
            </button>
            <button className="button" onClick={onClose}>
              取消
            </button>
            {error && <span className="error">{error}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
