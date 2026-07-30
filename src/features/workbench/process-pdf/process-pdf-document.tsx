import {
  Document,
  Page,
  Text,
  View,
  pdf,
} from "@react-pdf/renderer";
import {
  AUTOMATION_TONES,
  CATEGORY_LABELS,
  CATEGORY_TONES,
  COLORS,
  CONFIDENCE_TONES,
  s,
} from "./pdf-theme";
import { PdfMarkdown } from "./pdf-markdown";
import { FlowDiagramPdf } from "./flow-diagram-pdf";
import {
  buildProcessPdfData,
  type ProcessPdfData,
  type ProcessPdfInput,
  type StepNode,
} from "./build-process-pdf-data";
import { type FlowNode, pluralize } from "@/features/insights/insights-derivations";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtDateTime(ms: number | null | undefined) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDate(ms: number | null | undefined) {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

const FLOW_STATUS_COPY: Record<ProcessPdfData["flowStatus"], string> = {
  ready: "Flow generated",
  generating: "Flow generation in progress",
  failed: "Flow generation failed",
  none: "No flow generated yet",
};

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function Footer({ processName }: { processName: string }) {
  return (
    <View style={s.footer} fixed>
      <Text style={s.footerText}>{processName} · Process report</Text>
      <Text
        style={s.footerText}
        render={({ pageNumber, totalPages }) =>
          `${pageNumber} / ${totalPages}`
        }
      />
    </View>
  );
}

function SectionHeader({
  title,
  kicker,
  count,
}: {
  title: string;
  kicker?: string;
  count?: string;
}) {
  return (
    <View style={s.sectionHeader}>
      <View style={s.sectionAccent} />
      <Text style={s.sectionTitle}>{title}</Text>
      {count ? (
        <Text style={s.sectionKicker}>{count.toUpperCase()}</Text>
      ) : kicker ? (
        <Text style={s.sectionKicker}>{kicker.toUpperCase()}</Text>
      ) : null}
    </View>
  );
}

function Chip({
  label,
  tone,
}: {
  label: string;
  tone?: { soft: string; text: string };
}) {
  if (!tone) {
    return <Text style={s.chipOutline}>{label}</Text>;
  }
  return (
    <Text style={[s.chip, { backgroundColor: tone.soft, color: tone.text }]}>
      {label}
    </Text>
  );
}

function CategoryChip({ category }: { category: FlowNode["category"] }) {
  return (
    <Chip label={CATEGORY_LABELS[category]} tone={CATEGORY_TONES[category]} />
  );
}

function BulletList({
  items,
  empty,
}: {
  items: string[];
  empty?: string;
}) {
  if (items.length === 0) {
    return empty ? <Text style={s.muted}>{empty}</Text> : null;
  }
  return (
    <View>
      {items.map((item, i) => (
        <Text key={i} style={s.bulletText}>
          {`•  ${item}`}
        </Text>
      ))}
    </View>
  );
}

function PillRow({ values, empty }: { values: string[]; empty?: string }) {
  if (values.length === 0) {
    return empty ? <Text style={s.faint}>{empty}</Text> : null;
  }
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
      {values.map((v, i) => (
        <Text key={i} style={s.chipOutline}>
          {v}
        </Text>
      ))}
    </View>
  );
}

function DetailColumn({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={s.eyebrow}>{label}</Text>
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------

function MetricTile({ metric }: { metric: ProcessPdfData["metrics"][number] }) {
  return (
    <View
      style={{
        width: 120,
        marginRight: 6,
        marginBottom: 6,
        borderWidth: 1,
        borderColor: COLORS.hair,
        borderRadius: 7,
        backgroundColor: COLORS.surface,
        paddingVertical: 8,
        paddingHorizontal: 9,
      }}
    >
      <Text style={s.eyebrow}>{metric.label}</Text>
      <Text
        style={{
          fontFamily: "Helvetica-Bold",
          fontSize: 18,
          lineHeight: 1.1,
          color: COLORS.ink,
          marginBottom: 3,
        }}
      >
        {metric.value}
      </Text>
      <Text style={{ fontSize: 6.8, color: COLORS.faint, lineHeight: 1.25 }}>
        {metric.detail}
      </Text>
    </View>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ marginRight: 22 }}>
      <Text style={s.eyebrow}>{label}</Text>
      <Text style={{ fontSize: 9, color: COLORS.body }}>{value}</Text>
    </View>
  );
}

function Cover({ data }: { data: ProcessPdfData }) {
  const statusTone =
    data.flowStatus === "ready"
      ? CONFIDENCE_TONES.high
      : data.flowStatus === "failed"
        ? CONFIDENCE_TONES.low
        : data.flowStatus === "generating"
          ? CONFIDENCE_TONES.medium
          : { soft: COLORS.surfaceAlt, text: COLORS.muted };

  return (
    <View>
      {/* Brand bar */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 22,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View
            style={{
              width: 14,
              height: 14,
              borderRadius: 4,
              backgroundColor: COLORS.accent,
              marginRight: 7,
            }}
          />
          <Text
            style={{
              fontFamily: "Helvetica-Bold",
              fontSize: 12,
              color: COLORS.ink,
              letterSpacing: 0.4,
            }}
          >
            Fabric
          </Text>
        </View>
        <Text
          style={{
            fontFamily: "Helvetica-Bold",
            fontSize: 8,
            letterSpacing: 1.6,
            color: COLORS.accent,
          }}
        >
          PROCESS REPORT
        </Text>
      </View>

      {/* Breadcrumb */}
      <Text style={{ fontSize: 9, color: COLORS.muted, marginBottom: 5 }}>
        {data.functionName}
        <Text style={{ color: COLORS.faint }}> {" › "} </Text>
        {data.departmentName}
      </Text>

      {/* Title */}
      <Text
        style={{
          fontFamily: "Helvetica-Bold",
          fontSize: 25,
          color: COLORS.ink,
          lineHeight: 1.15,
          marginBottom: 12,
        }}
      >
        {data.processName}
      </Text>

      {/* Status + meta */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 14,
        }}
      >
        <View style={{ marginRight: 22, marginBottom: 4 }}>
          <Text style={s.eyebrow}>Status</Text>
          <Chip label={FLOW_STATUS_COPY[data.flowStatus]} tone={statusTone} />
        </View>
        <MetaItem
          label="Contributor"
          value={data.contributorName ?? "Not recorded"}
        />
        {/* Only when the latest conversation was filed for someone else. This
            report is a shareable artefact, so the attribution has to be
            unambiguous once it leaves the app. */}
        {data.submittedByName && (
          <MetaItem label="Submitted by" value={data.submittedByName} />
        )}
        <MetaItem label="Last updated" value={fmtDate(data.lastUpdatedAt)} />
        <MetaItem label="Generated" value={fmtDateTime(data.generatedAt)} />
      </View>

      {/* Metrics */}
      {data.hasFlow && data.metrics.length > 0 && (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            marginBottom: 6,
          }}
        >
          {data.metrics.map((metric) => (
            <MetricTile key={metric.label} metric={metric} />
          ))}
        </View>
      )}

      {!data.hasFlow && (
        <View style={[s.cardSoft, { marginBottom: 6 }]}>
          <Text style={{ fontSize: 9.5, color: COLORS.body, lineHeight: 1.5 }}>
            {FLOW_STATUS_COPY[data.flowStatus]}.{" "}
            {data.flowErrorMessage
              ? data.flowErrorMessage
              : "Generate the process flow in Fabric to include the diagram, step detail, and insights in this report."}
          </Text>
        </View>
      )}

      <View
        style={{
          height: 1,
          backgroundColor: COLORS.hair,
          marginTop: 12,
          marginBottom: 16,
        }}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function SummarySection({ data }: { data: ProcessPdfData }) {
  return (
    <View>
      <SectionHeader title="Process Summary" kicker="Synthesized overview" />
      {data.summary && data.summary.trim().length > 0 ? (
        <PdfMarkdown content={data.summary} />
      ) : (
        <View style={s.cardSoft}>
          <Text style={s.muted}>
            No process summary is available yet. Complete a conversation to
            generate the rolling summary.
          </Text>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function NumberMedallion({
  number,
  category,
}: {
  number: number;
  category: FlowNode["category"];
}) {
  const tone = CATEGORY_TONES[category];
  return (
    <View
      style={{
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: tone.soft,
        borderWidth: 1,
        borderColor: tone.base,
        alignItems: "center",
        justifyContent: "center",
        marginRight: 8,
      }}
    >
      <Text
        style={{
          fontFamily: "Helvetica-Bold",
          fontSize: 9,
          color: tone.text,
        }}
      >
        {number}
      </Text>
    </View>
  );
}

function StepCard({
  step,
  data,
}: {
  step: StepNode;
  data: ProcessPdfData;
}) {
  const outgoing = data.edges.filter((e) => e.source === step.id);
  const actors = Array.from(new Set(step.actors.filter(Boolean)));
  const tools = Array.from(new Set(step.tools.filter(Boolean)));

  return (
    <View style={[s.card, { marginBottom: 8 }]}>
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 5 }}>
        <NumberMedallion number={step.number} category={step.category} />
        <View style={{ flex: 1 }}>
          <Text style={s.cardTitle}>{step.label}</Text>
        </View>
      </View>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 4,
          marginBottom: 6,
        }}
      >
        <CategoryChip category={step.category} />
        <Chip
          label={`${CONFIDENCE_TONES[step.confidence].label} confidence`}
          tone={CONFIDENCE_TONES[step.confidence]}
        />
        {step.automationPotential !== "none" && (
          <Chip
            label={`${AUTOMATION_TONES[step.automationPotential].label} automation`}
            tone={AUTOMATION_TONES[step.automationPotential]}
          />
        )}
        {step.isBottleneck && (
          <Chip label="Bottleneck" tone={CONFIDENCE_TONES.low} />
        )}
        {step.isTribalKnowledge && (
          <Chip label="Tribal knowledge" tone={CONFIDENCE_TONES.medium} />
        )}
        {step.estimatedDuration ? (
          <Chip label={step.estimatedDuration} />
        ) : null}
      </View>

      {step.description ? (
        <Text style={[s.body, { marginBottom: 7 }]}>{step.description}</Text>
      ) : null}

      <View style={{ flexDirection: "row", gap: 14, marginBottom: 2 }}>
        <DetailColumn label="Actors">
          <Text style={s.muted}>
            {actors.length > 0 ? actors.join(", ") : "Not specified"}
          </Text>
        </DetailColumn>
        <DetailColumn label="Tools">
          <Text style={s.muted}>
            {tools.length > 0 ? tools.join(", ") : "None"}
          </Text>
        </DetailColumn>
      </View>

      {step.painPoints.length > 0 && (
        <View style={{ marginTop: 6 }}>
          <Text style={s.eyebrow}>Pain points</Text>
          <BulletList items={step.painPoints} />
        </View>
      )}

      {step.riskIndicators.length > 0 && (
        <View style={{ marginTop: 6 }}>
          <Text style={s.eyebrow}>Risk indicators</Text>
          <BulletList items={step.riskIndicators} />
        </View>
      )}

      {outgoing.length > 0 && (
        <View style={{ marginTop: 6 }}>
          <Text style={s.eyebrow}>Leads to</Text>
          {outgoing.map((edge) => {
            const targetNum = data.nodeNumber[edge.target];
            const targetLabel =
              data.steps.find((st) => st.id === edge.target)?.label ??
              edge.target;
            return (
              <Text key={edge.id} style={[s.muted, { marginBottom: 1 }]}>
                <Text style={{ color: COLORS.faint }}>{"» "}</Text>
                {targetNum ? `#${targetNum} ` : ""}
                {targetLabel}
                {edge.label ? `  (${edge.label})` : ""}
                {edge.isHappyPath ? "" : "  — exception"}
              </Text>
            );
          })}
        </View>
      )}
    </View>
  );
}

function StepsSection({ data }: { data: ProcessPdfData }) {
  return (
    <View>
      <SectionHeader
        title="Process Steps"
        count={pluralize(data.steps.length, "step")}
      />
      {data.steps.map((step) => (
        <StepCard key={step.id} step={step} data={data} />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

function InsightCard({
  title,
  count,
  children,
}: {
  title: string;
  count?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={[s.card, { marginBottom: 10 }]}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottomWidth: 1,
          borderBottomColor: COLORS.hair,
          paddingBottom: 6,
          marginBottom: 8,
        }}
      >
        <Text style={s.cardTitle}>{title}</Text>
        {count ? <Text style={s.chipOutline}>{count}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function MiniItem({
  title,
  children,
  rightChips,
}: {
  title: string;
  children?: React.ReactNode;
  rightChips?: React.ReactNode;
}) {
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: COLORS.surfaceAlt,
        paddingTop: 6,
        marginTop: 6,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          marginBottom: 3,
        }}
      >
        <View style={{ flex: 1, paddingRight: 6 }}>
          <Text style={[s.body, { fontFamily: "Helvetica-Bold" }]}>{title}</Text>
        </View>
        {rightChips ? <View style={{ flexShrink: 0 }}>{rightChips}</View> : null}
      </View>
      {children}
    </View>
  );
}

function ConfidenceBar({
  label,
  count,
  total,
}: {
  label: string;
  count: number;
  total: number;
}) {
  const percent = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <View style={{ marginBottom: 5 }}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          marginBottom: 2,
        }}
      >
        <Text style={s.muted}>{label}</Text>
        <Text style={s.faint}>
          {pluralize(count, "node")} · {percent}%
        </Text>
      </View>
      <View
        style={{
          height: 5,
          borderRadius: 3,
          backgroundColor: COLORS.surfaceAlt,
        }}
      >
        <View
          style={{
            height: 5,
            borderRadius: 3,
            width: `${percent}%`,
            backgroundColor: COLORS.accent,
          }}
        />
      </View>
    </View>
  );
}

function InsightsSection({ data }: { data: ProcessPdfData }) {
  const totalNodes = Math.max(data.steps.length, 1);
  const decisionEdges = (step: StepNode) =>
    data.edges.filter((e) => e.source === step.id);

  return (
    <View>
      <SectionHeader title="Flow Insights" kicker="Analysis" />

      {/* Critical path + duration */}
      {(data.criticalPathLabels.length > 0 || data.totalEstimatedDuration) && (
        <View style={[s.cardSoft, { marginBottom: 10 }]}>
          {data.totalEstimatedDuration ? (
            <View style={{ marginBottom: data.criticalPathLabels.length > 0 ? 8 : 0 }}>
              <Text style={s.eyebrow}>Estimated duration</Text>
              <Text style={s.muted}>{data.totalEstimatedDuration}</Text>
            </View>
          ) : null}
          {data.criticalPathLabels.length > 0 && (
            <View>
              <Text style={s.eyebrow}>Critical path</Text>
              <Text style={s.muted}>
                {data.criticalPathLabels.join("  »  ")}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Bottlenecks */}
      <InsightCard title="Bottlenecks" count={pluralize(data.bottlenecks.length, "step")}>
        {data.bottlenecks.length === 0 ? (
          <Text style={s.muted}>No bottleneck steps are marked.</Text>
        ) : (
          data.bottlenecks.map((node) => (
            <MiniItem
              key={node.id}
              title={`#${node.number}  ${node.label}`}
              rightChips={
                <Chip
                  label={`${CONFIDENCE_TONES[node.confidence].label} conf.`}
                  tone={CONFIDENCE_TONES[node.confidence]}
                />
              }
            >
              <BulletList
                items={node.painPoints}
                empty="No pain point text attached"
              />
            </MiniItem>
          ))
        )}
      </InsightCard>

      {/* Automation */}
      <InsightCard
        title="Automation Opportunities"
        count={pluralize(
          data.automationOpportunities.length + data.automationCandidates.length,
          "signal",
        )}
      >
        {data.automationOpportunities.length > 0 && (
          <>
            <Text style={s.eyebrow}>Flow-level candidates</Text>
            <BulletList items={data.automationOpportunities} />
          </>
        )}
        {data.automationCandidates.length === 0 &&
        data.automationOpportunities.length === 0 ? (
          <Text style={s.muted}>
            No automation candidates above none are marked.
          </Text>
        ) : (
          data.automationCandidates.map((node) => (
            <MiniItem
              key={node.id}
              title={`#${node.number}  ${node.label}`}
              rightChips={
                <Chip
                  label={`${AUTOMATION_TONES[node.automationPotential].label} potential`}
                  tone={AUTOMATION_TONES[node.automationPotential]}
                />
              }
            >
              {node.description ? (
                <Text style={s.muted}>{node.description}</Text>
              ) : null}
            </MiniItem>
          ))
        )}
      </InsightCard>

      {/* Tools */}
      <InsightCard
        title="Tools & Systems"
        count={pluralize(data.toolUsage.length, "tool")}
      >
        {data.toolUsage.length === 0 ? (
          <Text style={s.muted}>No tools are attached to the flow nodes.</Text>
        ) : (
          data.toolUsage.map((tool) => (
            <MiniItem
              key={tool.name}
              title={tool.name}
              rightChips={
                <Text style={s.chipOutline}>
                  {tool.steps.length} step{tool.steps.length === 1 ? "" : "s"}
                </Text>
              }
            >
              <Text style={s.faint}>
                {tool.steps.map((st) => st.label).join(", ")}
              </Text>
            </MiniItem>
          ))
        )}
      </InsightCard>

      {/* Decision points */}
      <InsightCard
        title="Decision Points"
        count={pluralize(data.decisionNodes.length, "decision")}
      >
        {data.decisionNodes.length === 0 ? (
          <Text style={s.muted}>No decision nodes are present.</Text>
        ) : (
          data.decisionNodes.map((node) => {
            const branches = decisionEdges(node);
            return (
              <MiniItem key={node.id} title={`#${node.number}  ${node.label}`}>
                {branches.length === 0 ? (
                  <Text style={s.faint}>No branch edges attached.</Text>
                ) : (
                  branches.map((edge) => {
                    const targetLabel =
                      data.steps.find((st) => st.id === edge.target)?.label ??
                      edge.target;
                    return (
                      <Text key={edge.id} style={[s.muted, { marginBottom: 1 }]}>
                        <Text style={{ color: COLORS.faint }}>{"» "}</Text>
                        {edge.label ?? edge.type}: {targetLabel}
                        {edge.isHappyPath ? "" : "  — exception"}
                      </Text>
                    );
                  })
                )}
              </MiniItem>
            );
          })
        )}
      </InsightCard>

      {/* Tribal knowledge */}
      <InsightCard
        title="Tribal Knowledge Risk"
        count={pluralize(data.tribalKnowledge.length, "step")}
      >
        {data.tribalKnowledge.length === 0 ? (
          <Text style={s.muted}>
            No flow nodes are marked as tribal knowledge risks.
          </Text>
        ) : (
          data.tribalKnowledge.map((node) => (
            <MiniItem
              key={node.id}
              title={`#${node.number}  ${node.label}`}
              rightChips={
                <Chip
                  label={`${CONFIDENCE_TONES[node.confidence].label} conf.`}
                  tone={CONFIDENCE_TONES[node.confidence]}
                />
              }
            >
              <BulletList
                items={node.riskIndicators}
                empty="No risk indicator text attached"
              />
            </MiniItem>
          ))
        )}
      </InsightCard>

      {/* Evidence coverage */}
      <InsightCard
        title="Evidence Coverage"
        count={`${data.flowConversationCount} of ${data.completedConversationCount} conversations`}
      >
        <Text style={s.eyebrow}>Confidence distribution</Text>
        <ConfidenceBar
          label="High"
          count={data.confidenceCounts.high}
          total={totalNodes}
        />
        <ConfidenceBar
          label="Medium"
          count={data.confidenceCounts.medium}
          total={totalNodes}
        />
        <ConfidenceBar
          label="Low"
          count={data.confidenceCounts.low}
          total={totalNodes}
        />
        <View style={{ marginTop: 6 }}>
          <Text style={s.eyebrow}>Source citations</Text>
          <PillRow
            values={data.allSources}
            empty="No source citations attached to the generated nodes."
          />
        </View>
      </InsightCard>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export function ProcessPdfDocument({ data }: { data: ProcessPdfData }) {
  return (
    <Document
      title={`${data.processName} — Process report`}
      author="Fabric"
      subject={`${data.functionName} · ${data.departmentName}`}
    >
      {/* Cover + summary (portrait, auto-paginates) */}
      <Page size="A4" style={s.page}>
        <Cover data={data} />
        <SummarySection data={data} />
        <Footer processName={data.processName} />
      </Page>

      {/* Flow diagram (vertical flowchart, auto-paginates) */}
      {data.hasFlow && (
        <Page size="A4" style={s.page}>
          <SectionHeader
            title="Process Flow"
            count={`${data.steps.length} steps · ${data.edges.length} connections`}
          />
          <FlowDiagramPdf data={data} />
          <Footer processName={data.processName} />
        </Page>
      )}

      {/* Steps (portrait) */}
      {data.hasFlow && data.steps.length > 0 && (
        <Page size="A4" style={s.page}>
          <StepsSection data={data} />
          <Footer processName={data.processName} />
        </Page>
      )}

      {/* Insights (portrait) */}
      {data.hasFlow && (
        <Page size="A4" style={s.page}>
          <InsightsSection data={data} />
          <Footer processName={data.processName} />
        </Page>
      )}
    </Document>
  );
}

/**
 * Builds the report data and renders it to a PDF Blob in the browser.
 * Imported dynamically from the workbench so @react-pdf/renderer stays out of
 * the main client bundle.
 */
export async function generateProcessPdfBlob(
  input: ProcessPdfInput,
): Promise<Blob> {
  const data = buildProcessPdfData(input);
  return pdf(<ProcessPdfDocument data={data} />).toBlob();
}
