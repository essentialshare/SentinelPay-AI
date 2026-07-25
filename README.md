# SentinelPay AI

**Investigate. Verify. Explain. Approve.**

SentinelPay AI is a controlled financial decision firewall that sits between
an AI agent and consequential financial actions. It receives a request like
*"Investigate transaction TX-827 and tell me whether it should be
released,"* gathers evidence through narrowly-scoped, read-only MCP tools,
runs that evidence through deterministic policy and risk engines, and
prepares a human-review request — it never executes a payment, approves
itself, or modifies vendor/policy records.

> **AI may investigate. AI may reason. AI may recommend. AI may explain.**
> **AI may NOT hold the keys to the money.**

This is an MVP prototype built against deterministic local fixtures. It does
not move real money and does not claim to detect legally-established fraud.

## Contents

- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Project structure](#project-structure)
- [MCP surface](#mcp-surface)
- [Testing](#testing)
- [Deployment](#deployment)
- [Safety boundaries](#safety-boundaries)

## Architecture

Seven MCP tools carry out a strict evidence-first pipeline:

```
getTransaction → verifyVendor → analyzeInvoice → getPaymentHistory
      → evaluatePolicy → calculateRisk → prepareApproval
```

Missing or conflicting evidence is never silently treated as safe — it is
recorded as its own evidence type (`INCOMPLETE_EVIDENCE`, `DATA_CONFLICT`)
and forces a `HOLD` recommendation regardless of the numeric risk score.

See [`docs/architecture.md`](docs/architecture.md) for the full component
breakdown and [`docs/threat-model.md`](docs/threat-model.md) for the
security model.

## Getting started

### Prerequisites

- Node.js LTS (>=20)
- npm or pnpm
- Git
- The official NitroStack CLI and TypeScript SDK

```bash
node --version
npm --version
git --version
nitrostack --version
```

### Install

```bash
npm install
cp .env.example .env
# then edit .env and set MCP_AUTH_TOKEN to a long random value
```

### Run locally

```bash
npm run dev
```

The server logs a `server.ready` line once fixture data has loaded
successfully. If `.env` has no `MCP_AUTH_TOKEN`, the server intentionally
fails closed rather than serving unauthenticated requests.

> **NitroStack wiring note:** this project deliberately keeps every tool,
> resource, and prompt module framework-agnostic (plain descriptor objects,
> no `@nitrostack/core` import). `src/index.ts` is the one place that needs
> the exact SDK registration call, taken from your installed CLI's
> scaffold/`--help` output rather than guessed — see the comment block at
> the top of that file and Appendix B of
> [`docs/technical-specification.md`](docs/technical-specification.md).

## Environment variables

See [`.env.example`](.env.example) for the full, documented list. The most
important ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_AUTH_TOKEN` | unset (fails closed) | Bearer token required on every tool call |
| `APPROVAL_THRESHOLD` | `500000` | INR amount above which human approval is required |
| `BENEFICIARY_MISMATCH_WEIGHT` | `35` | Risk weight |
| `AMOUNT_ANOMALY_WEIGHT` | `32` | Risk weight |
| `POLICY_VIOLATION_WEIGHT` | `20` | Risk weight |
| `RISK_SCORE_CAP` | `100` | Maximum risk score |

## Project structure

```
sentinelpay-ai/
├── src/
│   ├── index.ts              # Entry point (NitroStack wiring goes here)
│   ├── app.module.ts          # Collects every tool/resource/prompt descriptor
│   ├── modules/                # MCP-facing tools, resources, prompts
│   ├── domain/                 # Types, schemas, evidence logic, errors
│   ├── services/                # Business logic (fixture repo, engines, audit)
│   ├── widgets/                 # RiskCard, EvidenceTimeline, ApprovalCard (React)
│   ├── security/                 # auth, authorization, input validation, prompt safety
│   ├── observability/            # logger, metrics, tracing, audit events
│   └── health/                    # liveness / readiness
├── data/                            # Deterministic JSON fixtures (source of truth)
├── tests/                            # unit / integration / e2e / security
└── docs/                               # architecture, demo script, threat model
```

## MCP surface

**Tools** (exactly seven, read-only or compute-only — no `executePayment`
exists anywhere in this codebase):

| Tool | Purpose |
| --- | --- |
| `getTransaction` | Retrieve a transaction by ID |
| `verifyVendor` | Retrieve vendor identity + verified beneficiary account |
| `analyzeInvoice` | Retrieve invoice evidence, including duplicate status |
| `getPaymentHistory` | Retrieve computed payment-history statistics |
| `evaluatePolicy` | Apply deterministic policy rules to collected evidence |
| `calculateRisk` | Compute a reproducible prototype risk score (0–100) |
| `prepareApproval` | Create a `WAITING_FOR_HUMAN_APPROVAL` review request |

**Resources** (read-only contextual views):

```
transaction://{transactionId}
counterparty://{vendorId}
invoice://{invoiceId}
policy://{policyId}
investigation://{caseId}
audit://{caseId}
history://{vendorId}        (additive)
risk://{caseId}             (additive)
```

**Prompts:** `investigate_payment`, `explain_risk`.

## Testing

```bash
npm test                 # everything
npm run test:unit        # domain + service unit tests
npm run test:integration
npm run test:e2e         # full TX-827 pipeline regression test
npm run test:security    # auth, authorization, prompt-injection defense
```

The locked reference case is `TX-827`: risk score **87** (HIGH), historical
average **₹173,200**, amount multiplier **≈4.86x**, beneficiary mismatch
(`XXXX8291` vs `XXXX4412`), recommendation **HOLD**.

## Deployment

1. Confirm the server runs locally (`npm run dev`).
2. Push to a stable `main` branch.
3. Deploy to NitroStack Cloud using the current CLI's deploy command.
4. Smoke-test the deployed MCP endpoint against `TX-827`.
5. Repeat for each subsequent feature.

Docker is optional for this MVP; a conceptual `Dockerfile` is:

```dockerfile
FROM node:lts
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["npm", "start"]
```

## Safety boundaries

- No real-money transfer — there is no `executePayment` tool.
- No autonomous approval — every case is created as
  `WAITING_FOR_HUMAN_APPROVAL`.
- No modification of vendor, invoice, or policy records by the agent.
- Missing or conflicting evidence never becomes a silent positive
  assumption — it is recorded and forces `HOLD`.
- Invoice/document content is always treated as untrusted data, never as
  instructions (see `src/security/prompt-safety.ts`).
- The risk score is a labeled prototype heuristic, not a validated
  probability of fraud, AML compliance, or legal certainty.

See [`docs/threat-model.md`](docs/threat-model.md) for the full model.
