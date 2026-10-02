// demo/env/extensions/env-probe.ts —— 这个 demo 自带的插件。
//
// 它躺在 demo/env/extensions/ 里，pi 会自动发现并加载 agentDir 下的插件。
// 所以「这个工具被加载了」本身就是证据：插件来自 demo/env，不是本机 pi。
// （也可以显式声明：MemberSpec.extensions = ["./env/extensions/env-probe.ts"]。）
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "env_probe",
    label: "Env Probe",
    description: "返回一句话，说明这个工具是从哪个环境加载进来的",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text" as const, text: "env-probe：我是 demo/env/extensions/ 里的插件注册的工具" }],
      details: {},
    }),
  });
}
