# Microsoft Foundry migration runbook

Last verified: 2026-07-14

> **Superseded 2026-08-19 — historical record only.** The migration is complete
> and OpenRouter has been sunset as a sub-processor: the rollback backend, the
> `AI_PROVIDER` switch, and `OPENROUTER_API_KEY` are all removed from the code
> and from both deployments. Foundry is the only AI provider, and there is no
> longer any setting that can route a request elsewhere. The cutover and
> rollback procedures below no longer describe the system — do not follow them.
> The pricing comparison and the Foundry provisioning steps remain accurate.

## Implemented application changes

Fabric's eight AI calls now go through `convex/lib/aiProvider.ts` instead of calling OpenRouter directly. The adapter supports:

- Microsoft Foundry Claude Messages API for synthesis.
- Microsoft Foundry OpenAI v1 chat completions for safety and the warm fallback.
- Forced tool calls, normalized text/tool output, normalized stop reasons, token usage, request IDs, retries, timeouts, and prompt-free telemetry.

The model mapping is:

| Capability | Deployment | Model |
| --- | --- | --- |
| Process, department, function, flow, and voice synthesis | `fabric-claude-haiku-4-5` | Azure-hosted Claude Haiku 4.5, version `2` |
| Description safety | `fabric-description-safety` | GPT-5 nano, version `2025-08-07` |
| Evaluated fallback and Claude successor candidate | `fabric-gpt5-mini-fallback` | GPT-5 mini, version `2025-08-07` |

New voice analysis rows use `analysisProvider: "fabric-foundry"` after cutover. Existing `fabric-openrouter` rows remain valid and require no backfill.

## Pre-migration setup

### 1. Prerequisites

Use Azure subscription `dbad1439-85a4-4f10-8b06-e548be4dd778`. The implementing user was verified as subscription Owner and Foundry User. Azure CLI is authenticated, and Azure Developer CLI 1.27.1 is installed.

Open a new terminal after installation, then authenticate azd:

```powershell
azd auth login
azd auth login --check-status
```

The checked-in template under `infra/foundry` creates a public Foundry account and project in Sweden Central. Hosted agents and the capability host are disabled. Local authentication is enabled for the approved API-key-first phase; switch `disableLocalAuth` back to `true` when Convex moves to Microsoft Entra ID.

### 2. Provision the development account and project

The local azd environment `fabric-foundry-dev-se` is already initialized with:

- Resource group: `rg-fabric-foundry-dev-se`
- Project: `fabric-foundry-dev-se`
- Region and model deployment region: `swedencentral`
- `ENABLE_HOSTED_AGENTS=false`
- `ENABLE_CAPABILITY_HOST=false`

Provision it:

```powershell
cd infra/foundry
azd env select fabric-foundry-dev-se
azd provision --no-prompt
azd env get-values
```

Record `AZURE_AI_ACCOUNT_NAME` from the output. The account name is generated uniquely by the template.

### 3. Preview and deploy the models

The deployment script revalidates the live Sweden Central catalog and subscription quota before every apply. It is preview-only unless `-Apply` is supplied.

Anthropic requires the organization's industry for Claude deployment. Use one of the validated values accepted by the script; do not guess this value.

```powershell
cd ../..

# Preview: no Azure writes
./scripts/deploy-foundry-models.ps1 `
  -ResourceGroup rg-fabric-foundry-dev-se `
  -AccountName <AZURE_AI_ACCOUNT_NAME> `
  -Industry <approved-industry>

# Apply after reviewing the printed target
./scripts/deploy-foundry-models.ps1 `
  -ResourceGroup rg-fabric-foundry-dev-se `
  -AccountName <AZURE_AI_ACCOUNT_NAME> `
  -Industry <approved-industry> `
  -Apply
```

The script deploys Claude sequentially before the OpenAI models, uses Global Standard, pins every version with `NoAutoUpgrade` where Azure supports that property, and configures `Microsoft.DefaultV2` filtering for the OpenAI deployments.

Live preflight on 2026-07-14 found:

| Quota key | Unallocated capacity |
| --- | ---: |
| `AIServices.GlobalStandard.claude-haiku-4-5.Azure` | 80 |
| `OpenAI.GlobalStandard.gpt-5-nano` | 5,000 |
| `OpenAI.GlobalStandard.gpt-5-mini` | 1,000 |

Global Standard is globally routed. It does not guarantee Sweden-only inference or strict EU data-zone processing. Use Data Zone deployments for the OpenAI models if that becomes a compliance requirement; Claude Haiku 4.5 is currently offered here through Global Standard.

### 4. Set Convex variables while OpenRouter remains active

Never place these secrets in `.env.local`. Set them on each Convex deployment. Piping the account key prevents it from being written into shell history.

```powershell
$account = "<AZURE_AI_ACCOUNT_NAME>"
$resourceGroup = "rg-fabric-foundry-dev-se"
$endpoint = "https://$account.services.ai.azure.com"
$key = az cognitiveservices account keys list `
  --name $account `
  --resource-group $resourceGroup `
  --query key1 -o tsv

npx convex env set AI_PROVIDER openrouter
npx convex env set FOUNDRY_ENDPOINT $endpoint
$key | npx convex env set FOUNDRY_API_KEY
npx convex env set FOUNDRY_SYNTHESIS_BACKEND claude
npx convex env set FOUNDRY_CLAUDE_DEPLOYMENT fabric-claude-haiku-4-5
npx convex env set FOUNDRY_OPENAI_FALLBACK_DEPLOYMENT fabric-gpt5-mini-fallback
npx convex env set FOUNDRY_SAFETY_DEPLOYMENT fabric-description-safety

Remove-Variable key
```

Keep `OPENROUTER_API_KEY` set during the rollback window.

### 5. Run deployment smoke tests

Load the same values into the current PowerShell process only, then run:

```powershell
$env:FOUNDRY_ENDPOINT = $endpoint
$env:FOUNDRY_API_KEY = az cognitiveservices account keys list `
  --name $account `
  --resource-group $resourceGroup `
  --query key1 -o tsv
$env:FOUNDRY_CLAUDE_DEPLOYMENT = "fabric-claude-haiku-4-5"
$env:FOUNDRY_SAFETY_DEPLOYMENT = "fabric-description-safety"
$env:FOUNDRY_OPENAI_FALLBACK_DEPLOYMENT = "fabric-gpt5-mini-fallback"

npm run foundry:smoke

Remove-Item Env:FOUNDRY_API_KEY
```

The smoke script verifies Claude text generation, GPT-5 nano strict tool calling, and GPT-5 mini text generation.

## Cutover and rollback

1. Deploy this code with `AI_PROVIDER=openrouter`; this validates that the adapter preserves the current provider behavior.
2. Complete the three Foundry smoke checks.
3. Set the development Convex deployment to `AI_PROVIDER=foundry`.
4. Run the golden set: safe and blocked descriptions, incremental and full process summaries, department/function summaries, a voice analysis, and process-flow generation.
5. Confirm logs contain provider, model, deployment, latency, finish reason, token usage, and request ID without prompt or response content.
6. Apply the same sequence to production by adding `--prod` to every `npx convex env set` command.
7. Soak production for seven days, then remove the production `OPENROUTER_API_KEY`. Remove the rollback adapter in a later cleanup change after the soak rather than during cutover.

Immediate rollback is one setting change:

```powershell
npx convex env set AI_PROVIDER openrouter
# Production:
npx convex env set --prod AI_PROVIDER openrouter
```

Changing `FOUNDRY_SYNTHESIS_BACKEND` to `gpt5mini` is not an outage failover. Do it only after the golden-set quality comparison approves GPT-5 mini.

## Production environment

Production is provisioned as a separate azd environment and Foundry account so
its key, monitoring, deployments, and resource lifecycle are isolated from
development. Both accounts use the same Azure subscription and Sweden Central
model quota pools; use a separate subscription if hard quota isolation becomes
necessary.

The approved production target is:

- Environment/project: `fabric-foundry-prod-se`
- Resource group: `rg-fabric-foundry-prod-se`
- Foundry account: `ai-account-yr3a3wrezanyy`
- Region: Sweden Central
- Routing: Global Standard
- Claude Haiku 4.5 capacity: `50`
- GPT-5 nano capacity: `50`
- GPT-5 mini capacity: `10`
- Convex production deployment: `lovable-wolf-596`

The infrastructure was provisioned with:

```powershell
cd infra/foundry
azd env new fabric-foundry-prod-se `
  --subscription dbad1439-85a4-4f10-8b06-e548be4dd778 `
  --location swedencentral
azd env set AZURE_RESOURCE_GROUP rg-fabric-foundry-prod-se
azd env set AZURE_AI_PROJECT_NAME fabric-foundry-prod-se
azd env set AZURE_AI_DEPLOYMENTS_LOCATION swedencentral
azd env set ENABLE_HOSTED_AGENTS false
azd env set ENABLE_CAPABILITY_HOST false
azd provision --no-prompt
```

The model deployment is reproducible with:

```powershell
./scripts/deploy-foundry-models.ps1 `
  -ResourceGroup rg-fabric-foundry-prod-se `
  -AccountName ai-account-yr3a3wrezanyy `
  -Industry consulting `
  -ClaudeCapacity 50 `
  -SafetyCapacity 50 `
  -FallbackCapacity 10 `
  -Apply
```

All three production smoke tests passed. The separate production key and
deployment settings are stored in Convex production, with
`AI_PROVIDER=openrouter` intentionally retained until the golden set is run and
cutover is explicitly approved. Do not reuse the development account key.

## Cost comparison

Prices below are USD per one million tokens, before Azure contract discounts and taxes. OpenRouter's effective cash rates apply its documented 5.5% credit-purchase fee to the displayed model rate; its minimum fee can matter for very small purchases. Azure figures are Global Standard pay-as-you-go values verified from the Azure Retail Prices API on 2026-07-14.

| Workload | OpenRouter displayed | OpenRouter effective | Foundry | Difference |
| --- | ---: | ---: | ---: | ---: |
| Claude Haiku 4.5 input | $1.00 | $1.055 | $1.00 | Foundry about 5.2% lower cash cost |
| Claude Haiku 4.5 output | $5.00 | $5.275 | $5.00 | Foundry about 5.2% lower cash cost |
| Gemma 4 26B input (old safety model) | $0.06 | $0.0633 | — | Replaced, not self-hosted |
| Gemma 4 26B output (old safety model) | $0.33 | $0.34815 | — | Replaced, not self-hosted |
| GPT-5 nano input (new safety model) | — | — | $0.05 | About 21% below effective Gemma input |
| GPT-5 nano output (new safety model) | — | — | $0.40 | About 15% above effective Gemma output |
| GPT-5 mini input (unused fallback) | — | — | $0.25 | Charged only when invoked |
| GPT-5 mini output (unused fallback) | — | — | $2.00 | Charged only when invoked |

At a representative 10:1 safety ratio—10 million input tokens and 1 million output tokens—OpenRouter Gemma costs about $0.981 after the credit fee, while Foundry GPT-5 nano costs $0.90, about 8.3% less. At the same token volume, Claude synthesis costs about $15.825 through OpenRouter and $15.00 through Foundry.

Exact Gemma hosting was intentionally rejected. It would add dedicated managed-compute cost even when idle, whereas GPT-5 nano remains pay per token and supports the strict tool output used by the safety gate.

Sources: [Claude models and billing in Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models), [using Claude through Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude), [Azure OpenAI pricing](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/), [OpenRouter Claude Haiku 4.5](https://openrouter.ai/anthropic/claude-haiku-4.5), [OpenRouter Gemma 4 26B](https://openrouter.ai/google/gemma-4-26b-a4b-it), and [OpenRouter FAQ](https://openrouter.ai/docs/faq).

## Model lifecycle dates

- Begin the GPT-5 mini synthesis evaluation by 2026-09-20.
- Move off Claude Haiku 4.5 version `2` before its 2026-11-19 retirement.
- Review the safety model by 2026-12-08 and move off GPT-5 nano `2025-08-07` before 2027-02-06.
- Use blue/green deployment names for every version change; never update the active deployment in place.
