// 数据契约（与 research/clusters/micro/vizdata.ts 一一对应）
// ★ 只有一处真相：那边导出、这边读。改动必须两边同时改，且 SCHEMA 要 +1。

export const SCHEMA = 1;

export interface Carrier {
  dir: string;
  cmd: string;
  exit: number | null;
  out: string;
  outLines: number;
  ranAt: number | null;
  ms: number | null;
}

export interface Exp {
  id: string;
  at: number | null;
  recordedAt: number | null;
  by: string;
  project: string;
  outcome: string;
  verdict: string;
  reviewedBy: string;
  reviewNote: string;
  claim: string;
  killCondition: string;
  expected: string;
  expectedAtLine: number;
  prereg: string;
  preregBeforeRun: boolean | null;
  phenomenon: string;
  phenomenonAbsent: string;
  model: string;
  conjecture: string;
  conjectureState: string;
  conjectureEvidence: string;
  source: string;
  externalCheck: string;
  control: { dir: string; cmd: string; exit: number | null; at: number | null } | null;
  controlAbsent: string;
  carriers: Carrier[];
  runMs: number;
}

export interface Run {
  at: number | null;
  by: string;
  carrier: string;
  cmd: string;
  exit: number | null;
  ms: number | null;
  out: string;
  claim: string;
}

export interface Seal {
  batch: string;
  prereg: string;
  driver: string;
  t0: number | null;
  t1: number | null;
  ms: number | null;
  rowsWritten: number | null;
  startBytes: number | null;
  endBytes: number | null;
}

export interface Challenge {
  at: number | null;
  by: string;
  to: string;
  artifact: string;
  claim: string;
  verdict: string;
}

export interface Product {
  name: string;
  t: number | null;
  kb: number;
  text: string;
  cites: string[];
}

export interface VizData {
  meta: {
    generatedAt: number;
    lab: string;
    counts: Record<string, number>;
    warn: string[];
    sources: { name: string; path: string; rows: number; bytes: number }[];
    schema?: number;
  };
  span: { t0: number; t1: number };
  experiments: Exp[];
  projects: { id: string; n: number; alive: number; dead: number; parked: number }[];
  runs: Run[];
  seals: Seal[];
  challenges: Challenge[];
  debates: { at: number | null; to: string; text: string; chars: number }[];
  errata: { id: string; target: string; wrong: string; by: string; at: string; ref: string; status: string }[];
  products: Product[];
  external: { name: string; t: number | null; kb: number; text: string }[];
  librev: { at: number | null; fp: string; files: number; note: string }[];
  cost: { t: number | null; text: string; tokM: number | null; usd: number | null }[];
  events: { t: number | null; kind: string; sub: string; detail: string }[];
}

/** 载入校验：宁可**明确失败**，也不要白屏之后让人猜（纪律㉙：量具要能报错） */
export function parseData(raw: unknown): VizData {
  const d = raw as VizData;
  if (!d || typeof d !== "object") throw new Error("不是 JSON 对象");
  if (!d.meta || typeof d.meta !== "object") throw new Error("缺 meta —— 这可能不是 vizdata.ts 导出的文件");
  if (!d.meta.counts) throw new Error("缺 meta.counts —— 这不是 vizdata.ts 导出的文件");
  if (!Array.isArray(d.experiments)) throw new Error("缺 experiments 数组");
  if (!d.span || typeof d.span.t0 !== "number") throw new Error("缺 span.t0");
  if (d.meta.schema !== undefined && d.meta.schema !== SCHEMA) {
    throw new Error(`数据结构版本不符：文件 schema=${d.meta.schema}，页面认 ${SCHEMA} —— 请重跑 vizdata.ts`);
  }
  return d;
}
