import test from "node:test";
import assert from "node:assert/strict";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { startFaux } from "./faux-server.ts";
import { assistantTexts, lastAssistant, makeFauxRuntime } from "./faux-models.ts";

test("假 provider 能跑通一次完整 prompt", async () => {
  const faux = await startFaux();
  const { runtime, agentDir, cwd } = await makeFauxRuntime(faux.baseUrl);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: runtime.getModel("faux", "echo")!,
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({}),
  });
  await session.prompt("hi");
  assert.match(assistantTexts(session).join(""), /echo:hi/);
  assert.ok(lastAssistant(session).usage.totalTokens > 0);
  await faux.close();
});
