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
 * One gap below is now RESOLVED, verified directly against the installed
 * `@nitrostack/core` package's compiled source (not just its .d.ts), and
 * one is a documented, currently real SDK limitation — not a TODO left
 * for later, but something this version of the SDK cannot do:
 *
 *  1. RESOLVED — Resource templates (`transaction://{transactionId}` etc.).
 *     `server.resource(resource)` inspects `resource.uri` and, if it
 *     contains `{param}`, auto-registers a matching `ResourceTemplate` AND
 *     keeps the *same* `Resource` as the template's read target — there is
 *     no separate `server.resourceTemplate(...)` call needed for dynamic
 *     reads. On an incoming `resources/read`, the SDK regex-matches the
 *     concrete URI (e.g. `transaction://TX-827`) against the registered
 *     template and calls that resource's `handler(uri, context)` with the
 *     *real* URI — never just the template's static metadata. See
 *     `toSdkResource` below, which adapts each `{uriTemplate, description,
 *     read}` descriptor into that `handler(uri, context)` shape by
 *     extracting the `{param}` value out of the incoming URI itself.
 *
 *  2. STILL OPEN — Request-level authentication over HTTP. The installed
 *     SDK does not forward the real incoming `Authorization` header into
 *     `ExecutionContext` anywhere — `context.metadata` is populated only
 *     from a JSON-RPC call's own `_meta` field (a client-supplied
 *     convenience, not a header), and `context.auth` is only populated by
 *     the SDK's own `ApiKeyModule`/`JWTModule`/`OAuthModule` guards, which
 *     implement their *own* schemes (API key header / JWT / OAuth 2.1) —
 *     none of which is a drop-in for this app's shared-Bearer-token
 *     `security/auth.ts`. Concretely:
 *       - Over stdio (the default transport in development — see
 *         `NitroStackServer.start()`), there is no HTTP request or header
 *         at all, so this question doesn't apply.
 *       - Over HTTP/dual transport (production), the only way today for
 *         `security/auth.ts`'s existing Bearer check to see a token is if
 *         the *client* is configured to place it in each call's `_meta`
 *         field (`context.metadata.authorizationHeader`, already wired
 *         below) — the SDK will not extract it from a real `Authorization`
 *         header on its own. Migrating to `ApiKeyModule`/`JWTModule` would
 *         mean adopting one of *those* schemes instead of a shared Bearer
 *         secret. This is a real, currently-unresolved SDK gap, not
 *         something to paper over with a fabricated header-forwarding
 *         shim; flagging it here so it isn't silently "fixed" incorrectly.
 *     `security/authorization.ts` (the least-privilege capability map) and
 *     `security/input-validation.ts` are unaffected either way — they run
 *     entirely on data already inside this process.
 * -----------------------------------------------------------------------
 */

import {
  createServer,
  createResource,
  Prompt,
  Tool,
  type ExecutionContext,
  type JsonValue,
} from "@nitrostack/core";

import { appModule } from "./app.module.js";
import { checkLiveness, checkReadiness } from "./health/health.js";
import { logger } from "./observability/logger.js";
import type { ToolInvocationContext } from "./modules/tool-runtime.js";
import { CALCULATE_RISK_TOOL_NAME } from "./modules/risk.tools.js";
import { PREPARE_APPROVAL_TOOL_NAME } from "./modules/approval.tools.js";

const { tools, resources, prompts } = appModule;

/**
 * Attaches a `src/widgets/app/<route>` widget (see that directory's
 * Next.js pages) to its backing tool by name, plus the `examples.response`
 * every widget preview needs ("Without examples.response, the widget
 * preview won't render in the client" — UI Widgets Guide). Only tools
 * with a real, ready widget page are listed here. `EvidenceTimeline` is
 * deliberately absent: no tool currently returns an `Evidence[]` payload
 * (evidence is only exposed read-only via the `investigation://{caseId}`
 * resource), and `widget: { route }` only attaches to a *Tool* in this
 * SDK version — it still previews fine in Studio via widget-manifest.json
 * regardless of tool wiring.
 */
const TOOL_WIDGETS: Record<string, { route: string; examples: { request: JsonValue; response: JsonValue } }> = {
  [CALCULATE_RISK_TOOL_NAME]: {
    route: "/risk-card",
    examples: {
      request: { beneficiaryMismatch: true, amountAnomaly: true, policyViolation: true },
      response: {
        caseId: "CASE-827",
        rawScore: 87,
        riskScore: 87,
        riskLevel: "HIGH",
        factors: [
          { name: "beneficiaryMismatch", weight: 35, triggered: true },
          { name: "amountAnomaly", weight: 32, triggered: true },
          { name: "policyViolation", weight: 20, triggered: true },
        ],
      },
    },
  },
  [PREPARE_APPROVAL_TOOL_NAME]: {
    route: "/approval-card",
    examples: {
      request: {
        caseId: "CASE-827",
        transactionId: "TX-827",
        riskScore: 87,
        riskLevel: "HIGH",
        recommendation: "HOLD",
      },
      response: {
        caseId: "CASE-827",
        status: "WAITING_FOR_HUMAN_APPROVAL",
        recommendation: "HOLD",
        riskScore: 87,
      },
    },
  },
};

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
  const widgetConfig = TOOL_WIDGETS[descriptor.name];
  return new Tool({
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    ...(widgetConfig && { widget: { route: widgetConfig.route }, examples: widgetConfig.examples }),
    handler: async (input: unknown, context: ExecutionContext) => {
      const toolCtx: ToolInvocationContext = {
        correlationId: context.requestId,
        // See gap #2 above (still open): only populated if the calling
        // client places a token in this call's `_meta.authorizationHeader`
        // — the SDK does not extract this from a real HTTP Authorization
        // header on its own.
        authorizationHeader: (context.metadata?.authorizationHeader as string | undefined) ?? undefined,
      };
      return descriptor.handler(input, toolCtx);
    },
  });
}

/**
 * Adapts one of our `{ uriTemplate, description, read(id) }` resource
 * descriptors (see gap #1 above — resolved) into a real `@nitrostack/core`
 * `Resource`. `read(id)` only ever wants the *parsed* `{param}` value, so
 * this extracts it from the concrete incoming `uri` the SDK hands the
 * handler (e.g. `transaction://TX-827` -> `TX-827`) by re-deriving the
 * same param name/position from `uriTemplate` — there is exactly one
 * `{param}` per template in every descriptor in `src/modules/*.resources.ts`.
 */
function toSdkResource(descriptor: (typeof resources)[number]) {
  const paramMatch = /\{([^}]+)\}/.exec(descriptor.uriTemplate);
  const paramName = paramMatch?.[1] ?? "id";
  const [scheme] = descriptor.uriTemplate.split("://");

  return createResource({
    uri: descriptor.uriTemplate,
    name: `${scheme}-${paramName}`,
    description: descriptor.description,
    handler: async (uri: string) => {
      // Extract the concrete param value from e.g. "transaction://TX-827"
      // using the same "://" + single-segment-id shape every resource here
      // uses (mirrors `assertId`'s pattern in resource-runtime.ts).
      const id = uri.slice(uri.indexOf("://") + 3);
      const result = descriptor.read(id);
      // `createResource`'s `ResourceDefinition['handler']` return type
      // (`Promise<ResourceContent>`) checks this shape contextually —
      // `ResourceContent` itself isn't part of this SDK version's public
      // export surface (defined in types.ts but not re-exported from the
      // package root), so it can't be imported and annotated directly here.
      return { type: "json" as const, data: result as JsonValue };
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

// Resources: gap #1 resolved above. `server.resource(...)` auto-detects
// the `{param}` in each `uriTemplate` and wires template-read dispatch
// itself — no separate `server.resourceTemplate(...)` call is needed.
for (const resourceDescriptor of resources) {
  server.resource(toSdkResource(resourceDescriptor));
}

logger.info("server.resources_registered", {
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
