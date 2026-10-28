import { useEffect, useState } from "react";
import { useData } from "./lib/useData";
import { Gate } from "./components/Gate";
import { Timeline } from "./views/Timeline";
import { Experiments } from "./views/Experiments";
import { Products } from "./views/Products";
import { Debates } from "./views/Debates";
import { Ledger } from "./views/Ledger";
import { ExpDrawer } from "./components/ExpDrawer";
import { fmtDay, fmtTime } from "./lib/fmt";

type Tab = "timeline" | "exps" | "products" | "debates" | "ledger";
const TABS: { id: Tab; label: string }[] = [
  { id: "timeline", label: "时间轴" },
  { id: "exps", label: "实验" },
  { id: "products", label: "产物" },
  { id: "debates", label: "争辩" },
  { id: "ledger", label: "账本" },
];

export default function App() {
  const [state, pick] = useData();
  const [tab, setTab] = useState<Tab>("timeline");
  const [sel, setSel] = useState<string | null>(null);

  // ★ URL 直达（`?tab=exps&pick=E134`）：截图验收与"指给别人看某一条"都要用
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const t = p.get("tab");
    if (t && TABS.some((x) => x.id === t)) setTab(t as Tab);
    const k = p.get("pick");
    if (k) setSel(k);
  }, []);

  if (state.kind !== "ready") return <Gate state={state} onPick={(f) => void pick(f)} />;

  const d = state.data;
  const selExp = sel ? d.experiments.find((e) => e.id === sel) ?? null : null;
  const onPick = (id: string): void => setSel((cur) => (cur === id ? null : id));

  return (
    <div className={selExp ? "app with-drawer" : "app"}>
      <header className="top">
        <div className="brand">
          <h1>hunt · 研究数据</h1>
          <p className="meta">
            {fmtDay(d.span.t0)} → {fmtDay(d.span.t1)} · 实验 {d.experiments.length} · 产物 {d.products.length} · 争辩{" "}
            {d.challenges.length} · <span className="dim">{state.source}</span>
          </p>
        </div>

        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === "exps" && <span className="n">{d.experiments.length}</span>}
              {t.id === "products" && <span className="n">{d.products.length}</span>}
              {t.id === "debates" && <span className="n">{d.challenges.length}</span>}
            </button>
          ))}
        </nav>

        <label className="reload">
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pick(f);
            }}
          />
          <span>换一份数据</span>
        </label>
      </header>

      <main>
        {tab === "timeline" && <Timeline data={d} selected={sel} onPick={onPick} />}
        {tab === "exps" && <Experiments data={d} selected={sel} onPick={onPick} />}
        {tab === "products" && <Products data={d} />}
        {tab === "debates" && <Debates data={d} />}
        {tab === "ledger" && <Ledger data={d} />}
      </main>

      {selExp && (
        <ExpDrawer
          e={selExp}
          onClose={() => {
            setSel(null);
          }}
        />
      )}

      <footer className="foot">
        <span>
          数据文件生成于 {fmtTime(d.meta.generatedAt)} · 页面不联网、不改数据
        </span>
        <span className="dim">点圆点或表格行看实验内部；拖图面平移</span>
      </footer>
    </div>
  );
}
