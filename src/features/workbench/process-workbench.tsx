"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  BarChart3,
  Bot,
  ChevronLeft,
  ChevronRight,
  Building2,
  Layers,
  Cog,
  FileText,
  Mic,
} from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProcessHeader } from "@/features/workbench/process-header";
import { ProcessAppShell } from "@/features/shell/process-app-shell";
import { useWorkspaceRoutes } from "@/features/shell/use-workspace-routes";
import { ProcessConversationsTab } from "@/features/conversations/conversations-tab";
import { ProcessFlowTab } from "@/features/process-flow/process-flow-tab";
import { ProcessInsightsTab } from "@/features/insights/process-insights-tab";
import { ProcessAutomationsTab } from "@/features/automations/process-automations-tab";
import {
  HierarchyOverview,
  HierarchyOverviewCompactPreview,
  type HierarchyChildSummary,
} from "@/features/overview/hierarchy-overview";
import {
  ProcessOverview,
  ProcessOverviewCompactPreview,
} from "@/features/overview/process-overview";
import {
  ProcessTreeNavigator,
  type ProcessTreeDepartment,
  type ProcessTreeFunction,
  type ProcessTreeProcess,
} from "@/features/hierarchy/process-tree-navigator";
import {
  type SelectionParams,
  readSelectionParams,
  buildSelectionQuery,
} from "@/features/workbench/use-selection-params";
import {
  ColumnItem,
  ColumnHeader,
  EmptyState,
  LoadingSpinner,
  OverviewActions,
} from "@/features/workbench/workbench-columns";
import {
  RecordingModal,
  type RecordingMode,
} from "@/features/recording/recording-modal";
import { CrudDialog } from "@/features/hierarchy/crud-dialog";
import { CommandPalette } from "@/features/hierarchy/command-palette";
import { useProcessPdfDownload } from "@/features/workbench/process-pdf/use-process-pdf-download";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { GitBranch } from "lucide-react";

// --- Types ---

type MobileLevel = 1 | 2 | 3 | 4;
type MobilePreview =
  | { type: "function"; id: Id<"functions">; name: string }
  | { type: "department"; id: Id<"departments">; name: string }
  | { type: "process"; id: Id<"processes">; name: string }
  | null;

function deepestMobileLevel(sel: {
  fn: Id<"functions"> | null;
  dept: Id<"departments"> | null;
  proc: Id<"processes"> | null;
}): MobileLevel {
  if (sel.proc) return 4;
  if (sel.dept) return 3;
  if (sel.fn) return 2;
  return 1;
}

// --- Main Component ---

export function ProcessWorkbench() {
  // Current user role is sourced from their membership in the active org.
  const membership = useQuery(api.users.getMyMembership);
  const userRole = membership?.role ?? "viewer";
  const canEdit = userRole === "admin" || userRole === "contributor";

  // URL <-> selection sync plumbing. Selection is mirrored into the query
  // string so the view is refresh-safe, shareable, and Back-traversable.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const routes = useWorkspaceRoutes();
  const isMobile = useIsMobile();
  // Seed once from the URL (the initializer runs on first render only); later
  // external URL changes (Back/Forward) are reconciled by the read effect below.
  const [initialSelection] = useState(() => readSelectionParams(searchParams));

  // Column collapse state

  // Selection state (seeded from the URL so deep links / refresh restore position)
  const [selectedFunctionId, setSelectedFunctionId] =
    useState<Id<"functions"> | null>(initialSelection.fn);
  const [selectedDepartmentId, setSelectedDepartmentId] =
    useState<Id<"departments"> | null>(initialSelection.dept);
  const [selectedProcessId, setSelectedProcessId] =
    useState<Id<"processes"> | null>(initialSelection.proc);

  // Recording modal state
  const [recordingOpen, setRecordingOpen] = useState(false);
  const [recordingMode, setRecordingMode] = useState<RecordingMode>("agent");

  // Mobile navigation level
  const [mobileLevel, setMobileLevel] = useState<MobileLevel>(
    deepestMobileLevel(initialSelection),
  );
  const [mobilePreview, setMobilePreview] = useState<MobilePreview>(null);

  // Active detail tab (0 = Overview, 1 = Conversations, 2 = Process Flow,
  // 3 = Insights, 4 = Automations), seeded from the URL.
  const [detailTab, setDetailTab] = useState<number>(initialSelection.tab);
  const [flowNodeId, setFlowNodeId] = useState<string | null>(
    initialSelection.node,
  );
  const [labelingJumpKey, setLabelingJumpKey] = useState(0);
  const [conversationFocusId, setConversationFocusId] =
    useState<Id<"conversations"> | null>(null);
  const [conversationFocusJumpKey, setConversationFocusJumpKey] = useState(0);

  // Selected names for breadcrumbs / back buttons
  const [selectedFunctionName, setSelectedFunctionName] = useState("");
  const [selectedDepartmentName, setSelectedDepartmentName] = useState("");
  const [selectedProcessName, setSelectedProcessName] = useState("");

  // Process report PDF export (flow fetched + rendered on demand).
  const { download: downloadProcessPdf, isDownloading: isDownloadingPdf } =
    useProcessPdfDownload();

  // CRUD mutations/actions
  const createFunction = useMutation(api.functions.create);
  const updateFunction = useMutation(api.functions.update);
  const removeFunction = useMutation(api.functions.remove);
  const createDepartment = useAction(api.departments.create);
  const updateDepartment = useAction(api.departments.update);
  const removeDepartment = useMutation(api.departments.remove);
  const createProcess = useAction(api.processes.create);
  const updateProcess = useAction(api.processes.update);
  const removeProcess = useMutation(api.processes.remove);

  // CRUD dialog state
  const [crudOpen, setCrudOpen] = useState(false);
  const [crudMode, setCrudMode] = useState<"create" | "edit" | "delete">(
    "create",
  );
  const [crudEntity, setCrudEntity] = useState<
    "Function" | "Department" | "Process"
  >("Function");
  const [crudTargetName, setCrudTargetName] = useState("");
  const [crudTargetDescription, setCrudTargetDescription] = useState("");
  const [crudTargetId, setCrudTargetId] = useState<string | null>(null);
  const [crudCurrentLocationId, setCrudCurrentLocationId] = useState<
    string | null
  >(null);

  // Server-computed delete eligibility for the selected delete target.
  const deleteFnEligibility = useQuery(
    api.functions.deleteEligibility,
    crudOpen &&
      crudMode === "delete" &&
      crudEntity === "Function" &&
      crudTargetId
      ? { functionId: crudTargetId as Id<"functions"> }
      : "skip",
  );
  const deleteDeptEligibility = useQuery(
    api.departments.deleteEligibility,
    crudOpen &&
      crudMode === "delete" &&
      crudEntity === "Department" &&
      crudTargetId
      ? { departmentId: crudTargetId as Id<"departments"> }
      : "skip",
  );
  const deleteProcEligibility = useQuery(
    api.processes.deleteEligibility,
    crudOpen &&
      crudMode === "delete" &&
      crudEntity === "Process" &&
      crudTargetId
      ? { processId: crudTargetId as Id<"processes"> }
      : "skip",
  );
  const deleteEligibility =
    crudEntity === "Function"
      ? deleteFnEligibility
      : crudEntity === "Department"
        ? deleteDeptEligibility
        : deleteProcEligibility;

  const handleOpenDeleteCleanup = useCallback(() => {
    if (crudEntity !== "Process" || !crudTargetId) return;
    setCrudOpen(false);
    router.push(
      routes.withWorkspacePath(
        `/admin/conversations?processId=${crudTargetId}`,
      ),
    );
  }, [crudEntity, crudTargetId, router, routes]);

  const openCrud = useCallback(
    (
      mode: "create" | "edit" | "delete",
      entity: "Function" | "Department" | "Process",
      targetName?: string,
      targetId?: string,
      currentLocationId?: string,
      currentDescription?: string,
    ) => {
      setCrudMode(mode);
      setCrudEntity(entity);
      setCrudTargetName(targetName ?? "");
      setCrudTargetDescription(currentDescription ?? "");
      setCrudTargetId(targetId ?? null);
      setCrudCurrentLocationId(currentLocationId ?? null);
      setCrudOpen(true);
    },
    [],
  );

  const handleCrudConfirm = useCallback(
    async (name: string, newLocationId?: string, description?: string) => {
      if (crudEntity === "Function") {
        if (crudMode === "create") {
          await createFunction({ name });
        } else if (crudMode === "edit" && crudTargetId) {
          await updateFunction({
            functionId: crudTargetId as Id<"functions">,
            name,
          });
        } else if (crudMode === "delete" && crudTargetId) {
          await removeFunction({ functionId: crudTargetId as Id<"functions"> });
          if (selectedFunctionId === crudTargetId) {
            setSelectedFunctionId(null);
            setSelectedDepartmentId(null);
            setSelectedProcessId(null);
          }
        }
      } else if (crudEntity === "Department") {
        if (crudMode === "create" && selectedFunctionId) {
          await createDepartment({
            functionId: selectedFunctionId,
            name,
            description,
          });
        } else if (crudMode === "edit" && crudTargetId) {
          const newFunctionId = newLocationId as Id<"functions"> | undefined;
          await updateDepartment({
            departmentId: crudTargetId as Id<"departments">,
            name,
            functionId: newFunctionId,
            description,
          });
          if (newFunctionId && newFunctionId !== selectedFunctionId) {
            setSelectedDepartmentId(null);
            setSelectedProcessId(null);
          }
        } else if (crudMode === "delete" && crudTargetId) {
          await removeDepartment({
            departmentId: crudTargetId as Id<"departments">,
          });
          if (selectedDepartmentId === crudTargetId) {
            setSelectedDepartmentId(null);
            setSelectedProcessId(null);
          }
        }
      } else if (crudEntity === "Process") {
        if (crudMode === "create" && selectedDepartmentId) {
          await createProcess({
            departmentId: selectedDepartmentId,
            name,
            description,
          });
        } else if (crudMode === "edit" && crudTargetId) {
          const newDepartmentId = newLocationId as
            Id<"departments"> | undefined;
          await updateProcess({
            processId: crudTargetId as Id<"processes">,
            name,
            departmentId: newDepartmentId,
            description,
          });
          if (newDepartmentId && newDepartmentId !== selectedDepartmentId) {
            setSelectedProcessId(null);
          }
        } else if (crudMode === "delete" && crudTargetId) {
          await removeProcess({ processId: crudTargetId as Id<"processes"> });
          if (selectedProcessId === crudTargetId) {
            setSelectedProcessId(null);
          }
        }
      }
    },
    [
      crudEntity,
      crudMode,
      crudTargetId,
      selectedFunctionId,
      selectedDepartmentId,
      selectedProcessId,
      createFunction,
      updateFunction,
      removeFunction,
      createDepartment,
      updateDepartment,
      removeDepartment,
      createProcess,
      updateProcess,
      removeProcess,
    ],
  );

  // Convex queries
  const hierarchyTree = useQuery(api.hierarchy.getTree);
  const functions = useQuery(api.functions.list);
  const departments = useQuery(
    api.departments.listByFunction,
    selectedFunctionId ? { functionId: selectedFunctionId } : "skip",
  );
  const processes = useQuery(
    api.processes.listByDepartment,
    selectedDepartmentId ? { departmentId: selectedDepartmentId } : "skip",
  );
  const selectedProcess = useQuery(
    api.processes.get,
    selectedProcessId ? { processId: selectedProcessId } : "skip",
  );
  const processWorkbench = useQuery(
    api.processes.getWorkbench,
    selectedProcessId ? { processId: selectedProcessId } : "skip",
  );
  const selectedDepartment = useQuery(
    api.departments.get,
    selectedDepartmentId ? { departmentId: selectedDepartmentId } : "skip",
  );
  const selectedFunction = useQuery(
    api.functions.get,
    selectedFunctionId ? { functionId: selectedFunctionId } : "skip",
  );
  const allDepartments = useQuery(api.departments.listAll);
  const allProcesses = useQuery(api.processes.listAll);
  const attentionProcessIds = useQuery(
    api.conversations.processIdsNeedingAttention,
  );
  const processConversations = useQuery(
    api.conversations.listByProcess,
    selectedProcessId ? { processId: selectedProcessId } : "skip",
  );
  const completedProcessConversationCount =
    processConversations?.filter(
      (conversation) => conversation.status === "done",
    ).length ?? 0;
  const departmentOverviewChildren = useMemo<
    HierarchyChildSummary[] | undefined
  >(
    () =>
      processes?.map((process) => ({
        kind: "process" as const,
        id: process._id,
        name: process.name,
        state: process.summaryOverview.state,
        format: process.summaryOverview.format,
        generatedAt: process.summaryOverview.generatedAt,
        coverage: process.summaryOverview.coverage,
      })),
    [processes],
  );
  const functionOverviewChildren = useMemo<
    HierarchyChildSummary[] | undefined
  >(
    () =>
      departments?.map((department) => ({
        kind: "department" as const,
        id: department._id,
        name: department.name,
        state: department.summaryOverview.state,
        format: department.summaryOverview.format,
        generatedAt: department.summaryOverview.generatedAt,
        coverage: department.summaryOverview.coverage,
      })),
    [departments],
  );

  // Row scent, derived from the lists already loaded for navigation/search
  // (no per-row queries). See plan: "compute on read".
  const departmentCountByFunction = useMemo(() => {
    const map = new Map<Id<"functions">, number>();
    for (const dept of allDepartments ?? []) {
      map.set(dept.functionId, (map.get(dept.functionId) ?? 0) + 1);
    }
    return map;
  }, [allDepartments]);
  const processCountByDepartment = useMemo(() => {
    const map = new Map<Id<"departments">, number>();
    for (const proc of allProcesses ?? []) {
      map.set(proc.departmentId, (map.get(proc.departmentId) ?? 0) + 1);
    }
    return map;
  }, [allProcesses]);
  const attentionProcessIdSet = useMemo(
    () => new Set(attentionProcessIds ?? []),
    [attentionProcessIds],
  );

  // Display names sourced from the reactive docs so renames reflect immediately,
  // falling back to the snapshot captured at selection time while the doc loads.
  const functionDisplayName = selectedFunction?.name ?? selectedFunctionName;
  const departmentDisplayName =
    selectedDepartment?.name ?? selectedDepartmentName;
  const processDisplayName = selectedProcess?.name ?? selectedProcessName;
  const workbenchFunctionName =
    processWorkbench?.function.name ?? functionDisplayName;
  const workbenchDepartmentName =
    processWorkbench?.department.name ?? departmentDisplayName;
  const workbenchProcessName =
    processWorkbench?.process.name ?? processDisplayName;
  const functionBreadcrumbQuery = buildSelectionQuery(searchParams, {
    fn: selectedFunctionId,
    dept: null,
    proc: null,
    tab: detailTab,
    node: null,
  });
  const departmentBreadcrumbQuery = buildSelectionQuery(searchParams, {
    fn: selectedFunctionId,
    dept: selectedDepartmentId,
    proc: null,
    tab: detailTab,
    node: null,
  });
  const functionBreadcrumbHref = `${pathname}${
    functionBreadcrumbQuery ? `?${functionBreadcrumbQuery}` : ""
  }`;
  const departmentBreadcrumbHref = `${pathname}${
    departmentBreadcrumbQuery ? `?${departmentBreadcrumbQuery}` : ""
  }`;
  const safeDepartmentDescription =
    (selectedDepartment?.descriptionSafetyStatus ??
      processWorkbench?.department.descriptionSafetyStatus) === "safe"
      ? (selectedDepartment?.description ??
        processWorkbench?.department.description ??
        undefined)
      : undefined;
  const safeProcessDescription =
    (selectedProcess?.descriptionSafetyStatus ??
      processWorkbench?.process.descriptionSafetyStatus) === "safe"
      ? (selectedProcess?.description ??
        processWorkbench?.process.description ??
        undefined)
      : undefined;

  // Clear selection when a selected entity is removed out from under us (e.g.
  // deleted by another member). The `get` queries resolve to `null` (not
  // `undefined`) only once loaded-and-missing, so this never fires mid-load,
  // and clearing the id skips the query so the null condition can't re-fire.
  //
  // This is the legitimate "subscribe to an external system, setState when it
  // changes" case the lint rule below describes — the external system is the
  // Convex reactive store telling us the doc no longer exists.
  /* eslint-disable react-hooks/set-state-in-effect -- reacting to a Convex subscription; see note above */
  useEffect(() => {
    if (selectedFunctionId && selectedFunction === null) {
      setSelectedFunctionId(null);
      setSelectedFunctionName("");
      setSelectedDepartmentId(null);
      setSelectedDepartmentName("");
      setSelectedProcessId(null);
      setSelectedProcessName("");
      setFlowNodeId(null);
    }
  }, [selectedFunctionId, selectedFunction]);

  useEffect(() => {
    if (selectedDepartmentId && selectedDepartment === null) {
      setSelectedDepartmentId(null);
      setSelectedDepartmentName("");
      setSelectedProcessId(null);
      setSelectedProcessName("");
      setFlowNodeId(null);
    }
  }, [selectedDepartmentId, selectedDepartment]);

  useEffect(() => {
    if (selectedProcessId && selectedProcess === null) {
      setSelectedProcessId(null);
      setSelectedProcessName("");
      setFlowNodeId(null);
    }
  }, [selectedProcessId, selectedProcess]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // A shared process link may arrive with only `proc` in the query string.
  // Hydrate the missing ancestors from the workbench read model so the tree and
  // URL can settle on the full function -> department -> process path.
  /* eslint-disable react-hooks/set-state-in-effect -- reacting to Convex data for a URL-selected process */
  useEffect(() => {
    if (!selectedProcessId || !processWorkbench) return;

    const nextFunctionId = processWorkbench.function._id;
    const nextFunctionName = processWorkbench.function.name;
    const nextDepartmentId = processWorkbench.department._id;
    const nextDepartmentName = processWorkbench.department.name;
    const nextProcessName = processWorkbench.process.name;

    if (selectedFunctionId !== nextFunctionId) {
      setSelectedFunctionId(nextFunctionId);
    }
    if (selectedFunctionName !== nextFunctionName) {
      setSelectedFunctionName(nextFunctionName);
    }
    if (selectedDepartmentId !== nextDepartmentId) {
      setSelectedDepartmentId(nextDepartmentId);
    }
    if (selectedDepartmentName !== nextDepartmentName) {
      setSelectedDepartmentName(nextDepartmentName);
    }
    if (selectedProcessName !== nextProcessName) {
      setSelectedProcessName(nextProcessName);
    }
  }, [
    selectedProcessId,
    processWorkbench,
    selectedFunctionId,
    selectedFunctionName,
    selectedDepartmentId,
    selectedDepartmentName,
    selectedProcessName,
  ]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // --- URL <-> selection synchronization ---
  //
  // `committed` is the selection the URL should reflect. On mobile a row tap can
  // *preview* an item (loading its summary) without drilling in, so only ids
  // at-or-above the current drill level count as committed; on desktop every
  // selected id is committed.
  const committed = useMemo<SelectionParams>(() => {
    const ids = isMobile
      ? {
          fn: mobileLevel >= 2 ? selectedFunctionId : null,
          dept: mobileLevel >= 3 ? selectedDepartmentId : null,
          proc: mobileLevel >= 4 ? selectedProcessId : null,
        }
      : {
          fn: selectedFunctionId,
          dept: selectedDepartmentId,
          proc: selectedProcessId,
        };
    return {
      ...ids,
      tab: detailTab,
      node: ids.proc && detailTab === 2 ? flowNodeId : null,
    };
  }, [
    isMobile,
    mobileLevel,
    selectedFunctionId,
    selectedDepartmentId,
    selectedProcessId,
    detailTab,
    flowNodeId,
  ]);

  // Write: mirror the committed selection into the URL (push, so Back walks up
  // the hierarchy). Keyed on `committed` ONLY — deliberately NOT on
  // `searchParams` — so that an inbound URL change (Back/Forward, applied by the
  // read effect below) can't race this effect into re-pushing the
  // pre-navigation selection.
  useEffect(() => {
    if (committed.proc && (!committed.fn || !committed.dept)) {
      return;
    }

    const target = buildSelectionQuery(searchParams, committed);
    if (target !== searchParams.toString()) {
      router.push(target ? `${pathname}?${target}` : pathname, {
        scroll: false,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- excludes `searchParams` by design; see note above
  }, [committed, pathname, router]);

  // Read: reconcile state when the URL changes from the outside (Back/Forward,
  // deep link). Keyed on `searchParams` ONLY — deliberately NOT on the selection
  // state — so a local selection change can't be clobbered before the write
  // effect runs. Names reset to "" and re-resolve via the *DisplayName fallbacks.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- reacting to external URL changes; deps limited to `searchParams` by design */
  useEffect(() => {
    const next = readSelectionParams(searchParams);
    if (
      next.fn !== selectedFunctionId ||
      next.dept !== selectedDepartmentId ||
      next.proc !== selectedProcessId ||
      next.tab !== detailTab ||
      next.node !== flowNodeId
    ) {
      setSelectedFunctionId(next.fn);
      setSelectedDepartmentId(next.dept);
      setSelectedProcessId(next.proc);
      setSelectedFunctionName("");
      setSelectedDepartmentName("");
      setSelectedProcessName("");
      setMobileLevel(deepestMobileLevel(next));
      setDetailTab(next.tab);
      setFlowNodeId(next.node);
    }
  }, [searchParams]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  // Location options for edit modals
  const departmentLocationOptions = (functions ?? []).map((fn) => ({
    value: fn._id,
    label: fn.name,
  }));
  const processLocationOptions = (allDepartments ?? []).map((dept) => ({
    value: dept._id,
    label: dept.name,
    group: dept.functionName,
  }));

  // Selection handlers
  const handleSelectFunction = useCallback(
    (id: Id<"functions">, name: string) => {
      setSelectedFunctionId(id);
      setSelectedFunctionName(name);
      setSelectedDepartmentId(null);
      setSelectedDepartmentName("");
      setSelectedProcessId(null);
      setSelectedProcessName("");
      setFlowNodeId(null);
      setMobilePreview(null);
      setMobileLevel(2);
    },
    [],
  );

  const handlePreviewFunction = useCallback(
    (id: Id<"functions">, name: string) => {
      setSelectedFunctionId(id);
      setSelectedFunctionName(name);
      setSelectedDepartmentId(null);
      setSelectedDepartmentName("");
      setSelectedProcessId(null);
      setSelectedProcessName("");
      setFlowNodeId(null);
      setMobilePreview({ type: "function", id, name });
    },
    [],
  );

  const handleSelectDepartment = useCallback(
    (id: Id<"departments">, name: string) => {
      setSelectedDepartmentId(id);
      setSelectedDepartmentName(name);
      setSelectedProcessId(null);
      setSelectedProcessName("");
      setFlowNodeId(null);
      setMobilePreview(null);
      setMobileLevel(3);
    },
    [],
  );

  const handlePreviewDepartment = useCallback(
    (id: Id<"departments">, name: string) => {
      setSelectedDepartmentId(id);
      setSelectedDepartmentName(name);
      setSelectedProcessId(null);
      setSelectedProcessName("");
      setFlowNodeId(null);
      setMobilePreview({ type: "department", id, name });
    },
    [],
  );

  const handleSelectProcess = useCallback(
    (id: Id<"processes">, name: string) => {
      setSelectedProcessId(id);
      setSelectedProcessName(name);
      setFlowNodeId(null);
      setMobilePreview(null);
      setMobileLevel(4);
    },
    [],
  );

  const handlePreviewProcess = useCallback(
    (id: Id<"processes">, name: string) => {
      setSelectedProcessId(id);
      setSelectedProcessName(name);
      setFlowNodeId(null);
      setMobilePreview({ type: "process", id, name });
    },
    [],
  );

  // --- Command palette (⌘K jump-to-anything) ---
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Jump straight to a full selection path (sets every level at once); the
  // Phase-2 URL write effect then mirrors it to the query string.
  const jumpToDepartment = useCallback(
    (
      functionId: Id<"functions">,
      functionName: string,
      departmentId: Id<"departments">,
      departmentName: string,
    ) => {
      setSelectedFunctionId(functionId);
      setSelectedFunctionName(functionName);
      setSelectedDepartmentId(departmentId);
      setSelectedDepartmentName(departmentName);
      setSelectedProcessId(null);
      setSelectedProcessName("");
      setMobilePreview(null);
      setMobileLevel(3);
    },
    [],
  );

  const jumpToProcess = useCallback(
    (
      functionId: Id<"functions">,
      functionName: string,
      departmentId: Id<"departments">,
      departmentName: string,
      processId: Id<"processes">,
      processName: string,
    ) => {
      setSelectedFunctionId(functionId);
      setSelectedFunctionName(functionName);
      setSelectedDepartmentId(departmentId);
      setSelectedDepartmentName(departmentName);
      setSelectedProcessId(processId);
      setSelectedProcessName(processName);
      setMobilePreview(null);
      setMobileLevel(4);
    },
    [],
  );

  const handleTreeSelectFunction = useCallback(
    (fn: ProcessTreeFunction) => {
      handleSelectFunction(fn._id, fn.name);
    },
    [handleSelectFunction],
  );

  const handleTreeSelectDepartment = useCallback(
    (fn: ProcessTreeFunction, department: ProcessTreeDepartment) => {
      jumpToDepartment(fn._id, fn.name, department._id, department.name);
    },
    [jumpToDepartment],
  );

  const handleTreeSelectProcess = useCallback(
    (
      fn: ProcessTreeFunction,
      department: ProcessTreeDepartment,
      process: ProcessTreeProcess,
    ) => {
      jumpToProcess(
        fn._id,
        fn.name,
        department._id,
        department.name,
        process._id,
        process.name,
      );
    },
    [jumpToProcess],
  );

  const handleTreeCreateDepartment = useCallback(
    (fn: ProcessTreeFunction) => {
      handleSelectFunction(fn._id, fn.name);
      openCrud("create", "Department");
    },
    [handleSelectFunction, openCrud],
  );

  const handleTreeCreateProcess = useCallback(
    (fn: ProcessTreeFunction, department: ProcessTreeDepartment) => {
      jumpToDepartment(fn._id, fn.name, department._id, department.name);
      openCrud("create", "Process");
    },
    [jumpToDepartment, openCrud],
  );

  const handleTreeEditFunction = useCallback(
    (fn: ProcessTreeFunction) => {
      openCrud("edit", "Function", fn.name, fn._id);
    },
    [openCrud],
  );

  const handleTreeDeleteFunction = useCallback(
    (fn: ProcessTreeFunction) => {
      openCrud("delete", "Function", fn.name, fn._id);
    },
    [openCrud],
  );

  const handleTreeEditDepartment = useCallback(
    (_fn: ProcessTreeFunction, department: ProcessTreeDepartment) => {
      openCrud(
        "edit",
        "Department",
        department.name,
        department._id,
        department.functionId,
        department.description ?? undefined,
      );
    },
    [openCrud],
  );

  const handleTreeDeleteDepartment = useCallback(
    (_fn: ProcessTreeFunction, department: ProcessTreeDepartment) => {
      openCrud("delete", "Department", department.name, department._id);
    },
    [openCrud],
  );

  const handleTreeEditProcess = useCallback(
    (
      _fn: ProcessTreeFunction,
      _department: ProcessTreeDepartment,
      process: ProcessTreeProcess,
    ) => {
      openCrud(
        "edit",
        "Process",
        process.name,
        process._id,
        process.departmentId,
        process.description ?? undefined,
      );
    },
    [openCrud],
  );

  const handleTreeDeleteProcess = useCallback(
    (
      _fn: ProcessTreeFunction,
      _department: ProcessTreeDepartment,
      process: ProcessTreeProcess,
    ) => {
      openCrud("delete", "Process", process.name, process._id);
    },
    [openCrud],
  );

  const handleCopyProcessLink = useCallback(async () => {
    if (!selectedProcessId) return false;

    const target = buildSelectionQuery(searchParams, {
      fn: selectedFunctionId,
      dept: selectedDepartmentId,
      proc: selectedProcessId,
      tab: detailTab,
      node: detailTab === 2 ? flowNodeId : null,
    });
    const url = `${window.location.origin}${pathname}${target ? `?${target}` : ""}`;
    return await copyTextToClipboard(url);
  }, [
    detailTab,
    flowNodeId,
    pathname,
    searchParams,
    selectedDepartmentId,
    selectedFunctionId,
    selectedProcessId,
  ]);

  const handleOpenRecordingMode = useCallback((mode: RecordingMode) => {
    setRecordingMode(mode);
    setRecordingOpen(true);
  }, []);

  const handleJumpToLabeling = useCallback(() => {
    setFlowNodeId(null);
    setDetailTab(1);
    setLabelingJumpKey((key) => key + 1);
  }, []);

  const handleOpenOverviewConversation = useCallback(
    (conversationId: Id<"conversations">) => {
      setConversationFocusId(conversationId);
      setConversationFocusJumpKey((key) => key + 1);
      setFlowNodeId(null);
      setDetailTab(1);
    },
    [],
  );

  const handleOpenProcessFlow = useCallback((nodeId?: string) => {
    setFlowNodeId(nodeId ?? null);
    setDetailTab(2);
  }, []);

  const handleOpenOverviewProcess = useCallback(
    (processId: Id<"processes">) => {
      const process = processes?.find((row) => row._id === processId);
      if (process) handleSelectProcess(process._id, process.name);
    },
    [handleSelectProcess, processes],
  );

  const handleOpenOverviewDepartment = useCallback(
    (departmentId: Id<"departments">) => {
      const department = departments?.find((row) => row._id === departmentId);
      if (department) {
        handleSelectDepartment(department._id, department.name);
      }
    },
    [departments, handleSelectDepartment],
  );

  const handleEditSelectedProcess = useCallback(() => {
    if (!selectedProcessId) return;
    openCrud(
      "edit",
      "Process",
      workbenchProcessName,
      selectedProcessId,
      selectedProcess?.departmentId ?? processWorkbench?.process.departmentId,
      selectedProcess?.description ??
        processWorkbench?.process.description ??
        undefined,
    );
  }, [
    openCrud,
    processWorkbench,
    selectedProcess,
    selectedProcessId,
    workbenchProcessName,
  ]);

  const handleDeleteSelectedProcess = useCallback(() => {
    if (!selectedProcessId) return;
    openCrud("delete", "Process", workbenchProcessName, selectedProcessId);
  }, [openCrud, selectedProcessId, workbenchProcessName]);

  const handleDownloadProcess = useCallback(() => {
    if (!selectedProcessId) return;
    void downloadProcessPdf({
      processId: selectedProcessId,
      processName: workbenchProcessName,
      functionName: workbenchFunctionName,
      departmentName: workbenchDepartmentName,
      contributorName: processWorkbench?.latestContributor?.name ?? null,
      submittedByName:
        processWorkbench?.latestContributor?.submittedByName ?? null,
      lastUpdatedAt: processWorkbench?.lastUpdatedAt ?? null,
      completedConversationCount: completedProcessConversationCount,
    });
  }, [
    downloadProcessPdf,
    selectedProcessId,
    workbenchProcessName,
    workbenchFunctionName,
    workbenchDepartmentName,
    processWorkbench,
    completedProcessConversationCount,
  ]);

  // --- Mobile navigation columns ---
  // On desktop the hierarchy is the nested ProcessTreeNavigator. These single
  // columns are the mobile-only drill-down (functions → departments →
  // processes → detail), driven by `mobileLevel`; `detailPanel` is shared with
  // desktop. The `mobile` flag is always set when these are rendered (see the
  // `md:hidden` block below).

  const functionsColumn = (mobile?: boolean) => (
    <div className="flex h-full flex-col">
      <ColumnHeader
        title="Functions"
        count={functions?.length}
        onAdd={canEdit ? () => openCrud("create", "Function") : undefined}
        mobile={mobile}
      />
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className={cn("space-y-0.5 p-2", mobile && "space-y-2 p-3")}>
          {functions === undefined ? (
            <LoadingSpinner />
          ) : functions.length === 0 ? (
            <EmptyState
              icon={Building2}
              title="No functions yet"
              description="Organizational functions will appear here."
              actionLabel={canEdit ? "Add function" : undefined}
              onAction={
                canEdit ? () => openCrud("create", "Function") : undefined
              }
            />
          ) : (
            functions.map((fn) => (
              <ColumnItem
                key={fn._id}
                label={fn.name}
                selected={selectedFunctionId === fn._id}
                indicator="arrow"
                count={departmentCountByFunction.get(fn._id) ?? 0}
                status={fn.summaryStale ? "stale" : undefined}
                onClick={() =>
                  mobile
                    ? handlePreviewFunction(fn._id, fn.name)
                    : handleSelectFunction(fn._id, fn.name)
                }
                onNavigate={
                  mobile
                    ? () => handleSelectFunction(fn._id, fn.name)
                    : undefined
                }
                navigateLabel={`View departments in ${fn.name}`}
                onEdit={
                  canEdit && mobile
                    ? () => openCrud("edit", "Function", fn.name, fn._id)
                    : undefined
                }
                onDelete={
                  canEdit && mobile
                    ? () => openCrud("delete", "Function", fn.name, fn._id)
                    : undefined
                }
                mobile={mobile}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );

  const departmentsColumn = (mobile?: boolean) => (
    <div className="flex h-full flex-col">
      {mobile && selectedFunctionId && (
        <div className="shrink-0 border-b bg-background px-2 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMobileLevel(1)}
            className="min-h-10 gap-2 px-3 text-sm"
          >
            <ChevronLeft className="h-4 w-4" />
            Functions
          </Button>
        </div>
      )}
      <ColumnHeader
        title="Departments"
        count={departments?.length}
        onAdd={
          canEdit && selectedFunctionId
            ? () => openCrud("create", "Department")
            : undefined
        }
        mobile={mobile}
      />
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className={cn("space-y-0.5 p-2", mobile && "space-y-2 p-3")}>
          {!selectedFunctionId ? (
            <EmptyState
              icon={Layers}
              title="Select a function"
              description="Choose a function from the list to see its departments."
            />
          ) : departments === undefined ? (
            <LoadingSpinner />
          ) : departments.length === 0 ? (
            <EmptyState
              icon={Layers}
              title="No departments"
              description="This function has no departments defined yet."
              actionLabel={canEdit ? "Add department" : undefined}
              onAction={
                canEdit && selectedFunctionId
                  ? () => openCrud("create", "Department")
                  : undefined
              }
            />
          ) : (
            departments.map((dept) => (
              <ColumnItem
                key={dept._id}
                label={dept.name}
                selected={selectedDepartmentId === dept._id}
                indicator="arrow"
                count={processCountByDepartment.get(dept._id) ?? 0}
                status={dept.summaryStale ? "stale" : undefined}
                onClick={() =>
                  mobile
                    ? handlePreviewDepartment(dept._id, dept.name)
                    : handleSelectDepartment(dept._id, dept.name)
                }
                onNavigate={
                  mobile
                    ? () => handleSelectDepartment(dept._id, dept.name)
                    : undefined
                }
                navigateLabel={`View processes in ${dept.name}`}
                onEdit={
                  canEdit && mobile
                    ? () =>
                        openCrud(
                          "edit",
                          "Department",
                          dept.name,
                          dept._id,
                          dept.functionId,
                          dept.description,
                        )
                    : undefined
                }
                onDelete={
                  canEdit && mobile
                    ? () =>
                        openCrud("delete", "Department", dept.name, dept._id)
                    : undefined
                }
                mobile={mobile}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );

  const processesColumn = (mobile?: boolean) => (
    <div className="flex h-full flex-col">
      {mobile && selectedDepartmentId && (
        <div className="shrink-0 border-b bg-background px-2 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMobileLevel(2)}
            className="min-h-10 max-w-full gap-2 px-3 text-sm"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="truncate">
              {functionDisplayName || "Departments"}
            </span>
          </Button>
        </div>
      )}
      <ColumnHeader
        title="Processes"
        count={processes?.length}
        onAdd={
          canEdit && selectedDepartmentId
            ? () => openCrud("create", "Process")
            : undefined
        }
        mobile={mobile}
      />
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className={cn("space-y-0.5 p-2", mobile && "space-y-2 p-3")}>
          {!selectedDepartmentId ? (
            <EmptyState
              icon={Cog}
              title="Select a department"
              description="Choose a department to see its processes."
            />
          ) : processes === undefined ? (
            <LoadingSpinner />
          ) : processes.length === 0 ? (
            <EmptyState
              icon={Cog}
              title="No processes"
              description="No processes defined yet for this department."
              actionLabel={canEdit ? "Add process" : undefined}
              onAction={
                canEdit && selectedDepartmentId
                  ? () => openCrud("create", "Process")
                  : undefined
              }
            />
          ) : (
            processes.map((proc) => (
              <ColumnItem
                key={proc._id}
                label={proc.name}
                selected={selectedProcessId === proc._id}
                indicator="dot"
                status={
                  attentionProcessIdSet.has(proc._id)
                    ? "attention"
                    : // Read the projection, not the legacy field: a V2-only
                      // process still has knowledge even once `rollingSummary`
                      // stops being written.
                      proc.summaryOverview.format !== "none"
                      ? "knowledge"
                      : undefined
                }
                onClick={() =>
                  mobile
                    ? handlePreviewProcess(proc._id, proc.name)
                    : handleSelectProcess(proc._id, proc.name)
                }
                onNavigate={
                  mobile
                    ? () => handleSelectProcess(proc._id, proc.name)
                    : undefined
                }
                navigateLabel={`Open ${proc.name}`}
                onEdit={
                  canEdit && mobile
                    ? () =>
                        openCrud(
                          "edit",
                          "Process",
                          proc.name,
                          proc._id,
                          proc.departmentId,
                          proc.description,
                        )
                    : undefined
                }
                onDelete={
                  canEdit && mobile
                    ? () => openCrud("delete", "Process", proc.name, proc._id)
                    : undefined
                }
                mobile={mobile}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );

  const detailPanel = (mobile?: boolean) => (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      {mobile && selectedProcessId && (
        <div className="shrink-0 border-b bg-background px-2 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMobileLevel(3)}
            className="min-h-10 max-w-full gap-2 px-3 text-sm"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="truncate">
              {departmentDisplayName || "Processes"}
            </span>
          </Button>
        </div>
      )}
      {!selectedProcessId ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto scrollbar-hide">
          <ColumnHeader
            title={
              selectedDepartmentId
                ? departmentDisplayName || "Department Overview"
                : selectedFunctionId
                  ? functionDisplayName || "Function Overview"
                  : "Process Detail"
            }
            mobile={mobile}
            actions={
              canEdit && selectedDepartmentId ? (
                <OverviewActions
                  entityLabel={departmentDisplayName}
                  onEdit={() =>
                    selectedDepartmentId &&
                    openCrud(
                      "edit",
                      "Department",
                      departmentDisplayName,
                      selectedDepartmentId,
                      selectedDepartment?.functionId,
                      selectedDepartment?.description,
                    )
                  }
                  onDelete={() =>
                    selectedDepartmentId &&
                    openCrud(
                      "delete",
                      "Department",
                      departmentDisplayName,
                      selectedDepartmentId,
                    )
                  }
                />
              ) : canEdit && selectedFunctionId ? (
                <OverviewActions
                  entityLabel={functionDisplayName}
                  onEdit={() =>
                    selectedFunctionId &&
                    openCrud(
                      "edit",
                      "Function",
                      functionDisplayName,
                      selectedFunctionId,
                    )
                  }
                  onDelete={() =>
                    selectedFunctionId &&
                    openCrud(
                      "delete",
                      "Function",
                      functionDisplayName,
                      selectedFunctionId,
                    )
                  }
                />
              ) : undefined
            }
          />

          {/* Unified Department Overview */}
          {selectedDepartmentId && !selectedProcessId && (
            <HierarchyOverview
              entity={{ kind: "department", departmentId: selectedDepartmentId }}
              description={selectedDepartment?.description}
              childSummaries={departmentOverviewChildren}
              canRefresh={canEdit}
              onOpenProcess={handleOpenOverviewProcess}
            />
          )}

          {/* Unified Function Overview */}
          {selectedFunctionId && !selectedDepartmentId && (
            <HierarchyOverview
              entity={{ kind: "function", functionId: selectedFunctionId }}
              childSummaries={functionOverviewChildren}
              canRefresh={canEdit}
              onOpenDepartment={handleOpenOverviewDepartment}
            />
          )}

          {/* No selection at all */}
          {!selectedFunctionId && (
            <EmptyState
              icon={FileText}
              title="Select a function"
              description="Choose a function to start navigating the organization."
            />
          )}
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <ProcessHeader
            processName={workbenchProcessName}
            functionName={workbenchFunctionName}
            departmentName={workbenchDepartmentName}
            workbench={processWorkbench}
            canEdit={canEdit}
            functionHref={functionBreadcrumbHref}
            departmentHref={departmentBreadcrumbHref}
            onSelectFunction={() => {
              setSelectedDepartmentId(null);
              setSelectedProcessId(null);
              setMobileLevel(2);
            }}
            onSelectDepartment={() => {
              setSelectedProcessId(null);
              setMobileLevel(3);
            }}
            onCopyLink={handleCopyProcessLink}
            onJumpToLabeling={handleJumpToLabeling}
            onEditProcess={handleEditSelectedProcess}
            onMoveProcess={handleEditSelectedProcess}
            onDeleteProcess={handleDeleteSelectedProcess}
            onDownloadProcess={handleDownloadProcess}
            isDownloading={isDownloadingPdf}
            onStartInterview={() => handleOpenRecordingMode("agent")}
            onRecordVoice={() => handleOpenRecordingMode("voiceRecord")}
            onUploadAudio={() => handleOpenRecordingMode("audioUpload")}
          />

          {canEdit && selectedProcessId && (
            <RecordingModal
              open={recordingOpen}
              onOpenChange={setRecordingOpen}
              processId={selectedProcessId}
              processName={workbenchProcessName}
              functionName={workbenchFunctionName}
              departmentName={workbenchDepartmentName}
              departmentDescription={safeDepartmentDescription}
              processDescription={safeProcessDescription}
              mode={recordingMode}
            />
          )}

          <Tabs
            value={detailTab}
            onValueChange={(value) => {
              const nextTab = typeof value === "number" ? value : Number(value);
              const safeTab = Number.isFinite(nextTab) ? nextTab : 0;
              if (safeTab !== 2) setFlowNodeId(null);
              setDetailTab(safeTab);
            }}
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden gap-0"
          >
            <div className="shrink-0 overflow-x-auto overflow-y-hidden border-b px-2 sm:px-4">
              <TabsList
                variant="line"
                className="h-10 min-w-max justify-start"
                aria-label="Process workbench sections"
              >
                <TabsTrigger value={0} className="gap-1.5 px-2 text-xs">
                  <FileText className="h-3.5 w-3.5" />
                  Overview
                </TabsTrigger>
                <TabsTrigger value={1} className="gap-1.5 px-2 text-xs">
                  <Mic className="h-3.5 w-3.5" />
                  Conversations
                  {processConversations !== undefined && (
                    <span className="tabs-count-badge ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground">
                      {processConversations.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value={2} className="gap-1.5 px-2 text-xs">
                  <GitBranch className="h-3.5 w-3.5" />
                  Process Flow
                </TabsTrigger>
                <TabsTrigger value={3} className="gap-1.5 px-2 text-xs">
                  <BarChart3 className="h-3.5 w-3.5" />
                  Insights
                </TabsTrigger>
                <TabsTrigger value={4} className="gap-1.5 px-2 text-xs">
                  <Bot className="h-3.5 w-3.5" />
                  Automations
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Overview tab */}
            <TabsContent
              value={0}
              className="min-h-0 min-w-0 flex-1 overflow-y-auto"
            >
              <ProcessOverview
                processId={selectedProcessId!}
                canRefresh={canEdit}
                onOpenConversation={handleOpenOverviewConversation}
                onOpenFlow={() => handleOpenProcessFlow()}
                onOpenInsights={() => {
                  setFlowNodeId(null);
                  setDetailTab(3);
                }}
              />
            </TabsContent>

            {/* Conversations tab */}
            <TabsContent
              value={1}
              className="min-h-0 min-w-0 flex-1 overflow-y-auto md:overflow-hidden"
            >
              <ProcessConversationsTab
                key={selectedProcessId}
                processId={selectedProcessId!}
                canLabelSpeakers={canEdit}
                labelingJumpKey={labelingJumpKey}
                focusConversationId={conversationFocusId}
                focusConversationJumpKey={conversationFocusJumpKey}
              />
            </TabsContent>

            {/* Process Flow tab */}
            <TabsContent
              value={2}
              className="min-h-0 min-w-0 flex-1 overflow-y-auto md:overflow-hidden"
            >
              <ProcessFlowTab
                key={selectedProcessId}
                processId={selectedProcessId!}
                conversationCount={completedProcessConversationCount}
                flow={
                  processWorkbench === undefined
                    ? undefined
                    : (processWorkbench?.flow ?? null)
                }
                selectedNodeId={flowNodeId}
                onSelectedNodeChange={setFlowNodeId}
                onOpenConversation={handleOpenOverviewConversation}
                conversations={(processConversations ?? []).map(
                  (conversation) => ({
                    conversationId: conversation._id,
                    contributorName: conversation.contributorName,
                    creationTime: conversation._creationTime,
                    status: conversation.status,
                  }),
                )}
                onOpenInsights={() => {
                  setFlowNodeId(null);
                  setDetailTab(3);
                }}
              />
            </TabsContent>

            {/* Insights tab */}
            <TabsContent
              value={3}
              className="min-h-0 min-w-0 flex-1 overflow-y-auto scrollbar-hide"
            >
              <ProcessInsightsTab
                processId={selectedProcessId!}
                completedConversationCount={completedProcessConversationCount}
                canGenerate={canEdit}
                isActive={detailTab === 3}
                onOpenProcessFlow={handleOpenProcessFlow}
                onOpenAutomations={() => {
                  setFlowNodeId(null);
                  setDetailTab(4);
                }}
              />
            </TabsContent>

            {/* Automations tab */}
            <TabsContent
              value={4}
              className="min-h-0 min-w-0 flex-1 overflow-y-auto"
            >
              <ProcessAutomationsTab
                key={selectedProcessId}
                processId={selectedProcessId!}
                processName={workbenchProcessName}
                departmentName={workbenchDepartmentName}
                functionName={workbenchFunctionName}
                onOpenProcessFlow={handleOpenProcessFlow}
              />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  );

  const mobilePreviewTitle =
    mobilePreview?.type === "function"
      ? "Function Overview"
      : mobilePreview?.type === "department"
        ? "Department Overview"
        : "Process Overview";
  const mobilePreviewDescription =
    mobilePreview?.type === "function"
      ? "An at-a-glance view of the departments and work in this function."
      : mobilePreview?.type === "department"
        ? "An at-a-glance view of the processes inside this department."
        : "The current process brief synthesized from captured conversations.";
  const mobilePreviewNavigateLabel =
    mobilePreview?.type === "function"
      ? "View departments"
      : mobilePreview?.type === "department"
        ? "View processes"
        : "Open process details";
  const handleMobilePreviewNavigate = () => {
    if (!mobilePreview) return;

    if (mobilePreview.type === "function") {
      setSelectedFunctionId(mobilePreview.id);
      setSelectedFunctionName(mobilePreview.name);
      setMobileLevel(2);
    } else if (mobilePreview.type === "department") {
      setSelectedDepartmentId(mobilePreview.id);
      setSelectedDepartmentName(mobilePreview.name);
      setMobileLevel(3);
    } else {
      setSelectedProcessId(mobilePreview.id);
      setSelectedProcessName(mobilePreview.name);
      setMobileLevel(4);
    }

    setMobilePreview(null);
  };

  return (
    <TooltipProvider>
      <div className="h-full bg-background">
        <ProcessAppShell onSearch={() => setPaletteOpen(true)}>
          {/* Desktop: nested process tree + current workbench/detail surface */}
          <div className="hidden min-w-0 flex-1 overflow-hidden md:flex">
            <ProcessTreeNavigator
              tree={hierarchyTree}
              canEdit={canEdit}
              selectedFunctionId={selectedFunctionId}
              selectedDepartmentId={selectedDepartmentId}
              selectedProcessId={selectedProcessId}
              onSelectFunction={handleTreeSelectFunction}
              onSelectDepartment={handleTreeSelectDepartment}
              onSelectProcess={handleTreeSelectProcess}
              onCreateFunction={() => openCrud("create", "Function")}
              onCreateDepartment={handleTreeCreateDepartment}
              onCreateProcess={handleTreeCreateProcess}
              onEditFunction={handleTreeEditFunction}
              onDeleteFunction={handleTreeDeleteFunction}
              onEditDepartment={handleTreeEditDepartment}
              onDeleteDepartment={handleTreeDeleteDepartment}
              onEditProcess={handleTreeEditProcess}
              onDeleteProcess={handleTreeDeleteProcess}
            />
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {detailPanel()}
            </div>
          </div>

          {/* Mobile: stacked single column */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden md:hidden">
            {mobileLevel === 1 && functionsColumn(true)}
            {mobileLevel === 2 && departmentsColumn(true)}
            {mobileLevel === 3 && processesColumn(true)}
            {mobileLevel === 4 && detailPanel(true)}
          </div>
        </ProcessAppShell>

        <Sheet
          open={!!mobilePreview}
          onOpenChange={(open) => {
            if (!open) setMobilePreview(null);
          }}
        >
          <SheetContent
            side="bottom"
            className="max-h-[82dvh] gap-0 overflow-hidden rounded-t-2xl p-0"
          >
            <SheetHeader className="border-b p-5 pr-14">
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-org-accent-subtle text-org-accent">
                  {mobilePreview?.type === "function" ? (
                    <Building2 className="h-5 w-5" />
                  ) : mobilePreview?.type === "department" ? (
                    <Layers className="h-5 w-5" />
                  ) : (
                    <Cog className="h-5 w-5" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate text-base">
                    {mobilePreview?.name}
                  </SheetTitle>
                  <SheetDescription className="truncate text-xs">
                    {mobilePreviewTitle}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {mobilePreviewDescription}
                </p>
              </div>

              {mobilePreview?.type === "process" ? (
                <ProcessOverviewCompactPreview
                  processId={mobilePreview.id}
                />
              ) : mobilePreview?.type === "department" ? (
                <HierarchyOverviewCompactPreview
                  entity={{
                    kind: "department",
                    departmentId: mobilePreview.id,
                  }}
                />
              ) : mobilePreview?.type === "function" ? (
                <HierarchyOverviewCompactPreview
                  entity={{ kind: "function", functionId: mobilePreview.id }}
                />
              ) : null}
            </div>

            <SheetFooter className="border-t p-4">
              <Button
                variant="outline"
                size="lg"
                className="min-h-12 w-full justify-between rounded-xl"
                onClick={handleMobilePreviewNavigate}
              >
                {mobilePreviewNavigateLabel}
                <ChevronRight className="h-4 w-4" />
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>

        {/* CRUD Dialog */}
        {crudOpen && (
          <CrudDialog
            open={crudOpen}
            onOpenChange={setCrudOpen}
            mode={crudMode}
            entityType={crudEntity}
            currentName={crudTargetName}
            currentDescription={crudTargetDescription}
            currentLocationId={crudCurrentLocationId ?? undefined}
            locationOptions={
              crudMode === "edit" && crudEntity === "Department"
                ? departmentLocationOptions
                : crudMode === "edit" && crudEntity === "Process"
                  ? processLocationOptions
                  : undefined
            }
            locationLabel={
              crudEntity === "Department"
                ? "Function"
                : crudEntity === "Process"
                  ? "Department"
                  : undefined
            }
            deleteEligibility={
              crudMode === "delete" ? deleteEligibility : undefined
            }
            onCleanupChildren={
              crudMode === "delete" && crudEntity === "Process"
                ? handleOpenDeleteCleanup
                : undefined
            }
            onConfirm={handleCrudConfirm}
          />
        )}

        {/* ⌘K command palette — jump to any function/department/process */}
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          functions={functions ?? []}
          departments={allDepartments ?? []}
          processes={allProcesses ?? []}
          onJumpFunction={handleSelectFunction}
          onJumpDepartment={jumpToDepartment}
          onJumpProcess={jumpToProcess}
        />
      </div>
    </TooltipProvider>
  );
}
