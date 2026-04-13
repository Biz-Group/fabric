"use client";

import { useState, useCallback, lazy, Suspense } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";
import {
  ChevronLeft,
  ChevronRight,
  Building2,
  Layers,
  Cog,
  FileText,
  Mic,
  Sparkles,
  Loader2,
  AlertCircle,
  Plus,
  Pencil,
  Trash2,
  Clock,
} from "lucide-react";
import { ConversationLog } from "@/components/conversation-log";
import { UserMenu } from "@/components/user-menu";
import { RecordingModal } from "@/components/recording-modal";
import { CrudDialog } from "@/components/crud-dialog";
import { MarkdownSummary } from "@/components/markdown-summary";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { GitBranch } from "lucide-react";

const ProcessFlow = lazy(() =>
  import("@/components/process-flow").then((m) => ({ default: m.ProcessFlow }))
);

// --- Types ---

type MobileLevel = 1 | 2 | 3 | 4;

// --- Column Item ---

function ColumnItem({
  label,
  selected,
  indicator,
  onClick,
  onEdit,
  onDelete,
}: {
  label: string;
  selected: boolean;
  indicator: "arrow" | "dot";
  onClick: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-all",
        selected
          ? "bg-primary text-primary-foreground shadow-sm ring-1 ring-primary/20"
          : "text-foreground hover:bg-accent hover:text-accent-foreground"
      )}
    >
      <span className="truncate">{label}</span>
      <span
        className={cn(
          "flex shrink-0 items-center gap-0.5 transition-opacity",
          selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        )}
      >
        {onEdit && (
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className={cn(
              "rounded p-0.5 transition-colors",
              selected
                ? "hover:bg-primary-foreground/20"
                : "hover:bg-foreground/10"
            )}
            title="Rename"
          >
            <Pencil className="h-3 w-3" />
          </span>
        )}
        {onDelete && (
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className={cn(
              "rounded p-0.5 transition-colors",
              selected
                ? "hover:bg-primary-foreground/20"
                : "hover:bg-foreground/10"
            )}
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </span>
        )}
        {indicator === "arrow" ? (
          <ChevronRight className="h-4 w-4" />
        ) : (
          <span className="inline-block h-2 w-2 rounded-full bg-current" />
        )}
      </span>
    </button>
  );
}

// --- Empty State ---

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="rounded-xl bg-muted/60 p-4">
        <Icon className="h-7 w-7 text-muted-foreground/70" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <p className="max-w-[200px] text-xs leading-relaxed text-muted-foreground/70">
          {description}
        </p>
      </div>
    </div>
  );
}

// --- Column Header ---

function ColumnHeader({
  title,
  count,
  onAdd,
}: {
  title: string;
  count?: number;
  onAdd?: () => void;
}) {
  return (
    <div className="shrink-0 border-b bg-muted/30 px-4 py-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        <div className="flex items-center gap-1 min-h-[1.625rem]">
          {count !== undefined && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {count}
            </span>
          )}
          {onAdd && (
            <button
              onClick={onAdd}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
              title={`Add ${title.slice(0, -1)}`}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Loading Spinner ---

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
    </div>
  );
}

// --- Time Ago Helper ---

function formatTimeAgo(epochMs: number): string {
  const seconds = Math.floor((Date.now() - epochMs) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// --- Main Component ---

export function MillerColumns() {
  // Current user role
  const currentUser = useQuery(api.users.getMe);
  const userRole = currentUser?.role ?? "viewer";
  const canEdit = userRole === "admin" || userRole === "contributor";

  // Selection state
  const [selectedFunctionId, setSelectedFunctionId] =
    useState<Id<"functions"> | null>(null);
  const [selectedDepartmentId, setSelectedDepartmentId] =
    useState<Id<"departments"> | null>(null);
  const [selectedProcessId, setSelectedProcessId] =
    useState<Id<"processes"> | null>(null);

  // Recording modal state
  const [recordingOpen, setRecordingOpen] = useState(false);

  // Mobile navigation level
  const [mobileLevel, setMobileLevel] = useState<MobileLevel>(1);

  // Selected names for breadcrumbs / back buttons
  const [selectedFunctionName, setSelectedFunctionName] = useState("");
  const [selectedDepartmentName, setSelectedDepartmentName] = useState("");
  const [selectedProcessName, setSelectedProcessName] = useState("");

  // On-demand summary state (loading/error only - summary now comes from reactive queries)
  const [deptSummaryLoading, setDeptSummaryLoading] = useState(false);
  const [deptSummaryError, setDeptSummaryError] = useState<string | null>(null);
  const [funcSummaryLoading, setFuncSummaryLoading] = useState(false);
  const [funcSummaryError, setFuncSummaryError] = useState<string | null>(null);

  // On-demand summary actions
  const generateDepartmentSummary = useAction(api.summaries.generateDepartmentSummary);
  const generateFunctionSummary = useAction(api.summaries.generateFunctionSummary);
  const forceRefreshProcessSummary = useAction(api.summaries.forceRefreshProcessSummary);
  const [processSummaryRefreshing, setProcessSummaryRefreshing] = useState(false);

  // CRUD mutations
  const createFunction = useMutation(api.functions.create);
  const updateFunction = useMutation(api.functions.update);
  const removeFunction = useMutation(api.functions.remove);
  const createDepartment = useMutation(api.departments.create);
  const updateDepartment = useMutation(api.departments.update);
  const removeDepartment = useMutation(api.departments.remove);
  const createProcess = useMutation(api.processes.create);
  const updateProcess = useMutation(api.processes.update);
  const removeProcess = useMutation(api.processes.remove);

  // CRUD dialog state
  const [crudOpen, setCrudOpen] = useState(false);
  const [crudMode, setCrudMode] = useState<"create" | "edit" | "delete">("create");
  const [crudEntity, setCrudEntity] = useState<"Function" | "Department" | "Process">("Function");
  const [crudTargetName, setCrudTargetName] = useState("");
  const [crudTargetId, setCrudTargetId] = useState<string | null>(null);
  const [crudCurrentLocationId, setCrudCurrentLocationId] = useState<string | null>(null);

  // Child-count queries for delete pre-check
  const deleteFnChildCount = useQuery(
    api.functions.childCount,
    crudMode === "delete" && crudEntity === "Function" && crudTargetId
      ? { functionId: crudTargetId as Id<"functions"> }
      : "skip"
  );
  const deleteDeptChildCount = useQuery(
    api.departments.childCount,
    crudMode === "delete" && crudEntity === "Department" && crudTargetId
      ? { departmentId: crudTargetId as Id<"departments"> }
      : "skip"
  );
  const deleteProcChildCount = useQuery(
    api.processes.childCount,
    crudMode === "delete" && crudEntity === "Process" && crudTargetId
      ? { processId: crudTargetId as Id<"processes"> }
      : "skip"
  );
  const deleteChildCount =
    crudEntity === "Function"
      ? deleteFnChildCount
      : crudEntity === "Department"
        ? deleteDeptChildCount
        : deleteProcChildCount;

  const openCrud = useCallback(
    (
      mode: "create" | "edit" | "delete",
      entity: "Function" | "Department" | "Process",
      targetName?: string,
      targetId?: string,
      currentLocationId?: string
    ) => {
      setCrudMode(mode);
      setCrudEntity(entity);
      setCrudTargetName(targetName ?? "");
      setCrudTargetId(targetId ?? null);
      setCrudCurrentLocationId(currentLocationId ?? null);
      setCrudOpen(true);
    },
    []
  );

  const handleCrudConfirm = useCallback(
    async (name: string, newLocationId?: string) => {
      if (crudEntity === "Function") {
        if (crudMode === "create") {
          await createFunction({ name });
        } else if (crudMode === "edit" && crudTargetId) {
          await updateFunction({ functionId: crudTargetId as Id<"functions">, name });
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
          await createDepartment({ functionId: selectedFunctionId, name });
        } else if (crudMode === "edit" && crudTargetId) {
          const newFunctionId = newLocationId as Id<"functions"> | undefined;
          await updateDepartment({
            departmentId: crudTargetId as Id<"departments">,
            name,
            functionId: newFunctionId,
          });
          if (newFunctionId && newFunctionId !== selectedFunctionId) {
            setSelectedDepartmentId(null);
            setSelectedProcessId(null);
          }
        } else if (crudMode === "delete" && crudTargetId) {
          await removeDepartment({ departmentId: crudTargetId as Id<"departments"> });
          if (selectedDepartmentId === crudTargetId) {
            setSelectedDepartmentId(null);
            setSelectedProcessId(null);
          }
        }
      } else if (crudEntity === "Process") {
        if (crudMode === "create" && selectedDepartmentId) {
          await createProcess({ departmentId: selectedDepartmentId, name });
        } else if (crudMode === "edit" && crudTargetId) {
          const newDepartmentId = newLocationId as Id<"departments"> | undefined;
          await updateProcess({
            processId: crudTargetId as Id<"processes">,
            name,
            departmentId: newDepartmentId,
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
    ]
  );

  // Convex queries
  const functions = useQuery(api.functions.list);
  const departments = useQuery(
    api.departments.listByFunction,
    selectedFunctionId ? { functionId: selectedFunctionId } : "skip"
  );
  const processes = useQuery(
    api.processes.listByDepartment,
    selectedDepartmentId ? { departmentId: selectedDepartmentId } : "skip"
  );
  const selectedProcess = useQuery(
    api.processes.get,
    selectedProcessId ? { processId: selectedProcessId } : "skip"
  );
  const selectedDepartment = useQuery(
    api.departments.get,
    selectedDepartmentId ? { departmentId: selectedDepartmentId } : "skip"
  );
  const selectedFunction = useQuery(
    api.functions.get,
    selectedFunctionId ? { functionId: selectedFunctionId } : "skip"
  );
  const allDepartments = useQuery(api.departments.listAll);
  const processConversations = useQuery(
    api.conversations.listByProcess,
    selectedProcessId ? { processId: selectedProcessId } : "skip"
  );

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
      setDeptSummaryError(null);
      setFuncSummaryError(null);
      setMobileLevel(2);
    },
    []
  );

  const handleSelectDepartment = useCallback(
    (id: Id<"departments">, name: string) => {
      setSelectedDepartmentId(id);
      setSelectedDepartmentName(name);
      setSelectedProcessId(null);
      setSelectedProcessName("");
      setDeptSummaryError(null);
      setMobileLevel(3);
    },
    []
  );

  const handleSelectProcess = useCallback(
    (id: Id<"processes">, name: string) => {
      setSelectedProcessId(id);
      setSelectedProcessName(name);
      setMobileLevel(4);
    },
    []
  );

  // --- Column renderers ---

  const functionsColumn = (mobile?: boolean) => (
    <div className="flex h-full flex-col">
      {mobile && (
        <div className="flex shrink-0 items-center justify-between border-b bg-background px-4 py-3">
          <h1 className="text-lg font-semibold tracking-tight">Fabric.</h1>
          <UserMenu />
        </div>
      )}
      <ColumnHeader
        title="Functions"
        count={functions?.length}
        onAdd={canEdit ? () => openCrud("create", "Function") : undefined}
      />
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className="space-y-0.5 p-2">
          {functions === undefined ? (
            <LoadingSpinner />
          ) : functions.length === 0 ? (
            <EmptyState
              icon={Building2}
              title="No functions yet"
              description="Organizational functions will appear here."
            />
          ) : (
            functions.map((fn) => (
              <ColumnItem
                key={fn._id}
                label={fn.name}
                selected={selectedFunctionId === fn._id}
                indicator="arrow"
                onClick={() => handleSelectFunction(fn._id, fn.name)}
                onEdit={canEdit ? () => openCrud("edit", "Function", fn.name, fn._id) : undefined}
                onDelete={canEdit ? () => openCrud("delete", "Function", fn.name, fn._id) : undefined}
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
        <div className="shrink-0 border-b bg-background">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMobileLevel(1)}
            className="m-1"
          >
            <ChevronLeft className="h-4 w-4" />
            Functions
          </Button>
        </div>
      )}
      <ColumnHeader
        title="Departments"
        count={departments?.length}
        onAdd={canEdit && selectedFunctionId ? () => openCrud("create", "Department") : undefined}
      />
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className="space-y-0.5 p-2">
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
            />
          ) : (
            departments.map((dept) => (
              <ColumnItem
                key={dept._id}
                label={dept.name}
                selected={selectedDepartmentId === dept._id}
                indicator="arrow"
                onClick={() => handleSelectDepartment(dept._id, dept.name)}
                onEdit={canEdit ? () => openCrud("edit", "Department", dept.name, dept._id, dept.functionId) : undefined}
                onDelete={canEdit ? () => openCrud("delete", "Department", dept.name, dept._id) : undefined}
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
        <div className="shrink-0 border-b bg-background">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMobileLevel(2)}
            className="m-1"
          >
            <ChevronLeft className="h-4 w-4" />
            {selectedFunctionName || "Departments"}
          </Button>
        </div>
      )}
      <ColumnHeader
        title="Processes"
        count={processes?.length}
        onAdd={canEdit && selectedDepartmentId ? () => openCrud("create", "Process") : undefined}
      />
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className="space-y-0.5 p-2">
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
            />
          ) : (
            processes.map((proc) => (
              <ColumnItem
                key={proc._id}
                label={proc.name}
                selected={selectedProcessId === proc._id}
                indicator="dot"
                onClick={() => handleSelectProcess(proc._id, proc.name)}
                onEdit={canEdit ? () => openCrud("edit", "Process", proc.name, proc._id, proc.departmentId) : undefined}
                onDelete={canEdit ? () => openCrud("delete", "Process", proc.name, proc._id) : undefined}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );

  const detailPanel = (mobile?: boolean) => (
    <div className="flex h-full flex-col">
      {mobile && selectedProcessId && (
        <div className="shrink-0 border-b bg-background">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMobileLevel(3)}
            className="m-1"
          >
            <ChevronLeft className="h-4 w-4" />
            {selectedDepartmentName || "Processes"}
          </Button>
        </div>
      )}
      {!selectedProcessId ? (
        <div className="flex flex-1 flex-col overflow-y-auto scrollbar-hide">
          <ColumnHeader title={selectedDepartmentId ? "Department Overview" : selectedFunctionId ? "Function Overview" : "Process Detail"} />

          {/* On-demand Department Summary */}
          {selectedDepartmentId && !selectedProcessId && (
            <div className="space-y-4 p-4 md:p-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Sparkles className="h-4 w-4 text-muted-foreground" />
                    Department Summary
                    {selectedDepartment?.summaryStale && selectedDepartment?.summary && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                        New data available
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription>
                    {selectedDepartment?.summary
                      ? `AI-synthesized overview of processes in ${selectedDepartmentName}.`
                      : `Generate an AI-synthesized overview of all processes in ${selectedDepartmentName}.`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {deptSummaryLoading && selectedDepartment?.summary && (
                    <div className="relative">
                      <div className="opacity-50">
                        <MarkdownSummary content={selectedDepartment.summary} />
                      </div>
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Loader2 className="h-6 w-6 animate-spin text-primary" />
                      </div>
                    </div>
                  )}
                  {!deptSummaryLoading && selectedDepartment?.summary && (
                    <MarkdownSummary content={selectedDepartment.summary} />
                  )}
                  {selectedDepartment?.summaryUpdatedAt && (
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
                      <Clock className="h-3 w-3" />
                      Last refreshed: {formatTimeAgo(selectedDepartment.summaryUpdatedAt)}
                    </div>
                  )}
                  {deptSummaryError && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
                      {deptSummaryError}
                    </div>
                  )}
                  <Button
                    variant={
                      !selectedDepartment?.summary
                        ? "default"
                        : selectedDepartment?.summaryStale
                          ? "default"
                          : "outline"
                    }
                    size="sm"
                    className="gap-2"
                    disabled={deptSummaryLoading}
                    onClick={async () => {
                      if (!selectedDepartmentId) return;
                      setDeptSummaryLoading(true);
                      setDeptSummaryError(null);
                      try {
                        const result = await generateDepartmentSummary({
                          departmentId: selectedDepartmentId,
                          forceRefresh: !!selectedDepartment?.summary && !selectedDepartment?.summaryStale,
                        });
                        if (!result.summary && result.message) {
                          setDeptSummaryError(result.message);
                        }
                      } catch {
                        setDeptSummaryError("Failed to generate summary. Please try again.");
                      } finally {
                        setDeptSummaryLoading(false);
                      }
                    }}
                  >
                    {deptSummaryLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Generating...
                      </>
                    ) : !selectedDepartment?.summary ? (
                      <>
                        <Sparkles className="h-4 w-4" />
                        Generate Summary
                      </>
                    ) : selectedDepartment?.summaryStale ? (
                      <>
                        <Sparkles className="h-4 w-4" />
                        Refresh Summary
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" />
                        Regenerate
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>
              <p className="text-center text-xs text-muted-foreground">
                Select a process from the list to view conversations and details.
              </p>
            </div>
          )}

          {/* On-demand Function Summary */}
          {selectedFunctionId && !selectedDepartmentId && (
            <div className="space-y-4 p-4 md:p-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Sparkles className="h-4 w-4 text-muted-foreground" />
                    Function Summary
                    {selectedFunction?.summaryStale && selectedFunction?.summary && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                        New data available
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription>
                    {selectedFunction?.summary
                      ? `AI-synthesized overview of departments across ${selectedFunctionName}.`
                      : `Generate an AI-synthesized overview of all departments across ${selectedFunctionName}.`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {funcSummaryLoading && selectedFunction?.summary && (
                    <div className="relative">
                      <div className="opacity-50">
                        <MarkdownSummary content={selectedFunction.summary} />
                      </div>
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Loader2 className="h-6 w-6 animate-spin text-primary" />
                      </div>
                    </div>
                  )}
                  {!funcSummaryLoading && selectedFunction?.summary && (
                    <MarkdownSummary content={selectedFunction.summary} />
                  )}
                  {selectedFunction?.summaryUpdatedAt && (
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
                      <Clock className="h-3 w-3" />
                      Last refreshed: {formatTimeAgo(selectedFunction.summaryUpdatedAt)}
                    </div>
                  )}
                  {funcSummaryError && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
                      {funcSummaryError}
                    </div>
                  )}
                  <Button
                    variant={
                      !selectedFunction?.summary
                        ? "default"
                        : selectedFunction?.summaryStale
                          ? "default"
                          : "outline"
                    }
                    size="sm"
                    className="gap-2"
                    disabled={funcSummaryLoading}
                    onClick={async () => {
                      if (!selectedFunctionId) return;
                      setFuncSummaryLoading(true);
                      setFuncSummaryError(null);
                      try {
                        const result = await generateFunctionSummary({
                          functionId: selectedFunctionId,
                          forceRefresh: !!selectedFunction?.summary && !selectedFunction?.summaryStale,
                        });
                        if (!result.summary && result.message) {
                          setFuncSummaryError(result.message);
                        }
                      } catch {
                        setFuncSummaryError("Failed to generate summary. Please try again.");
                      } finally {
                        setFuncSummaryLoading(false);
                      }
                    }}
                  >
                    {funcSummaryLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Generating...
                      </>
                    ) : !selectedFunction?.summary ? (
                      <>
                        <Sparkles className="h-4 w-4" />
                        Generate Summary
                      </>
                    ) : selectedFunction?.summaryStale ? (
                      <>
                        <Sparkles className="h-4 w-4" />
                        Refresh Summary
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" />
                        Regenerate
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>
              <p className="text-center text-xs text-muted-foreground">
                Select a department to drill down further.
              </p>
            </div>
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
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Breadcrumb bar */}
          <div className="shrink-0 border-b bg-muted/30 px-4 py-3">
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink
                    className="cursor-pointer text-xs"
                    onClick={() => {
                      setSelectedDepartmentId(null);
                      setSelectedProcessId(null);
                      setMobileLevel(2);
                    }}
                  >
                    {selectedFunctionName}
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbLink
                    className="cursor-pointer text-xs"
                    onClick={() => {
                      setSelectedProcessId(null);
                      setMobileLevel(3);
                    }}
                  >
                    {selectedDepartmentName}
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="text-xs">
                    {selectedProcessName}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>

          <Tabs defaultValue={0} className="flex flex-1 flex-col overflow-hidden gap-0">
            <div className="shrink-0 border-b px-4">
              <TabsList variant="line" className="h-9">
                <TabsTrigger value={0} className="gap-1.5 text-xs">
                  <Mic className="h-3.5 w-3.5" />
                  Conversations
                </TabsTrigger>
                <TabsTrigger value={1} className="gap-1.5 text-xs">
                  <GitBranch className="h-3.5 w-3.5" />
                  Process Flow
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Conversations tab */}
            <TabsContent value={0} className="flex-1 overflow-y-auto scrollbar-hide">
              <div className="space-y-6 p-4 md:p-6">
                {/* Record a Conversation — contributors and admins only */}
                {canEdit && (
                  <Button
                    size="lg"
                    className="w-full gap-2"
                    onClick={() => setRecordingOpen(true)}
                  >
                    <Mic className="h-4 w-4" />
                    Record a Conversation
                  </Button>
                )}

                {canEdit && selectedProcessId && (
                  <RecordingModal
                    open={recordingOpen}
                    onOpenChange={setRecordingOpen}
                    processId={selectedProcessId}
                    processName={selectedProcessName}
                    functionName={selectedFunctionName}
                    departmentName={selectedDepartmentName}
                  />
                )}

                {/* Process Summary Card */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      Process Summary
                    </CardTitle>
                    {!selectedProcess?.rollingSummary && (
                      <CardDescription>
                        No summary yet — record a conversation to get started.
                      </CardDescription>
                    )}
                  </CardHeader>
                  {selectedProcess?.rollingSummary && (
                    <CardContent className="space-y-3">
                      {processSummaryRefreshing ? (
                        <div className="relative">
                          <div className="opacity-50">
                            <MarkdownSummary content={selectedProcess.rollingSummary} />
                          </div>
                          <div className="absolute inset-0 flex items-center justify-center">
                            <Loader2 className="h-6 w-6 animate-spin text-primary" />
                          </div>
                        </div>
                      ) : (
                        <MarkdownSummary content={selectedProcess.rollingSummary} />
                      )}
                      {canEdit && selectedProcessId && (processConversations?.filter(c => c.status === "done").length ?? 0) > 1 && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-2"
                          disabled={processSummaryRefreshing}
                          onClick={async () => {
                            if (!selectedProcessId) return;
                            setProcessSummaryRefreshing(true);
                            try {
                              await forceRefreshProcessSummary({
                                processId: selectedProcessId,
                              });
                            } catch {
                              // Error is logged server-side
                            } finally {
                              setProcessSummaryRefreshing(false);
                            }
                          }}
                        >
                          {processSummaryRefreshing ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Rebuilding...
                            </>
                          ) : (
                            <>
                              <Sparkles className="h-4 w-4" />
                              Rebuild from all transcripts
                            </>
                          )}
                        </Button>
                      )}
                    </CardContent>
                  )}
                </Card>

                {/* Conversations section */}
                <ConversationLog processId={selectedProcessId!} />
              </div>
            </TabsContent>

            {/* Process Flow tab */}
            <TabsContent value={1} className="flex flex-1 overflow-hidden">
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                }
              >
                <ProcessFlow
                  processId={selectedProcessId!}
                  conversationCount={processConversations?.filter(c => c.status === "done").length ?? 0}
                />
              </Suspense>
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-background">
      {/* App header — desktop only (mobile shows header inside functions column) */}
      <header className="hidden shrink-0 items-center justify-between border-b bg-background px-6 py-3 md:flex">
        <h1 className="text-lg font-semibold tracking-tight">Fabric.</h1>
        <UserMenu />
      </header>

      {/* Desktop: 4 side-by-side columns */}
      <div className="hidden flex-1 overflow-hidden md:flex">
        <div className="flex w-[220px] shrink-0 flex-col border-r bg-muted/10">
          {functionsColumn()}
        </div>
        <div className="flex w-[220px] shrink-0 flex-col border-r bg-muted/10">
          {departmentsColumn()}
        </div>
        <div className="flex w-[220px] shrink-0 flex-col border-r bg-muted/10">
          {processesColumn()}
        </div>
        <div className="flex flex-1 flex-col">
          {detailPanel()}
        </div>
      </div>

      {/* Mobile: stacked single column */}
      <div className="flex flex-1 flex-col overflow-hidden md:hidden">
        {mobileLevel === 1 && functionsColumn(true)}
        {mobileLevel === 2 && departmentsColumn(true)}
        {mobileLevel === 3 && processesColumn(true)}
        {mobileLevel === 4 && detailPanel(true)}
      </div>

      {/* CRUD Dialog */}
      <CrudDialog
        open={crudOpen}
        onOpenChange={setCrudOpen}
        mode={crudMode}
        entityType={crudEntity}
        currentName={crudTargetName}
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
        childCount={crudMode === "delete" ? deleteChildCount : undefined}
        onConfirm={handleCrudConfirm}
      />
    </div>
  );
}
