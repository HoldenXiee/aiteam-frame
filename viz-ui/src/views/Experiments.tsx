import { useMemo, useState } from "react";
import type { Exp, VizData } from "../types";
import { clip, fmtDur, fmtTime, outcomeKey, OUTCOME_LABEL } from "../lib/fmt";
import { Rich } from "../components/Rich";

/**
 * 「实验」页签：**表格 + 卡片**两个形态（设计者裁定「两个都要」）。
 *
 * ★ 为什么表格是主形态：134 条要能一眼比较（结局/判决/载体数/时长并排）。
 * ★ 卡片是"读一条"的形态：字段分行，适合逐条细看。
 */

type SortKey = "at" | "id" | "carriers" | "runMs";
const OUT: { key: string; label: string }[] = [
  { key: "", label: "全部结局" },
  { key: "alive", label: "活" },
  { key: "dead", label: "死" },
  { key: "parked", label: "挂起" },
  { key: "unsaid", label: "未声明" },
];
const VER: { key: string; label: string }[] = [
  { key: "", label: "全部判决" },
  { key: "真意外", label: "真意外" },
  { key: "补的", label: "补的" },
  { key: "未审", label: "未审" },
];

export function Experiments({ data, selected, onPick }: { data: VizData; selected: string | null; onPick: (id: string) => void }) {
  const [mode, setMode] = useState<"table" | "cards">(
    new URLSearchParams(location.search).get("mode") === "cards" ? "cards" : "table",
  );
  const [q, setQ] = useState("");
  const [proj, setProj] = useState("");
  const [out, setOut] = useState("");
  const [ver, setVer] = useState("");
  const [onlyOut, setOnlyOut] = useState(false);
  const [sort, setSort] = useState<SortKey>("at");
  const [desc, setDesc] = useState(true);

  const rows = useMemo(() => {
    const key = (e: Exp): number | string => {
      if (sort === "at") return e.at ?? 0;
      if (sort === "id") return Number(e.id.replace(/\D/g, "")) || 0;
      if (sort === "carriers") return e.carriers.length;
      return e.runMs;
    };
    return data.experiments
      .filter((e) => {
        if (proj && e.project !== proj) return false;
        if (out && outcomeKey(e.outcome) !== out) return false;
        if (ver && e.verdict !== ver) return false;
        if (onlyOut && !e.carriers.some((c) => c.out.trim())) return false;
        if (q) {
          const hay = `${e.id} ${e.project} ${e.by} ${e.claim} ${e.phenomenon} ${e.expected}`.toLowerCase();
          if (!hay.includes(q.toLowerCase())) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        const r = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
        return desc ? -r : r;
      });
  }, [data.experiments, proj, out, ver, onlyOut, q, sort, desc]);

  const th = (k: SortKey, label: string): JSX.Element => (
    <th
      onClick={() => {
        if (sort === k) setDesc(!desc);
        else {
          setSort(k);
          setDesc(k !== "id");
        }
      }}
      className={sort === k ? "sorted" : ""}
    >
      {label}
      {sort === k ? (desc ? " ↓" : " ↑") : ""}
    </th>
  );

  return (
    <div className="exps">
      <div className="filters">
        <input placeholder="搜 claim / 现象 / 预期 / 编号 / 谁做的" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={proj} onChange={(e) => setProj(e.target.value)}>
          <option value="">全部项目</option>
          {data.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}（{p.n}）
            </option>
          ))}
        </select>
        <select value={out} onChange={(e) => setOut(e.target.value)}>
          {OUT.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <select value={ver} onChange={(e) => setVer(e.target.value)}>
          {VER.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={onlyOut} onChange={(e) => setOnlyOut(e.target.checked)} />
          只看记了输出的
        </label>
        <div className="seg small">
          <button className={mode === "table" ? "on" : ""} onClick={() => setMode("table")}>
            表格
          </button>
          <button className={mode === "cards" ? "on" : ""} onClick={() => setMode("cards")}>
            卡片
          </button>
        </div>
        <span className="count">
          {rows.length} / {data.experiments.length} 条
        </span>
      </div>

      {mode === "table" ? (
        <table className="tbl">
          <thead>
            <tr>
              {th("id", "编号")}
              <th>项目</th>
              <th className="wide">这条实验在测什么（claim）</th>
              <th>结局</th>
              <th>同侪判决</th>
              {th("carriers", "载体")}
              {th("runMs", "跑时")}
              {th("at", "时间")}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className={selected === e.id ? "on" : ""} onClick={() => onPick(e.id)}>
                <td className="mono">{e.id}</td>
                <td className="mono dim">{e.project}</td>
                <td className="wide">{clip(e.claim, 80)}</td>
                <td>
                  <span className={`chip k-${outcomeKey(e.outcome)}`}>{OUTCOME_LABEL[outcomeKey(e.outcome)]}</span>
                </td>
                <td>{e.verdict === "未声明" ? <span className="dim">未审</span> : e.verdict}</td>
                <td className="mono">{e.carriers.length || "—"}</td>
                <td className="mono">{e.runMs ? fmtDur(e.runMs) : "—"}</td>
                <td className="mono dim">{fmtTime(e.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="cards">
          {rows.map((e) => (
            <article key={e.id} className={selected === e.id ? "card on" : "card"} onClick={() => onPick(e.id)}>
              <header>
                <b className="mono">{e.id}</b>
                <span className="mono dim">{e.project}</span>
                <span className={`chip k-${outcomeKey(e.outcome)}`}>{OUTCOME_LABEL[outcomeKey(e.outcome)]}</span>
                <span className="dim">{fmtTime(e.at)}</span>
              </header>
              <p className="claim"><Rich text={clip(e.claim, 220)} /></p>
              <footer>
                <span>{e.verdict === "未声明" ? "同侪未审" : e.verdict}</span>
                <span>{e.carriers.length} 个载体</span>
                <span>{e.carriers.some((c) => c.out.trim()) ? "有真实输出" : "没记输出"}</span>
                {e.expectedAtLine > 0 && <span>预期在 PREREG 第 {e.expectedAtLine} 行</span>}
              </footer>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
