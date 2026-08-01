"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  ArrowRightLeft,
  BarChart3,
  Bot,
  ChevronDown,
  Clock,
  Copy,
  FileText,
  GitBranch,
  KeyRound,
  Lightbulb,
  Menu,
  Mic,
  MoreHorizontal,
  Play,
  Share2,
  Sparkles,
  Square,
  User,
  Users,
  Wrench,
  X,
  Zap,
} from "lucide-react";

import styles from "@/features/marketing/marketing-landing-page.module.css";

const stages = [
  {
    id: "capture",
    title: "Capture",
    heading: "Start with a natural conversation.",
    description:
      "People share the practical details, judgment calls, and exceptions that a blank document never asks for.",
  },
  {
    id: "understand",
    title: "Understand",
    heading: "Turn many voices into shared knowledge.",
    description:
      "Fabric organizes the evidence into a readable brief while keeping contributor context close at hand.",
  },
  {
    id: "map",
    title: "Map",
    heading: "See how the work moves end to end.",
    description:
      "Actions, decisions, tools, waits, and handoffs become a process map the whole team can examine.",
  },
  {
    id: "improve",
    title: "Improve",
    heading: "Find the change that is worth making.",
    description:
      "Fabric connects operational signals to the evidence behind them, making improvement priorities easier to defend.",
  },
] as const;

type StageId = (typeof stages)[number]["id"];

export function MobileNavigation() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <div className={styles.mobileNavigation}>
      <button
        type="button"
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        aria-controls="mobile-marketing-navigation"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.nav
            id="mobile-marketing-navigation"
            aria-label="Mobile navigation"
            className={styles.mobileNavigationPanel}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            <a href="#how-it-works" onClick={() => setOpen(false)}>
              How it works
            </a>
            <a href="#platform" onClick={() => setOpen(false)}>
              Platform
            </a>
            <a href="#use-cases" onClick={() => setOpen(false)}>
              Use cases
            </a>
          </motion.nav>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Fixed envelope for the decorative waveforms. The bar heights used to be derived
 * in CSS with `calc(... var(--bar-index) % 5 ...)`, but `%` is a unit in `calc()`
 * rather than a modulo operator, so the whole declaration was invalid and the bars
 * collapsed to zero height. Driving the height from here keeps the pattern
 * deterministic across server and client renders.
 */
const waveformEnvelope = [
  34, 52, 78, 96, 64, 40, 58, 88, 100, 72, 46, 30, 44, 68,
  92, 76, 50, 36, 62, 84, 98, 70, 42, 32, 56, 80, 60, 38,
];

function waveformBarStyle(index: number): CSSProperties {
  return {
    "--bar-index": index,
    "--bar-height": `${waveformEnvelope[index % waveformEnvelope.length]}%`,
  } as CSSProperties;
}

const heroSources = [
  {
    icon: Users,
    title: "Invoice approvals",
    meta: "Team conversation",
    visual: "conversation",
    delay: "0s",
  },
  {
    icon: Mic,
    title: "Customer onboarding",
    meta: "Voice recording",
    visual: "voice",
    delay: "2s",
  },
  {
    icon: FileText,
    title: "Month-end close",
    meta: "Existing process notes",
    visual: "document",
    delay: "4s",
  },
] as const;

/**
 * Thread geometry is expressed as percentages of the `.heroConcept` box, which is
 * why the SVGs use a 0-100 viewBox with `preserveAspectRatio="none"`. The layout
 * keeps those percentages true:
 *
 * - desktop columns are `6fr 8fr 6fr` with no gap or padding, so the source cards
 *   end at x=30, the result cards start at x=70, and the core sits at (50, 50);
 * - mobile rows are `5fr 7fr 5fr`, so the source cards end at y=29.4 and the
 *   result cards start at y=70.6;
 * - each bank lays its cards on equal `1fr` tracks, putting their centres on the
 *   1/6, 1/2 and 5/6 lines of the cross axis (the mobile banks keep a small gap,
 *   which nudges the outer two by a fraction of a percent).
 *
 * Every thread runs a few units *underneath* the cards and into the core, both of
 * which paint opaquely above the SVG. The ends stay hidden, so sub-pixel drift
 * never leaves a line dangling in open space.
 */
const heroThreadViewBox = "0 0 100 100";

const desktopHeroThreads = [
  "M 26 16.667 C 34 16.667, 36 50, 50 50",
  "M 26 50 L 50 50",
  "M 26 83.333 C 34 83.333, 36 50, 50 50",
  "M 50 50 C 64 50, 66 16.667, 74 16.667",
  "M 50 50 L 74 50",
  "M 50 50 C 64 50, 66 83.333, 74 83.333",
] as const;

const mobileHeroThreads = [
  "M 16.3 26.4 C 16.3 36, 50 40, 50 50",
  "M 50 26.4 L 50 50",
  "M 83.7 26.4 C 83.7 36, 50 40, 50 50",
  "M 50 50 C 50 60, 16.3 64, 16.3 73.6",
  "M 50 50 L 50 73.6",
  "M 50 50 C 50 60, 83.7 64, 83.7 73.6",
] as const;

function HeroConceptThreads({
  paths,
  className,
}: {
  paths: readonly string[];
  className: string;
}) {
  return (
    <svg
      className={className}
      viewBox={heroThreadViewBox}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {paths.map((path, index) => (
        <g key={path}>
          <path className={styles.heroThreadBase} d={path} />
          <path
            className={styles.heroThreadPulse}
            d={path}
            pathLength="100"
            style={{ "--thread-delay": `${index * 0.72}s` } as CSSProperties}
          />
        </g>
      ))}
    </svg>
  );
}

export function HeroConversationDemo() {
  return (
    <div className={styles.heroDemo}>
      <p className={styles.srOnly}>
        Conversations, recordings, and existing process notes flow into Fabric.
        Fabric connects them into a shared summary, a living process flow, and
        clear improvement insights.
      </p>
      <div className={styles.heroConcept} aria-hidden="true">
        <HeroConceptThreads
          paths={desktopHeroThreads}
          className={styles.heroDesktopThreads}
        />
        <HeroConceptThreads
          paths={mobileHeroThreads}
          className={styles.heroMobileThreads}
        />

        <div className={styles.heroSourceBank}>
          {heroSources.map((source) => {
            const Icon = source.icon;
            return (
              <article
                key={source.title}
                className={styles.heroSourceCard}
                style={{ "--item-delay": source.delay } as CSSProperties}
              >
                <div className={styles.heroSourceHeading}>
                  <span><Icon /></span>
                  <div>
                    <strong>{source.title}</strong>
                    <small>{source.meta}</small>
                  </div>
                </div>
                {source.visual === "conversation" && (
                  <div className={styles.heroConversationSignal}>
                    <i /><i /><i />
                  </div>
                )}
                {source.visual === "voice" && (
                  <div className={styles.heroVoiceSignal}>
                    {Array.from({ length: waveformEnvelope.length }, (_, index) => (
                      <i key={index} style={waveformBarStyle(index)} />
                    ))}
                  </div>
                )}
                {source.visual === "document" && (
                  <div className={styles.heroDocumentSignal}>
                    <i /><i /><i />
                  </div>
                )}
              </article>
            );
          })}
        </div>

        <div className={styles.heroFabricEngine}>
          <div className={styles.heroFabricCore}>
            <i />
          </div>
          <div>
            <strong>Fabric</strong>
            <span>Connects what people know</span>
          </div>
        </div>

        <div className={styles.heroResultBank}>
          <article
            className={`${styles.heroResultCard} ${styles.heroSummaryResult}`}
          >
            <div className={styles.heroResultHeading}>
              <span><FileText /></span>
              <strong>Shared summary</strong>
            </div>
            <div className={styles.heroSummaryLines}>
              <i /><i /><i />
            </div>
            <small>One evidence-backed view</small>
          </article>

          <article
            className={`${styles.heroResultCard} ${styles.heroFlowResult}`}
          >
            <div className={styles.heroResultHeading}>
              <span><GitBranch /></span>
              <strong>Living process</strong>
            </div>
            <div className={styles.heroMiniFlow}>
              <i /><b /><i /><b /><i />
            </div>
            <small>Steps, decisions, and handoffs</small>
          </article>

          <article
            className={`${styles.heroResultCard} ${styles.heroInsightsResult}`}
          >
            <div className={styles.heroResultHeading}>
              <span><Lightbulb /></span>
              <strong>Clear insights</strong>
            </div>
            <div className={styles.heroInsightSignals}>
              <span><strong>1</strong> bottleneck</span>
              <span><strong>2</strong> opportunities</span>
            </div>
            <small>Where to improve next</small>
          </article>
        </div>
      </div>
    </div>
  );
}

export function ProductJourneyDemo() {
  const [activeStage, setActiveStage] = useState<StageId>("capture");
  const [paused, setPaused] = useState(false);
  const reduceMotion = useReducedMotion();
  const activeIndex = stages.findIndex((stage) => stage.id === activeStage);
  const active = stages[activeIndex];

  useEffect(() => {
    if (paused || reduceMotion) return;

    const interval = window.setInterval(() => {
      setActiveStage((current) => {
        const index = stages.findIndex((stage) => stage.id === current);
        return stages[(index + 1) % stages.length].id;
      });
    }, 6500);

    return () => window.clearInterval(interval);
  }, [paused, reduceMotion]);

  return (
    <div
      className={styles.productJourney}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className={styles.journeyControls} role="tablist" aria-label="How Fabric works">
        {stages.map((stage, index) => (
          <button
            key={stage.id}
            type="button"
            role="tab"
            aria-selected={stage.id === activeStage}
            aria-controls="fabric-demo-panel"
            id={`fabric-demo-tab-${stage.id}`}
            className={stage.id === activeStage ? styles.journeyTabActive : undefined}
            onClick={() => setActiveStage(stage.id)}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            {stage.title}
          </button>
        ))}
      </div>

      <div className={styles.journeyContent}>
        <div className={styles.journeyCopy} aria-live="polite">
          <AnimatePresence mode="wait">
            <motion.div
              key={active.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: reduceMotion ? 0 : 0.28, ease: "easeOut" }}
            >
              <h3>{active.heading}</h3>
              <p>{active.description}</p>
            </motion.div>
          </AnimatePresence>
          <div className={styles.journeyProgress} aria-hidden="true">
            <span style={{ width: `${((activeIndex + 1) / stages.length) * 100}%` }} />
          </div>
        </div>

        <div
          id="fabric-demo-panel"
          role="tabpanel"
          aria-labelledby={`fabric-demo-tab-${active.id}`}
          className={styles.demoStage}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={active.id}
              className={styles.demoStageInner}
              initial={{ opacity: 0, scale: 0.99 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.99 }}
              transition={{ duration: reduceMotion ? 0 : 0.3, ease: "easeOut" }}
            >
              {/* Deterministic product simulations: no API or service calls. */}
              <FabricWorkbench stage={active.id}>
                {active.id === "capture" && <CaptureStage />}
                {active.id === "understand" && <UnderstandStage />}
                {active.id === "map" && <MapStage />}
                {active.id === "improve" && <ImproveStage />}
              </FabricWorkbench>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function FabricWorkbench({ stage, children }: { stage: StageId; children: ReactNode }) {
  const activeTab =
    stage === "capture"
      ? "Conversations"
      : stage === "understand"
        ? "Process Summary"
        : stage === "map"
          ? "Process Flow"
          : "Insights";

  const tabs = [
    { label: "Process Summary", icon: FileText },
    { label: "Conversations", icon: Mic, count: 4 },
    { label: "Process Flow", icon: GitBranch },
    { label: "Insights", icon: BarChart3 },
  ];

  return (
    <div className={styles.fabricWorkbench}>
      <div className={styles.workbenchHeader}>
        <div className={styles.workbenchHeaderCopy}>
          <div className={styles.workbenchBreadcrumb}>
            Operations <span>/</span> Procurement <span>/</span> Purchase order approvals
          </div>
          <div className={styles.workbenchTitleRow}>
            <h4>Purchase order approvals</h4>
            <span>Current</span>
          </div>
          <div className={styles.workbenchMetadata}>
            <span>AK</span>
            <p>Last contribution by Amira K.</p>
            <i />
            <p>Updated 2h ago</p>
          </div>
        </div>
        <div className={styles.workbenchActions}>
          <button type="button" tabIndex={-1}>
            <Bot /> Start AI interview <ChevronDown />
          </button>
          <span><Share2 /></span>
          <span><MoreHorizontal /></span>
        </div>
      </div>
      <div className={styles.workbenchTabs}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <span
              key={tab.label}
              className={tab.label === activeTab ? styles.workbenchTabActive : undefined}
            >
              <Icon /> {tab.label}
              {tab.count && <i>{tab.count}</i>}
            </span>
          );
        })}
      </div>
      <div className={styles.workbenchBody}>{children}</div>
    </div>
  );
}

function CaptureStage() {
  const waveform = Array.from({ length: 28 }, (_, index) => index);

  return (
    <div className={styles.conversationDemo}>
      <div className={styles.conversationListMock}>
        <div className={styles.mockFilters}>
          <span>All conversations <ChevronDown /></span>
          <span>Newest first <ChevronDown /></span>
        </div>
        <div className={`${styles.mockConversationRow} ${styles.mockConversationSelected}`}>
          <span className={styles.mockConversationIcon}><Bot /></span>
          <div>
            <div><strong>AI Interview with Amira K.</strong><span>Completed</span></div>
            <p><User /> Amira K. <Clock /> Today, 10:24 AM <i>18:42</i></p>
          </div>
        </div>
        <div className={styles.mockConversationRow}>
          <span className={styles.mockConversationIcon}><Mic /></span>
          <div>
            <div><strong>Voice Recording with Kareem S.</strong><span>Completed</span></div>
            <p><User /> Kareem S. <Clock /> Yesterday <i>11:08</i></p>
          </div>
        </div>
      </div>

      <div className={styles.mockPlayback}>
        <div className={styles.mockAudioControls}>
          <button type="button" tabIndex={-1}><Play /></button>
          <div>
            {waveform.map((index) => (
              <i key={index} style={waveformBarStyle(index)} />
            ))}
          </div>
          <span>18:42</span>
        </div>
        <div className={styles.mockPlaybackSection}>
          <h5>Summary</h5>
          <p>
            Purchase requests are checked for complete project coding before
            routing to the appropriate approver.
          </p>
        </div>
        <div className={styles.mockPlaybackSection}>
          <h5>Transcript</h5>
          <div className={styles.mockTranscript}>
            <p><strong>Fabric</strong> What happens when the project code is missing?</p>
            <p><strong>Amira</strong> It comes back to Operations before Finance sees it.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function UnderstandStage() {
  return (
    <div className={styles.summaryDemo}>
      <div className={styles.summaryDemoToolbar}>
        <button type="button" tabIndex={-1} aria-label="Copy summary"><Copy /></button>
        <button type="button" tabIndex={-1}><Sparkles /> Rebuild</button>
      </div>
      <article>
        <h5>Overview</h5>
        <p>
          Purchase requests are validated by Operations before routing to the
          correct financial approver. Project coding is the most common source
          of delay. <strong>[Amira K., Kareem S.]</strong>
        </p>
        <h5>Key stages</h5>
        <ul>
          <li>Validate the request, supplier, and project code.</li>
          <li>Route by value and approval threshold.</li>
          <li>Return incomplete requests to the owner.</li>
        </ul>
        <h5>Tensions &amp; gaps</h5>
        <p>
          Operations describes project-code validation as mandatory, while one
          contributor reports urgent requests occasionally bypassing the check.
          <strong>[Operations review, Kareem S.]</strong>
        </p>
        <blockquote>
          “Missing codes come back to us before approval.”
          <cite>Amira K., Operations</cite>
        </blockquote>
      </article>
    </div>
  );
}

type FlowCategory = "start" | "action" | "decision" | "handoff" | "end";

const flowNodeConfig = {
  start: { icon: Play, label: "Start" },
  action: { icon: Zap, label: "Action" },
  decision: { icon: GitBranch, label: "Decision" },
  handoff: { icon: ArrowRightLeft, label: "Handoff" },
  end: { icon: Square, label: "End" },
} as const;

function DemoFlowNode({
  category,
  title,
  description,
  indicator,
  automation,
}: {
  category: FlowCategory;
  title: string;
  description: string;
  indicator?: string;
  automation?: "high" | "medium";
}) {
  const config = flowNodeConfig[category];
  const Icon = config.icon;

  return (
    <div className={`${styles.demoFlowNode} ${styles[`demoFlowNode${category}`]}`}>
      <div className={styles.demoFlowNodeHeader}>
        <span><Icon /></span>
        <strong>{title}</strong>
      </div>
      <div className={styles.demoFlowBadges}>
        <span>{config.label}</span>
        {automation && <span><Bot /> {automation}</span>}
      </div>
      <p>{description}</p>
      {indicator && (
        <div className={styles.demoFlowIndicator}>
          <AlertTriangle /> {indicator}
        </div>
      )}
    </div>
  );
}

function FlowConnector({ label }: { label?: string }) {
  return (
    <div className={styles.flowConnector}>
      {label && <span>{label}</span>}
      <i />
    </div>
  );
}

function MapStage() {
  return (
    <div className={styles.processFlowDemo}>
      <div className={styles.processFlowTrack}>
        <DemoFlowNode
          category="start"
          title="Request received"
          description="Operations receives the purchase request."
        />
        <FlowConnector />
        <DemoFlowNode
          category="action"
          title="Validate request"
          description="Check supplier, project code, and supporting evidence."
          automation="high"
        />
        <FlowConnector />
        <DemoFlowNode
          category="decision"
          title="Project code valid?"
          description="Incomplete requests cannot enter approval."
          indicator="bottleneck"
        />
        <div className={styles.flowBranches}>
          <div>
            <FlowConnector label="No" />
            <DemoFlowNode
              category="action"
              title="Return to owner"
              description="Operations requests the missing information."
            />
          </div>
          <div>
            <FlowConnector label="Yes" />
            <DemoFlowNode
              category="handoff"
              title="Route for approval"
              description="Finance receives the validated request."
            />
          </div>
        </div>
      </div>
      <div className={styles.processFlowSignals}>
        <span><BarChart3 /> 5 steps</span>
        <span><ArrowRightLeft /> 1 handoff</span>
        <span><Wrench /> 3 tools</span>
        <span><AlertTriangle /> 1 bottleneck</span>
        <span><Bot /> 1 automation opportunity</span>
      </div>
    </div>
  );
}

function MetricTile({ icon, label, value, detail }: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className={styles.metricTile}>
      <div>{icon}<span>{label}</span></div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}

function ImproveStage() {
  return (
    <div className={styles.insightsDemo}>
      <div className={styles.insightMetricGrid}>
        <MetricTile icon={<Users />} label="Evidence" value="4" detail="completed conversations" />
        <MetricTile icon={<GitBranch />} label="Mapped steps" value="5" detail="1 decision point" />
        <MetricTile icon={<AlertTriangle />} label="Bottlenecks" value="1" detail="coding validation" />
        <MetricTile icon={<Bot />} label="Automation" value="1" detail="high-potential candidate" />
      </div>
      <section className={styles.insightSectionCard}>
        <header>
          <h5><Bot /> Automation opportunities</h5>
          <span>1</span>
        </header>
        <div className={styles.insightCandidate}>
          <div>
            <strong>Validate project codes before submission</strong>
            <span>High potential</span>
          </div>
          <p>
            Three contributors identified missing or incorrect codes as the
            main cause of returned requests and approval delay.
          </p>
          <div>
            <span><Lightbulb /> Suggested next step</span>
            Add validation at the request form before the Finance handoff.
          </div>
        </div>
      </section>
      <section className={styles.insightSectionCard}>
        <header>
          <h5><KeyRound /> Tribal knowledge risk</h5>
          <span>1</span>
        </header>
        <div className={styles.insightRiskRow}>
          Approval routing depends on a threshold table maintained by one team member.
        </div>
      </section>
    </div>
  );
}
