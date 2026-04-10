"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectValue,
} from "@/components/ui/select";

type CrudMode = "create" | "edit" | "delete";

export interface LocationOption {
  value: string;
  label: string;
  group?: string;
}

interface CrudDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: CrudMode;
  entityType: string; // "Function" | "Department" | "Process"
  currentName?: string;
  currentLocationId?: string;
  locationOptions?: LocationOption[];
  locationLabel?: string;
  /** Number of children the target entity has. Used in delete mode to block deletion. undefined = still loading. */
  childCount?: number;
  onConfirm: (name: string, newLocationId?: string) => Promise<void>;
}

export function CrudDialog({
  open,
  onOpenChange,
  mode,
  entityType,
  currentName,
  currentLocationId,
  locationOptions,
  locationLabel,
  childCount,
  onConfirm,
}: CrudDialogProps) {
  const [name, setName] = useState("");
  const [selectedLocationId, setSelectedLocationId] = useState<
    string | undefined
  >(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(mode === "edit" ? currentName ?? "" : "");
      setSelectedLocationId(mode === "edit" ? currentLocationId : undefined);
      setError(null);
    }
  }, [open, mode, currentName, currentLocationId]);

  const handleSubmit = async () => {
    if (mode !== "delete" && !name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await onConfirm(name.trim(), selectedLocationId);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const showLocation =
    mode === "edit" && locationOptions && locationOptions.length > 0;

  const hasGroups = locationOptions?.some((opt) => opt.group);
  const groupedOptions = useMemo(() => {
    if (!hasGroups || !locationOptions) return [];
    const groups: Record<string, LocationOption[]> = {};
    for (const opt of locationOptions) {
      const group = opt.group ?? "Other";
      (groups[group] ??= []).push(opt);
    }
    return Object.entries(groups);
  }, [hasGroups, locationOptions]);

  // Build items map for SelectValue to display label instead of raw ID
  const itemsMap = useMemo(() => {
    if (!locationOptions) return undefined;
    const map: Record<string, string> = {};
    for (const opt of locationOptions) {
      map[opt.value] = opt.label;
    }
    return map;
  }, [locationOptions]);

  const title =
    mode === "create"
      ? `Add ${entityType}`
      : mode === "edit"
        ? `Edit ${entityType}`
        : `Delete ${entityType}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {mode === "delete" ? (
            <DialogDescription>
              {childCount !== undefined && childCount > 0 ? (
                <>
                  <strong>{currentName}</strong> cannot be deleted because it has{" "}
                  {childCount}{" "}
                  {entityType === "Function"
                    ? childCount === 1 ? "department" : "departments"
                    : entityType === "Department"
                      ? childCount === 1 ? "process" : "processes"
                      : childCount === 1 ? "conversation" : "conversations"}
                  . Remove all child items first.
                </>
              ) : (
                <>
                  Are you sure you want to delete <strong>{currentName}</strong>?
                  This action cannot be undone.
                </>
              )}
            </DialogDescription>
          ) : (
            <DialogDescription>
              {mode === "create"
                ? `Enter a name for the new ${entityType.toLowerCase()}.`
                : `Update the name${showLocation ? " or location" : ""} of this ${entityType.toLowerCase()}.`}
            </DialogDescription>
          )}
        </DialogHeader>

        {mode !== "delete" && (
          <div className="space-y-3 py-2">
            <div>
              <Input
                placeholder={`${entityType} name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubmit();
                }}
                autoFocus
              />
            </div>

            {showLocation && (
              <div>
                <p className="mb-1.5 text-sm font-medium text-foreground">
                  {locationLabel ?? "Location"}
                </p>
                <Select
                  value={selectedLocationId}
                  onValueChange={(val) => setSelectedLocationId(val as string)}
                  items={itemsMap}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={`Select ${(locationLabel ?? "location").toLowerCase()}`}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {hasGroups
                      ? groupedOptions.map(([groupName, items]) => (
                          <SelectGroup key={groupName}>
                            <SelectLabel>{groupName}</SelectLabel>
                            {items.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ))
                      : (locationOptions ?? []).map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            variant={mode === "delete" ? "destructive" : "default"}
            disabled={
              loading ||
              !!error ||
              (mode === "delete" && (childCount === undefined || childCount > 0)) ||
              (mode !== "delete" && !name.trim())
            }
            onClick={handleSubmit}
          >
            {loading
              ? "Saving..."
              : mode === "create"
                ? "Create"
                : mode === "edit"
                  ? "Save"
                  : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
