// ★★★ 发布门接线的**结构测试** —— 防「死代码」再犯
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 为什么需要这个测试（2026-10-20 的教训）
//
//   本项目已经抓到 **三个死代码**，全是同一形状：
//
//     #  函数                写好了  导入了  被调用
//     1  `writeVerdicts`      ✔      ✔      ✘
//     2  `readFileSync`       —      ✘      ✔（未导入，被 catch 吞）
//     3  `publishAndReport`   ✔      ✔      ✘   ← 这个让书整整进不去
//
//   ★★ 共同点：**没有任何东西会响**。
//      `publishAndReport` 没被调用的表现是「书不变」——
//      看起来像"没有产物过门"，而不像"代码没接上"。
//
//   ★★★ 所以这个测试**不测行为，测接线**：
//      读 `runner.ts` 源码，断言那几处关键调用**真的写在里面**。
//      ★ 这看起来笨，但它正好堵住"导入却没调用"这个洞。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const HERE = import.meta.dirname;
const FORGE_RUNNER = join(HERE, "../../research/clusters/forge/runner.ts");
const HUNT_RUNNER = join(HERE, "../../research/clusters/hunt/runner.ts");

const read = (p: string) => readFileSync(p, "utf8");

/** ★ 去掉注释，只留真正会执行的代码（避免"注释里写了"冒充"接上了"）*/
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l)) // 行注释
    .map((l) => l.replace(/\s\/\/.*$/, "")) // 行尾注释
    .join("\n");
}

describe("★★★ 发布门接线（死代码防护）", () => {
  const src = stripComments(read(FORGE_RUNNER));

  it("`publishAndReport` 被 import 了", () => {
    assert.match(src, /import\s*\{[^}]*publishAndReport[^}]*\}\s*from\s*["']\.\/tools\/publish\.ts["']/);
  });

  it("★★★ 而且**真的被调用**了（这是 2026-10-20 那个 bug 的断言）", () => {
    // ★ 只认「publishAndReport(」这种调用形式；import 行已在上一条单独验
    const calls = src.match(/publishAndReport\s*\(/g) ?? [];
    assert.ok(
      calls.length >= 1,
      "publishAndReport 被导入但从未调用 —— 书将永远进不去（2026-10-20 实际发生过）",
    );
  });

  it("★ 发布门失败时**必须响**（不许静默）", () => {
    // ★ 找 publish 那段的 try/catch，确认 catch 里 log 了 error
    const idx = src.indexOf("publishAndReport(");
    assert.ok(idx > 0, "没有调用点");
    // ★★★ 2026-10-21 修：原来只看 `idx + 2000` 字符 —— **太脆**。
    //
    //   病：我给这段加了「引用孤儿」的日志（几十行），catch 被推到 3756 字符外
    //   ⇒ 测试变红，**但代码其实没坏**（catch 还在，只是更远了）。
    //   ★★ 这是**量具缺陷**，不是能力缺陷（纪律⑧）。
    //
    //   ★ 修法：先找到这次的 `try {` 起点，再找**配平后的** catch —— 与代码长短无关。
    const tryIdx = src.lastIndexOf("try {", idx);
    assert.ok(tryIdx > 0, "发布门调用不在 try 里 —— 挂了会中断整个收尾");
    // ★ 从 tryIdx 往后找第一个 `} catch (`（这一段里没有嵌套 try）
    const catchIdx = src.indexOf("} catch (", tryIdx);
    assert.ok(catchIdx > 0, "发布门没有 catch —— 挂了会中断整个收尾");
    const tail = src.slice(catchIdx, catchIdx + 400);
    assert.match(tail, /log\(\s*["']error["']/, "发布门 catch 里没有 log('error') —— 会静默失败");
  });

  it("★ 它传了必需的四个参数（少一个门就判不出来）", () => {
    const idx = src.indexOf("publishAndReport(");
    const body = src.slice(idx, idx + 700);
    for (const key of ["outboxDir", "signoffsPath", "allTeams", "bookSrc"]) {
      assert.ok(body.includes(key), `发布门少了 ${key} 参数`);
    }
  });
});

describe("★★ forge 的其余关键接线", () => {
  const src = stripComments(read(FORGE_RUNNER));

  it("鉴定 / 观众 / 规则 三个入口都在", () => {
    assert.match(src, /makeJudge\s*\(/, "观众 judge 没接");
    assert.match(src, /makeSignOff\s*\(/, "共识门 sign_off 没接");
    assert.match(src, /tick\s*\(/, "规则 tick 没接");
  });

  it("★ 凭证来源被打进日志（换 key 后能核对读了哪个来源）", () => {
    assert.match(src, /AUTH_SOURCE/, "auth 来源没有进日志");
    // ★★ 同时断言：**不许把 key 值打进日志**
    assert.doesNotMatch(
      src,
      /log\([^)]*AUTH_SOURCE[^)]*\+.*key/i,
      "日志里拼接了 key —— 日志会进 git",
    );
  });
});

describe("★ hunt 侧没有 forge 的机制（拆分后的边界）", () => {
  const src = stripComments(read(HUNT_RUNNER));

  it("hunt 不导出/调用发布门", () => {
    assert.doesNotMatch(src, /publishAndReport/, "hunt 不该有发布门（它不出书）");
  });

  it("hunt 不建观众", () => {
    assert.doesNotMatch(src, /makeJudge/, "hunt 不该有观众");
  });
});
