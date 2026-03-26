"use client";

import { useState, useCallback } from "react";
import { useQuery } from "convex/react";
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
} from "lucide-react";
import { ConversationLog } from "@/components/conversation-log";
import { UserMenu } from "@/components/user-menu";

// --- Types ---

type MobileLevel = 1 | 2 | 3 | 4;

// --- Column Item ---

function ColumnItem({
  label,
  selected,
  indicator,
  onClick,
}: {
  label: string;
  selected: boolean;
  indicator: "arrow" | "dot";
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-all",
        selected
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-foreground hover:bg-accent hover:text-accent-foreground"
      )}
    >
      <span className="truncate">{label}</span>
      <span
        className={cn(
          "shrink-0 transition-opacity",
          selected ? "opacity-100" : "opacity-0 group-hover:opacity-50"
        )}
      >
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

function ColumnHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="shrink-0 border-b bg-muted/30 px-4 py-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        {count !== undefined && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {count}
          </span>
        )}
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

// --- Main Component ---

export function MillerColumns() {
  // Selection state
  const [selectedFunctionId, setSelectedFunctionId] =
    useState<Id<"functions"> | null>(null);
  const [selectedDepartmentId, setSelectedDepartmentId] =
    useState<Id<"departments"> | null>(null);
  const [selectedProcessId, setSelectedProcessId] =
    useState<Id<"processes"> | null>(null);

  // Mobile navigation level
  const [mobileLevel, setMobileLevel] = useState<MobileLevel>(1);

  // Selected names for breadcrumbs / back buttons
  const [selectedFunctionName, setSelectedFunctionName] = useState("");
  const [selectedDepartmentName, setSelectedDepartmentName] = useState("");
  const [selectedProcessName, setSelectedProcessName] = useState("");

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

  // Selection handlers
  const handleSelectFunction = useCallback(
    (id: Id<"functions">, name: string) => {
      setSelectedFunctionId(id);
      setSelectedFunctionName(name);
      setSelectedDepartmentId(null);
      setSelectedDepartmentName("");
      setSelectedProcessId(null);
      setSelectedProcessName("");
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
      <ColumnHeader title="Functions" count={functions?.length} />
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
      <ColumnHeader title="Departments" count={departments?.length} />
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
      <ColumnHeader title="Processes" count={processes?.length} />
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
        <div className="flex flex-1 flex-col">
          <ColumnHeader title="Process Detail" />
          <EmptyState
            icon={FileText}
            title="Select a process"
            description="Choose a process to view its details, conversations, and summary."
          />
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

          <div className="flex-1 overflow-y-auto scrollbar-hide">
            <div className="space-y-6 p-4 md:p-6">
              {/* Record button placeholder (Phase 4/5) */}
              <Button size="lg" className="w-full gap-2" disabled>
                <Mic className="h-4 w-4" />
                Record a Conversation
              </Button>

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
                  <CardContent>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {selectedProcess.rollingSummary}
                    </p>
                  </CardContent>
                )}
              </Card>

              {/* Conversations section */}
              <ConversationLog processId={selectedProcessId!} />
            </div>
          </div>
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
    </div>
  );
}
