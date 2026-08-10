# Automation Solution Portfolio and Agents Library Plan

**Status:** Proposed  
**Date:** 2026-08-05  
**Primary surface:** Process workbench  
**Target platform:** Microsoft Copilot Studio, new agent experience

## 1. Summary

Fabric should not move directly from a process-flow automation signal to a
fully specified agent. Automation potential indicates that work might be
improved; it does not establish that a Copilot Studio agent is the right
solution, that the required systems and permissions exist, or that the use case
is valuable enough to build and operate.

The proposed product is therefore an **Automation Solution Portfolio**, with
Copilot Studio agent opportunities as one filtered outcome. Within a process,
Fabric first presents evidence-linked opportunity cards, chooses a disposition,
and, for agent solutions, recommends an architecture. A user can then generate
an editable Copilot Studio build pack only for selected, suitable candidates.

The process page remains the v1 discovery surface. The underlying design should
support organization-wide agent concepts so that the same agent can eventually
serve several processes without being rediscovered and rebuilt independently.

This approach keeps Fabric focused on its unique advantage: capturing how work
actually happens and converting that evidence into a qualified transformation
portfolio. Copilot Studio configuration becomes a downstream implementation
decision rather than an automatic conclusion.

## 2. Product Principles

1. **Start with the business problem, not the agent.** Describe the friction,
   evidence, users, value, and readiness before proposing a technical solution.
2. **Automation potential is a signal, not an eligibility rule.** High-potential
   nodes help prioritize opportunities but do not independently create agents.
3. **Choose the smallest suitable solution.** Prefer a workflow, integration,
   process change, skill, or existing-agent enhancement when a new agent would
   add unnecessary complexity.
4. **Generate detail on demand.** Create lightweight opportunity assessments
   for the portfolio first; create full build packs only when a user selects a
   candidate.
5. **Never invent readiness.** Unknown connectors, data locations, permissions,
   owners, or policies remain explicit prerequisites.
6. **Ground every recommendation.** Agent purpose, instructions, tools, and
   knowledge recommendations must be traceable to process evidence.
7. **Separate generated content from human edits.** Regeneration must not erase
   deliberate user changes.
8. **Treat platform compatibility as versioned data.** Copilot Studio models,
   components, licensing, and regional availability change over time.
9. **Optimize for realized value, not recommendation count.** A small portfolio
   of implementable opportunities is better than a large catalog of plausible
   agents.

## 3. Research Basis

### 3.1 Internal process-flow pipeline

The v3 flow pipeline already provides the correct first-stage foundation:

- A whole-process AI pass identifies structured automation opportunities across
  the enriched graph rather than treating every automatable node as a separate
  solution.
- Each opportunity includes a title, generic kind, relevant node IDs,
  rationale, expected benefit, prerequisites, and confidence.
- `automationOpportunitiesSource` distinguishes analysed opportunities from the
  mechanical node-level fallback.
- Node details contribute actors, tools, duration, pain points, automation
  potential, confidence, risks, and contributor names.

This output should seed solution discovery, but it is not sufficient to produce
a build-ready agent without an additional qualification and readiness stage.

### 3.2 Internal issues to resolve first

1. **Successful empty analysis is ambiguous.** In `deriveFlowInsights`, an empty
   `automationOpportunityDetails` array is treated like an absent analysis. The
   system therefore cannot distinguish "AI analysis succeeded and found no
   opportunities" from "analysis failed and the fallback was used."
2. **Opportunities lack stable identifiers.** Titles and node combinations can
   change between flow generations, making edits, relationships, and evidence
   history difficult to reconcile.
3. **Evidence coverage is capped.** Flow generation reads at most 50 completed
   conversations and currently selects the earliest rows. A portfolio must not
   present capped evidence as comprehensive, and newer evidence must not be
   silently excluded.
4. **Source references are not durable evidence anchors.** Contributor names are
   useful context but do not identify the exact transcript turns or analysis
   fields supporting a recommendation.
5. **The current `kind` is generic.** It distinguishes agent, workflow,
   integration, and other opportunities for process insights; it is not a
   Copilot Studio solution-architecture decision.

### 3.3 Copilot Studio capability boundary

The new Copilot Studio experience organizes an agent around instructions,
model, skills, tools, knowledge, connected agents, and memory. Relevant v1
capabilities include:

- Markdown-based reusable skills.
- Power Platform connectors, MCP servers, and Copilot Studio workflows as
  tools.
- Knowledge sources including files, public websites, SharePoint, ServiceNow,
  Confluence, Dataverse, Azure AI Search, and Copilot connectors, subject to
  environment and licensing availability.
- Generally available general and deep-reasoning models, with regional and
  data-movement constraints.
- Connected agents built in Copilot Studio. The connected agent must be
  published, available to connect, and accessible in the same environment.

Official references:

- [Build an agent](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/build-overview)
- [Skills overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/skills-overview)
- [Available tools](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/tools-available)
- [Available knowledge sources](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/knowledge-sources-overview)
- [Connected agents overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/authoring-add-other-agents)
- [Model selection](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-select-agent-model)
- [Define value before building](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/agent-business-value-define-value)

## 4. Proposed User Journey

```text
Process evidence
    -> Automation opportunities
    -> Solution-pattern classification
    -> Value, readiness, and risk assessment
    -> Process-level opportunity portfolio
    -> User selects a suitable agent candidate
    -> Copilot Studio build pack is generated
    -> Maker evaluates, builds, publishes, and monitors outside Fabric
```

### 4.1 Opportunity discovery

After a current process flow and its analysed automation opportunities are
ready, Fabric creates lightweight opportunity assessments. It does not generate
full agent instructions or components at this stage.

Each opportunity card shows:

- Problem and current friction.
- Relevant process nodes and evidence links.
- A recommended disposition and, when applicable, agent architecture.
- Expected benefit and confidence.
- Value signals and missing baseline measurements.
- Technical readiness and unknown prerequisites.
- Risk and human-oversight requirements.
- Why the opportunity is or is not suitable for Copilot Studio.

### 4.2 Solution disposition and architecture

Classification has two separate dimensions. This avoids conflating the decision
to build with the architecture of what gets built.

Every opportunity receives exactly one mutually exclusive **disposition**:

1. **Build an agent solution** -- agentic interaction, reasoning, retrieval, or
   orchestration is materially useful.
2. **Enhance an existing agent** -- the need belongs in an agent that already
   exists. This disposition is valid only when the user has supplied a matching
   existing-agent inventory record. Without one, Fabric uses
   `build_agent_solution` and records "check for an existing agent" as a
   prerequisite rather than claiming an enhancement target exists.
3. **Build a workflow** -- the work is deterministic and does not benefit from
   a conversational or agentic layer.
4. **Build an integration** -- reliable data movement is the primary need.
5. **Improve the process** -- policy, role, sequencing, or simplification is the
   better intervention.
6. **No build** -- evidence, value, feasibility, or safety is insufficient.

Only `build_agent_solution` receives an **architecture pattern**:

- **Standalone agent** -- one agent owns the experience and behavior.
- **Agent with tools/workflows** -- one agent handles interaction or reasoning
  while deterministic work runs through supported tools.
- **Multi-agent solution** -- a primary agent delegates to one or more genuinely
  separate specialist agents.

The Agents view contains only `build_agent_solution` opportunities. Existing
agent enhancements remain visible in the portfolio but are not presented as new
agents. Other dispositions remain visible instead of being discarded.

### 4.3 Agent build-pack generation

An admin or contributor selects **Generate build pack** on a suitable agent
candidate. Fabric generates one bounded build pack for that candidate using its
opportunity data, relevant node details, process metadata, and targeted evidence
passages. Full transcripts are not concatenated into the prompt.

The build pack is immediately editable. There is no draft/approval/archive
lifecycle in v1. Viewers can read, copy, and export but cannot generate or edit.

For a multi-agent solution, generation produces a bundle: one build pack for
the primary agent, one build pack for each proposed specialist, and directional
relationship contracts between them. A relationship is never represented as a
single ambiguous pack.

### 4.4 Handoff to implementation

Fabric provides copyable fields, a complete Markdown build brief, and valid
`SKILL.md` content for recommended skills. It does not create, publish, or
modify anything in Copilot Studio in v1.

Exports contain the effective selected pack, process and opportunity labels,
evidence identifiers, prerequisites, and provenance, but omit transcript
excerpts and contributor identities by default. Only admins can opt into an
internal evidence appendix, and it remains subject to secret/sensitive-data
checks.

The build pack is an evidence-backed starting point, not a production-readiness
certification. The Copilot Studio maker remains responsible for verifying
connections, permissions, regional processing, evaluation quality, licensing,
and governance.

## 5. Qualification Framework

Qualification must be a hybrid of deterministic rules and LLM-supported
synthesis. The LLM interprets the process evidence; deterministic validation
enforces platform and tenant constraints.

### 5.1 Value

Assess:

- Frequency and volume of the work.
- Time, waiting, errors, or rework in the current state.
- Number and type of users affected.
- Expected business outcome.
- Whether a measurable baseline exists.
- Adoption likelihood and channel fit.

Unknown values stay unknown. Fabric should ask for missing measurements or list
them as readiness gaps rather than inventing savings.

### 5.2 Copilot Studio fit

An agent candidate should have at least one credible agentic role:

- Grounded question answering or retrieval.
- Drafting, summarization, classification, or structured extraction.
- Decision support with defined boundaries.
- User-facing orchestration across supported tools.
- Autonomous work with explicit triggers, guardrails, and human escalation.
- Delegation to a genuinely separate Copilot Studio specialist agent.

Do not recommend a new agent when the work is purely deterministic, is only data
movement, requires unsupported physical-world activity, lacks a viable data or
system-access path, or would make a high-impact decision without adequate human
review.

### 5.3 Readiness and risk

Assess or request:

- Business, technical, content, and risk owners.
- Target users and delivery channel.
- Required source systems and data locations.
- Connector, MCP, or workflow availability.
- Authentication mode and least-privilege access.
- Knowledge freshness and stewardship.
- Environment and licensing availability.
- Data sensitivity, retention, and regional-processing requirements.
- Human approval, escalation, and override points.
- Evaluation cases and expected outcomes.

Readiness results are `ready`, `conditional`, or `not_ready`. Risk results are
`low`, `medium`, `high`, or `prohibited`. Copilot Studio fit results are
`supported`, `conditional`, or `unsupported`. Component availability is
`verified`, `unverified`, or `unavailable`. These enums are stored and validated
rather than inferred from prose.

Readiness and risk describe implementation conditions, not an approval
lifecycle for the blueprint. A prohibited use case always receives `no_build`.

### 5.4 Capability catalog and tenant profile

Fabric maintains a platform capability catalog derived from current Microsoft
documentation and verification in a Copilot Studio test environment. Fabric
product/engineering owns it, versions it by effective date, reviews it monthly
and before feature releases, and can issue an immediate withdrawal version when
a model or capability is retired or suspended. Existing build packs become
platform-stale when the catalog version changes in a relevant way.

Fabric needs a versioned capability profile for each organization or target
Power Platform environment. It records:

- Permitted generally available models and data-region restrictions.
- Preview/experimental policy, which is disabled for recommendations in v1.
- Available connectors, MCP servers, and workflows.
- Relevant DLP policies and authentication constraints.
- Available knowledge-source types.
- Licensing and Copilot Credit constraints.
- Copilot Studio environment identity.

If this profile is not configured, Fabric may recommend component categories but
must not claim that a named model, connection, action, agent, or knowledge source
exists in the tenant. Generation fails open at the category level: it may say
"GA general model" or "Power Platform connector," but every tenant-specific
component is `unverified`. A user selects the target environment before named
components can be verified. `Default GA` is the only model selection emitted
without a configured model allowlist.

Existing-agent enhancements and connections to already deployed agents require
manual inventory input in v1: environment, agent name/ID, owner, publication
state, connection availability, and access. Automatic Copilot Studio inventory
discovery is deferred.

### 5.5 Build-pack eligibility gate

**Generate build pack** is enabled only when all of the following are true:

- The source is a current, non-stale v3 process flow whose graph and node details
  are ready.
- The whole-process automation analysis completed successfully, even if it found
  no other opportunities; fallback-derived signals are never eligible.
- No relevant conversation or node evidence was silently excluded by a read or
  token cap.
- The opportunity disposition is `build_agent_solution`.
- Copilot Studio fit is `supported` or `conditional`, never `unsupported`.
- Readiness is `ready` or `conditional`; `not_ready` blocks generation until the
  blocking facts or prerequisites change.
- Risk is `low`, `medium`, or `high`, never `prohibited`. High-risk candidates
  must include an explicit human decision, approval, or escalation boundary.
- Evidence confidence is medium or high. A low-confidence opportunity becomes
  eligible only after a contributor or admin supplies or confirms supporting
  evidence.
- Required unknowns are represented as prerequisites rather than fabricated
  configuration.

`conditional` fit or readiness does not block a build pack; it produces a
prominent prerequisites section and prevents Fabric from describing the pack as
implementation-ready. `not_ready`, `unsupported`, and `prohibited` always block
generation.

### 5.6 Evidence snapshots and identity

Each flow generation creates immutable opportunity assessments with
server-generated UUIDs. V1 does not attempt to semantically merge opportunities
across different flow generations: renamed, split, merged, or topologically
changed opportunities are new assessments. The prior assessment and build pack
remain readable and become evidence-stale; a user may explicitly mark a new
assessment as superseding an older one.

Qualification uses a bounded evidence snapshot containing:

- Process-flow generation ID and opportunity ID.
- Relevant node IDs and node-detail generation IDs.
- Conversation ID, transcript message ordinal, content hash, and the minimum
  relevant excerpt needed for review.
- Structured analysis field and contributor reference where applicable.

The assessment evidence population is reproducible: every nondeleted
conversation in the same organization and process whose status is `done` and
whose completion/creation time is at or before the assessment cutoff. Pending,
processing, failed, or later conversations are excluded; a later conversation
marks the assessment stale and belongs to the next run.

Before this feature ships, flow evidence collection must include that full
population through bounded map/reduce processing or explicitly fail the
completeness gate. Selecting the earliest 50 rows is not acceptable. If any
relevant node lacks ready detail or any in-population conversation is excluded
by a read or token cap, qualification is materially incomplete and build-pack
generation is blocked.

If source evidence is deleted under existing retention behavior, its excerpt is
deleted with it, the anchor becomes unavailable, and associated assessments and
packs become stale. Fabric does not preserve deleted source text merely to keep
an old recommendation looking complete.

## 6. Copilot Studio Build-Pack Specification

### 6.1 Identity and purpose

- Name.
- Purpose and intended outcome.
- Target users and channels.
- Supported requests or triggers.
- Explicit out-of-scope behavior.
- Source opportunity, process, nodes, and evidence.
- Expected benefit, prerequisites, confidence, and readiness gaps.

### 6.2 Instructions

Markdown instructions covering:

- Role, goals, tone, and response style.
- Supported tasks and boundaries.
- Required sequence for multi-step work.
- When and how to use knowledge, skills, tools, or connected agents.
- Questions to ask when required context is missing.
- Human approval and escalation rules.
- Prohibited or irreversible actions.
- Output and citation expectations.

Evidence is treated as untrusted data and is never copied into instructions as
an executable directive.

### 6.3 Model recommendation

Recommend a model class and operating requirements before a named model:

- `general` for everyday grounded answers, drafting, and simple actions.
- `deep` for justified multistep reasoning or tool-rich work.

The build pack can display a current generally available candidate from the
tenant capability profile, along with rationale, latency/cost expectations, and
regional-processing caveats. Final model selection requires evaluation in the
target environment. Preview and experimental models are never recommended in
v1.

### 6.4 Skills

Each skill includes:

- Valid lowercase/hyphenated name.
- Description of what it does and when it activates.
- Markdown instructions.
- Step-by-step behavior and output format.
- Edge cases and escalation behavior.
- Required knowledge and referenced tools.
- Downloadable `SKILL.md` content.

### 6.5 Tools

Tool recommendations are limited to supported categories:

- Power Platform connector.
- MCP server.
- Copilot Studio workflow.

Each tool includes its purpose, expected action, inputs, outputs,
authentication assumption, error behavior, human-confirmation requirement,
evidence, and verification state. Fabric never invents a connection, endpoint,
action, or credential.

### 6.6 Knowledge

Each recommendation includes source category, required content, intended scope,
access expectations, freshness owner, and verification state. Fabric should
recommend what information the agent needs even when the exact site, file,
table, or index is not yet known.

### 6.7 Connected agents

A connected agent is recommended only when a separate agent has a distinct
domain, owner, security boundary, knowledge corpus, tool-permission set, release
cycle, or clear cross-process reuse value. Otherwise the capability remains a
skill, tool, workflow, or instruction within one agent.

Each relationship includes:

- Primary and specialist agent.
- When to delegate and when not to delegate.
- Context and sensitive data that may be passed.
- Expected result and response contract.
- Failure and fallback behavior.
- Ownership and permission assumptions.
- Same-environment, publication, and availability prerequisites.

V1 recommendations are process-local. The data model must allow a future
organization-wide agent concept to be connected from several process views.

## 7. Information Architecture and Data Direction

### 7.1 Product surfaces

- **Process-level Automation Opportunities:** the evidence-led portfolio,
  dispositions, and agent-architecture recommendations for the selected process.
- **Process-level Agents view:** suitable agent candidates and their generated
  build packs.
- **Future organization-level portfolio:** canonical agents, enhancements,
  workflows, integrations, ownership, reuse, and cross-process evidence.

Calling the process-only surface a library is acceptable for v1, but canonical
identity should not be permanently scoped to one process.

### 7.2 Conceptual records

- `automationOpportunityAssessments`: process-scoped immutable assessment
  versions containing disposition, optional agent architecture, evidence,
  value, fit, readiness, risk, and rejection explanation.
- `agentBuildPackVersions`: process-scoped immutable generated packs with model,
  prompt, capability-catalog, source-flow, and assessment provenance.
- `agentBuildPackOverrides`: field-level user-authored values keyed by build-pack
  version, stable component ID, and field path.
- `qualificationInputs`: process-scoped human-supplied facts such as volume,
  ownership, target environment, system availability, risk constraints, and
  evidence confirmations, with author, timestamp, evidence anchor, and source
  type.
- `agentRelationships`: directional, versioned relationships within one
  multi-agent bundle.
- `agentOutcomeReports`: optional manual v1 entries recording whether a pack was
  built and the outcome; automatic runtime ingestion is deferred.

The exact Convex schema should keep high-growth evidence and version history in
child tables rather than unbounded arrays on one document.

V1 does **not** create canonical organization-level agent records or perform
cross-process deduplication. IDs and links remain process-scoped. The future
organization-level portfolio introduces `agentConcepts` and many-to-many
evidence links through a widening migration; v1 records must retain enough
provenance to support that migration without pretending deduplication already
exists.

### 7.3 Staleness and regeneration

Track at least two independent forms of staleness:

- **Evidence stale:** the process flow or underlying conversations changed.
- **Platform stale:** the Copilot Studio capability catalog or tenant profile
  changed.

Regeneration creates a new generated version. User overrides remain intact and
the last usable build pack remains visible during generation or failure.

Overrides never mutate the generated base. The effective editable/exported pack
is the selected generated version plus its overrides, with overrides taking
precedence at their exact field paths. A regenerated version starts with no
automatic override migration. The UI compares it with the previously selected
effective pack and lets the user explicitly copy individual overridden fields
or component blocks. If a component disappeared, its overrides remain attached
to the old version rather than being silently dropped or applied elsewhere.
Users can reset an override to reveal the generated value. Exports always use
the effective selected version and state its provenance.

### 7.4 Assessment and generation job states

Qualification is started explicitly by an admin or contributor from the process
portfolio after the flow is ready. Build-pack generation is started separately
for one eligible assessment or one multi-agent bundle.

Both use `pending`, `running`, `ready`, `partial`, `failed`, and `superseded` job
states. At most one active qualification run exists per process-flow generation,
and at most one active build-pack run exists per assessment version. Every write
is guarded by run and source-generation IDs. Retries target only failed units;
a new run supersedes, but does not delete, an older run. Staleness is orthogonal
to job status.

A partial build-pack run exposes completed components for review and editing,
but disables Markdown, `SKILL.md`, and multi-agent bundle export until every
required primary pack, specialist pack, and relationship contract is ready.
Retries regenerate only failed units.

### 7.5 Editing, audit, and concurrency

Build-pack edits use the existing organization membership roles: admins and
contributors may edit; viewers are read-only. Every override records editor and
timestamp. Updates include the version last read by the client; a conflicting
concurrent update is rejected and the editor is shown the newer value before
retrying. V1 keeps field-level audit metadata but does not add comments,
approvals, or collaborative presence.

Opportunity cards include an **Add qualification facts** action for admins and
contributors. Human inputs are stored separately from AI output and never patch
an immutable assessment in place. Saving facts schedules a new assessment
version that cites the input records it used. Confirming low-confidence evidence
requires a note and at least one valid evidence anchor; a bare confidence toggle
is not sufficient. Viewers can see who supplied each fact but cannot change it.

## 8. Security, Governance, and Operations

### 8.1 Generation safety

- Treat transcripts, analyses, process descriptions, and external content as
  untrusted evidence, not instructions.
- Delimit evidence structurally and use strict tool-output schemas.
- Validate every node and evidence reference against stored records.
- Never intentionally retrieve known credential fields or connection secrets
  into generation prompts.
- Run secret-pattern and sensitive-data checks over targeted evidence,
  generated content, user overrides, and exports. Redact safe-to-remove matches
  and block generation or export when a suspected secret cannot be safely
  removed; show an authorized user which source must be corrected without
  echoing the secret.
- Redact contributor names from exported packs by default while preserving
  internal evidence links for authorized users.
- Retain tenant isolation and derive organization identity server-side.

This is a prevention and detection boundary, not a claim that existing user
content can never contain a secret. Raw source retention remains governed by the
existing conversation-data controls.

### 8.2 Implementation governance

Every selected candidate should identify or request:

- Business owner.
- Technical owner.
- Knowledge/content steward.
- Risk or compliance owner.
- Human escalation owner.
- Intended Power Platform environment.
- Evaluation and monitoring owner.

Fabric does not enforce an approval lifecycle in v1, but the build pack must
make missing ownership and controls visible.

### 8.3 Cost and capacity

Show qualitative cost drivers for:

- Fabric-side opportunity and build-pack generation.
- Copilot Studio model use and Copilot Credits.
- Workflow and connector actions.
- Premium connectors or external services.
- Connected-agent calls and additional orchestration.
- Knowledge indexing and maintenance.

Do not produce precise savings or runtime cost estimates without measured
volume, frequency, and target-environment pricing inputs.

### 8.4 Post-handoff lifecycle

Although build and publishing remain outside v1, the PRD should acknowledge the
downstream operating lifecycle:

1. Verify systems, permissions, and data policies.
2. Build in a development environment and managed solution.
3. Evaluate with representative and adversarial test cases.
4. Obtain necessary business, security, and compliance review.
5. Publish through the organization's ALM process.
6. Monitor quality, tool failures, usage, cost, and user feedback.
7. Re-evaluate when the process, knowledge, tools, model, or policies change.

## 9. V1 Scope

### In scope

- Process-local opportunity portfolio based on the current structured flow.
- Solution-pattern classification and explainable rejections.
- Value, fit, readiness, risk, and unknown-prerequisite assessment.
- On-demand editable build packs for Copilot Studio-suitable candidates.
- GA-only model class and, when a tenant profile verifies it, an approved named
  model recommendation.
- Skills, tools, knowledge, instructions, and process-local connected-agent
  recommendations.
- Evidence and platform staleness tracking.
- Copyable Markdown build brief and `SKILL.md` exports.
- Admin/contributor generation and editing; viewer read/copy access.
- Versioned generated content with persistent user overrides.

### Out of scope

- Creating, modifying, publishing, or monitoring Copilot Studio agents.
- Copilot Studio solution-package generation.
- Automatic connection or credential provisioning.
- Preview or experimental model recommendations.
- Automatic ROI claims without baseline data.
- An approval/archive workflow for build packs.
- Organization-wide portfolio UI and automatic cross-process deduplication.
- Automatic discovery of existing Copilot Studio agents or environments.
- Runtime analytics integration from deployed agents.

## 10. Testing and Acceptance

### 10.1 Pipeline and classification

- A high-automation node without a whole-process opportunity does not create an
  agent candidate.
- An opportunity spanning several nodes can produce one consolidated solution.
- `agent`, `workflow`, and `integration` source kinds are independently assessed
  instead of being copied directly into the final pattern.
- Purely deterministic and integration-only opportunities remain in the
  portfolio but do not appear in the Agents view.
- Successful analysis with zero opportunities is distinguishable from an
  analysis failure.
- Fallback-derived opportunities cannot generate build packs.
- Relevant incomplete or capped evidence blocks build-pack qualification.
- The evidence population includes every `done` conversation at the run cutoff,
  excludes other statuses and later completions, and becomes stale when new
  eligible evidence arrives.
- `not_ready`, `unsupported`, and `prohibited` results block generation;
  conditional results generate prerequisite-labelled packs.
- Human qualification facts create a new immutable assessment and low-confidence
  confirmation requires anchored evidence.

### 10.2 Platform validation

- Every named model is generally available and permitted by the tenant profile.
- Every recommended tool and knowledge category is supported by the versioned
  capability catalog.
- Unverified tenant-specific components are clearly labelled.
- Skill names and `SKILL.md` exports match Copilot Studio rules.
- Connected-agent links are directional, process-local in v1, non-self, and
  free of duplicate or circular routing recommendations.

### 10.3 Security and permissions

- Cross-tenant reads and writes are impossible.
- Evidence cannot inject instructions into generated build packs.
- Known credential sources are excluded; suspected secrets in selected evidence,
  generated content, overrides, or exports are redacted or block the operation.
- Contributor identities are redacted from exports by default.
- Viewers cannot generate or edit; admins and contributors can.

### 10.4 Reliability and editing

- One candidate failure does not affect the process flow or other candidates.
- Previous build packs remain readable during a failed or superseded run.
- Partial single- or multi-agent runs are reviewable but not exportable until all
  required units are ready.
- Stale writes cannot overwrite a newer generation.
- User overrides remain attached to their original pack version and are never
  silently migrated, overwritten, or deleted by regeneration.
- Build-pack provenance identifies the source flow, evidence version, capability
  catalog, model, and prompt version.

### 10.5 Product acceptance

Test representative knowledge-only, action-oriented, workflow-backed,
mixed-orchestration, no-fit, high-risk, and multi-agent processes with process
owners and Copilot Studio makers.

V1 release criteria track outcomes observable inside Fabric:

- Opportunity precision and rejection quality.
- Percentage of selected candidates considered buildable with minor edits.
- Unsupported or invented component rate.
- Time from process evidence to a maker-ready build brief.
- User edits by field, as a signal of generation quality.
- Build-pack generation/export rate.

The initial golden set contains at least 60 labelled opportunities, at least
five examples of every disposition, every agent architecture, conditional
readiness, prohibited risk, incomplete evidence, and no-opportunity cases. Keep
at least 20 percent held out from prompt tuning. The v1 release gate is:

- 100% of prohibited or unsupported cases remain ineligible.
- 0 named tenant components are described as verified without profile evidence.
- At least 80% SME agreement with disposition, Copilot Studio fit, and rejection
  explanations.
- At least 80% of selected packs are rated buildable with minor edits by a
  Copilot Studio maker.
- 100% of exported evidence identifiers resolve or are explicitly marked
  unavailable.
- 100% of mandatory build-pack fields pass schema validation.

Record results with the capability-catalog, model, prompt, and dataset versions.

Post-handoff measures are north-star metrics, not v1 automated acceptance
criteria: duplicate-agent rate, candidates built/deployed/adopted/retired, and
realized business outcomes. V1 may collect them through optional manual outcome
reports. Automatic measurement requires future Copilot Studio inventory and
runtime integration.

Do not optimize for the number of agents generated.

## 11. Recommended Delivery Sequence

1. Fix empty-analysis provenance, stable opportunity identity, evidence coverage,
   and evidence anchors in the existing flow pipeline.
2. Define the versioned Copilot Studio capability catalog and optional tenant
   capability profile.
3. Build disposition, architecture, value, readiness, and risk qualification with
   deterministic validation around structured AI output.
4. Add the process-local opportunity portfolio and explainable no-fit states.
5. Add on-demand build-pack generation for a selected candidate.
6. Add editable generated/user layers, provenance, staleness, and Markdown
   exports.
7. Add the connected-agent boundary rubric and process-local relationship
   recommendations.
8. Run a golden-set evaluation with real processes and Copilot Studio makers.
9. Use acceptance, rejection, and edit feedback to tune qualification and
   build-pack prompts before considering an organization-wide portfolio.

## 12. Decisions and Assumptions

- V1 is evidence-led and process-local in its user experience.
- Full build packs are generated on demand, not automatically for every
  opportunity.
- Blueprints are editable and have no user-facing approval lifecycle.
- Generated versions and user overrides are stored separately.
- Only generally available models are recommended.
- Named model, connector, knowledge, agent, and environment availability is
  verified against a tenant profile; without one, recommendations stay at the
  generic category level and are marked unverified.
- Connected agents are recommended sparingly and only for distinct specialist
  boundaries.
- Existing agents are supplied manually in v1; automatic inventory discovery is
  deferred.
- V1 records remain process-scoped and do not create canonical organization-wide
  agent concepts.
- Direct Copilot Studio provisioning is deferred.
- The organization-level portfolio is a north-star architecture, not a v1 UI
  commitment.
