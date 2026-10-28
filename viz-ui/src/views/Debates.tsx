import { useState } from "react";
import type { VizData } from "../types";
import { clip, fmtTime, fmtTimeSec } from "../lib/fmt";

/** 争辩：谁挑战谁、判了什么。★ 判决词是集群自己写的，页面不改写 */
export function Debates({ data }: { data: VizData }) {
  const [open, setOpen] = useState<number | null>(null);
  const rows = [...data.challenges].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const byVerdict = new Map<string, number>();
  for (const r of rows) byVerdict.set(r.verdict, (byVerdict.get(r.verdict) ?? 0) + 1);

  return (
    <div className="debates">
      <div className="statrow">
        {[...byVerdict.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => (
            <div key={k}>
              <b>{n}</b>
              <span>{k}</span>
            </div>
          ))}
        <div>
          <b>{data.debates.length}</b>
          <span>长文辩论</span>
        </div>
      </div>

      <ul className="deb-list">
        {rows.map((r, i) => (
          <li key={i} className={open === i ? "on" : ""}>
            <button className="deb-head" onClick={() => setOpen(open === i ? null : i)}>
              <span className="mono dim">{fmtTimeSec(r.at)}</span>
              <span className="who">
                {r.by} <span className="dim">→</span> {r.to}
              </span>
              <span className={r.verdict === "补的" ? "chip warn" : "chip"}>{r.verdict}</span>
              <span className="deb-claim">{clip(r.claim, 90)}</span>
            </button>
            {open === i && (
              <div className="deb-body">
                <p className="path">{r.artifact}</p>
                <pre className="doc">{r.claim}</pre>
              </div>
            )}
          </li>
        ))}
      </ul>

      {data.debates.length > 0 && (
        <>
          <h2 className="sec">长文辩论（{data.debates.length} 段 · 共 {data.debates.reduce((a, d) => a + d.chars, 0).toLocaleString()} 字）</h2>
          {data.debates.map((d, i) => (
            <details key={i} className="longdeb">
              <summary>
                <span className="mono dim">{fmtTime(d.at)}</span> → {d.to} · {d.chars} 字
              </summary>
              <pre className="doc">{d.text}</pre>
            </details>
          ))}
        </>
      )}
    </div>
  );
}
