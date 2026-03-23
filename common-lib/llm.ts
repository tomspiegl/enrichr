/**
 * Shared LLM call helper — wraps pi SDK session creation into a single function.
 */

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

export { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

export interface LlmContext {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: any;
}

/** Resolve a model spec like "anthropic/claude-sonnet-4-20250514" into an LlmContext */
export function createLlmContext(modelSpec: string): LlmContext {
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);
  const [provider, ...idParts] = modelSpec.split("/");
  const model = modelRegistry.find(provider, idParts.join("/"));
  if (!model) {
    throw new Error(`Model "${modelSpec}" not found.`);
  }
  return { authStorage, modelRegistry, model };
}

/** Single LLM call — creates a disposable session, returns the response text */
export async function llmCall(
  systemPrompt: string,
  userPrompt: string,
  ctx: LlmContext
): Promise<string> {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    settingsManager: SettingsManager.inMemory(),
    disableExtensions: true,
    disableSkills: true,
    disablePromptTemplates: true,
    disableThemes: true,
    disableAgentsFiles: true,
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    model: ctx.model,
    thinkingLevel: "off",
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    resourceLoader: loader,
    tools: [],
  });

  let response = "";
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      response += event.assistantMessageEvent.delta;
    }
  });

  await session.prompt(userPrompt);
  session.dispose();
  return response.trim();
}

/** Parse JSON from LLM response — handles markdown fences */
export function parseJson<T = any>(raw: string): T {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) s = fence[1].trim();
  return JSON.parse(s);
}

/** Verify a URL is reachable (HEAD request, 5s timeout) */
export async function verifyUrl(url: string): Promise<boolean> {
  const fullUrl = url.startsWith("http") ? url : `https://${url}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(fullUrl, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
    clearTimeout(timer);
    return res.status < 400;
  } catch {
    return false;
  }
}
