// 探针 06：模型解析 —— 规格决策 #3 说直接用导出的 resolveCliModel，验证它真的在。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCliModel, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import { check, finish, note, section, startFaux } from "./_support.ts";
import { FAUX_MODEL_ID, makeRuntime } from "./_sdk.ts";

const faux = await startFaux();
const root = mkdtempSync(join(tmpdir(), "aiteam-p06-"));
const agentDir = join(root, "agent");
const runtime = await makeRuntime(agentDir, faux.baseUrl);

section("import 是否存在");
check("resolveCliModel 已导出", typeof resolveCliModel === "function");
check("resolveModelScopeWithDiagnostics 已导出", typeof resolveModelScopeWithDiagnostics === "function");

section("基础解析 provider/id");
{
  const result = resolveCliModel({ cliModel: `faux/${FAUX_MODEL_ID}`, modelRuntime: runtime });
  note("结果", { model: result.model?.id, provider: result.model?.provider, thinking: result.thinkingLevel, error: result.error, warning: result.warning });
  check("解析出模型", result.model?.id === FAUX_MODEL_ID, result.error ?? "无错误");
  check("没有报错", !result.error, result.error);
}

section("带思考档 provider/id:high");
{
  const result = resolveCliModel({ cliModel: `faux/${FAUX_MODEL_ID}:high`, modelRuntime: runtime });
  note("结果", { model: result.model?.id, thinking: result.thinkingLevel, error: result.error, warning: result.warning });
  check("解析出思考档", Boolean(result.thinkingLevel), String(result.thinkingLevel));
}

section("不存在的模型");
{
  const result = resolveCliModel({ cliModel: "faux/nope", modelRuntime: runtime });
  note("结果", { model: result.model?.id, error: result.error, warning: result.warning });
  check("解析失败时有 error 或 warning 而不是静默成功", Boolean(result.error || result.warning), JSON.stringify(result));
}

section("模型作用域解析（供 scopedModels 用）");
{
  const result = await resolveModelScopeWithDiagnostics(["faux/*"], runtime);
  note("解析出的模型", (result.scopedModels ?? []).map((s: any) => s.model?.id));
  note("诊断", (result.diagnostics ?? []).map((d: any) => d.message));
  check("通配符能解析出模型", (result.scopedModels ?? []).length > 0);
}

await faux.close();
finish();
