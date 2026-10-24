// ★★★★★ 「发现」有没有进状态表（知识吸收率）
//
// ══════════════════════════════════════════════════════════════════════════
// 实测（2026-10-21）：hunt 做出 11 份手段审查，只有 6 份进了 `CONVERGED.md`
//
//   ★★★ 未进的 5 份里，**3 份是最新的纠正**：
//     · `手段VI`：出生后未封口的 3 批**不存在**（两次快照拼的）
//     · `手段VII`：**seal 自己的洞** —— 窗口内别人写的行会被签成自己的
//     · `手段续`：43/101 是错的，逐字节可核的只有 **7/101**
//
//   ★★ 后果可数：`CONVERGED` 的 `O27` 现在写着「**装置已证**」——
//      而 `手段VII` 已经证明它有洞。**状态表偏乐观了。**
//
//   ★★★ 为什么这是 hunt 的核心问题：
//     hunt 的价值不是"产出多少份"，是**它维护的那张状态表**。
//     新发现不进表 ⇒ 那张表**越来越像真的、实际越来越旧** ——
//     比没有表更危险（没有表时人会去查原始产物；有表时会信表）。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  absorption,
  renderAbsorption,
  shortCode,
} from "../../research/clusters/hunt/topology/absorption.ts";

describe("★★★★ ① 短代号（状态表里实际用的写法）", () => {
  it("★★★★ 三种真实形态都要认", () => {
    assert.equal(shortCode("INSPIR-7-手段审查-依据行225次.md"), "INSPIR-7");
    assert.equal(shortCode("手段VII-seal的字节窗口会.md"), "手段VII");
    assert.equal(shortCode("手段续-我上一条的43of101是错的.md"), "手段续");
  });

  it("★★★ 为什么不用全名：全名 40+ 字，状态表里从不写全名", () => {
    // ★ 用全名判会得 1/11（9%），用短代号得 6/11（55%）—— 差 6 倍
    const f = "INSPIR-8-手段审查-零API复算14.4小时202个脚本41份产物新增agent行0.md";
    assert.equal(shortCode(f), "INSPIR-8");
    assert.ok(shortCode(f).length < 12);
  });
});

describe("★★★★★ ② 核心判据：进没进状态表", () => {
  it("★★★★★ 提到了 ⇒ absorbed；没提 ⇒ 进 missing", () => {
    const a = absorption(
      ["INSPIR-7-甲.md", "INSPIR-8-乙.md"],
      "表里写了 INSPIR-7 的结论", // ★ 只提了 7
      () => 100,
    );
    assert.equal(a.total, 2);
    assert.equal(a.absorbed, 1);
    assert.equal(a.missing.length, 1);
    assert.equal(shortCode(a.missing[0]!.name), "INSPIR-8");
  });

  it("★★★★ 未进的按字数排序（长的优先看）", () => {
    const a = absorption(
      ["INSPIR-1-短.md", "手段VI-长.md"],
      "没有提到任何一个",
      (f) => (f.includes("手段VI") ? 9000 : 100),
    );
    assert.equal(a.missing[0]!.name.includes("手段VI"), true, "长的要排前面");
  });

  it("★★ 没有这类产物 ⇒ 不炸", () => {
    const a = absorption(["理论-某章.md"], "", () => 0);
    assert.equal(a.total, 0);
    assert.ok(renderAbsorption(a).includes("还没有"));
  });

  it("★★★ 只数手段审查类（INSPIR/手段），不数研究内容", () => {
    // ★ 分母必须只含这一类 —— 否则比例永远很小（纪律㉝）
    const a = absorption(["理论-甲.md", "实践-乙.md", "手段V-丙.md"], "", () => 1);
    assert.equal(a.total, 1, "★ 分母只含手段审查类");
  });
});

describe("★★★ ③ 渲染要说清弱点和名单", () => {
  it("★★★ 必须列出**未进的是哪几份**（否则不知道去补哪个）", () => {
    const a = absorption(["手段VII-甲.md"], "", () => 1);
    const s = renderAbsorption(a);
    assert.ok(s.includes("未进"), s);
    assert.ok(s.includes("手段VII"), `要点名：${s}`);
  });

  it("★★★ `手段` 这个代号有歧义，要说明（★ 可能误命中）", () => {
    const a = absorption(["手段-甲.md"], "", () => 1);
    assert.ok(renderAbsorption(a).includes("通用词"), "要披露判据的弱点");
  });
});
