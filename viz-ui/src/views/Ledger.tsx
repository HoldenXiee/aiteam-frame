import { useMemo } from "react";
import type { VizData } from "../types";
import { fmtDay, fmtDur, fmtTime, fmtTimeSec, kb } from "../lib/fmt";

/** 账本页：他到底记了什么、缺了什么、花了多少、库漂了多少 */
export function Ledger({ data }: { data: VizData }) {
  // 成本：心跳里的 cost 行（★ 有些行明写"成本未声明" —— 那是缺数据，不画 0）
  const costs = data.cost.filter((c) => c.usd !== null);
  const costSum = costs.reduce((a, c) => a + (c.usd ?? 0), 0);
  const tokSum = data.cost.reduce((a, c) => a + (c.tokM ?? 0), 0);

  // 活动密度：按小时聚合拓扑事件（★ 只在账本页画柱，不塞进时间轴 —— 那是另一件事）
  const hours = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of data.events) {
      if (e.t === null) continue;
      const h = Math.floor(e.t / 3600_000) * 3600_000;
      m.set(h, (m.get(h) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [data.events]);
  const maxHour = Math.max(1, ...hours.map(([, n]) => n));

  const sealMs = data.seals.filter((s) => s.ms !== null).map((s) => s.ms as number);
  const avgSeal = sealMs.length ? Math.round(sealMs.reduce((a, b) => a + b, 0) / sealMs.length) : null;

  const kindCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of data.events) {
      const k = e.sub ? `${e.kind}:${e.sub}` : e.kind;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  }, [data.events]);

  return (
    <div className="ledger">
      <section>
        <h2>数据从哪来</h2>
        <p className="note">
          {data.meta.lab} · 导出于 {fmtTimeSec(data.meta.generatedAt)}
          {data.meta.warn.length > 0 && ` · ⚠ 缺账 ${data.meta.warn.length} 处`}
        </p>
        <table className="tbl tight">
          <thead>
            <tr>
              <th>账本</th>
              <th>条数</th>
              <th>字节</th>
            </tr>
          </thead>
          <tbody>
            {data.meta.sources.map((s) => (
              <tr key={s.name}>
                <td className="mono">{s.name}</td>
                <td className="mono">{s.rows}</td>
                <td className="mono dim">{s.bytes ? kb(s.bytes) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.meta.warn.length > 0 && (
          <ul className="warn">
            {data.meta.warn.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>成本</h2>
        {/* ★★★ 这里必须分两栏说：有金额的合计，和"明说未声明"的行 —— 混起来就成了假读数 */}
        <p className="metric">
          <b>${costSum.toFixed(2)}</b> <span className="dim">只能算 {costs.length} / {data.cost.length} 行</span> ·{" "}
          <b>{tokSum.toFixed(1)}M</b> token <span className="dim">（同样只来自那几行）</span>
        </p>
        <p className="note">
          {data.cost.length - costs.length > 0 &&
            `另外 ${data.cost.length - costs.length} 行原话是「成本未声明（agent.usage 拿不到）」—— 那是缺数据，不是 0。`}
          {" 心跳日志里的成本行没有时间戳，所以这一栏不按时间画。"}
        </p>
        <ul className="cost">
          {data.cost.slice(-12).map((c, i) => (
            <li key={i}>
              <span>{c.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>集群在动吗（每小时事件数）</h2>
        <div className="hist">
          {hours.map(([h, n]) => (
            <i key={h} style={{ height: `${(n / maxHour) * 100}%` }} title={`${fmtDay(h)} ${new Date(h).getHours()}:00 · ${n} 条`} />
          ))}
        </div>
        {hours.length > 0 && (
          <p className="haxis">
            <span>{`${fmtDay(hours[0][0])} ${new Date(hours[0][0]).getHours()}:00`}</span>
            <span className="dim">
              {hours.length} 个小时 · 每小时事件数（最高的那根 = {maxHour}）
            </span>
            <span>{`${fmtDay(hours[hours.length - 1][0])} ${new Date(hours[hours.length - 1][0]).getHours()}:00`}</span>
          </p>
        )}
        <p className="note">
          {data.events.length} 条拓扑事件 · 峰值 {maxHour} 条/小时 · 高频事件：
          {kindCount
            .slice(0, 6)
            .map(([k, n]) => `${k} ${n}`)
            .join(" · ")}
        </p>
      </section>

      <section>
        <h2>出生封口（{data.seals.length} 次）</h2>
        <p className="note">封口 = 开跑前把 PREREG/驱动/判据的指纹钉死；平均窗口 {avgSeal === null ? "没记" : fmtDur(avgSeal)}</p>
        <table className="tbl tight">
          <thead>
            <tr>
              <th>批次</th>
              <th>PREREG</th>
              <th>窗口</th>
              <th>写入行</th>
            </tr>
          </thead>
          <tbody>
            {[...data.seals]
              .sort((a, b) => (b.t0 ?? 0) - (a.t0 ?? 0))
              .slice(0, 12)
              .map((s, i) => (
                <tr key={i}>
                  <td className="mono">{s.batch}</td>
                  <td className="mono dim">{s.prereg}</td>
                  <td className="mono">{fmtDur(s.ms)}</td>
                  <td className="mono">{s.rowsWritten ?? "—"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>集群自己那份 lib 漂了多少（{data.librev.length} 次修订）</h2>
        <p className="note">每次修订记 6 个面的内容哈希 —— 变了就是它改了自己的库（要不要合回主库由助手决定）</p>
        <ul className="revs">
          {data.librev.slice(-10).map((r, i) => (
            <li key={i}>
              <span className="mono dim">{fmtTime(r.at)}</span>
              <code>{r.fp}</code>
              <span className="dim">{r.files} 个面</span>
              <span>{r.note}</span>
            </li>
          ))}
        </ul>
      </section>

      {data.errata.length > 0 && (
        <section>
          <h2>勘误（{data.errata.length} 条）</h2>
          <table className="tbl tight">
            <thead>
              <tr>
                <th>编号</th>
                <th>错在哪</th>
                <th>谁提的</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {data.errata.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{e.id}</td>
                  <td className="mono dim">{e.wrong}</td>
                  <td>{e.by}</td>
                  <td>{e.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2>设计者投递的外部材料（{data.external.length} 份）</h2>
        <p className="note">这是集群的**输入**，不是产出 —— 放进来看的是"它有没有把材料读进去"</p>
        <ul className="ext">
          {data.external.map((e) => (
            <li key={e.name}>
              <b>{e.name}</b>
              <span className="dim">
                {fmtTime(e.t)} · {e.kb}KB
              </span>
              <pre className="doc">{e.text.slice(0, 1200)}</pre>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
