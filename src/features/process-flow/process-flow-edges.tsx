"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import { cn } from "@/lib/utils";
import { resolveEdgeVisualTokens } from "./flow-focus";
import type {
  ProcessFlowEdge,
  ProcessFlowEdgeData,
} from "./use-process-flow-layout";
import styles from "./process-flow-edge.module.css";

const LABEL_CLASSES: Record<ProcessFlowEdgeData["flowType"], string> = {
  sequential: "border-border bg-card text-muted-foreground",
  conditional:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200",
  parallel:
    "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-200",
  fallback:
    "border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-700 dark:bg-orange-950 dark:text-orange-200",
};

function strokeColor(data: ProcessFlowEdgeData) {
  if (data.emphasis === "active") return "var(--org-accent)";
  if (data.emphasis === "muted") return "var(--color-border)";
  return data.isHappyPath
    ? "var(--color-foreground)"
    : "var(--color-muted-foreground)";
}

function ProcessEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  label,
  style,
  interactionWidth,
  data,
}: EdgeProps<ProcessFlowEdge>) {
  const edgeData: ProcessFlowEdgeData = data ?? {
    flowType: "sequential",
    isHappyPath: true,
    emphasis: "default",
    focusMode: "none",
    animateFlow: false,
    spotlighted: false,
  };
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
    offset: 20,
  });
  const tokens = resolveEdgeVisualTokens({
    type: edgeData.flowType,
    isHappyPath: edgeData.isHappyPath,
    emphasis: edgeData.emphasis,
  });
  const stroke = edgeData.spotlighted
    ? "var(--org-accent)"
    : strokeColor(edgeData);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth ?? 32}
        className={styles.edgePath}
        vectorEffect="non-scaling-stroke"
        style={{
          ...style,
          stroke,
          strokeDasharray: tokens.dashArray,
          strokeLinecap: tokens.lineCap,
          strokeWidth: tokens.strokeWidth,
          opacity: tokens.opacity,
          filter:
            edgeData.emphasis === "active"
              ? "drop-shadow(0 0 2px color-mix(in oklch, var(--org-accent) 30%, transparent))"
              : undefined,
        }}
      />

      {edgeData.animateFlow && (
        <circle
          r="2.5"
          fill="var(--org-accent)"
          opacity="0.88"
          pointerEvents="none"
          aria-hidden
        >
          <animateMotion dur="1.8s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}

      {label && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              opacity: edgeData.emphasis === "muted" ? 0.5 : 1,
            }}
            aria-hidden
          >
            <span
              className={cn(
                "inline-flex max-w-40 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-4 shadow-sm transition-opacity motion-reduce:transition-none",
                LABEL_CLASSES[edgeData.flowType],
                edgeData.emphasis === "active" &&
                  "ring-2 ring-org-accent-ring/25",
              )}
            >
              {label}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = {
  process: ProcessEdgeComponent,
} as const;
