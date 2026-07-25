/**
 * SentinelPay AI — NitroStack Application Entry Point
 * Source: Technical Specification §3.1/§3.2 (src/index.ts), §16.2, Appendix B
 *
 * -----------------------------------------------------------------------
 * NitroStack wiring status
 * -----------------------------------------------------------------------
 * `@nitrostack/core` is installed (see package.json). Its published type
 * declarations confirm the following real, verified exports used below:
 *
 *   createServer(config: McpServerConfig): NitroStackServer
 *   new Tool({ name, description, inputSchema, handler })
 *   new Prompt({ name, description, arguments, handler })
 *   server.tool(tool) / server.prompt(prompt) / server.start()
 *
 * Every `src/modules/*.tools.ts` / `investigation.prompts.ts` file exports
 * a plain descriptor object precisely so it can be adapted into these
 * real SDK classes without touching any business logic — that adaptation
 * happens only in this file.
 *
 * Two things are deliberately NOT wired below and are called out inline,
 * per Appendix B ("never guess NitroStack syntax; verify against the
 * current scaffold/docs"):
 *
 *  1. Resource templates (`transaction://{transactionId}` etc.). The SDK's
 *     public types expose `ResourceTemplate`/`createResourceTemplate` for
 *     *advertising* a templated URI, and a separate `Resource` class whose
 *     `handler(uri, context)` serves a *fixed* URI — but the exact runtime
 *     mechanism that routes an incoming templated read (e.g.
 *     `transaction://TX-827`) to our per-ID `read()` functions in
 *     `*.resources.ts` is not fully visible from type declarations alone.
 *     Confirm the current NitroStack docs/scaffold example for dynamic
 *     resource-template handlers before wiring `server.resourceTemplate(...)`
 *     for real reads; a naive registration risks silently only ever
 *     serving the template's static metadata, never the per-ID content.
 *
 *  2. Request-level authentication. `ExecutionContext.auth` is a
 *     structured, already-validated `AuthContext` (populated by one of the
 *     SDK's own guard modules — `ApiKeyModule`/`JWTModule`/`OAuthModule`)
 *     rather than a raw `Authorization` header string, so this app's
 *     hand-rolled `security/auth.ts` (which expects the raw header) is not
 *     a drop-in guard for this SDK. Two supportable paths, to be decided
 *     against the installed SDK version's guard docs:
 *       a) attach one of the SDK's own guard modules to the server/tools
 *          and treat a populated `context.auth` as "authenticated", or
 *       b) keep `security/auth.ts` as an app-level check by forwarding the
 *          raw header through `context.metadata` if the transport exposes it.
 *     `security/authorization.ts` (the least-privilege capability map) and
 *     `security/input-validation.ts` are unaffected either way — they run
 *     entirely on data already inside this process.
 *
 * Both gaps are isolated to this file's adapter layer; nothing in
 * `modules/`, `services/`, `domain/`, or `security/` needs to change once
 * they're resolved.
 * -----------------------------------------------------------------------
 */

import { createServer, Prompt, Tool, type ExecutionContext } from "@nitrostack/core";

import { appModule } from "./app.module";
import { checkLiveness, checkReadiness } from "./health/health";
import { logger } from "./observability/logger";
import type { ToolInvocationContext } from "./modules/tool-runtime";

const { tools, resources, prompts } = appModule;

// --- Readiness gate: never appear to serve traffic without fixture data loaded (§13.7) ---
const readiness = checkReadiness();
if (readiness.status !== "ok") {
  logger.error("server.not_ready", readiness.checks);
  process.exit(1);
}

const server = createServer({
  name: "sentinelpay-ai",
  version: "1.0.0",
  description:
    "SentinelPay AI — AI governance layer / financial decision firewall for agent-initiated financial actions.",
  capabilities: { tools: true, resources: true, prompts: true },
  logging: { level: (process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error") ?? "info" },
});

/**
 * Adapts one of our framework-agnostic tool descriptors (see gap #2 above
 * re: authentication) into a real `@nitrostack/core` `Tool`. Every tool
 * still runs through this app's own `runTool` pipeline internally (auth →
 * authorization → validation → service → audit) — the SDK's `Tool` is a
 * thin transport-facing wrapper around that, not a replacement for it.
 */
function toSdkTool(descriptor: (typeof tools)[number]): Tool {
  return new Tool({
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    handler: async (input: unknown, context: ExecutionContext) => {
      const toolCtx: ToolInvocationContext = {
        correlationId: context.requestId,
        // See gap #2: until a guard/header-forwarding decision is made,
        // this app-level check will reject every call unless MCP_AUTH_TOKEN
        // handling is reconciled with the SDK's own auth context.
        authorizationHeader: (context.metadata?.authorizationHeader as string | undefined) ?? undefined,
      };
      return descriptor.handler(input, toolCtx);
    },
  });
}

function toSdkPrompt(descriptor: (typeof prompts)[number]): Prompt {
  return new Prompt({
    name: descriptor.name,
    description: descriptor.description,
    arguments: [],
    handler: async () => [{ role: "system", content: descriptor.text }],
  });
}

for (const toolDescriptor of tools) {
  server.tool(toSdkTool(toolDescriptor));
}

for (const promptDescriptor of prompts) {
  server.prompt(toSdkPrompt(promptDescriptor));
}

// Resources: see gap #1 above. `resources` (from app.module.ts) still holds
// every `{ uriTemplate, description, read }` descriptor, ready to wire once
// the dynamic-template dispatch mechanism is confirmed against the current
// NitroStack docs/scaffold.
logger.info("server.resources_pending_verification", {
  resourceCount: resources.length,
  uriTemplates: resources.map((r) => r.uriTemplate),
});

logger.info("server.boot", {
  toolCount: tools.length,
  resourceCount: resources.length,
  promptCount: prompts.length,
  nodeEnv: process.env.NODE_ENV ?? "development",
  liveness: checkLiveness().status,
});

server.start().catch((err) => {
  logger.error("server.start_failed", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

export { server };
export { tools, resources, prompts, appModule };
