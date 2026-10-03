// 测形态 7「共享黑板」：全队 cwd 指向同一目录时，成员间能否通过文件互通。
// A 路：两个直连 createAgent 同 cwd；B 路：花名册成员（member spec 带 cwd）经 spawn_agent。
// 写/读都用假 provider 的脚本化工具调用（[[tool:...]][[args:...]]），零 API 成本。
//
// 结论（2026-10-02，faux，本机）：两条路都 ✅ —— writer 写入的文件落在共享 cwd，
// member spec 的 cwd 正确传递给分身，reader 读到了全文。形态 7 可用，课题 4 的
// 「共享黑板」条件成立。附带 ground truth：pi 内置工具 = read / bash / edit / write。
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgent, createAgentHost } from "../src/index.ts";
import { startFaux } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF } from "../test/faux-models.ts";
import { runTool } from "../test/helpers.ts";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);

console.log("═══ 前置：假环境里实际提供的内置工具名（ground truth） ═══");
{
  const probe = await createAgent(
    { model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir },
    { modelRuntime: made.runtime },
  );
  await probe.prompt("看看你有哪些工具").catch(() => {});
  console.log(`  pi 实际下发的工具：${faux.calls[0]?.tools.join(", ")}`);
  probe.dispose();
}

const WRITE_TASK = '[[tool:write]][[args:{"path":"board.md","content":"黑板内容ABC123"}]]';
const READ_TASK = '[[tool:read]][[args:{"path":"board.md"}]]';

console.log("\n═══ A 路：两个直连 createAgent，cwd 指向同一目录 ═══");
{
  const shared = mkdtempSync(join(tmpdir(), "aiteam-shared-a-"));
  const writer = await createAgent(
    { model: FAUX_MODEL_REF, cwd: shared, agentDir: made.agentDir, tools: ["write"] },
    { modelRuntime: made.runtime },
  );
  const reader = await createAgent(
    { model: FAUX_MODEL_REF, cwd: shared, agentDir: made.agentDir, tools: ["read"] },
    { modelRuntime: made.runtime },
  );

  const w = await writer.prompt(`把这句话写进黑板：${WRITE_TASK}`);
  console.log(`  writer 最终文本：${JSON.stringify(w.text.slice(0, 120))}`);

  const boardPath = join(shared, "board.md");
  const landed = existsSync(boardPath);
  console.log(
    `  文件落在共享目录：${landed ? "✅" : "❌"}${landed ? `，内容=${JSON.stringify(readFileSync(boardPath, "utf-8"))}` : ""}`,
  );

  const r = await reader.prompt(`读出黑板内容：${READ_TASK}`);
  const got = r.text.includes("ABC123");
  console.log(`  reader 读到内容：${got ? "✅" : "❌"}（文本=${JSON.stringify(r.text.slice(0, 150))}）`);
  writer.dispose();
  reader.dispose();
}

console.log("\n═══ B 路：花名册成员（member spec 各带同一 cwd）经 spawn_agent ═══");
{
  const shared = mkdtempSync(join(tmpdir(), "aiteam-shared-b-"));
  const host = createAgentHost({
    members: {
      w: { description: "写手", cwd: shared, tools: ["write"] },
      r: { description: "读者", cwd: shared, tools: ["read"] },
    },
  });
  const lead = await createAgent(
    { model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir, tools: ["spawn_agent"] },
    { host, modelRuntime: made.runtime },
  );

  const rw = await runTool("spawn_agent", { member: "w", task: `把这句话写进黑板：${WRITE_TASK}` }, { agent: lead, host } as never);
  const wText = (rw.content[0] as { type: string; text: string })?.text ?? JSON.stringify(rw);
  console.log(`  spawn(w) 返回：${JSON.stringify(wText.slice(0, 150))}`);

  const boardPath = join(shared, "board.md");
  const landed = existsSync(boardPath);
  console.log(
    `  文件落在成员共享 cwd：${landed ? "✅" : "❌"}${landed ? `，内容=${JSON.stringify(readFileSync(boardPath, "utf-8"))}` : ""}`,
  );

  const rr = await runTool("spawn_agent", { member: "r", task: `读出黑板内容：${READ_TASK}` }, { agent: lead, host } as never);
  const rText = (rr.content[0] as { type: string; text: string })?.text ?? JSON.stringify(rr);
  console.log(`  spawn(r) 返回：${JSON.stringify(rText.slice(0, 150))}`);
  console.log(`  → reader ${rText.includes("黑板内容ABC123") ? "✅ 读到黑板内容" : "❌ 没读到"}`);

  host.dispose();
}

await faux.close();
