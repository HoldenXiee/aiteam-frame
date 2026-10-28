import { useState } from "react";
import type { Exp } from "../types";
import { clip, fmtDur, fmtTimeSec, outcomeKey, OUTCOME_LABEL } from "../lib/fmt";
import { Rich } from "./Rich";

/** 长文本折叠：★ 默认折叠，但**永远给一句开头**，不让人对着空白标题猜 */
function Fold({ title, text, lines = 6, meta, raw }: { title: string; text: string; lines?: number; meta?: string; raw?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  const body = open ? text : text.split("\n").slice(0, lines).join("\n");
  const more = text.split("\n").length > lines || text.length > 320;
  return (
    <section className="fold">
      <h3>
        {title}
        {meta && <span className="m">{meta}</span>}
      </h3>
      <pre className={open ? "fold-body open" : "fold-body"}>
        {raw ? open ? body : clip(body, 900) : <Rich text={open ? body : clip(body, 900)} />}
      </pre>
      {more && (
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? "收起" : "展开全部"}
        </button>
      )}
    </section>
  );
}

function ExitBadge({ code }: { code: number | null }) {
  if (code === null) return <span className="badge">没记退出码</span>;
  return <span className={code === 0 ? "badge ok" : "badge bad"}>exit {code}</span>;
}

export function ExpDrawer({ e, onClose }: { e: Exp; onClose: () => void }) {
  const k = outcomeKey(e.outcome);
  const sameOutput = e.carriers.length > 1 && new Set(e.carriers.map((c) => c.out)).size === 1;

  return (
    <aside className="drawer" aria-label="实验详情">
      <header className="dr-head">
        <div>
          <p className="eyebrow">
            {e.project} · {e.by || "未记谁做的"} · {fmtTimeSec(e.at)}
          </p>
          <h2>{e.id}</h2>
        </div>
        <button className="close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>

      <div className="chips">
        <span className={`chip k-${k}`}>{OUTCOME_LABEL[k]}</span>
        <span className={e.verdict === "补的" ? "chip warn" : "chip"}>{e.verdict === "未声明" ? "同侪未审" : e.verdict}</span>
        {e.reviewedBy && <span className="chip">复核 {e.reviewedBy}</span>}
        {e.carriers.length > 0 && <span className="chip">{e.carriers.length} 个载体</span>}
        {e.runMs > 0 && <span className="chip">跑时 {fmtDur(e.runMs)}</span>}
      </div>

      <Fold title="猜想 / 这条实验要证什么" text={e.claim} lines={8} />
      <Fold title="判死条件（写成什么样就算它错）" text={e.killCondition} lines={5} />

      <section className="fold">
        <h3>
          跑前写下的预期
          <span className="m">
            {e.preregBeforeRun === null
              ? "PREREG 早于执行：未声明"
              : e.preregBeforeRun
                ? "PREREG 早于执行 ✓"
                : "PREREG 晚于执行 ⚠"}
            {e.expectedAtLine > 0 ? ` · 在 PREREG 第 ${e.expectedAtLine} 行逐字命中` : " · 未在 PREREG 里逐字命中"}
          </span>
        </h3>
        {e.prereg && <p className="path">{e.prereg}</p>}
        <pre className="fold-body open">
          <Rich text={e.expected || "（没写预期）"} />
        </pre>
      </section>

      <h3 className="sec">载体（真跑的命令与输出）</h3>
      {e.carriers.length === 0 && <p className="note">这条实验**没记载体** —— 没记 ≠ 没跑。</p>}
      {sameOutput && <p className="note">几个载体的输出逐字相同（页面照实显示，不合并）。</p>}
      {e.carriers.map((c, i) => (
        <article className="carrier" key={i}>
          <div className="carrier-head">
            <b>载体 {String.fromCharCode(65 + i)}</b>
            <span className="path">{c.dir || "（没记目录）"}</span>
            <ExitBadge code={c.exit} />
            <span className="badge">{c.ms === null ? "耗时没记" : fmtDur(c.ms)}</span>
          </div>
          <pre className="cmd">$ {c.cmd || "（没记命令）"}</pre>
          {c.out.trim() ? <Fold title={`输出 ${c.outLines} 行`} text={c.out} lines={18} raw /> : <p className="note">没记输出（★ 缺数据 ≠ 0）</p>}
        </article>
      ))}

      {e.control && (
        <>
          <h3 className="sec">对照（预期失败的那次）</h3>
          <article className="carrier">
            <div className="carrier-head">
              <span className="path">{e.control.dir}</span>
              <ExitBadge code={e.control.exit} />
              <span className="badge">{fmtTimeSec(e.control.at)}</span>
            </div>
            <pre className="cmd">$ {e.control.cmd}</pre>
          </article>
        </>
      )}
      {e.controlAbsent && <p className="note">对照缺席的理由：{e.controlAbsent}</p>}

      <h3 className="sec">检验出了什么</h3>
      <Fold
        title="现象（它自己说发现了什么）"
        text={e.phenomenon || (e.phenomenonAbsent ? `（${e.phenomenonAbsent}）` : "（空）")}
        lines={8}
        meta={e.reviewNote ? `同侪备注：${clip(e.reviewNote, 60)}` : undefined}
      />
      <Fold title="模型（能解释现象的机制）" text={e.model} lines={4} />
      <Fold title="外部核对（跟别人的说法对不对得上）" text={e.externalCheck} lines={4} />

      <h3 className="sec">猜想状态</h3>
      <p className="kv">
        <span className="k">状态</span>
        <span>{e.conjectureState}</span>
      </p>
      <Fold title="猜想原文" text={e.conjecture} lines={3} />
      <Fold title="支撑这猜想的证据" text={e.conjectureEvidence} lines={3} />

      <h3 className="sec">来源</h3>
      <ul className="src">
        {e.source
          .split(/\s*·\s*|\n/)
          .filter(Boolean)
          .map((s, i) => (
            <li key={i}>
              {/^https?:\/\//.test(s) ? (
                <a href={s} target="_blank" rel="noreferrer">
                  {s}
                </a>
              ) : (
                <code>{s}</code>
              )}
            </li>
          ))}
        {!e.source && <li className="dim">（没记来源）</li>}
      </ul>
    </aside>
  );
}
