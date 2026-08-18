/**
 * Composes the copy-paste brief for one automation opportunity.
 *
 * V0 deliberately makes no AI call. Every sentence this needs already exists as
 * prose in Convex — the flow and overview pipelines wrote it during their own
 * model passes and stored it structured — so this is templating, not
 * generation: instant on click, free, deterministic, and unit-testable. A model
 * earns its place in V1, where the job changes from narrating the evidence to
 * translating it into Copilot Studio's element model.
 *
 * Pure by design: no React, no Convex, no clock. The caller supplies everything,
 * including `generatedAt`, so the output is reproducible in a test.
 */

import {
  type FlowEdge,
  type FlowNode,
  type ProcessFlow,
  isNodeDescribed,
  pluralize,
  uniqueStrings,
} from "@/features/insights/insights-derivations";

export type AutomationOpportunity = NonNullable<
  ProcessFlow["insights"]["automationOpportunityDetails"]
>[number];

export type BriefCoverage = {
  includedSources: number;
  totalEligibleSources: number;
  /** Absent on older coverage records, so the brief has to survive without it. */
  uniqueContributors?: number;
  complete: boolean;
};

export type BriefOverview = {
  executiveBrief?: string | null;
  gaps?: Array<{ title: string; body: string }>;
};

export type BriefInput = {
  opportunity: AutomationOpportunity;
  /** Nodes as returned by `getProcessFlow` — detail merged, `detailStatus` set. */
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** `insights.criticalPath`; used only for ordering, may be empty. */
  criticalPath: string[];
  processName: string;
  departmentName?: string | null;
  functionName?: string | null;
  overview?: BriefOverview | null;
  coverage?: BriefCoverage | null;
};

export type OpportunityBrief = {
  title: string;
  /** The whole brief, ready to copy. */
  body: string;
};

const KIND_LEAD: Record<AutomationOpportunity["kind"], string> = {
  agent: "an AI agent",
  workflow: "an automated workflow",
  integration: "a system integration",
  other: "an automation",
};

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function sentence(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function labelsOf(nodeIds: string[], nodes: Map<string, FlowNode>): string[] {
  return uniqueStrings(
    nodeIds
      .map((id) => nodes.get(id)?.label)
      .filter((label): label is string => Boolean(label)),
  );
}

/**
 * The steps that sit *between* covered steps without being covered.
 *
 * Without this, a span that skips a step misreports its own boundary: the
 * infrastructure opportunity in the sample data covers database → hosting →
 * domain, and the AI-model decision sits inside that stretch, so naive
 * inbound/outbound edge filtering listed that decision as both the upstream
 * trigger and the downstream handoff. Walking forward from each covered node
 * until the next one separates "outside the span" from "inside a hole in the
 * span" — and the hole is worth telling the maker about, not hiding.
 */
export function findInterstitialNodeIds(
  coveredIds: string[],
  edges: FlowEdge[],
): string[] {
  const covered = new Set(coveredIds);
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source);
    if (list) list.push(edge.target);
    else outgoing.set(edge.source, [edge.target]);
  }

  const interstitial = new Set<string>();
  for (const start of coveredIds) {
    // Path-wise: a node only counts as interstitial when the walk that reached
    // it actually lands back on a covered node. `seen` is per-start and bounds
    // the walk on a cyclic graph.
    const stack: Array<{ id: string; path: string[] }> = (
      outgoing.get(start) ?? []
    ).map((id) => ({ id, path: [] as string[] }));
    const seen = new Set<string>([start]);

    while (stack.length > 0) {
      const step = stack.pop();
      if (!step) break;
      if (covered.has(step.id)) {
        for (const via of step.path) interstitial.add(via);
        continue;
      }
      if (seen.has(step.id)) continue;
      seen.add(step.id);
      const nextPath = [...step.path, step.id];
      for (const next of outgoing.get(step.id) ?? []) {
        stack.push({ id: next, path: nextPath });
      }
    }
  }
  return [...interstitial];
}

export function composeOpportunityBrief(input: BriefInput): OpportunityBrief {
  const { opportunity, edges, coverage, overview } = input;
  const nodeMap = new Map(input.nodes.map((node) => [node.id, node]));

  const order = new Map(input.criticalPath.map((id, index) => [id, index]));
  const fallbackOrder = new Map(
    input.nodes.map((node, index) => [node.id, index]),
  );
  const orderOf = (id: string) =>
    order.get(id) ?? fallbackOrder.get(id) ?? Number.MAX_SAFE_INTEGER;

  const coveredIds = uniqueStrings(opportunity.nodeIds).filter((id) =>
    nodeMap.has(id),
  );
  coveredIds.sort((a, b) => orderOf(a) - orderOf(b));
  const covered = coveredIds.map((id) => nodeMap.get(id)!);
  const described = covered.filter(isNodeDescribed);
  const undescribed = covered.filter((node) => !isNodeDescribed(node));

  const coveredSet = new Set(coveredIds);
  const interstitialIds = findInterstitialNodeIds(coveredIds, edges);
  const insideSpan = new Set([...coveredIds, ...interstitialIds]);

  const upstream = labelsOf(
    edges
      .filter((edge) => coveredSet.has(edge.target) && !insideSpan.has(edge.source))
      .map((edge) => edge.source),
    nodeMap,
  );
  const downstream = labelsOf(
    edges
      .filter((edge) => coveredSet.has(edge.source) && !insideSpan.has(edge.target))
      .map((edge) => edge.target),
    nodeMap,
  );
  const branches = edges.filter(
    (edge) => coveredSet.has(edge.source) && edge.type === "conditional",
  );

  // Detail-derived facts read only from described steps. A step still awaiting
  // enrichment carries placeholder values indistinguishable from a real
  // assessment, and publishing those as findings is the exact hazard
  // `isNodeDescribed` exists to prevent.
  const actors = uniqueStrings(described.flatMap((node) => node.actors));
  const systems = uniqueStrings(described.flatMap((node) => node.tools));
  const painPoints = uniqueStrings(described.flatMap((node) => node.painPoints));
  const risks = uniqueStrings(described.flatMap((node) => node.riskIndicators));

  const where = input.departmentName
    ? input.functionName
      ? `${input.departmentName} department, ${input.functionName}`
      : `${input.departmentName} department`
    : null;

  // Sections are built first and assembled below, so the running order is one
  // readable list rather than something you have to reconstruct from the order
  // of pushes. What a maker needs to judge the brief — who does this today, and
  // what the evidence could not tell us — sits directly under the pitch,
  // ahead of the longer process context.
  const lead =
    `Build ${KIND_LEAD[opportunity.kind]} that supports the **${input.processName}** process` +
    `${where ? ` (${where})` : ""}. ` +
    (coverage
      ? `This brief is built from ${pluralize(coverage.includedSources, "recorded conversation")}` +
        `${
          coverage.uniqueContributors === undefined
            ? ""
            : ` with ${pluralize(coverage.uniqueContributors, "contributor")}`
        } describing how the work is done today. `
      : "") +
    `Evidence confidence for this opportunity: **${opportunity.confidence}**.`;

  const whatToBuild: string[] = ["## What to build", "", sentence(opportunity.rationale)];
  if (opportunity.expectedBenefit) {
    whatToBuild.push("", `**Expected benefit.** ${sentence(opportunity.expectedBenefit)}`);
  }

  const who: string[] = [
    "## Who does this today, and with what",
    "",
    `**People:** ${actors.length > 0 ? actors.join(", ") : "not named in the evidence"}`,
    `**Systems named by contributors:** ${systems.length > 0 ? systems.join(", ") : "none named"}`,
  ];
  if (systems.length > 0) {
    who.push(
      "",
      "Check each system is actually reachable from your Copilot Studio environment before building.",
    );
  }

  // Absence is stated, never silently dropped: a maker who cannot see what the
  // evidence missed will assume it covered everything.
  const unknowns: string[] = [];
  for (const gap of overview?.gaps ?? []) {
    unknowns.push(`${gap.title}: ${sentence(gap.body)}`);
  }
  if (undescribed.length > 0) {
    unknowns.push(
      `${pluralize(undescribed.length, "covered step")} not yet described by the analysis: ` +
        `${undescribed.map((node) => node.label).join(", ")}.`,
    );
  }
  const lowConfidence = described.filter((node) => node.confidence === "low");
  if (lowConfidence.length > 0) {
    unknowns.push(
      `Low-confidence detail for ${lowConfidence.map((node) => node.label).join(", ")}.`,
    );
  }
  if (coverage && !coverage.complete) {
    unknowns.push(
      `Evidence is partial — ${coverage.includedSources} of ` +
        `${coverage.totalEligibleSources} eligible conversations are included.`,
    );
  }
  if (actors.length === 0) unknowns.push("No owner is named for these steps.");
  if (systems.length === 0) unknowns.push("No systems are named for these steps.");
  if (opportunity.confidence === "low") {
    unknowns.push(
      "This opportunity was identified with low confidence — confirm it with the process owner " +
        "before building.",
    );
  }
  const notKnown: string[] =
    unknowns.length > 0
      ? ["## What the evidence does not tell us", "", bullets(unknowns)]
      : [];

  const where_: string[] = ["## Where this sits in the process"];
  if (overview?.executiveBrief) {
    where_.push("", overview.executiveBrief.trim());
  }
  if (described.length > 0) {
    where_.push(
      "",
      `The ${described.length === 1 ? "step" : "steps"} this covers, in the order they happen today:`,
      "",
    );
    described.forEach((node, index) => {
      where_.push(`${index + 1}. **${node.label}** — ${sentence(node.description)}`);
    });
  }
  if (interstitialIds.length > 0) {
    const skipped = labelsOf(interstitialIds, nodeMap);
    where_.push(
      "",
      `**Not one continuous stretch.** ${pluralize(skipped.length, "step")} ` +
        `${skipped.length === 1 ? "sits" : "sit"} between the steps above without being part of ` +
        `this automation: ${skipped.join(", ")}. Whatever gets built has to hand back to the ` +
        `process there and pick it up again afterwards.`,
    );
  }
  if (upstream.length > 0 || downstream.length > 0) {
    where_.push("");
    if (upstream.length > 0) where_.push(`**Runs after:** ${upstream.join(", ")}.`);
    if (downstream.length > 0) where_.push(`**Hands off to:** ${downstream.join(", ")}.`);
  }
  if (branches.length > 0) {
    where_.push("", "**Decision branches it has to handle:**", "");
    where_.push(
      bullets(
        branches.map((edge) => {
          const from = nodeMap.get(edge.source)?.label ?? edge.source;
          const to = nodeMap.get(edge.target)?.label ?? edge.target;
          return edge.label
            ? `At "${from}": if **${edge.label}**, go to "${to}".`
            : `From "${from}", one branch goes to "${to}".`;
        }),
      ),
    );
  }

  const friction: string[] =
    painPoints.length > 0
      ? ["## Friction reported today", "", bullets(painPoints)]
      : [];
  const risk: string[] =
    risks.length > 0 ? ["## Risks it has to handle", "", bullets(risks)] : [];
  const prerequisites: string[] =
    opportunity.prerequisites.length > 0
      ? ["## Prerequisites before building", "", bullets(opportunity.prerequisites)]
      : [];

  const sections = [
    [`# ${opportunity.title}`, "", lead],
    whatToBuild,
    who,
    notKnown,
    where_,
    friction,
    risk,
    prerequisites,
  ].filter((section) => section.length > 0);

  return {
    title: opportunity.title,
    body: sections
      .map((section) => section.join("\n"))
      .join("\n\n"),
  };
}

