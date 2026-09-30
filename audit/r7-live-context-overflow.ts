// 真模型专项 G：上下文超限的真实行为（清单 6.5 未覆盖项）
// 跑法：node audit/r7-live-context-overflow.ts        （会产生小额真实 API 花费）
// 用一个小窗口的模型：openrouter/qwen/qwen-2.5-7b-instruct（contextWindow=32768，$0.1/M input）
import { createAgent } from "../src/index.ts";
import { dump, msAsync, record, section } from "./_harness.ts";

const MODEL = "openrouter/qwen/qwen-2.5-7b-instruct";
const NL = "\n";
let cost = 0;

// 构造一段可压缩性低的填充文本（随机字母，避免被 tokenizer 压得太厉害）
const filler = (chars: number) => {
  const words: string[] = [];
  let seed = 12345;
  while (words.join(" ").length < chars) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    words.push(seed.toString(36).padStart(6, "0"));
  }
  return words.join(" ").slice(0, chars);
};

section("G1  上下文超限会发生什么（清单 6.5）");

{
  // 先确认这个模型能正常解析并跑起来
  const probe = await createAgent({ model: MODEL, tools: [] });
  const [r0, ms0] = await msAsync(() => probe.prompt("只回数字 1"));
  cost += r0.usage.cost.total;
  if (r0.error) {
    record({
      id: "G1a",
      question: "小窗口模型（ctx=32768）能否正常跑起来",
      observed: `prompt 返回 error=${JSON.stringify(r0.error)}，${Math.round(ms0)}ms`,
      verdict: "INFO",
      conclusion: "模型无法正常跑（可能是解析告警被库硬拒、或 provider 不可达），本部分后续项跳过。",
      data: { errorText: r0.error, ms: Math.round(ms0) },
    });
    probe.dispose();
    console.log(`\n真模型专项 G 中断：$${cost.toFixed(5)}`);
    dump("r7-live-context-overflow");
    process.exit(0);
  }
  const baseTokens = r0.usage.totalTokens;
  probe.dispose();

  // 逐步加大输入：目标覆盖「远低于」「接近」「超过」窗口三档
  const cases = [
    { key: "远低于窗口", chars: 20_000, note: "约 5k token" },
    { key: "接近窗口", chars: 100_000, note: "约 25k token，窗口 32768" },
    { key: "超过窗口", chars: 200_000, note: "约 50k token，明显超出" },
    { key: "远超窗口", chars: 400_000, note: "约 100k token，3 倍于窗口" },
  ];
  const rows: Array<{ key: string; note: string; chars: number; ok: boolean; errorText: string | null; tokens: number; ms: number; cost: number; threw: string | null; answerHead: string }> = [];
  for (const c of cases) {
    const text = filler(c.chars);
    let agent;
    try {
      agent = await createAgent({ model: MODEL, tools: [] });
    } catch (e) {
      rows.push({ key: c.key, note: c.note, chars: c.chars, ok: false, errorText: null, tokens: 0, ms: 0, cost: 0, threw: `构造抛错: ${(e as Error).message.slice(0, 120)}`, answerHead: "" });
      continue;
    }
    try {
      const [res, ms] = await msAsync(() =>
        agent!.prompt(`下面是一段无意义的填充文本。请只回答两个字：收到。${NL}${NL}${text}`),
      );
      cost += res.usage.cost.total;
      rows.push({ key: c.key, note: c.note, chars: c.chars, ok: !res.error, errorText: res.error ?? null, tokens: res.usage.totalTokens, ms: Math.round(ms), cost: Number(res.usage.cost.total.toFixed(6)), threw: null, answerHead: res.text.trim().slice(0, 60) });
    } catch (e) {
      rows.push({ key: c.key, note: c.note, chars: c.chars, ok: false, errorText: null, tokens: 0, ms: 0, cost: 0, threw: (e as Error).message.slice(0, 200), answerHead: "" });
    }
    // 超限之后这个分身还能不能用？
    if (c.key === "超过窗口") {
      try {
        const [after, msAfter] = await msAsync(() => agent!.prompt("只回数字 7"));
        cost += after.usage.cost.total;
        rows.push({ key: "超限后同一分身再问一句", note: "检验会话是否被污染", chars: 0, ok: !after.error, errorText: after.error ?? null, tokens: after.usage.totalTokens, ms: Math.round(msAfter), cost: Number(after.usage.cost.total.toFixed(6)), threw: null, answerHead: after.text.trim().slice(0, 40) });
      } catch (e) {
        rows.push({ key: "超限后同一分身再问一句", note: "检验会话是否被污染", chars: 0, ok: false, errorText: null, tokens: 0, ms: 0, cost: 0, threw: (e as Error).message.slice(0, 200), answerHead: "" });
      }
    }
    agent.dispose();
  }

  const failed = rows.filter((r) => !r.ok);
  const firstFail = failed[0];
  record({
    id: "G1b",
    question: "输入超过上下文窗口时，失败以什么形式出现、能否被程序识别",
    observed:
      `基线（无长输入）单轮 ${baseTokens} tok` + NL + "     " +
      rows.map((r) => `${r.key}（${r.chars} 字符 / ${r.note}）: ${r.ok ? `成功（${r.tokens} tok，${r.ms}ms，$${r.cost}）` : r.threw ? `**抛错** ${r.threw}` : `**失败** RunResult.error=${JSON.stringify(r.errorText)}（${r.ms}ms）`}${r.answerHead ? ` 回答=${JSON.stringify(r.answerHead)}` : ""}`).join(NL + "     "),
    verdict: failed.length === 0 ? "GAP" : firstFail?.threw ? "PARTIAL" : "OK",
    conclusion:
      failed.length === 0
        ? `四档输入（最大 ${Math.max(...rows.map((r) => r.chars))} 字符）**全部成功**，即使明显超出声明的 32768 窗口 —— 说明 provider 侧要么自动截断、要么窗口声明与实际不符，**本地不做任何长度预检**（这一点与清单 4.2e 一致）。含义：设计者无法在库这一层预防超限，只能靠 provider 报错。`
        : `超限时失败以 ${firstFail?.threw ? `**抛错**（不是 RunResult.error）` : `RunResult.error=${JSON.stringify(firstFail?.errorText)}`} 的形式出现 —— ${firstFail?.threw ? "可以被 try/catch 捕获，但**与预算耗尽的抛错混在同一通道**（都是 throw），设计者靠错误文本区分" : "不抛错，只填 error 字段，设计者必须检查返回值"}。含义：超限是**可识别的**，但识别方式与其它失败混在一起，没有专门的错误码。`,
    data: { model: MODEL, declaredContextWindow: 32768, baseTokens, rows },
  });

  const afterRow = rows.find((r) => r.key.startsWith("超限后"));
  if (afterRow) {
    record({
      id: "G1c",
      question: "一次超限之后，同一个分身还能继续正常对话吗",
      observed: `超限后同一分身再问一句：${afterRow.ok ? `成功（${afterRow.tokens} tok，回答=${JSON.stringify(afterRow.answerHead)}）` : afterRow.threw ? `抛错 ${afterRow.threw}` : `失败 error=${JSON.stringify(afterRow.errorText)}`}`,
      verdict: afterRow.ok ? "OK" : "GAP",
      conclusion: afterRow.ok
        ? "超限失败**不污染会话**：同一个分身接着问一句仍然正常回答。含义：设计者可以在 catch/检查 error 之后直接降级重试（例如把长输入切短），不需要重建分身。"
        : "超限失败**会污染会话**：同一个分身之后再也跑不通。含义：设计者必须回收并重建分身，不能原地恢复。",
      data: afterRow,
    });
  }
}

console.log(`\n真模型专项 G 结束：本次真实花费约 $${cost.toFixed(5)}`);
dump("r7-live-context-overflow");
