import { join } from "node:path";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { createAgent } from "../src/index.ts";
import { makeEnv } from "./_faux.ts";
const env = await makeEnv();
const { agentDir, cwd, runtime, model } = env;
const slash = (p: string) => p.replace(/\\/g, "/");

// write 工具参数名
{
  const bb = join(env.root, "bb.md");
  const a = await createAgent({ model, cwd: env.root, agentDir, tools: ["read", "write"] }, { modelRuntime: runtime });
  const r = await a.prompt(`[[tool:write]] [[args:{"path":"${slash(bb)}","content":"黑板内容-ZZZ"}]]`);
  console.log("write:", JSON.stringify({ text: r.text.slice(0, 120), exists: existsSync(bb) }));
  a.dispose();
}

// 声明的扩展工具（能写任意路径）
{
  const extPath = join(env.root, "fs-ext.ts");
  writeFileSync(
    extPath,
    `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerTool({ name: "ext_fs_write", label: "w", description: "写文件",
    parameters: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } }, required: ["path", "text"] },
    execute: async (_id, params) => { writeFileSync(params.path, params.text); return { content: [{ type: "text", text: "written" }], details: {} }; } });
}
`,
    "utf-8",
  );
  const target = join(env.root, "ext-escape.txt");
  const a = await createAgent({ model, cwd, agentDir, tools: ["read"], extensions: [extPath] }, { modelRuntime: runtime });
  const r = await a.prompt(`[[tool:ext_fs_write]] [[args:{"path":"${slash(target)}","text":"来自扩展" }]]`);
  console.log("ext:", JSON.stringify({ tools: env.last()!.tools, text: r.text.slice(0, 100), exists: existsSync(target), content: existsSync(target) ? readFileSync(target, "utf-8") : null }));
  a.dispose();
}

// bash 读孤立根之外的文件
{
  const { tmpdir } = await import("node:os");
  const outside = join(tmpdir(), "aiteam-outside-marker.txt");
  writeFileSync(outside, "机器上任意文件的内容-QQQ");
  const a = await createAgent({ model, cwd, agentDir, tools: ["bash"] }, { modelRuntime: runtime });
  const cmd = `node -e "console.log(require('fs').readFileSync(process.argv[1],'utf8'))" "${outside}"`;
  const r = await a.prompt(`[[tool:bash]] [[args:{"command":${JSON.stringify(cmd)}}]]`);
  console.log("bash读:", JSON.stringify({ text: r.text.slice(0, 150) }));
  a.dispose();
}
await env.close();
