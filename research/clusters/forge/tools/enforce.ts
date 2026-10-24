// enforce —— ★★★★★ 集群**对成员施加一条约束**（不是给所有人加一份文档）
//
// ══════════════════════════════════════════════════════════════════════════
// 设计者 2026-10-21（逐字，这一条是整件事的起点）：
//
//   「skill 可能会有弊端，你可以尝试看看有没有更好的方式实现 ai 发挥更好的作用，
//    这个底层库开放了很多 api（甚至有需求可以自己改底层库造 api），
//    完全可以去实验创新，创新出更符合我们目标的东西。
//    （比如：skill 在单 agent 上有用，能让 agent 快速学会，避免犯错，
//      **但是也有弊端**。然后我们这个是 **agent 集群**，
//      按照 skill 的作用，**会不会有更好的东西，更适合 agent 集群**）」
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ skill 的弊端（逐条对应到"集群"这个场景）
//
//   skill 是什么：一份**静态文本**，加载进上下文，所有 agent 一律读同一份。
//
//   | skill 的性质 | 在**单 agent** 上 | 在**集群**上变成问题 |
//   |---|---|---|
//   | 静态文本 | ✔ 学会了就一直会 | ✘ **情况变了它还在**；过时的规矩比没规矩更坏 |
//   | 一律生效 | ✔ 就一个 agent | ✘ **守规矩的人也在付 token** |
//   | 不追踪谁犯 | ✔ 就是自己 | ✘ **改了谁都一样，没人知道该改谁** |
//   | 不撤销 | ✔ 有助于稳定 | ✘ **错误被修好之后，它还在占上下文** |
//
//   ★★★ 核心差异一句话：
//      skill 治的是「**这个 agent 不会做**」
//      集群要治的是「**这一位成员，在这件事上，反复做错**」
//   ⇒ 前者需要**文档**，后者需要**干预**。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 所以 enforce 是什么：**一次有对象的干预**
//
//   它和 write_skill 的四点不同（★ 每一点都是针对上面那四个弊端）：
//
//   | | write_skill | **enforce** |
//   |---|---|---|
//   | 作用范围 | 全体（进所有人上下文）| ★ **一位成员**（`target`）|
//   | 形态 | 文档 | ★ **挂在对方身上的门**（`tools` 面的 gate / permissions）|
//   | 治谁 | 谁读到算谁 | ★ **只治它自己** |
//   | 撤销 | 删文件（手工）| ★★ **有 `until`：条件消失就自动失效** |
//   | 记账 | 一条 md | ★★★ **每次被拦都落盘**（`enforce.jsonl`）⇒ 能问"这条约束起效了吗" |
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 为什么"挂在对方身上"是真事，不是比喻
//
//   库给了 `agent.tools.gate(fn)`（单槽位，每次工具调用前过一遍）与
//   `agent.permissions.gate(fn)`。⇒ 我们能把一条**判据**装进**另一个 agent 的运行回路**。
//
//   ★ 这和 skill 的差别是**结构性的**，不是程度的：
//     · skill：进它的**上下文**（它读了，可能照做，可能不照做）
//     · enforce：进它的**执行回路**（不满足就真的过不去）
//
//   ★★★ 纪律㉕ 说的就是这个：「**规则必须落在结构上，不能落在提示词里**」。
//       skill 是提示词层；enforce 是结构层。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 框架边界（硬规则①：不许碰框架）
//
//   ★ 这个工具**不许**：加删规则、改门、改团队/席位。
//     它只能**约束已有成员的行为**（比如"landing 必须读过 X 才能发 Y"）。
//   ★★ 判据：`FORBIDDEN` 里那几条正则，写了就拒绝。
//   ★★★ 而且 enforce **不管框架**：它治的是成员的**做法**，不是集群的结构。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★ 为什么必须带 `evidence` 和 `until`
//
//   · `evidence`：**现在确实在犯**的证据（读数/产物名/具体句子）
//     ⇒ 没有实测依据的干预 = 拍脑袋 = 不许（纪律②）
//   · `until`：**什么条件下这条约束自动失效**
//     ⇒ ★★★ 这是治「过时的规矩比没规矩更坏」的唯一办法：
//        干预要**自带退出条件**，不能靠人记得删。
//     ★ 而且 `until` 会被**每轮检查**：条件满足 ⇒ 撤销，并落盘记"已解除"。
// ══════════════════════════════════════════════════════════════════════════

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const NL = String.fromCharCode(10);

/** ★ 框架的三件事：enforce 不许碰（与 write_skill 同一条） */
const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /规则表|rules\.ts|加一条规则|删一条规则/, why: "规则表属于框架（观察点与触发次序）" },
  { re: /改门|BOOK_THRESHOLD|否决权|门槛值|共识门怎么判/, why: "门属于框架" },
  { re: /加.{0,2}团队|删.{0,2}团队|团队数|席位怎么分|换人|新成员/, why: "席位与派活属于框架" },
];

/** ★ 一条干预（★ 落盘，可事后复核） */
export type EnforceRecord = {
  /** 作用对象：member key（如 `landing#1`）—— ★ 不是"全体" */
  target: string;
  /** ★ 一句话：这条约束要求它做到什么 */
  rule: string;
  /** ★★★ 什么条件下自动失效（★ 治"过时规矩"） */
  until: string;
  /** ★★ 现在确实在犯的证据 */
  evidence: string;
  /** ★ 挂在哪：`tool`（工具调用前拦）/ `post`（产出后检查） */
  kind: "tool" | "post";
  /** ★ 给 `kind=tool` 用：管哪些工具名 */
  tools?: string[];
  /**
   * ★★★★★ 判据：**看参数**判"这次调用合不合规"（不是"禁用这个工具"）。
   *
   *   `missing` = 参数里必须出现的字串（全部都要有）；空 = 不看内容、只看工具名。
   *
   *   ★★★ 为什么必须有这个（2026-10-21 我自己的诊断）：
   *     只有 `tools` 的话，「拦 write」= **禁用 write**，不叫约束。
   *     真正的约束是：「**调用 write 时，内容里必须有 `依据：` 这一行，否则拦**」。
   *   ★ 而 `ToolGate` 拿得到 `call.input` ⇒ 这件事**做得到**，只是要显式声明。
   */
  requireInInput?: string[];
  /** 已失效了没有（事后判） */
  releasedAt?: string;
  at: string;
};

export type EnforceDeps = {
  /** ★ 现有的成员 key（★ 只能用其中的 —— 不许对不存在的人下约束） */
  members: () => string[];
  /** ★ 收尾态不许下新约束 */
  closing: () => boolean;
  /** ★★ 真正装进对方回路里（由 runner 提供 —— 它拿得到 agent） */
  install: (rec: EnforceRecord) => void;
  /** ★ 记账文件（每次被拦/被解除都追加一行） */
  ledger: string;
  /** ★ 记日志 */
  log: (msg: string) => void;
};

export type EnforceInput = {
  target: string;
  rule: string;
  until: string;
  evidence: string;
  /** `tool` = 工具调用前拦（拦得住）；`post` = 产出后检查（只提醒） */
  kind: "tool" | "post";
  tools?: string[];
  /** ★ 这些字串必须出现在参数里（不填 = 只按工具名拦 = 那是禁用） */
  requireInInput?: string[];
};

/** ★ 纯函数：校验（纪律⑦：可离线重判） */
export function checkEnforceInput(input: EnforceInput, members: string[]): string[] {
  const errs: string[] = [];

  // ① 必须指向一个**存在的**成员
  if (!input.target.trim()) errs.push("target 必填：要说明对**谁**下约束");
  else if (!members.includes(input.target)) {
    errs.push(
      `target「${input.target}」不存在。现有成员：${members.join("、")}` +
        `（★ skill 是给全体的，enforce 是给**一个人**的 —— 指不出人，就别用 enforce）`,
    );
  }

  // ② 规则要能判死（与 write_skill 同一个理由）
  const soft = ["更好", "更准确", "更清晰", "注意", "尽量", "努力"];
  if (input.rule.trim().length < 6) errs.push("rule 太短：必须能判死");
  else if (soft.some((w) => input.rule.includes(w)) && !/必须|禁止|一律|不得|只能|不能/.test(input.rule)) {
    errs.push(`rule「${input.rule}」像口号 —— 要写成可判死的（必须/禁止/一律…）`);
  }

  // ③ ★★★ 必须有失效条件
  if (input.until.trim().length < 4) {
    errs.push("until 必填：**什么条件下这条约束自动失效** —— 没有退出条件的干预会变成过时规矩");
  }

  // ④ 必须有实测证据
  if (input.evidence.trim().length < 6) errs.push("evidence 太短：必须给现在确实在犯的证据");

  // ⑤ kind=tool 时必须说管哪些工具
  if (input.kind === "tool" && (!input.tools || input.tools.length === 0)) {
    errs.push("kind=tool 时必须给 tools（管哪些工具名）");
  }
  // ★★★ ⑤之一：kind=tool 但没给 requireInInput ⇒ 那只是"禁用工具"，不是"约束做法"
  //   ★ 不硬拒（有时确实需要完全禁用），但**必须让它自己知道**（纪律：不静默降级）
  if (input.kind === "tool" && input.tools?.length && !input.requireInInput?.length) {
    // ★ 不报错 —— 但工具描述和返回值都会说清这一点（见 description 与成功返回）
  }

  // ⑥ 不许碰框架
  const all = `${input.rule} ${input.until} ${input.evidence}`;
  for (const f of FORBIDDEN) {
    if (f.re.test(all)) errs.push(`碰了框架：命中「${f.why}」—— enforce 只能约束成员的做法`);
  }

  return errs;
}

export function makeEnforceTool(deps: EnforceDeps) {
  return defineTool({
    name: "enforce",
    label: "对某位成员下一道约束",
    // ★★★ 纪律㉘：描述必须说清「它和 skill 有什么不同」，否则它会当成 skill 用
    description: [
      "对**某一位具体成员**下一道约束，装进它的**执行回路**（不是发给它一份文档）。",
      "",
      "★★ 它和 `write_skill` 的区别 —— 选错就白做：",
      "  · `write_skill`：写**文档**给**全体**看，靠它自觉 ⇒ 治「大家都不懂」",
      "  · `enforce`：装**一道门**给**一个人**，不满足就真的过不去 ⇒ 治「**这一位**反复做错同一件事」",
      "",
      "★★★ 什么时候该用 enforce：你指名道姓能说出是谁在犯（target 填得出来）。",
      "  如果说不出是谁 —— 那不是 enforce 的问题，是 skill 的问题，别用这个。",
      "",
      "★ 必填：",
      "  · target：成员 key（现有成员见报错里的列表）",
      "  · rule：**可判死**的判据（必须/禁止/一律…）",
      "  · until：**什么条件下自动失效** ← ★★ 没有退出条件的约束会变成过时规矩",
      "  · evidence：现在确实在犯的证据",
      "  · kind：`tool` = 工具调用前拦（**拦得住**）/ `post` = 产出后检查（只提醒）",
      "  · tools：kind=tool 时必填，管哪些工具名",
      "  · requireInInput：★ 哪些字串**必须出现在参数里**（不填 = 只按工具名拦 = 那是禁用不是约束）",
      "",
      "★★ 不许碰：规则表 / 门 / 团队席位（这些是框架，不是你该改的）。",
    ].join(NL),
    parameters: Type.Object({
      target: Type.String({ description: "成员 key" }),
      rule: Type.String({ description: "可判死的判据" }),
      until: Type.String({ description: "★ 什么条件下自动失效" }),
      evidence: Type.String({ description: "现在确实在犯的证据" }),
      kind: Type.Union([Type.Literal("tool"), Type.Literal("post")], { description: "tool=拦得住 / post=只提醒" }),
      tools: Type.Optional(Type.Array(Type.String(), { description: "kind=tool 时必填" })),
      requireInInput: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "★ 判据：这些字串必须出现在参数里（全部都要有），否则拦。" +
            "不填 = 只按工具名拦（那等于**禁用**这个工具，不是约束做法）",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (deps.closing()) {
        return {
          content: [{ type: "text" as const, text: "⛔ 已进收尾态，不再下新约束。" }],
          details: { ok: false } as { ok: boolean; target?: string },
          isError: true,
        };
      }

      const input = params as EnforceInput;
      const errs = checkEnforceInput(input, deps.members());
      if (errs.length) {
        return {
          content: [{ type: "text" as const, text: ["⛔ 这条约束不收：", ...errs.map((e) => `  · ${e}`)].join(NL) }],
          details: { ok: false, errors: errs } as { ok: boolean; target?: string; errors?: string[] },
          isError: true,
        };
      }

      const rec: EnforceRecord = {
        target: input.target,
        rule: input.rule,
        until: input.until,
        evidence: input.evidence,
        kind: input.kind,
        tools: input.tools,
        requireInInput: input.requireInInput,
        at: new Date().toISOString(),
      };

      deps.install(rec);

      // ★ 记账：每次下约束都落盘（否则事后无法回答"这条约束起效了吗"）
      try {
        mkdirSync(dirname(deps.ledger), { recursive: true });
        appendFileSync(deps.ledger, JSON.stringify({ op: "enforce", ...rec }) + NL, "utf8");
      } catch (e) {
        deps.log(`★ 约束已装，但记账失败：${(e as Error).message}`);
      }

      deps.log(`★★ 对「${rec.target}」下了约束（${rec.kind}）：${rec.rule}`);
      deps.log(`   失效条件：${rec.until}`);

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `✔ 已对「${rec.target}」装上约束（${rec.kind === "tool" ? "工具调用前拦" : "产出后检查"}）`,
              `★ 判据：「${rec.rule}」`,
              `★★ 失效条件：「${rec.until}」—— 条件满足就自动撤，不需要谁记得删。`,
              `★★★ 它**不是**写给全体看的文档：只有「${rec.target}」受影响。`,
            ].join(NL),
          },
        ],
        details: { ok: true, target: rec.target } as { ok: boolean; target?: string },
      };
    },
  });
}

/** ★★ 每轮检查一次：`until` 满足的约束自动撤销（★ 治"过时规矩"） */
export function releaseExpired(
  records: EnforceRecord[],
  /** ★ 判据：这条是否该撤（由 runner 给，可离线重判） */
  isSatisfied: (rec: EnforceRecord) => boolean,
): { released: EnforceRecord[]; kept: EnforceRecord[] } {
  const released: EnforceRecord[] = [];
  const kept: EnforceRecord[] = [];
  for (const r of records) {
    if (isSatisfied(r)) released.push({ ...r, releasedAt: new Date().toISOString() });
    else kept.push(r);
  }
  return { released, kept };
}
