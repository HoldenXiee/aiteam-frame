// 小工具：时间/数字/颜色。★ 一律"本地时间"，别混 UTC（纪律㉛ 的教训）

export const pad = (n: number): string => String(n).padStart(2, "0");

export function fmtTime(t: number | null): string {
  if (t === null) return "—";
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtTimeSec(t: number | null): string {
  if (t === null) return "—";
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtDay(t: number | null): string {
  if (t === null) return "—";
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 轴标：跨度大于 36 小时看日期，否则看时分 */
export function axisLabel(t: number, spanMs: number): string {
  const d = new Date(t);
  if (spanMs > 36 * 3600_000) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDur(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}min`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

/** 结局三态：活/挂起/死；其余一律"未声明"（★ 缺数据 ≠ 0） */
export function outcomeKey(s: string): "alive" | "dead" | "parked" | "unsaid" {
  if (s === "活") return "alive";
  if (s === "死") return "dead";
  if (s === "挂起") return "parked";
  return "unsaid";
}

export const OUTCOME_LABEL: Record<string, string> = {
  alive: "活",
  dead: "死",
  parked: "挂起",
  unsaid: "未声明",
};

export function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
