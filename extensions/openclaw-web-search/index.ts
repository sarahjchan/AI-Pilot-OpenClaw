import { readFile, access } from "node:fs/promises";
import { execSync } from "node:child_process";
import { homedir, release } from "node:os";
import { join } from "node:path";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";

const WEB_SEARCH_API = "https://ollama.com/api/web_search";
const MAX_RESULTS = 5;
const TIMEOUT_MS = 15_000;
const OLLAMA_KEYS_URL = "https://ollama.com/settings/keys";
const WEB_SEARCH_TOOL_NAME = "ollama_web_search";
const WEB_SEARCH_PLUGIN_ID = "openclaw-web-search";
const WEB_SEARCH_PLUGIN_GROUP = "group:plugins";
const OPENCLAW_API_KEY_CONFIG_PATH =
  `plugins.entries.${WEB_SEARCH_PLUGIN_ID}.config.apiKey`;

interface PluginConfig {
  apiKey?: string;
}

interface ConfigWriteApi {
  loadConfig(): Record<string, any>;
  writeConfigFile(nextConfig: Record<string, any>): Promise<void>;
}

interface KeyPair {
  privateKey: ReturnType<typeof createPrivateKey>;
  pubBase64: string;
}

function isWSL(): boolean {
  return release().toLowerCase().includes("microsoft");
}

function windowsOllamaKeyPath(): string | null {
  try {
    const raw = execSync('cmd.exe /C "echo %USERPROFILE%" 2>/dev/null', {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const posix = raw
      .replace(/\\/g, "/")
      .replace(/^([A-Za-z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`);
    return join(posix, ".ollama", "id_ed25519");
  } catch {
    return null;
  }
}

let _cachedKeyPath: string | null = null;
let _pluginApiKey: string | undefined;

function parsePluginConfig(value: unknown): PluginConfig {
  if (!value || typeof value !== "object") return {};
  const apiKey = (value as Record<string, unknown>).apiKey;
  return { apiKey: typeof apiKey === "string" ? apiKey : undefined };
}

function syncPluginApiKey(pluginConfig: unknown): void {
  _pluginApiKey = parsePluginConfig(pluginConfig).apiKey?.trim() || undefined;
}

async function resolveKeyPath(): Promise<string | null> {
  if (_cachedKeyPath) return _cachedKeyPath;

  const nativePath = join(homedir(), ".ollama", "id_ed25519");

  if (isWSL()) {
    // On WSL, prefer the Windows-side key (registered with ollama.com)
    // and fall back to the native WSL key.
    const winPath = windowsOllamaKeyPath();
    if (winPath) {
      try {
        await access(winPath);
        _cachedKeyPath = winPath;
        return _cachedKeyPath;
      } catch {}
    }
  }

  try {
    await access(nativePath);
    _cachedKeyPath = nativePath;
    return _cachedKeyPath;
  } catch {}

  return null;
}

async function loadKey(): Promise<KeyPair | null> {
  const keyPath = await resolveKeyPath();
  if (!keyPath) return null;
  try {
    const pem = await readFile(keyPath, "utf-8");
    const lines = pem.split("\n").filter((l) => !l.startsWith("-----") && l.trim());
    const der = Buffer.from(lines.join(""), "base64");

    const magic = "openssh-key-v1\0";
    let offset = magic.length;
    const readBuf = (): Buffer => {
      const len = der.readUInt32BE(offset);
      offset += 4;
      const data = der.subarray(offset, offset + len);
      offset += len;
      return data;
    };

    readBuf(); // ciphername
    readBuf(); // kdfname
    readBuf(); // kdfoptions
    offset += 4; // nkeys
    readBuf(); // public key blob (must be read before private section)
    const privBlob = readBuf(); // private section

    // Parse private section: 2x uint32 checkint, keytype, pubkey(32), privkey(64), comment
    let po = 8; // skip checkints
    const readPrivBuf = (): Buffer => {
      const len = privBlob.readUInt32BE(po);
      po += 4;
      const data = privBlob.subarray(po, po + len);
      po += len;
      return data;
    };
    readPrivBuf();
    const pubkey = readPrivBuf();
    const privkey = readPrivBuf();

    const seed = privkey.subarray(0, 32);
    const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const pkcs8 = Buffer.concat([pkcs8Prefix, seed]);
    const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });

    const keyType = Buffer.from("ssh-ed25519");
    const sshPub = Buffer.alloc(4 + keyType.length + 4 + pubkey.length);
    sshPub.writeUInt32BE(keyType.length, 0);
    keyType.copy(sshPub, 4);
    sshPub.writeUInt32BE(pubkey.length, 4 + keyType.length);
    pubkey.copy(sshPub, 4 + keyType.length + 4);

    return { privateKey, pubBase64: sshPub.toString("base64") };
  } catch {
    return null;
  }
}

function resolveConfiguredApiKey(): string | null {
  const apiKey = _pluginApiKey?.trim() || process.env.OLLAMA_API_KEY?.trim();
  return apiKey || null;
}

function clonePluginEntryConfig(config: Record<string, any>): Record<string, any> {
  const entry = config.plugins?.entries?.[WEB_SEARCH_PLUGIN_ID];
  if (!entry || typeof entry !== "object") return {};
  const pluginConfig = entry.config;
  return pluginConfig && typeof pluginConfig === "object" ? { ...pluginConfig } : {};
}

function withPluginApiKey(
  config: Record<string, any>,
  apiKey: string | null,
): Record<string, any> {
  const nextPluginConfig = clonePluginEntryConfig(config);
  if (apiKey) {
    nextPluginConfig.apiKey = apiKey;
  } else {
    delete nextPluginConfig.apiKey;
  }

  const existingPlugins = config.plugins && typeof config.plugins === "object"
    ? config.plugins
    : {};
  const existingEntries = existingPlugins.entries && typeof existingPlugins.entries === "object"
    ? existingPlugins.entries
    : {};
  const existingEntry = existingEntries[WEB_SEARCH_PLUGIN_ID] &&
      typeof existingEntries[WEB_SEARCH_PLUGIN_ID] === "object"
    ? existingEntries[WEB_SEARCH_PLUGIN_ID]
    : {};

  const nextEntry =
    Object.keys(nextPluginConfig).length > 0 ? { ...existingEntry, config: nextPluginConfig } : (() => {
      const { config: _ignoredConfig, ...rest } = existingEntry;
      return rest;
    })();

  return {
    ...config,
    plugins: {
      ...existingPlugins,
      entries: {
        ...existingEntries,
        [WEB_SEARCH_PLUGIN_ID]: nextEntry,
      },
    },
  };
}

function asObjectRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, any>) }
    : {};
}

function cloneStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function resolveToolPolicySource(config: Record<string, any>): string | null {
  const tools = asObjectRecord(config.tools);
  for (const [path, rawList] of [
    ["tools.allow", tools.allow],
    ["tools.alsoAllow", tools.alsoAllow],
  ] as const) {
    const list = cloneStringList(rawList);
    if (list.includes(WEB_SEARCH_TOOL_NAME)) {
      return `${path} (${WEB_SEARCH_TOOL_NAME})`;
    }
    if (list.includes(WEB_SEARCH_PLUGIN_ID)) {
      return `${path} (${WEB_SEARCH_PLUGIN_ID})`;
    }
    if (list.includes(WEB_SEARCH_PLUGIN_GROUP)) {
      return `${path} (${WEB_SEARCH_PLUGIN_GROUP})`;
    }
  }
  return null;
}

function withWebSearchToolEnabled(
  config: Record<string, any>,
): { nextConfig: Record<string, any>; changed: boolean; policyPath: string } {
  const existingSource = resolveToolPolicySource(config);
  if (existingSource) {
    return { nextConfig: config, changed: false, policyPath: existingSource };
  }

  const tools = asObjectRecord(config.tools);
  if (Array.isArray(tools.allow)) {
    const allow = cloneStringList(tools.allow);
    allow.push(WEB_SEARCH_TOOL_NAME);
    return {
      nextConfig: {
        ...config,
        tools: {
          ...tools,
          allow,
        },
      },
      changed: true,
      policyPath: `tools.allow (${WEB_SEARCH_TOOL_NAME})`,
    };
  }

  const alsoAllow = cloneStringList(tools.alsoAllow);
  alsoAllow.push(WEB_SEARCH_TOOL_NAME);
  return {
    nextConfig: {
      ...config,
      tools: {
        ...tools,
        alsoAllow,
      },
    },
    changed: true,
    policyPath: `tools.alsoAllow (${WEB_SEARCH_TOOL_NAME})`,
  };
}

function missingAuthMessage(): string {
  return `Web search requires authentication. Paste an Ollama API key into ${OPENCLAW_API_KEY_CONFIG_PATH} or set OLLAMA_API_KEY. Create a key at ${OLLAMA_KEYS_URL}. File-based auth via ~/.ollama/id_ed25519 is still supported when that key is readable.`;
}

function invalidAuthMessage(): string {
  return `Web search authentication failed. Your Ollama API key or ~/.ollama/id_ed25519 key may be invalid. Refresh the key at ${OLLAMA_KEYS_URL}, or run ollama signin again if you are using file-based auth.`;
}

async function buildAuthHeader(requestURI: string): Promise<string | null> {
  const apiKey = resolveConfiguredApiKey();
  if (apiKey) return `Bearer ${apiKey}`;

  const key = await loadKey();
  if (!key) return null;
  const payload = Buffer.from(`POST,${requestURI}`);
  const sig = cryptoSign(null, payload, key.privateKey);
  return `Bearer ${key.pubBase64}:${sig.toString("base64")}`;
}

async function executeOllamaWebSearch(
  _toolCallId: string,
  params: { query: string },
  signal?: AbortSignal,
) {
  const query = params.query?.trim();
  if (!query) {
    throw new Error("query parameter is required");
  }

  const url = new URL(WEB_SEARCH_API);
  const ts = Math.floor(Date.now() / 1000).toString();
  url.searchParams.set("ts", ts);

  const requestURI = `${url.pathname}?${url.searchParams.toString()}`;
  const authHeader = await buildAuthHeader(requestURI);
  if (!authHeader) {
    throw new Error(missingAuthMessage());
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({ query, max_results: MAX_RESULTS }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Web search timed out after ${TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401) {
    throw new Error(invalidAuthMessage());
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Web search failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    results: { title: string; url: string; content: string }[];
  };

  if (!data.results?.length) {
    return { content: [{ type: "text" as const, text: `No results for: ${query}` }] };
  }

  const text = data.results
    .map(
      (r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content?.length > 300 ? r.content.slice(0, 300) + "..." : r.content}`,
    )
    .join("\n\n");

  return { content: [{ type: "text" as const, text }] };
}

async function webSearchStatusText(config?: Record<string, any>): Promise<string> {
  const pluginKey = _pluginApiKey?.trim() || "";
  const envKey = process.env.OLLAMA_API_KEY?.trim() || "";
  const keyPath = await resolveKeyPath();
  const toolPolicy = config ? resolveToolPolicySource(config) : null;

  const activeSource = pluginKey
    ? "plugin config"
    : envKey
    ? "OLLAMA_API_KEY"
    : keyPath
    ? `key file (${keyPath})`
    : "not configured";

  return [
    "Web search auth status:",
    `- active source: ${activeSource}`,
    `- plugin apiKey: ${pluginKey ? "(set)" : "(unset)"}`,
    `- OLLAMA_API_KEY: ${envKey ? "(set)" : "(unset)"}`,
    `- key file fallback: ${keyPath ?? "(not found)"}`,
    `- global tool policy: ${toolPolicy ?? "(not enabled)"}`,
    "",
    `Create a key at ${OLLAMA_KEYS_URL}`,
    "To save a key in OpenClaw: /websearch auth <OLLAMA_API_KEY>",
    "To enable the tool without changing auth: /websearch enable",
    `The model can only use ${WEB_SEARCH_TOOL_NAME} after OpenClaw exposes it in tool policy.`,
    "Start a new session or restart the gateway if the agent still does not see the tool.",
    "Use a private/owner-only chat for this command. Some channels may keep slash command text in history or provider logs.",
  ].join("\n");
}

function updateLivePluginConfig(api: any, apiKey: string | null): void {
  const nextPluginConfig = asObjectRecord(api.pluginConfig);
  if (apiKey) {
    nextPluginConfig.apiKey = apiKey;
  } else {
    delete nextPluginConfig.apiKey;
  }
  api.pluginConfig = nextPluginConfig;
  _pluginApiKey = apiKey?.trim() || undefined;
}

async function setPluginApiKey(
  api: any,
  configApi: ConfigWriteApi,
  apiKey: string | null,
): Promise<Record<string, any>> {
  const currentConfig = configApi.loadConfig();
  const nextConfig = withPluginApiKey(currentConfig, apiKey);
  await configApi.writeConfigFile(nextConfig);
  updateLivePluginConfig(api, apiKey);
  return nextConfig;
}

async function enableWebSearchTool(
  configApi: ConfigWriteApi,
): Promise<{ nextConfig: Record<string, any>; changed: boolean; policyPath: string }> {
  const currentConfig = configApi.loadConfig();
  const { nextConfig, changed, policyPath } = withWebSearchToolEnabled(currentConfig);
  if (changed) {
    await configApi.writeConfigFile(nextConfig);
  }
  return { nextConfig, changed, policyPath };
}

async function handleWebSearchCommand(api: any, args: string): Promise<{ text: string }> {
  syncPluginApiKey(api.pluginConfig);
  const tokens = args.split(/\s+/).filter(Boolean);
  const action = tokens[0]?.toLowerCase() ?? "status";
  const configApi = api.runtime?.config as ConfigWriteApi | undefined;
  const loadedConfig = configApi?.loadConfig?.();

  if (action === "status" || action === "help") {
    return { text: await webSearchStatusText(loadedConfig) };
  }

  if (!["auth", "enable"].includes(action)) {
    return {
      text: [
        "Web search commands:",
        "",
        "/websearch status",
        "/websearch enable",
        "/websearch auth <OLLAMA_API_KEY>",
        "/websearch auth clear",
        "",
        `Create a key at ${OLLAMA_KEYS_URL}`,
      ].join("\n"),
    };
  }

  if (!configApi?.loadConfig || !configApi?.writeConfigFile) {
    return {
      text:
        "Web search commands cannot update config in this runtime. Set " +
        `${OPENCLAW_API_KEY_CONFIG_PATH} and tools.alsoAllow/tools.allow manually.`,
    };
  }

  if (action === "enable") {
    const { nextConfig, changed, policyPath } = await enableWebSearchTool(configApi);
    return {
      text: [
        changed
          ? `Enabled ${WEB_SEARCH_TOOL_NAME} in ${policyPath}.`
          : `${WEB_SEARCH_TOOL_NAME} is already enabled via ${policyPath}.`,
        "Start a new session or restart the gateway if the agent still does not see the tool.",
        "",
        await webSearchStatusText(nextConfig),
      ].join("\n"),
    };
  }

  const authArgs = tokens.slice(1);
  const subaction = authArgs[0]?.toLowerCase() ?? "";

  if (!subaction) {
    return {
      text: [
        "Usage: /websearch auth <OLLAMA_API_KEY>",
        "       /websearch auth clear",
        "       /websearch enable",
        "",
        `Create a key at ${OLLAMA_KEYS_URL}`,
        `This also enables ${WEB_SEARCH_TOOL_NAME} in OpenClaw tool policy.`,
        "Use a private/owner-only chat for this command. Some channels may keep slash command text in history or provider logs.",
      ].join("\n"),
    };
  }

  if (subaction === "clear" || subaction === "unset" || subaction === "remove") {
    const nextConfig = await setPluginApiKey(api, configApi, null);
    const status = await webSearchStatusText(nextConfig);
    return {
      text:
        "Cleared the saved web search API key from plugin config.\n" +
        "Environment-variable and key-file auth may still apply. Tool enablement was left unchanged.\n\n" +
        status,
    };
  }

  const apiKey = authArgs.join(" ").trim();
  if (!apiKey) {
    return { text: "Usage: /websearch auth <OLLAMA_API_KEY>" };
  }

  const nextConfig = await setPluginApiKey(api, configApi, apiKey);
  const enabled = withWebSearchToolEnabled(nextConfig);
  const finalConfig = enabled.changed ? enabled.nextConfig : nextConfig;
  if (enabled.changed) {
    await configApi.writeConfigFile(finalConfig);
  }

  return {
    text: [
      `Saved Ollama API key to ${OPENCLAW_API_KEY_CONFIG_PATH}.`,
      "Web search can use it immediately in this process.",
      enabled.changed
        ? `Enabled ${WEB_SEARCH_TOOL_NAME} in ${enabled.policyPath}.`
        : `${WEB_SEARCH_TOOL_NAME} is already enabled via ${enabled.policyPath}.`,
      "",
      `You can create or rotate keys at ${OLLAMA_KEYS_URL}`,
      "Start a new session or restart the gateway if the agent still does not see the tool.",
      "Use a private/owner-only chat for this command. Some channels may keep slash command text in history or provider logs.",
    ].join("\n"),
  };
}

const ollamaWebSearchPlugin = {
  id: WEB_SEARCH_PLUGIN_ID,
  name: "Ollama Web Search",
  description: "Web search via ollama.com API",
  configSchema: {
    parse: parsePluginConfig,
  },
  register(api: any) {
    syncPluginApiKey(api.pluginConfig);
    api.registerCommand({
      name: "websearch",
      description: "Web search settings.",
      acceptsArgs: true,
      handler: async (ctx: { args?: string }) => {
        const args = ctx.args?.trim() ?? "";
        return handleWebSearchCommand(api, args);
      },
    });
    api.registerTool({
      name: WEB_SEARCH_TOOL_NAME,
      label: "Ollama Web Search",
      description:
        "Search the web for current information using Ollama's search API.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
      execute: executeOllamaWebSearch,
    } as any);
  },
};

export default ollamaWebSearchPlugin;
