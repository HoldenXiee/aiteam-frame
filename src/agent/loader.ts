// 由 MemberSpec 造 ResourceLoader：显式注入技能、扩展、角色，不依赖磁盘发现的偶然性（决策 #1）。
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DefaultResourceLoader,
  type InlineExtension,
  type SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import type { MemberSpec } from "./types.ts";

export interface LoaderDeps {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  extensionFactories?: InlineExtension[];
}

function norm(p: string): string {
  return resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

function under(file: string, dir: string): boolean {
  const f = norm(file);
  const d = norm(dir);
  return f === d || f.startsWith(`${d}/`);
}

/**
 * 设计者声明的扩展所提供的工具名。
 * 只认 `spec.extensions` 里显式给的那些（路径或内联工厂），**不**包括用户级/项目级自动发现的扩展 ——
 * 否则 `tools` 白名单会被环境里碰巧存在的扩展悄悄撑开，等于绕过设计者的能力裁剪。
 * （探路实测：内联工厂在 getExtensions() 里的 path 形如 `<inline:1>`。）
 */
export function declaredExtensionToolNames(spec: MemberSpec, loader: DefaultResourceLoader): string[] {
  const declaredPaths = new Set(
    (spec.extensions ?? []).filter((e): e is string => typeof e === "string").map((p) => norm(p)),
  );
  return loader
    .getExtensions()
    .extensions.filter((e) => e.path.startsWith("<inline:") || declaredPaths.has(norm(e.path)))
    .flatMap((e) => [...e.tools.keys()]);
}

/**
 * 配置收敛：把 MemberSpec 里声明的技能/扩展/角色变成 DefaultResourceLoader 的显式注入。
 * 技能名解析失败、Skill 对象指向不存在的文件 —— 一律抛错，不静默降级（决策 #2/#27）。
 */
export async function buildLoader(spec: MemberSpec, deps: LoaderDeps): Promise<DefaultResourceLoader> {
  const skillPaths: string[] = [];
  const skillNames: string[] = [];
  const skillObjects: Skill[] = [];

  for (const ref of spec.skills ?? []) {
    if (typeof ref === "string") {
      if (/\.md$/i.test(ref) || /[\\/]/.test(ref)) skillPaths.push(ref);
      else skillNames.push(ref);
    } else {
      if (!existsSync(ref.filePath)) {
        throw new Error(`技能「${ref.name}」的 SKILL.md 不存在：${ref.filePath}`);
      }
      skillObjects.push(ref);
    }
  }

  const extensionPaths: string[] = [];
  const extensionFactories: InlineExtension[] = [...(deps.extensionFactories ?? [])];
  for (const ext of spec.extensions ?? []) {
    if (typeof ext === "string") extensionPaths.push(ext);
    else extensionFactories.push(ext);
  }

  const loader = new DefaultResourceLoader({
    cwd: deps.cwd,
    agentDir: deps.agentDir,
    settingsManager: deps.settingsManager,
    ...(extensionFactories.length ? { extensionFactories } : {}),
    ...(extensionPaths.length ? { additionalExtensionPaths: extensionPaths } : {}),
    ...(skillPaths.length ? { additionalSkillPaths: skillPaths } : {}),
    ...(skillObjects.length
      ? {
          skillsOverride: (base: { skills: Skill[]; diagnostics: any[] }) => ({
            skills: [
              ...base.skills.filter((b) => !skillObjects.some((o) => samePath(o.filePath, b.filePath))),
              ...skillObjects,
            ],
            diagnostics: base.diagnostics,
          }),
        }
      : {}),
    appendSystemPrompt: spec.role ? [spec.role] : [],
  });

  await loader.reload();
  const available = loader.getSkills().skills;

  for (const name of skillNames) {
    if (!available.some((s) => s.name === name)) {
      const known = available.map((s) => s.name).join(", ") || "(无)";
      throw new Error(`找不到技能「${name}」，当前可用：${known}`);
    }
  }
  for (const ref of skillPaths) {
    const hit = /\.md$/i.test(ref)
      ? available.some((s) => samePath(s.filePath, ref))
      : available.some((s) => under(s.filePath, ref));
    if (!hit) throw new Error(`技能路径没能加载出任何技能：${ref}`);
  }

  return loader;
}
