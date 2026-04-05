"use client";

import { useState, useEffect } from "react";
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

type CrudMode = "create" | "edit" | "delete";

interface CrudDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: CrudMode;
  entityType: string; // "Function" | "Department" | "Process"
  currentName?: string;
  onConfirm: (name: string) => Promise<void>;
}

export function CrudDialog({
  open,
  onOpenChange,
  mode,
  entityType,
  currentName,
  onConfirm,
}: CrudDialogProps) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setName(mode === "edit" ? currentName ?? "" : "");
    }
  }, [open, mode, currentName]);

  const handleSubmit = async () => {
    if (mode !== "delete" && !name.trim()) return;
    setLoading(true);
    try {
      await onConfirm(name.trim());
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  const title =
    mode === "create"
      ? `Add ${entityType}`
      : mode === "edit"
        ? `Rename ${entityType}`
        : `Delete ${entityType}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {mode === "delete" ? (
            <DialogDescription>
              Are you sure you want to delete <strong>{currentName}</strong>? All
              child items will also be removed. This action cannot be undone.
            </DialogDescription>
          ) : (
            <DialogDescription>
              {mode === "create"
                ? `Enter a name for the new ${entityType.toLowerCase()}.`
                : `Update the name of this ${entityType.toLowerCase()}.`}
            </DialogDescription>
          )}
        </DialogHeader>

        {mode !== "delete" && (
          <div className="py-2">
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
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            variant={mode === "delete" ? "destructive" : "default"}
            disabled={loading || (mode !== "delete" && !name.trim())}
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
