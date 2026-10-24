// ★★★ 集群自己写规矩（write_skill）
//
// ══════════════════════════════════════════════════════════════════════════
// 设计者 2026-10-21（逐字）：
//   「我**突然发现好像无论是第一层的两个研究员集群还是第二层的实验的集群
//     都没有通过 skill 的方式来优化过**呢」
//
// ★ 设计者裁定「A B 都可以做」。
// ★★ A（把 agentDir/skills 接进 createLab）**不需要做** —— 实测本来就是通的：
//    `inspectEnv().skills` = 1 个 `env-style`，agent 也真的拿到了。
//    （我第一版诊断说"加载 0 个"，那是我调了不存在的 `lab.resources` —— 见文档 §0）
// ★★★ B（给集群一个写 skill 的出口）**才是真缺的**：grep 全仓 → 0 行代码。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 这个文件守的最重要一条：**不许写口号**
//
//   设计者的原话（AGENTS.md）：
//     「**不定格式，要立规则，立高要求**，而不是规定格式抑制灵感」
//   ★ 而「高要求」的可判据是：**能判死**。
//     「写得更好」收不了 —— 谁知道什么叫更好。
//     「每节末尾必须有 `依据：` 一行」才收。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkSkillInput, renderSkill, type WriteSkillInput } from "../../research/clusters/forge/tools/write-skill.ts";

const SBX = join(import.meta.dirname, "_sbx-writeskill");

const GOOD: WriteSkillInput = {
  name: "cite-source",
  when: "写任何技术结论时",
  judge: "每一节的末尾必须有一行「依据：<语料 id>」，没有就是违反",
  counterExample: "「实测发现 X 更快」—— 没有依据行",
  evidence: "isolation 读数：278 次引用里 1 次是光秃秃的",
  body: "写完一节，另起一行写 `依据：` 加语料 id。",
};

function setup() {
  rmSync(SBX, { recursive: true, force: true });
  mkdirSync(SBX, { recursive: true });
}

describe("★★★ ① 好规矩必须收", () => {
  it("★★★ 五样齐全 ⇒ 0 错误", () => {
    assert.deepEqual(checkSkillInput(GOOD, []), []);
  });

  it("★★ 渲染出的 SKILL.md 有 pi 认的 frontmatter", () => {
    const md = renderSkill(GOOD);
    assert.ok(md.startsWith("---"));
    assert.ok(md.includes("name: cite-source"));
    assert.ok(md.includes("description: 写任何技术结论时"));
    // ★ 判据和反例必须都在（否则读者不知道怎样算违反）
    assert.ok(md.includes("依据：<语料 id>"));
    assert.ok(md.includes("没有依据行"));
  });
});

describe("★★★★ ② 最关键：口号必须被拒", () => {
  it("★★★ 「写得更好」这种收不了", () => {
    const e = checkSkillInput({ ...GOOD, judge: "要写得更好一点" }, []);
    assert.ok(e.some((x) => x.includes("口号")), `应该拒，实际：${e.join(";")}`);
  });

  it("★★★ 「尽量准确」也不行", () => {
    const e = checkSkillInput({ ...GOOD, judge: "尽量准确，注意细节" }, []);
    assert.ok(e.length > 0);
  });

  it("★★★ 含「必须/禁止」的确实可判死，不该误杀", () => {
    // ★ 这条守的是边界：含"必须"的**确实**可判死，不该误杀
    assert.deepEqual(checkSkillInput({ ...GOOD, judge: "必须给出依据行，禁止只写结论" }, []), []);
  });

  it("★★ 判据太短 ⇒ 拒", () => {
    assert.ok(checkSkillInput({ ...GOOD, judge: "好" }, []).length > 0);
  });
});

describe("★★★ ③ 必须有实测依据（不许拍脑袋）", () => {
  it("★★★ evidence 空缺 ⇒ 拒", () => {
    const e = checkSkillInput({ ...GOOD, evidence: "" }, []);
    assert.ok(e.some((x) => x.includes("evidence")), `实际：${e.join(";")}`);
  });

  it("★★ 没有反例 ⇒ 拒", () => {
    assert.ok(checkSkillInput({ ...GOOD, counterExample: "" }, []).length > 0);
  });
});

describe("★★★★ ④ 不许碰框架（硬规则①）", () => {
  it("★★★ 想改规则表 ⇒ 拒", () => {
    const e = checkSkillInput({ ...GOOD, body: "在 rules.ts 里加一条规则，观察点改成每 3 分钟" }, []);
    assert.ok(e.some((x) => x.includes("框架")), `实际：${e.join(";")}`);
  });

  it("★★★ 想改门 ⇒ 拒", () => {
    const e = checkSkillInput({ ...GOOD, judge: "BOOK_THRESHOLD 改成 0.8，门就好过了" }, []);
    assert.ok(e.some((x) => x.includes("框架")));
  });

  it("★★★ 想改席位 ⇒ 拒", () => {
    const e = checkSkillInput({ ...GOOD, when: "当 landing 太闲的时候，加一个团队" }, []);
    assert.ok(e.some((x) => x.includes("框架")));
  });

  it("★★ 讲做法 ⇒ 不误杀", () => {
    // ★ 这些词本身无害，别把正常的写作规矩当成改框架
    assert.deepEqual(checkSkillInput({ ...GOOD, body: "先给一句话定义，再给两个例子，最后说明什么时候不适用。" }, []), []);
  });
});

describe("★★★ ⑤ 重名/格式", () => {
  it("★★★ 同名已存在 ⇒ 拒（一条 skill 只讲一件事）", () => {
    const e = checkSkillInput(GOOD, ["cite-source"]);
    assert.ok(e.some((x) => x.includes("已存在")));
  });

  it("★★ 名字不合规 ⇒ 拒", () => {
    for (const bad of ["Cite", "有中文", "a", "has space"]) {
      assert.ok(checkSkillInput({ ...GOOD, name: bad }, []).length > 0, `「${bad}」该被拒`);
    }
  });
});

describe("★★ ⑥ 落盘", () => {
  it("★★ 写出的文件真的在盘上，且内容完整", async () => {
    setup();
    const { makeWriteSkillTool } = await import("../../research/clusters/forge/tools/write-skill.ts");
    let written = "";
    const tool = makeWriteSkillTool({
      skillsDir: SBX,
      existing: () => [],
      closing: () => false,
      onWritten: (s) => {
        written = s.name;
      },
    });
    await tool.execute("t1", GOOD, undefined, undefined, undefined as never);
    const f = join(SBX, GOOD.name, "SKILL.md");
    assert.ok(existsSync(f), "文件没写出来");
    const md = readFileSync(f, "utf8");
    assert.ok(md.includes("判据"));
    assert.ok(md.includes("依据：<语料 id>"));
    assert.equal(written, "cite-source", "onWritten 没回调");
  });

  it("★★★ 收尾态不许再长规矩", async () => {
    setup();
    const { makeWriteSkillTool } = await import("../../research/clusters/forge/tools/write-skill.ts");
    const tool = makeWriteSkillTool({
      skillsDir: SBX,
      existing: () => [],
      closing: () => true,
      onWritten: () => {},
    });
    const r = (await tool.execute("t2", GOOD, undefined, undefined, undefined as never)) as { isError?: boolean };
    assert.equal(r.isError, true);
    assert.ok(!existsSync(join(SBX, GOOD.name, "SKILL.md")));
  });
});
