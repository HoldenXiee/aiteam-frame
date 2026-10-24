// ★★★ inspector 失联兜底（2026-10-20）
//
//   病（实测）：inspector 跑了 900s+ 没回来，
//   期间 `onSettled` 反复打"还在跑，不重复叫"，**审查停摆 15 分钟**。
//
//   ★★ 根因：`inspectorInFlight` 只在 `onDone` 里清零。
//     如果那次 run **永不回调**（崩了 / dispose 截断 / 网络挂住），
//     标志就永久为 true ⇒ `onSettled` **永久失效**（静默停摆）。
//
//   ★ 这类病在本项目出现过多次："一次失败就永远不再做"。
//     所以判据必须是**纯函数**，能离线重判（纪律⑦）。

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

/**
 * ★ 与 `rules.ts` 的 onSettled 守卫同源。
 * @returns "skip"（还在跑，别重复叫）| "reset"（失联，强制清零）| "fire"（可以叫了）
 */
export function inspectorGuard(
  inFlight: boolean,
  sinceMs: number | undefined,
  nowMs: number,
  staleMs = 1800_000,
): "skip" | "reset" | "fire" {
  if (!inFlight) return "fire";
  const since = sinceMs ?? nowMs;
  if (nowMs - since > staleMs) return "reset";
  return "skip";
}

describe("★★★ inspector 失联兜底", () => {
  it("★ 没在跑 ⇒ 可以叫", () => {
    assert.equal(inspectorGuard(false, undefined, 1000), "fire");
  });

  it("★★ 刚起 5 分钟 ⇒ 别重复叫（正常长任务）", () => {
    assert.equal(inspectorGuard(true, 0, 300_000), "skip");
  });

  it("★★★ 实测 900s 未回来 ⇒ 仍然别叫（它是真在跑，5047 字那种）", () => {
    assert.equal(inspectorGuard(true, 0, 900_000), "skip", "把正常长任务误杀了");
  });

  it("★★★ 超过 30 分钟 ⇒ 判定失联，强制清零（否则永久停摆）", () => {
    assert.equal(inspectorGuard(true, 0, 1800_001), "reset", "失联了却还在等 —— 会永久停摆");
  });

  it("★★ since 缺失 ⇒ 用 now 兜底（不因此误判成失联）", () => {
    assert.equal(inspectorGuard(true, undefined, 3_000_000), "skip");
  });

  it("★ 清零之后能再叫 ⇒ 审查恢复", () => {
    // 模拟：失联 → reset → 下一次 guard 返回 fire
    let inFlight = true;
    const since = 0;
    const now = 2_000_000;
    if (inspectorGuard(inFlight, since, now) === "reset") inFlight = false;
    assert.equal(inspectorGuard(inFlight, since, now), "fire");
  });
});
