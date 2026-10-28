import type { LoadState } from "../lib/useData";

/**
 * 首屏 / 出错页。
 * ★ 空状态要告诉人「下一步点哪里」，而不是一句"暂无数据"。
 */
export function Gate({ state, onPick }: { state: LoadState; onPick: (f: File) => void }) {
  let last: { name: string; at: number; counts: Record<string, number> } | null = null;
  try {
    const s = localStorage.getItem("viz:last");
    if (s) last = JSON.parse(s);
  } catch {
    last = null;
  }

  return (
    <div className="gate">
      <div className="gate-inner">
        <p className="eyebrow">hunt · 研究数据</p>
        <h1>把这一轮的研究摊开看</h1>
        <p className="lede">
          先跑 <code>可视化数据生成.cmd</code>，它会写出一个 <code>hunt.json</code>；
          把那个文件选进来（或者直接拖进这个窗口）。
        </p>

        <label className="pick">
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPick(f);
            }}
          />
          <span>选择 hunt.json</span>
        </label>

        {state.kind === "loading" && <p className="note">读着……</p>}

        {state.kind === "error" && (
          <div className="oops">
            <b>读不了这个文件</b>
            <p>{state.message}</p>
          </div>
        )}

        {last && (
          <p className="note">
            上次载入：{last.name} · {new Date(last.at).toLocaleString()} ·{" "}
            {Object.entries(last.counts)
              .slice(0, 4)
              .map(([k, v]) => `${k} ${v}`)
              .join(" · ")}
            <br />
            <span className="dim">（只记了文件名和条数 —— 6MB 数据不往浏览器存储里塞）</span>
          </p>
        )}

        <dl className="facts">
          <div>
            <dt>数据里有什么</dt>
            <dd>
              134 条结构化实验（含每条实验的载体命令、真实输出、退出码、耗时）、485 份产物全文、
              270 次争辩、37 次出生封口、102 次真跑记录、成本行与拓扑事件
            </dd>
          </div>
          <div>
            <dt>它不做什么</dt>
            <dd>不替你判断"这条研究好不好" —— 结局与判决照抄账本，页面只负责摆出来</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
