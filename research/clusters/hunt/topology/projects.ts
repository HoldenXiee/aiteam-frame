/**
 * 项目账 —— 跨轮的载体（DESIGN v2 §1 第 1 条改正）
 *
 * ★★★ 为什么需要它（2026-10-21 实测出来的）：
 *   191 份产物里，**三段齐（猜想 / 接口 / 对照）= 0**。
 *   而它其实**有**跨轮能力 —— `手段 I → XXII` 是一条 24 层的连续链，每层引用上一层。
 *   **能力在，方向错了**：那条链朝内（审自己），不是朝外（做一个东西）。
 *   `P*` 是独立编号，彼此只引用、不累积 ⇒ **没有任何对象在跨轮变好**。
 *
 * ★ 所以加一层：`项目`（一个想法，有版本历史）⊃ `实验`（知识单位）。
 * ★★ 表由**集群自己写**（`outbox/PROJECTS.md`），我只读。我不写一行内容（硬规则①）。
 *
 * ★ 判据全是**形式**的（按列名取、按标记认），不做内容判断。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ───────────────────────── 类型 ─────────────────────────

export interface ProjectRow {
  /** 代号（`PRJ-1` / 一句话的名都行）*/
  id: string;
  /** 一句话猜想（原文）*/
  conjecture: string;
  version: string;
  /** ★ 三段：猜想 / 接口 / 对照 —— `null` = 表里没这一列或空（**未声明**，不是 false）*/
  hasConjecture: boolean | null;
  hasInterface: boolean | null;
  hasControl: boolean | null;
  /** 链深（这份想法被推到了第几轮）；表里没写 ⇒ null */
  chainDepth: number | null;
  /**
   * ★★★ 2026-10-21 补：「对象」—— 这个想法**在研究什么**。
   * ★ 真因分析（`真因-研究对象被驯化了-2026-10-21.md`）：196 份里可推广的只有 9%，
   *   而 10-19 之后 102 份只有 1 份 —— 研究对象从「集群」漂移成「本 lab 的测量装置」。
   * ★★ 所以对象必须是**外部可控/可跑的**：一个 lab、别人的集群、或外部材料。
   *   填本 lab 的 outbox / EXPERIMENTS / 量具 = **自指**，不算。
   */
  object: string;
  /** true=外部（URL / 别人的集群 / 自己搭的 lab）· false=自指 · null=未声明 */
  objectExternal: boolean | null;
  /** ★ 有没有「可推广：…」+「边界：…」两句 */
  generalizable: boolean | null;
}

export interface ProjectStats {
  total: number;
  /** ★★ 三段齐的项目数（DESIGN v2 的主判据）*/
  complete: number;
  /** ★ 链深 ≥ 3 的（真的在跨轮迭代，而不是一次性）*/
  deep: number;
  /** 表里明确声明了三段齐这一格的合计（三段全 true）*/
  declared: number;
  /** 有猜想这一格且非空的项目数 */
  withConjecture: number;
  /** ★ 对象**外部**的项目数（DESIGN 真因分析 §5.1）*/
  external: number;
  /** ★ 对象**自指**的项目数（本 lab 的 outbox / 量具 / 账）*/
  selfReferential: number;
  /** ★ 有「可推广 + 边界」两句的项目数 */
  generalizable: number;
  /** ★ 表里**声明了**「对象」这一格的行数（0 且 declaredObject=0 ⇒ 未声明，不是 0）*/
  declaredObject: number;
  /** ★ 表里声明了「可推广/边界」两列的行数 */
  declaredGeneral: number;
}

// ───────────────────────── 形式判据 ─────────────────────────

const ID_H = /^(代号|项目|编号|id|ID)$/i;
const CONJ_H = /(猜想|conjecture|一句话)/i;
const VER_H = /^(版本|version|v\d|当前版本)$/i;
const IFACE_H = /(接口|装置|artifact|interface)/i;
const CTRL_H = /(对照|control|相比)/i;
const DEPTH_H = /(链深|轮次|版本数|depth)/i;
const OBJ_H = /^(对象|object|研究对象)$/i;
// ★ 可推广 / 边界 也做成**列**（按列名取，不靠正文里找句子 —— 正文里到处都是"边界"两个字）
const GEN_H = /^(可推广|适用面|generalizable)$/i;
const BND_H = /^(边界|不成立的条件|boundary)$/i;

/** ★ 自指：对象指向本 lab 自己的读数 */
export function isSelfObject(obj: string): boolean {
  const t = obj.toLowerCase();
  return /outbox|experiments|converged|本 ?lab|自己的账|量具/.test(t);
}

/** ★ 被判为重复的占位符（可推广/边界没写）*/
const GENERIC_HEAD = /(可推广|推广给)/;
const BOUNDARY_HEAD = /(边界|什么时候不成立|不成立的条件)/;

/** 一格算不算"填了"：非空且不是占位符 */
export function filled(cell: string | undefined): boolean {
  if (!cell) return false;
  const t = cell.trim();
  if (!t) return false;
  return !/^([-—–?？无·]*|\s*未声明\s*|n\/a|NA)$/i.test(t);
}

/** 对照那一格必须**有数字**才算（"比现状好"是话，不是读数） */
export function controlFilled(cell: string | undefined): boolean {
  return filled(cell) && /\d/.test(cell ?? "");
}

/**
 * ★ 解析项目表。
 * ★★ 必须**按列名**取，不按位置 —— 位置取法是"谁最后写谁算"的老病（纪律㉞）。
 */
export function parseProjects(text: string): ProjectRow[] {
  const rows: ProjectRow[] = [];
  let cols: Record<string, number> = {};
  let inTable = false;

  for (const line of text.split(String.fromCharCode(10))) {
    const t = line.trim();
    if (!t.startsWith("|")) {
      cols = {};
      inTable = false;
      continue;
    }
    const body = t.split("|").slice(1, -1).map((c) => c.trim());
    if (!body.length) continue;
    if (body.every((c) => /^[-:\s]*$/.test(c))) {
      inTable = true;
      continue;
    }
    if (!inTable) {
      const find = (re: RegExp) => body.findIndex((c) => re.test(c));
      const i = find(ID_H);
      if (i < 0) {
        cols = {};
      } else {
        cols = {
          id: i,
          conj: find(CONJ_H),
          ver: find(VER_H),
          iface: find(IFACE_H),
          ctrl: find(CTRL_H),
          depth: find(DEPTH_H),
          obj: find(OBJ_H),
          gen: find(GEN_H),
          bnd: find(BND_H),
        };
      }
      continue;
    }
    // ★★★ 2026-10-25：**去掉反引号** —— 集群把代号写成 `` `X2-IS` ``，
    //   原来原样返回 ⇒ `record_experiment` 的 project 校验把**所有代号都拒了**
    //   （包括它自己列出来的那几个）。这是集群第一轮就抓到的（`outbox/缺陷-P127`）。
    const rawId = body[cols.id ?? -1] ?? "";
    const id = rawId.replace(/[`*]/g, "").trim();
    if (!id || /^[-:\s]+$/.test(id)) continue;
    const cell = (k: string) => (cols[k] >= 0 ? body[cols[k]!] : undefined);
    const depthRaw = cell("depth");
    const depthNum = depthRaw ? Number((depthRaw.match(/\d+/) ?? [])[0]) : NaN;
    rows.push({
      id,
      conjecture: cell("conj") ?? "",
      version: cell("ver") ?? "",
      // ★ 没这一列 ⇒ null（未声明），不是 false
      hasConjecture: cols.conj === undefined || cols.conj < 0 ? null : filled(cell("conj")),
      hasInterface: cols.iface === undefined || cols.iface < 0 ? null : filled(cell("iface")),
      hasControl: cols.ctrl === undefined || cols.ctrl < 0 ? null : controlFilled(cell("ctrl")),
      chainDepth: Number.isFinite(depthNum) ? depthNum : null,
      object: cell("obj") ?? "",
      objectExternal:
        cols.obj === undefined || cols.obj < 0
          ? null
          : filled(cell("obj"))
            ? !isSelfObject(cell("obj") ?? "")
            : null,
      // ★ 可推广 / 边界：**两列都要非空**才算（只有"可推广"是口号）
      generalizable:
        cols.gen === undefined || cols.gen < 0 || cols.bnd === undefined || cols.bnd < 0
          ? null
          : filled(cell("gen")) && filled(cell("bnd")),
    });
  }
  return rows;
}

/** ★ 三段齐 = 三段**都明确为真**；任何一段 null / false 都不算（宁缺勿滥） */
export function isComplete(r: ProjectRow): boolean {
  return r.hasConjecture === true && r.hasInterface === true && r.hasControl === true;
}

export function projectStats(rows: ProjectRow[]): ProjectStats {
  const complete = rows.filter(isComplete).length;
  return {
    total: rows.length,
    complete,
    deep: rows.filter((r) => (r.chainDepth ?? 0) >= 3).length,
    declared: complete,
    withConjecture: rows.filter((r) => r.hasConjecture === true).length,
    declaredObject: rows.filter((r) => r.objectExternal !== null).length,
    declaredGeneral: rows.filter((r) => r.generalizable !== null).length,
    external: rows.filter((r) => r.objectExternal === true).length,
    selfReferential: rows.filter((r) => r.objectExternal === false).length,
    generalizable: rows.filter((r) => r.generalizable === true).length,
  };
}

/**
 * ★★★ 「可推广 + 边界」的判据（DESIGN 真因分析 §5.2）。
 * ★ 为什么这两句一起要：只有「可推广」是口号；**边界**才让它可判死
 *   （书里每章都有「这一章可以被判死的地方」）。
 * ★ 只看**行首标记**，不靠正文里的语气。
 */
export function generalizableText(text: string): boolean {
  return GENERIC_HEAD.test(text.split(String.fromCharCode(10)).find((l) => GENERIC_HEAD.test(l)) ?? "") &&
    BOUNDARY_HEAD.test(
      text.split(String.fromCharCode(10)).find((l) => BOUNDARY_HEAD.test(l)) ?? "",
    );
}

/** 渲染（★ 缺数据写「未声明」，不写 0 —— 纪律㉜） */
export function renderProjects(s: ProjectStats, mode: "table" | "none"): string {
  const L: string[] = [];
  if (mode === "none") {
    L.push("★ 项目账：**不存在**（`outbox/PROJECTS.md` 没有）—— 三段齐 = 未声明，不是 0");
    L.push("   ★ 注意：这不是「你没做东西」，是「没有跨轮的载体可以数」");
    return L.join(String.fromCharCode(10));
  }
  L.push(
    `★ 项目账：共 ${s.total} 个 · ★★ **三段齐 ${s.complete}**（猜想+接口+对照）· ` +
      `链深≥3 的 ${s.deep} · 有猜想的 ${s.withConjecture}`,
  );
  L.push(
    s.declaredObject === 0
      ? `   ★ 对象：**未声明**（表里没有「对象」列）　← ★ 研究对象是「怎么设计集群」，不是「怎么量本 lab」`
      : `   ★ 对象：**外部 ${s.external}** · 自指（本 lab 的账/量具）**${s.selfReferential}**` +
          `（声明了 ${s.declaredObject}/${s.total} 行）　← ★ 对象必须是外部可控/可跑的`,
  );
  L.push(
    s.declaredGeneral === 0
      ? `   ★ 可推广+边界：**未声明**（表里没有这两列）—— 只有"可推广"是口号，**边界**才让它可判死`
      : `   ★ 可推广+边界：${s.generalizable}/${s.declaredGeneral}`,
  );
  return L.join(String.fromCharCode(10));
}

// ───────────────────────── I/O ─────────────────────────

/** 读项目账。★ 传错根会抛错，不静默返回空（纪律㉞ 的教训）*/
export function readProjects(labRoot: string): { rows: ProjectRow[]; stats: ProjectStats; mode: "table" | "none" } {
  if (labRoot.replace(/[\\/]+$/, "").endsWith("outbox")) {
    throw new Error(
      `readProjects 要的是**集群空间根**（如 research/labfirst/hunt），拿到的是「${labRoot}」。★ 传错根会静默返回空。`,
    );
  }
  const dir = join(labRoot, "outbox");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^PROJECTS.*\.md$/i.test(f)).sort();
  } catch {
    files = [];
  }
  if (!files.length) {
    const empty: ProjectStats = {
      total: 0,
      complete: 0,
      deep: 0,
      declared: 0,
      withConjecture: 0,
      external: 0,
      selfReferential: 0,
      generalizable: 0,
      declaredObject: 0,
      declaredGeneral: 0,
    };
    return { rows: [], stats: empty, mode: "none" };
  }
  const byId = new Map<string, ProjectRow>();
  for (const f of files) {
    if (!existsSync(join(dir, f))) continue;
    for (const r of parseProjects(readFileSync(join(dir, f), "utf8"))) {
      const prev = byId.get(r.id);
      // ★ 冲突不悄悄挑一个：后到的把 null 补上，其余保持先到的
      if (!prev) byId.set(r.id, r);
      else {
        byId.set(r.id, {
          ...prev,
          hasConjecture: prev.hasConjecture ?? r.hasConjecture,
          hasInterface: prev.hasInterface ?? r.hasInterface,
          hasControl: prev.hasControl ?? r.hasControl,
          chainDepth: prev.chainDepth ?? r.chainDepth,
        });
      }
    }
  }
  const rows = [...byId.values()];
  return { rows, stats: projectStats(rows), mode: "table" };
}
