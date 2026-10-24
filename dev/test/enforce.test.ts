// ★★★★ enforce：集群对成员施加约束（不是给全体加文档）
//
// 设计者 2026-10-21（逐字）：
//   「skill 会有弊端…比如 skill 在单 agent 上有用…**但是也有弊端**。
//    然后我们这个是 **agent 集群**，按照 skill 的作用，
//    **会不会有更好的东西，更适合 agent 集群**」
//
// ★★★ 这个文件守的核心：**enforce 必须真的和 skill 不同**。
//   如果它退化成"又一份文档"，那这个设计就没意义。
//   四条差别，每条都要有测试：
//     ① 有对象（不是全体）
//     ② 落在结构上（装在别人回路里，不是进它上下文）
//     ③ 有退出条件（until，不用人记得删）
//     ④ 有账（事后能问"这条起效了吗"）

import { strict as assert } from "node:assert";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  checkEnforceInput,
  makeEnforceTool,
  releaseExpired,
  type EnforceInput,
  type EnforceRecord,
} from "../../research/clusters/forge/tools/enforce.ts";

const SBX = join(import.meta.dirname, "_sbx-enforce");
const MEMBERS = ["theory#1", "practice#1", "landing#1"];
const B = String.fromCharCode(10);

const GOOD: EnforceInput = {
  target: "landing#1",
  rule: "必须读过理论章的判据才能发 landing 产物",
  until: "连续 3 份产物都带判据引用",
  evidence: "outbox 里 7 份 landing 产物，0 份引用理论章的判据",
  kind: "tool",
  tools: ["write"],
};

describe("★★★★ ① 它必须有对象（这是和 skill 最根本的差别）", () => {
  it("★★★★ 指不出具体的人 ⇒ 拒（说明该用 skill 不用 enforce）", () => {
    const e = checkEnforceInput({ ...GOOD, target: "全体" }, MEMBERS);
    assert.ok(e.some((x) => x.includes("不存在")), `实际：${e.join(";")}`);
    // ★ 报错必须**告诉它该用什么**，否则它会一直试
    assert.ok(e.some((x) => x.includes("skill")), "报错要点出：指不出人就不该用 enforce");
  });

  it("★★★ 指向存在的成员 ⇒ 收", () => {
    assert.deepEqual(checkEnforceInput(GOOD, MEMBERS), []);
  });

  it("★★ 空 target ⇒ 拒", () => {
    assert.ok(checkEnforceInput({ ...GOOD, target: "" }, MEMBERS).length > 0);
  });
});

describe("★★★★ ② 必须有退出条件（治「过时的规矩比没规矩更坏」）", () => {
  it("★★★★ 没有 until ⇒ 拒", () => {
    const e = checkEnforceInput({ ...GOOD, until: "" }, MEMBERS);
    assert.ok(e.some((x) => x.includes("until")), `实际：${e.join(";")}`);
    assert.ok(e.some((x) => x.includes("失效")), "要说清为什么必须给退出条件");
  });

  it("★★★★ until 满足 ⇒ 自动撤销，并记 releasedAt", () => {
    const recs: EnforceRecord[] = [
      { ...GOOD, at: "t0" },
      { ...GOOD, target: "theory#1", until: "永远不满足", at: "t1" },
    ];
    const { released, kept } = releaseExpired(recs, (r) => r.target === "landing#1");
    assert.equal(released.length, 1);
    assert.equal(released[0]!.target, "landing#1");
    assert.ok(released[0]!.releasedAt, "撤销必须记时间");
    assert.equal(kept.length, 1, "不该撤的不能撤");
  });
});

describe("★★★ ③ 规则必须能判死", () => {
  it("★★★ 口号 ⇒ 拒", () => {
    const e = checkEnforceInput({ ...GOOD, rule: "要写得更好一些" }, MEMBERS);
    assert.ok(e.some((x) => x.includes("口号")));
  });

  it("★★ 太短 ⇒ 拒", () => {
    assert.ok(checkEnforceInput({ ...GOOD, rule: "好" }, MEMBERS).length > 0);
  });
});

describe("★★★ ④ 必须有实测依据", () => {
  it("★★★ 没证据 ⇒ 拒（不许拍脑袋干预）", () => {
    assert.ok(checkEnforceInput({ ...GOOD, evidence: "" }, MEMBERS).length > 0);
  });
});

describe("★★★★ ⑤ 不许碰框架", () => {
  it("★★★ 想借 enforce 改规则表 ⇒ 拒", () => {
    const e = checkEnforceInput({ ...GOOD, rule: "必须按新规则表执行，rules.ts 加一条" }, MEMBERS);
    assert.ok(e.some((x) => x.includes("框架")), `实际：${e.join(";")}`);
  });

  it("★★★ 想改门 ⇒ 拒", () => {
    const e = checkEnforceInput({ ...GOOD, until: "BOOK_THRESHOLD 改成 0.8 之后" }, MEMBERS);
    assert.ok(e.some((x) => x.includes("框架")));
  });

  it("★★★ 想改席位 ⇒ 拒", () => {
    assert.ok(checkEnforceInput({ ...GOOD, rule: "必须接受新加的团队" }, MEMBERS).length > 0);
  });
});

describe("★★★ ⑥ 落到盘上（事后能问起效了没有）", () => {
  it("★★★ 下约束 ⇒ 记账文件里有一行", async () => {
    rmSync(SBX, { recursive: true, force: true });
    const ledger = join(SBX, "enforce.jsonl");
    const installed: EnforceRecord[] = [];
    const tool = makeEnforceTool({
      members: () => MEMBERS,
      closing: () => false,
      install: (r) => installed.push(r),
      ledger,
      log: () => {},
    });

    await tool.execute("t1", GOOD, undefined, undefined, undefined as never);

    // ★★ 真装进去了（不是写在文档里）
    assert.equal(installed.length, 1);
    assert.equal(installed[0]!.target, "landing#1");

    // ★★★ 真记了账
    assert.ok(existsSync(ledger), "记账文件没生成");
    const line = JSON.parse(readFileSync(ledger, "utf8").trim());
    assert.equal(line.op, "enforce");
    assert.equal(line.target, "landing#1");
    assert.ok(line.until, "账里必须留退出条件");
  });

  it("★★ 收尾态不许下新约束", async () => {
    rmSync(SBX, { recursive: true, force: true });
    let called = false;
    const tool = makeEnforceTool({
      members: () => MEMBERS,
      closing: () => true,
      install: () => {
        called = true;
      },
      ledger: join(SBX, "e.jsonl"),
      log: () => {},
    });
    const r = (await tool.execute("t2", GOOD, undefined, undefined, undefined as never)) as { isError?: boolean };
    assert.equal(r.isError, true);
    assert.equal(called, false, "收尾态不该真的装");
  });

  it("★★ kind=tool 必须说管哪些工具", () => {
    assert.ok(checkEnforceInput({ ...GOOD, tools: undefined }, MEMBERS).length > 0);
  });
});

// ★★★★★ 这一组是整个设计的关键分界：
//   「按工具名全拦」= 禁用（粗暴）；「看参数才拦」= 约束（有对象、有判据）
describe("★★★★★ ⑦ requireInInput：约束 vs 禁用的分界线", () => {
  /** 复刻 runner 里的门逻辑（纯函数，可离线重判） */
  function gateOf(recs: { tools: string[]; requireInInput?: string[]; rule: string }[]) {
    return (call: { name: string; input: unknown }): string | undefined => {
      for (const r of recs) {
        if (!r.tools.includes(call.name)) continue;
        const need = r.requireInInput;
        if (need?.length) {
          const blob = JSON.stringify(call.input ?? "");
          const missing = need.filter((k) => !blob.includes(k));
          if (missing.length === 0) continue; // ★ 合格放行
          return `miss:${missing.join(",")}`;
        }
        return `block:${r.rule}`;
      }
      return undefined;
    };
  }

  it("★★★★★ 内容合格 ⇒ **放行**（这是约束，不是禁用）", () => {
    const g = gateOf([{ tools: ["write"], requireInInput: ["依据："], rule: "必须带依据" }]);
    assert.equal(g({ name: "write", input: { path: "a.md", content: "结论" + B + "依据：P25" } }), undefined);
  });

  it("★★★★★ 内容不合格 ⇒ 拦，并说清缺什么", () => {
    const g = gateOf([{ tools: ["write"], requireInInput: ["依据："], rule: "必须带依据" }]);
    const r = g({ name: "write", input: { path: "a.md", content: "结论很简单" } });
    assert.ok(r?.startsWith("miss:"));
    assert.ok(r?.includes("依据："), "要说清缺的是哪个");
  });

  it("★★★ 不管的工具 ⇒ 一律放行", () => {
    const g = gateOf([{ tools: ["write"], requireInInput: ["依据："], rule: "x" }]);
    assert.equal(g({ name: "read", input: {} }), undefined);
  });

  it("★★★★ 对比：不给 requireInInput ⇒ 就是**禁用**（这样写也能用，但是另一回事）", () => {
    const g = gateOf([{ tools: ["write"], rule: "不许写" }]);
    assert.ok(g({ name: "write", input: { content: "完美内容，带依据：" } })?.startsWith("block:"));
  });

  it("★★ 多个要求必须**全部**满足", () => {
    const g = gateOf([{ tools: ["write"], requireInInput: ["依据：", "边界："], rule: "x" }]);
    assert.ok(g({ name: "write", input: { content: "依据：P25" } })?.includes("边界："));
    assert.equal(g({ name: "write", input: { content: "依据：P25 边界：只测 n=8" } }), undefined);
  });
});
