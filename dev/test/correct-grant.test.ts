// ★★★★ correct（改记忆）+ grant（加能力）
//
// 设计者 2026-10-21：
//   「这个底层库开放了很多 api…完全可以去**实验创新**，
//    创新出更符合我们目标的东西。」
//
// ★★★ 这一族工具的判据：**它们必须真的落在结构上**
//   · correct  ⇒ 改的是**它上下文里那条 entry**（不是发提醒）
//   · grant    ⇒ 改的是**它的工具表**（不是告诉它"你可以用"）
//
// ★★ 而本文最重的一组测试是「**不许绕过框架**」：
//   grant 只能加只读工具 —— 否则 `spawn_seat` 的「新席位只读」约束就被绕过了。

import { strict as assert } from "node:assert";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  checkCorrectInput,
  makeCorrectTool,
  type CorrectInput,
} from "../../research/clusters/forge/tools/correct.ts";
import {
  checkGrantInput,
  makeGrantTool,
  SAFE_TOOLS,
  type GrantInput,
} from "../../research/clusters/forge/tools/grant.ts";

const SBX = join(import.meta.dirname, "_sbx-correct-grant");
const MEMBERS = ["theory#1", "practice#1", "landing#1"];
const B = String.fromCharCode(10);

const GOOD_CORRECT: CorrectInput = {
  target: "landing#1",
  entryId: "e-42",
  originalPreview: "我认为 p=0.0014 ⇒ 可以解除这条挂账",
  evidence: "复算内容口径是 p=1.0，两种读法结论相反 —— 原句漏了读法",
  replacement: "在**内容口径**下 p=1.0 ⇒ 不解除；要解除须写明读法且两种口径都满足",
};

const GOOD_GRANT: GrantInput = {
  target: "landing#1",
  tools: ["grep"],
  until: "这批复算做完（约 3 份产物）",
  evidence: "它要核对 12 份 jsonl 里的口径字段，现在只能一份份 read",
};

describe("★★★★ ① correct：改记忆必须说清是哪一条", () => {
  it("★★★★ 不指 entryId ⇒ 拒（不许模糊清空）", () => {
    const e = checkCorrectInput({ ...GOOD_CORRECT, entryId: "" }, MEMBERS);
    assert.ok(e.some((x) => x.includes("entryId")), `实际：${e.join(";")}`);
    assert.ok(e.some((x) => x.includes("暴力")), "要说清为什么（那是暴力不是纠正）");
  });

  it("★★★ 五样齐全 ⇒ 0 错误", () => {
    assert.deepEqual(checkCorrectInput(GOOD_CORRECT, MEMBERS), []);
  });

  it("★★ 指不出成员 ⇒ 拒", () => {
    assert.ok(checkCorrectInput({ ...GOOD_CORRECT, target: "全体" }, MEMBERS).length > 0);
  });
});

describe("★★★★★ ② correct：只抹不给对的 ⇒ 拒", () => {
  it("★★★★★ 这是整条设计的关键：只抹掉会让它重踩同一个坑", () => {
    const e = checkCorrectInput({ ...GOOD_CORRECT, erase: true, replacement: "" }, MEMBERS);
    assert.ok(e.some((x) => x.includes("erase")), `实际：${e.join(";")}`);
    assert.ok(e.some((x) => x.includes("再得出同一个错")), "要说清后果");
  });

  it("★★★ erase + 给对的说法 ⇒ 收", () => {
    assert.deepEqual(checkCorrectInput({ ...GOOD_CORRECT, erase: true }, MEMBERS), []);
  });

  it("★★ 既不给 replacement 也不 erase ⇒ 拒", () => {
    assert.ok(checkCorrectInput({ ...GOOD_CORRECT, replacement: "" }, MEMBERS).length > 0);
  });
});

describe("★★★ ③ correct：必须有证据 + 留原文", () => {
  it("★★★ 没有 evidence ⇒ 拒（否则是集群内霸凌）", () => {
    const e = checkCorrectInput({ ...GOOD_CORRECT, evidence: "" }, MEMBERS);
    assert.ok(e.some((x) => x.includes("evidence") || x.includes("霸凌")));
  });

  it("★★★ 没有 originalPreview ⇒ 拒（事后要能查它当初为什么那么想）", () => {
    assert.ok(checkCorrectInput({ ...GOOD_CORRECT, originalPreview: "" }, MEMBERS).length > 0);
  });
});

describe("★★★★★ ④ grant：不许绕过框架（只能加只读工具）", () => {
  it("★★★★★ 想 grant write ⇒ 拒（那会绕过「新席位只读」）", () => {
    const e = checkGrantInput({ ...GOOD_GRANT, tools: ["write"] }, MEMBERS);
    assert.ok(e.some((x) => x.includes("不许 grant")), `实际：${e.join(";")}`);
  });

  it("★★★★★ bash / edit 也一样拒（会改盘）", () => {
    for (const t of ["bash", "edit"]) {
      assert.ok(checkGrantInput({ ...GOOD_GRANT, tools: [t] }, MEMBERS).length > 0, `${t} 该被拒`);
    }
  });

  it("★★★ 只读工具 ⇒ 收", () => {
    for (const t of SAFE_TOOLS) {
      assert.deepEqual(checkGrantInput({ ...GOOD_GRANT, tools: [t] }, MEMBERS), [], `${t} 该被收`);
    }
  });

  it("★★ 混着来（合法 + 非法）⇒ 整体拒", () => {
    assert.ok(checkGrantInput({ ...GOOD_GRANT, tools: ["grep", "write"] }, MEMBERS).length > 0);
  });
});

describe("★★★★ ⑤ grant：必须能收回", () => {
  it("★★★★ 没有 until ⇒ 拒（否则变成出厂配置）", () => {
    const e = checkGrantInput({ ...GOOD_GRANT, until: "" }, MEMBERS);
    assert.ok(e.some((x) => x.includes("until")));
  });

  it("★★★ 没有 evidence ⇒ 拒", () => {
    assert.ok(checkGrantInput({ ...GOOD_GRANT, evidence: "" }, MEMBERS).length > 0);
  });

  it("★★ tools 空 ⇒ 拒", () => {
    assert.ok(checkGrantInput({ ...GOOD_GRANT, tools: [] }, MEMBERS).length > 0);
  });
});

describe("★★★ ⑥ 落到盘上（真改了，不是提醒）", () => {
  it("★★★ correct 真调了 apply，并记账（含原文）", async () => {
    rmSync(SBX, { recursive: true, force: true });
    const ledger = join(SBX, "correct.jsonl");
    let applied = "";
    const tool = makeCorrectTool({
      members: () => MEMBERS,
      closing: () => false,
      apply: async (r) => {
        applied = r.entryId;
        return { ok: true, note: "已 replace" };
      },
      ledger,
      log: () => {},
    });

    await tool.execute("t1", GOOD_CORRECT, undefined, undefined, undefined as never);
    assert.equal(applied, "e-42", "没真的去改");
    assert.ok(existsSync(ledger), "没记账");
    const rec = JSON.parse(readFileSync(ledger, "utf8").trim());
    assert.equal(rec.op, "correct");
    assert.ok(rec.originalPreview, "★★ 账里必须留原文（事后查它当初为什么那么想）");
  });

  it("★★★ grant 真调了 apply", async () => {
    rmSync(SBX, { recursive: true, force: true });
    let applied = 0;
    const tool = makeGrantTool({
      members: () => MEMBERS,
      closing: () => false,
      apply: async () => {
        applied++;
        return { ok: true, note: "已加" };
      },
      ledger: join(SBX, "grant.jsonl"),
      log: () => {},
    });
    await tool.execute("t1", GOOD_GRANT, undefined, undefined, undefined as never);
    assert.equal(applied, 1);
  });

  it("★★ 收尾态都不许动", async () => {
    rmSync(SBX, { recursive: true, force: true });
    let called = false;
    const c = makeCorrectTool({
      members: () => MEMBERS,
      closing: () => true,
      apply: async () => {
        called = true;
        return { ok: true, note: "" };
      },
      ledger: join(SBX, "c.jsonl"),
      log: () => {},
    });
    const r = (await c.execute("t", GOOD_CORRECT, undefined, undefined, undefined as never)) as { isError?: boolean };
    assert.equal(r.isError, true);
    assert.equal(called, false);
  });
});
