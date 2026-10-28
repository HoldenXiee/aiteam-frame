import { useEffect, useRef, useState } from "react";
import type { Exp, VizData } from "../types";
import { axisLabel, clip, fmtDur, fmtTime, outcomeKey } from "../lib/fmt";

/**
 * 时间轴 —— 第一屏。
 *
 * ★★★ 低密度的三个做法（设计者：「信息密度降低一点，不要太拥挤」）：
 *   ① 行里只有点与 E 号，没有别的字；
 *   ② 默认只开 24 小时，要看全程点「全部」；
 *   ③ ★ **同一位置的点聚成簇**：一个圆里写「几条」，点它就放大到那个时刻。
 *      —— 这是关键：134 条实验有一半集中在几个钟头里，硬画就是一坨墨。
 *
 * ★★ 按需加载（设计者：「可能数据量大，所以要考虑按需加载」）：
 *   只渲染落在窗口（±10% 缓冲）里的元素，窗口外不进 DOM。
 */

type Win = { w0: number; w1: number };
const PRESETS: { label: string; ms: number | null }[] = [
  { label: "全部", ms: null },
  { label: "7 天", ms: 7 * 86400_000 },
  { label: "24 小时", ms: 86400_000 },
  { label: "6 小时", ms: 6 * 3600_000 },
  { label: "1 小时", ms: 3600_000 },
];

const LABEL_W = 118;
/** 两个点在屏幕上小于这个距离 ⇒ 合成一簇（★ 阈值 = 圆点直径 + 间隙，再小就一定重叠） */
const CLUSTER_PX = 15;

interface Cluster {
  x: number;
  ids: Exp[];
}

export function Timeline({ data, selected, onPick }: { data: VizData; selected: string | null; onPick: (id: string) => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(1000);
  const [h, setH] = useState(520);

  const t1 = data.span.t1;
  const t0 = data.span.t0;
  const [win, setWin] = useState<Win>(() => ({ w0: Math.max(t0, t1 - 86400_000), w1: t1 }));
  const [preset, setPreset] = useState(presetOf(t1 - Math.max(t0, t1 - 86400_000)));

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      setW(Math.max(520, es[0].contentRect.width));
      setH(Math.max(420, es[0].contentRect.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const span = win.w1 - win.w0;
  const plotW = Math.max(200, w - LABEL_W - 20);
  const x = (t: number): number => LABEL_W + ((t - win.w0) / span) * plotW;
  const inside = (t: number | null): boolean => t !== null && t >= win.w0 - span * 0.1 && t <= win.w1 + span * 0.1;

  const applyPreset = (label: string): void => {
    const p = PRESETS.find((v) => v.label === label);
    if (!p) return;
    setPreset(label);
    if (p.ms === null) setWin({ w0: t0, w1: t1 });
    else setWin({ w0: Math.max(t0, t1 - p.ms), w1: t1 });
  };

  /** 放大到某个区间的中心（点簇时用） */
  const zoomTo = (center: number, halfMs: number): void => {
    const w0 = Math.max(t0, center - halfMs);
    const w1 = Math.min(t1, center + halfMs);
    setWin({ w0, w1 });
    setPreset(presetOf(w1 - w0));
  };

  // ── 拖动平移 ──
  const drag = useRef<{ x: number; win: Win; moved: boolean } | null>(null);
  const onDown = (e: React.PointerEvent): void => {
    drag.current = { x: e.clientX, win, moved: false };
  };
  const onMove = (e: React.PointerEvent): void => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 3) d.moved = true;
    const shift = (-dx / plotW) * (d.win.w1 - d.win.w0);
    let w0 = d.win.w0 + shift;
    let w1 = d.win.w1 + shift;
    const L = w1 - w0;
    if (w0 < t0) {
      w0 = t0;
      w1 = t0 + L;
    }
    if (w1 > t1) {
      w1 = t1;
      w0 = t1 - L;
    }
    setWin({ w0, w1 });
  };
  const onUp = (): void => {
    drag.current = null;
  };

  // ── 车道：窗口内没有实验的项目不占地方（★ 但要报一句，别让人以为它不存在） ──
  const expsIn = data.experiments.filter((e) => inside(e.at));
  const activeProjects = data.projects.filter((p) => expsIn.some((e) => e.project === p.id));
  const idleProjects = data.projects.filter((p) => !expsIn.some((e) => e.project === p.id));
  const runsIn = data.runs.filter((r) => inside(r.at));
  const prodsIn = data.products.filter((p) => inside(p.t));
  const debIn = data.challenges.filter((c) => inside(c.at));

  const axisH = 44;
  const lanes = activeProjects.length + 3;
  const laneH = Math.max(46, Math.min(110, Math.floor((h - axisH - 8) / Math.max(1, lanes))));
  const laneY = (i: number): number => axisH + i * laneH;
  const runIdx = activeProjects.length;
  const prodIdx = activeProjects.length + 1;
  const debIdx = activeProjects.length + 2;
  const H = laneY(debIdx) + laneH;

  // 轴标
  const ticks: number[] = [];
  const nTicks = Math.max(3, Math.min(8, Math.floor(plotW / 120)));
  for (let i = 0; i <= nTicks; i++) ticks.push(win.w0 + (span * i) / nTicks);

  // 每日分隔
  const days: number[] = [];
  {
    const d = new Date(win.w0);
    d.setHours(0, 0, 0, 0);
    for (let t = d.getTime() + 86400_000; t < win.w1; t += 86400_000) if (t > win.w0) days.push(t);
  }

  /** 把一条车道上的实验按 x 聚簇（★ 同簇里数 >=2 就只有一个带数字的圆） */
  const clustersOf = (list: Exp[]): Cluster[] => {
    const sorted = [...list].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const out: Cluster[] = [];
    for (const e of sorted) {
      const cx = x(e.at as number);
      const last = out[out.length - 1];
      if (last && cx - last.x < CLUSTER_PX) last.ids.push(e);
      else out.push({ x: cx, ids: [e] });
    }
    return out;
  };

  return (
    <div className="tl">
      <div className="tl-bar">
        <div className="seg" role="group" aria-label="时间窗口">
          {PRESETS.map((p) => (
            <button key={p.label} className={preset === p.label ? "on" : ""} onClick={() => applyPreset(p.label)}>
              {p.label}
            </button>
          ))}
        </div>
        <p className="tl-hint">
          拖图面平移 · 点圆看实验内部 · 点带数字的圆放大到那一刻 · 当前 {fmtTime(win.w0)} → {fmtTime(win.w1)}（{fmtDur(span)}）
        </p>
      </div>

      <div className="tl-host" ref={hostRef}>
        <svg width={w} height={H} className="tl-svg" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {days.map((t) => (
            <line key={t} x1={x(t)} y1={axisH - 8} x2={x(t)} y2={H - 6} className="tl-day" />
          ))}

          {ticks.map((t, i) => (
            <text key={i} x={x(t)} y={22} className="tl-tick" textAnchor={i === 0 ? "start" : i === nTicks ? "end" : "middle"}>
              {axisLabel(t, span)}
            </text>
          ))}
          <line x1={LABEL_W} y1={axisH - 12} x2={LABEL_W + plotW} y2={axisH - 12} className="tl-rule" />

          {activeProjects.map((p, i) => {
            const cy = laneY(i) + laneH / 2;
            const clusters = clustersOf(expsIn.filter((e) => e.project === p.id));
            return (
              <g key={p.id}>
                <text x={0} y={cy - 3} className="lane-name">
                  {p.id}
                </text>
                <text x={0} y={cy + 13} className="lane-sub">
                  窗口 {clusters.reduce((a, c) => a + c.ids.length, 0)} / 共 {p.n}
                </text>
                <line x1={LABEL_W} y1={laneY(i) + laneH - 1} x2={LABEL_W + plotW} y2={laneY(i) + laneH - 1} className="lane-base" />
                {clusters.map((c, ci) =>
                  c.ids.length === 1 ? (
                    <SingleDot key={ci} e={c.ids[0]} cx={c.x} cy={cy} selected={selected === c.ids[0].id} onPick={onPick} />
                  ) : (
                    <g
                      key={ci}
                      className="dot-g"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (drag.current?.moved !== true) zoomTo(c.ids[0].at as number, Math.max(900_000, span / 8));
                      }}
                    >
                      <title>{`${c.ids.length} 条实验（点一下放大到这一刻）\n${c.ids.map((e) => `${e.id} ${e.outcome}`).join("\n")}`}</title>
                      <circle
                        cx={c.x}
                        cy={cy}
                        r={8.5}
                        className={
                          "cluster " +
                          (c.ids.some((e) => e.outcome === "死")
                            ? "cluster-dead"
                            : c.ids.some((e) => e.verdict === "补的")
                              ? "cluster-warn"
                              : "")
                        }
                      />
                      <text x={c.x} y={cy + 3.4} className="cluster-n" textAnchor="middle">
                        {c.ids.length}
                      </text>
                    </g>
                  ),
                )}
              </g>
            );
          })}

          {/* 运行车道：载体真跑，长度 = 耗时 */}
          <g>
            <text x={0} y={laneY(runIdx) + laneH / 2 - 3} className="lane-name">
              运行
            </text>
            <text x={0} y={laneY(runIdx) + laneH / 2 + 13} className="lane-sub">
              {runsIn.length} 次
            </text>
            <line x1={LABEL_W} y1={laneY(runIdx) + laneH - 1} x2={LABEL_W + plotW} y2={laneY(runIdx) + laneH - 1} className="lane-base" />
            {runsIn.map((r, i) => {
              const bx = x(r.at as number);
              const bw = Math.max(3, ((r.ms ?? 0) / span) * plotW);
              return (
                <rect
                  key={i}
                  x={bx}
                  y={laneY(runIdx) + laneH / 2 - 8}
                  width={Math.min(bw, plotW)}
                  height={16}
                  rx={1.5}
                  className={r.exit === 0 ? "run-ok" : "run-bad"}
                >
                  <title>{`${r.cmd}\nexit ${r.exit ?? "?"} · ${fmtDur(r.ms)}\n${r.carrier}\n${clip(r.claim, 80)}`}</title>
                </rect>
              );
            })}
          </g>

          {/* 产物车道 */}
          <g>
            <text x={0} y={laneY(prodIdx) + laneH / 2 - 3} className="lane-name">
              产物
            </text>
            <text x={0} y={laneY(prodIdx) + laneH / 2 + 13} className="lane-sub">
              {prodsIn.length} 份
            </text>
            <line x1={LABEL_W} y1={laneY(prodIdx) + laneH - 1} x2={LABEL_W + plotW} y2={laneY(prodIdx) + laneH - 1} className="lane-base" />
            {prodsIn.map((p, i) => (
              <rect key={i} x={x(p.t as number)} y={laneY(prodIdx) + laneH / 2 - 11} width={1.8} height={22} className="prod-tick">
                <title>{`${p.name}\n${fmtTime(p.t)} · ${p.kb}KB`}</title>
              </rect>
            ))}
          </g>

          {/* 争辩车道 */}
          <g>
            <text x={0} y={laneY(debIdx) + laneH / 2 - 3} className="lane-name">
              争辩
            </text>
            <text x={0} y={laneY(debIdx) + laneH / 2 + 13} className="lane-sub">
              {debIn.length} 次
            </text>
            <line x1={LABEL_W} y1={laneY(debIdx) + laneH - 1} x2={LABEL_W + plotW} y2={laneY(debIdx) + laneH - 1} className="lane-base" />
            {debIn.map((c, i) => (
              <rect key={i} x={x(c.at as number)} y={laneY(debIdx) + laneH / 2 - 3.5} width={7} height={7} className="deb-sq">
                <title>{`${c.by} → ${c.to}\n判决：${c.verdict}\n${clip(c.claim, 100)}`}</title>
              </rect>
            ))}
          </g>
        </svg>
      </div>

      <div className="tl-foot">
        <ul className="legend">
          <li>
            <i className="k-alive" /> 活
          </li>
          <li>
            <i className="k-parked" /> 挂起
          </li>
          <li>
            <i className="k-dead" /> 死
          </li>
          <li>
            <i className="k-ring" /> 判「补的」
          </li>
          <li>
            <i className="k-cluster" /> 簇（数字 = 这一刻有几条）
          </li>
          <li>
            <i className="k-run" /> 载体真跑（长度 = 耗时，红 = 退出码非 0）
          </li>
        </ul>
        {idleProjects.length > 0 && (
          <p className="note">
            窗口内没有实验的项目：{idleProjects.map((p) => p.id).join(" · ")}
            <span className="dim">（不是没在做，是这个时段它没落账）</span>
          </p>
        )}
      </div>
    </div>
  );
}

/** 单条实验：★ 只有"点 + E 号"，选中时加一个圈 */
function SingleDot({ e, cx, cy, selected, onPick }: { e: Exp; cx: number; cy: number; selected: boolean; onPick: (id: string) => void }) {
  const k = outcomeKey(e.outcome);
  return (
    <g
      className="dot-g"
      onClick={(ev) => {
        ev.stopPropagation();
        onPick(e.id);
      }}
    >
      <title>{`${e.id} · ${e.outcome}${e.verdict !== "未声明" ? ` · ${e.verdict}` : ""}\n${clip(e.claim, 90)}`}</title>
      {selected && <circle cx={cx} cy={cy} r={9} className="dot-sel" />}
      <circle cx={cx} cy={cy} r={4.6} className={`dot dot-${k}`} />
      {e.verdict === "补的" && <circle cx={cx} cy={cy} r={7.4} className="dot-ring" />}
      <text x={cx + 8} y={cy + 3.6} className="dot-id">
        {e.id}
      </text>
    </g>
  );
}

function presetOf(spanMs: number): string {
  const day = 86400_000;
  if (spanMs >= 9 * day) return "全部";
  if (spanMs >= 6 * day) return "7 天";
  if (spanMs >= 20 * 3600_000) return "24 小时";
  if (spanMs >= 4 * 3600_000) return "6 小时";
  return "1 小时";
}

