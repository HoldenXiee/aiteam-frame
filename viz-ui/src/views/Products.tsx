import { useMemo, useState } from "react";
import type { VizData } from "../types";
import { clip, fmtTime } from "../lib/fmt";

/** 产物：左列表可搜全文，右侧读全文。★ 不做摘要 —— 设计者要看原始文字 */
export function Products({ data }: { data: VizData }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s
      ? data.products.filter((p) => p.name.toLowerCase().includes(s) || p.text.toLowerCase().includes(s))
      : data.products;
    return [...list].sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  }, [data.products, q]);

  const cur = rows.find((p) => p.name === sel) ?? rows[0] ?? null;

  return (
    <div className="split">
      <div className="split-list">
        <input placeholder="搜标题或全文" value={q} onChange={(e) => setQ(e.target.value)} />
        <p className="count">
          {rows.length} / {data.products.length} 份
        </p>
        <ul>
          {rows.slice(0, 400).map((p) => (
            <li key={p.name} className={cur?.name === p.name ? "on" : ""} onClick={() => setSel(p.name)}>
              <b>{clip(p.name.replace(/\.md$/, ""), 46)}</b>
              <span className="dim">
                {fmtTime(p.t)} · {p.kb}KB
                {p.cites.length > 0 && ` · 引 ${p.cites.length} 条实验`}
              </span>
            </li>
          ))}
        </ul>
        {rows.length > 400 && <p className="note">只列出最近 400 份（用搜索缩小范围）</p>}
      </div>
      <div className="split-read">
        {cur ? (
          <>
            <h2>{cur.name.replace(/\.md$/, "")}</h2>
            <p className="dim">
              {fmtTime(cur.t)} · {cur.kb}KB{cur.cites.length > 0 && ` · 提到 ${cur.cites.join(" ")}`}
            </p>
            <pre className="doc">{cur.text}</pre>
          </>
        ) : (
          <p className="note">没有匹配的产物</p>
        )}
      </div>
    </div>
  );
}
