// demo/log.ts —— 只干一件事：把「跑到哪一步、过没过」打成一行行给人看的字。
// 硬检查（check）决定退出码；note 是软提示 —— 依赖模型自由意志的那部分不算失败。
const TOTAL = 4;
const state = { step: 0, failed: 0, notes: 0 };

/** 一行摘要：多行文本压成一行，超长截断 */
export const oneLine = (v: unknown, n = 200): string => String(v).replace(/\s+/g, " ").slice(0, n);

export function say(line = ""): void {
  console.log(line);
}

export function step(title: string): void {
  state.step += 1;
  say(`\n【${state.step}/${TOTAL}】${title}`);
}

export function check(label: string, pass: boolean, detail?: unknown): boolean {
  if (pass) say(`  ✔ ${label}${detail === undefined ? "" : `  →  ${oneLine(detail)}`}`);
  else fail(label, detail);
  return pass;
}

export function fail(label: string, detail?: unknown): void {
  state.failed += 1;
  say(`  ✘ ${label}${detail === undefined ? "" : `  →  ${oneLine(detail)}`}`);
}

export function note(label: string, detail?: unknown): void {
  state.notes += 1;
  say(`  · ${label}${detail === undefined ? "" : `  →  ${oneLine(detail)}`}`);
}

export function summary(): { failed: number; notes: number } {
  return { failed: state.failed, notes: state.notes };
}
