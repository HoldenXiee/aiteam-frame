// write_skill —— ★★★ agent 触发：**在框架里长一条规矩**（本轮有效）
//
// ══════════════════════════════════════════════════════════════════════════
// 设计者 2026-10-21（逐字）：
//   「我**突然发现好像无论是第一层的两个研究员集群还是第二层的实验的集群
//     都没有通过 skill 的方式来优化过**呢」
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 它和 `spawn_seat` 的区别（**两个不同的生长维度**）
//
//   spawn_seat（已有）              write_skill（本文件）
//   ─────────────────────          ──────────────────────────────
//   长的是**一个席位**              长的是**一条规矩**
//   拓扑上多一个节点                拓扑不变
//   ★ 只在内存，本轮有效             ★ **写进盘，下轮还在**（见下）
//   解决"没人干这件事"              解决"大家反复犯同一个错"
//
//   ★★★ 关键差异：**skill 落盘、跨轮有效**，而座位不落盘。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 为什么 skill 可以落盘，而座位不行
//
//   设计者给 seats 的裁定是「只在内存里，本轮有效」，理由是：
//     「若写盘并下轮读回 —— 盘上的结构会变成**事实上的框架**，
//       只是没写在代码里。那正是「框架渐变」，比写死更难管。」
//
//   ★★★ 而 skill **不是拓扑**，它是**做法**。判据（硬规则①之一）：
//     「改它需要懂研究内容吗？」
//       · skill = 「写小节要先给定义」这类**做法** ⇒ 需要懂内容 ⇒ **是集群的**
//       · 座位 = 「谁来干哪件事」⇒ **是结构** ⇒ 框架，不许落盘累积
//
//   ⇒ 座位不落盘（防框架渐变），skill 落盘（允许经验积累）。
//   ★ 这条分界线是设计者两条裁定的一致推论，不是我临时找的理由。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 框架在这里的体现（硬约束，工具不给商量余地）
//
//   ① **只能新增，不能改框架**（`FORBIDDEN`）——
//      写出的 skill 不许规定「规则表怎么排 / 门怎么判 / 席位怎么分」。
//      那三条是框架。★ 写了也拒绝。
//   ② **必须给判据**（`judge`）—— 「要写得更好」不收；
//      「每一节末尾必须有 `依据：` 一行」才收。
//      ★★ 理由：没有判据的规矩 = 提示词里的口号 = 没有规矩（纪律㉕）。
//   ③ **必须给反例**（`counterExample`）—— 说明「怎样算违反」，
//      ★ 否则写的人和读的人对同一条规矩理解不同。
//   ④ **一条 skill 只讲一件事**（`name` 已有则拒绝，不许追加到别人身上）。
//   ⑤ **写之前先证明它现在确实在犯**（`evidence`）——
//      ★★ 没有实测依据的规矩 = 拍脑袋 = 不许（纪律②：把改动当实验做）。
//
// ══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const NL = String.fromCharCode(10);

/** ★ 框架的三件事：写了也拒绝（★ 这是硬规则①：不许替集群定框架，也不许集群自己定） */
const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /规则表|rules\.ts|加一条规则|删一条规则/, why: "规则表属于框架（观察点与触发次序）" },
  { re: /门怎么判|改门|BOOK_THRESHOLD|否决权|门槛值/, why: "门属于框架（共识门 / 发布门）" },
  { re: /席位怎么分|加一个团队|团队数|spawn_seat|换人/, why: "席位与派活属于框架" },
];

export type WriteSkillDeps = {
  /** ★ skill 写到哪（一般是 `agentDir/skills`） */
  skillsDir: string;
  /** ★ 已有哪些（防重名 / 防覆盖） */
  existing: () => string[];
  /** ★ 收尾态不许再长（与其它工具同一条纪律） */
  closing: () => boolean;
  /** ★ 写成功之后回调（runner 用来 reload + 记日志） */
  onWritten: (skill: { name: string; path: string; why: string }) => Promise<void> | void;
};

export type WriteSkillInput = {
  name: string;
  /** ★ 一句话说清「什么时候该用它」（会进 description，决定它何时被展开） */
  when: string;
  /** ★★★ 可判死的判据 —— 必须能机器或人一眼判「违反没违反」 */
  judge: string;
  /** ★ 怎样算违反（给个具体的坏例子） */
  counterExample: string;
  /** ★★ 现在确实在犯的证据（读数 / 产物名 / 具体句子） */
  evidence: string;
  /** ★ 正文：怎么做 */
  body: string;
};

/** ★ 纯函数：校验通过没有（★ 可离线重判，纪律⑦） */
export function checkSkillInput(input: WriteSkillInput, existing: string[]): string[] {
  const errs: string[] = [];

  // ① 名字：只能小写字母/数字/连字符
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(input.name)) {
    errs.push(`name「${input.name}」不合规：只能小写字母开头，a-z0-9-，3~41 字符`);
  }
  // ④ 不许重名（★ 一条 skill 只讲一件事）
  if (existing.includes(input.name)) {
    errs.push(`name「${input.name}」已存在 —— 一条 skill 只讲一件事，不要追加到别人身上`);
  }
  // ② 判据不能是口号
  const soft = ["更好", "更清晰", "更准确", "更简洁", "尽量", "努力", "注意"];
  if (input.judge.trim().length < 6) errs.push("judge 太短：必须能判死，不是一句话口号");
  else if (soft.some((w) => input.judge.includes(w)) && !/必须|禁止|一律|不得|只能/.test(input.judge)) {
    errs.push(`judge「${input.judge}」像口号（含"${soft.find((w) => input.judge.includes(w))}"）—— 要写成可判死的：必须/禁止/一律…`);
  }
  // ③ 必须有反例
  if (input.counterExample.trim().length < 4) errs.push("counterExample 太短：必须说清怎样算违反");
  // ⑤ 必须有实测依据
  if (input.evidence.trim().length < 6) errs.push("evidence 太短：必须给现在确实在犯的证据（读数/产物名/句子）");
  // ① 不许碰框架
  const all = `${input.name} ${input.when} ${input.judge} ${input.body}`;
  for (const f of FORBIDDEN) {
    if (f.re.test(all)) errs.push(`碰了框架：命中「${f.why}」—— skill 只能讲做法，不能改框架`);
  }
  // 正文不能太短（否则等于没写）
  if (input.body.trim().length < 20) errs.push("body 太短（<20 字符）：读者照不了做");

  return errs;
}

/** ★ 纯函数：渲染 SKILL.md（★ frontmatter 是 pi 认的格式） */
export function renderSkill(input: WriteSkillInput): string {
  return [
    "---",
    `name: ${input.name}`,
    `description: ${input.when}`,
    "---",
    "",
    `# ${input.name}`,
    "",
    `## 什么时候用`,
    "",
    input.when,
    "",
    `## 判据（★ 能判死）`,
    "",
    input.judge,
    "",
    `## 怎样算违反`,
    "",
    input.counterExample,
    "",
    `## 为什么需要它（★ 实测证据）`,
    "",
    input.evidence,
    "",
    `## 怎么做`,
    "",
    input.body,
    "",
    "---",
    "",
    "> ★ 这条 skill 是**集群自己写的**（`write_skill`），不是框架给的。",
    "> 写它的理由见上面「为什么需要它」—— 如果那条证据不再成立，它就该校验作废。",
    "",
  ].join(NL);
}

export function makeWriteSkillTool(deps: WriteSkillDeps) {
  return defineTool({
    name: "write_skill",
    label: "写一条规矩（skill）",
    // ★★★ 纪律㉘：加了新选项必须同时改描述，否则它永远不知道有这个工具
    description: [
      "写一条**新 skill**（一条可复用的做法），写进你的 `skills/` 目录，之后所有研究员的上下文里都能看到它。",
      "",
      "★ 什么时候该用：你发现**同一个错反复犯**，而且每次都在提示词里临时提醒 —— 那就该把它写成 skill。",
      "",
      "★ 五个必填字段，缺一个都不收：",
      "  · when：一句话说清什么时候该用它",
      "  · judge：**可判死**的判据（写成「必须/禁止/一律」，不许写「更好/尽量」）",
      "  · counterExample：怎样算违反（给个具体的坏例子）",
      "  · evidence：**现在确实在犯**的证据（读数 / 产物名 / 具体句子）",
      "  · body：怎么做",
      "",
      "★★ 不许写的东西（这些是框架，不是做法，`write_skill` 会拒绝）：",
      "  · 规则表怎么排 / 加删规则",
      "  · 门怎么判（共识门、发布门、门槛值）",
      "  · 席位怎么分 / 几个团队",
      "",
      "★★ 一条 skill 只讲一件事；同名已存在会被拒绝（不要追加到别人身上）。",
    ].join(NL),
    parameters: Type.Object({
      name: Type.String({ description: "小写字母开头，a-z0-9-，" }),
      when: Type.String({ description: "一句话：什么时候该用它" }),
      judge: Type.String({ description: "可判死的判据（必须/禁止/一律…）" }),
      counterExample: Type.String({ description: "怎样算违反" }),
      evidence: Type.String({ description: "现在确实在犯的证据" }),
      body: Type.String({ description: "怎么做" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (deps.closing()) {
        return {
          content: [{ type: "text" as const, text: "⛔ 已进收尾态，不再长新规矩（与停新专家同一条纪律）。" }],
          details: { ok: false } as { ok: boolean; name?: string; path?: string },
          isError: true,
        };
      }

      const input = params as WriteSkillInput;
      const errs = checkSkillInput(input, deps.existing());
      if (errs.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: [`⛔ 这条 skill 不收：`, ...errs.map((e) => `  · ${e}`)].join(NL),
            },
          ],
          details: { ok: false, errors: errs } as { ok: boolean; name?: string; path?: string; errors?: string[] },
          isError: true,
        };
      }

      const dir = join(deps.skillsDir, input.name);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "SKILL.md");
      // ★ 双重保险：文件已在就不覆盖（防并发写坏别人的）
      if (existsSync(file)) {
        return {
          content: [{ type: "text" as const, text: `⛔ ${file} 已存在，不覆盖。` }],
          details: { ok: false } as { ok: boolean; name?: string; path?: string },
          isError: true,
        };
      }
      writeFileSync(file, renderSkill(input), "utf8");

      await deps.onWritten({ name: input.name, path: file, why: input.judge });

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `✔ 已写进 ${file}`,
              `★ 之后所有研究员的上下文里都会有它（description 决定它何时被展开）。`,
              `★★ 它的判据是：「${input.judge}」`,
              `★★★ 如果哪天这条证据不再成立，记得删掉它 —— 过时的规矩比没有规矩更坏。`,
            ].join(NL),
          },
        ],
        details: { ok: true, name: input.name, path: file } as { ok: boolean; name?: string; path?: string },
      };
    },
  });
}
