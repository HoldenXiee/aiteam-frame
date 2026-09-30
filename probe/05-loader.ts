// 探针 05：ResourceLoader 注入 vs project trust（规格决策 #1/#2 的实证）。
// 关键修正：系统提示词里只有技能的 name/description/location，不含正文，
// 所以断言必须看技能名，不能看正文 marker。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { check, finish, note, section, startFaux, withTimeout } from "./_support.ts";
import { FAUX_MODEL_ID, makeRuntime } from "./_sdk.ts";

const faux = await startFaux();
const root = mkdtempSync(join(tmpdir(), "aiteam-p05-"));
const agentDir = join(root, "agent");
const runtime = await makeRuntime(agentDir, faux.baseUrl);
const model = runtime.getModel("faux", FAUX_MODEL_ID)!;

function writeSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const file = join(skillDir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n正文不重要\n`);
  return file;
}

// 项目内资源（按安全设计需要 trust 才加载）
const projectCwd = join(root, "project");
mkdirSync(join(projectCwd, ".pi", "skills"), { recursive: true });
mkdirSync(join(projectCwd, ".pi", "extensions"), { recursive: true });
writeSkill(join(projectCwd, ".pi", "skills"), "repo-skill", "项目内技能");
writeFileSync(join(projectCwd, ".pi", "extensions", "noop.ts"), "export default function() {}\n");

// 项目外技能目录（用于显式注入）
const externalSkills = join(root, "external-skills");
const externalSkillFile = writeSkill(externalSkills, "injected-skill", "外部注入技能");

async function run(options: {
  settings?: any;
  trusted?: boolean;
  loaderOptions?: Record<string, unknown>;
  cwd?: string;
}) {
  const cwd = options.cwd ?? projectCwd;
  const settingsManager = SettingsManager.inMemory(options.settings ?? {});
  if (options.trusted) settingsManager.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, ...options.loaderOptions });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });
  const before = faux.calls.length;
  await withTimeout(session.prompt("hello"), 20000, "loader probe");
  return { system: faux.calls[before]?.system ?? "", loader };
}

function availableSkills(system: string): string[] {
  const block = system.match(/<available_skills>([\s\S]*?)<\/available_skills>/)?.[1] ?? "";
  return [...block.matchAll(/<name>(.*?)<\/name>/g)].map((m) => m[1]);
}

section("case A：默认 settings（projectTrusted 默认就是 true）");
{
  const { system } = await run({});
  note("系统提示词里的技能", availableSkills(system));
  check(
    "SDK 路径下项目内技能会被加载（决策 #1 原前提是错的）",
    availableSkills(system).includes("repo-skill"),
    availableSkills(system).join(","),
  );
}

section("case B：显式 setProjectTrusted(false) —— 真正的静默跳过场景");
{
  const cwd = projectCwd;
  const settingsManager = SettingsManager.inMemory({});
  settingsManager.setProjectTrusted(false);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });
  const before = faux.calls.length;
  await withTimeout(session.prompt("hello"), 20000, "untrusted probe");
  const system = faux.calls[before]?.system ?? "";
  note("系统提示词里的技能", availableSkills(system));
  check("置为不可信后，项目内技能确实被跳过", !availableSkills(system).includes("repo-skill"));
}

section("case D：additionalSkillPaths 显式注入项目外技能");
{
  const { system, loader } = await run({ loaderOptions: { additionalSkillPaths: [externalSkills] } });
  note("系统提示词里的技能", availableSkills(system));
  check("显式注入的技能被加载", availableSkills(system).includes("injected-skill"), availableSkills(system).join(","));
  note("loader.getSkills() 返回的形状", Object.keys(loader.getSkills()).join(","));
  note("loader.getSkills().skills 名字表", loader.getSkills().skills.map((s: any) => s.name));
}

section("case E：skillsOverride 塞 Skill 对象（必须指向真实文件）");
{
  const { system } = await run({
    loaderOptions: {
      skillsOverride: (base: any) => ({
        skills: [
          ...base.skills,
          {
            name: "override-skill",
            description: "直接塞进去的技能",
            content: "正文",
            filePath: externalSkillFile,
            baseDir: externalSkills,
            source: "custom",
          },
        ],
        diagnostics: base.diagnostics,
      }),
    },
  });
  note("系统提示词里的技能", availableSkills(system));
  check("skillsOverride 能塞进技能（filePath 必须真实存在）", availableSkills(system).includes("override-skill"));
}

section("case F：systemPrompt 是整体替换（实测事实）");
{
  const { system } = await run({ loaderOptions: { systemPrompt: "SYSTEM_PROMPT_MARKER_XYZ" } });
  check("systemPrompt 生效", system.includes("SYSTEM_PROMPT_MARKER_XYZ"));
  check("pi 内置默认提示词被完全替换", !system.includes("expert coding assistant"));
  check("但动态段仍然拼在后面（<cwd>）", system.includes("<cwd>"), system.slice(0, 120));
  note("重要", "替换后 <tools> 段也没了 —— 所以 role 不该用 systemPrompt");
}

section("case G：systemPromptOverride 收到的 base 是什么");
{
  let received: unknown = "(未被调用)";
  const { system } = await run({
    loaderOptions: {
      systemPrompt: "BASE_FROM_OPTION",
      systemPromptOverride: (base: string | undefined) => {
        received = base;
        return `HEADER_MARKER\n${base ?? ""}`;
      },
    },
  });
  note("override 收到的 base", received);
  check("base 是 systemPrompt 选项的值，不是 pi 内置默认提示词", received === "BASE_FROM_OPTION");
  check("override 结果生效", system.includes("HEADER_MARKER"));
}

section("case G2：设置 role / 角色设定的正确旋钮");
{
  const { system } = await run({ loaderOptions: { appendSystemPrompt: ["ROLE_MARKER_我是审查员"] } });
  note("位置", `${system.indexOf("ROLE_MARKER")} / ${system.length}`);
  check("appendSystemPrompt 保留 pi 默认提示词", system.includes("expert coding assistant"));
  check("appendSystemPrompt 保留 <tools> 段", system.includes("<tools>"));
  check("角色说明被追加在里面", system.includes("ROLE_MARKER_我是审查员"));
  const roleAt = system.indexOf("ROLE_MARKER");
  const toolsAt = system.indexOf("<tools>");
  const skillsAt = system.indexOf("<available_skills>");
  note("段序", `tools@${toolsAt} role@${roleAt} skills@${skillsAt}`);
  check("角色说明在 <tools> 段之后", roleAt > toolsAt);
  check("角色说明在 <available_skills> 段之前", skillsAt < 0 || roleAt < skillsAt);
}

section("case H：技能名解析（决策 #2）");
{
  const loader = new DefaultResourceLoader({
    cwd: projectCwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({}),
    additionalSkillPaths: [externalSkills],
  });
  await loader.reload();
  const skills = loader.getSkills().skills;
  note("拿到的技能", skills.map((s: any) => s.name));
  const found = skills.find((s: any) => s.name === "injected-skill");
  check("能按名字找到技能", Boolean(found));
  note("Skill 字段", found ? Object.keys(found).join(",") : "(无)");
}

await faux.close();
finish();
