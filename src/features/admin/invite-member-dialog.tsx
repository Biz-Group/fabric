"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE_OPTIONS = ["admin", "contributor", "viewer"] as const;
type Role = (typeof ROLE_OPTIONS)[number];

export function InviteMemberDialog({
  open,
  onOpenChange,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvited?: () => void;
}) {
  const invite = useAction(api.invitations.invite);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("contributor");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      toast.error("Enter a valid email address.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await invite({ email: trimmed, role });
      if (result.outcome === "alreadyMember") {
        toast.error(`${result.email} is already a member of this workspace.`);
        return;
      }
      if (result.outcome === "alreadyInvited") {
        toast.error(`An invitation is already pending for ${result.email}.`);
        return;
      }
      if (result.outcome === "failed") {
        toast.error(result.userMessage);
        return;
      }
      toast.success(`Invitation sent to ${trimmed}.`);
      setEmail("");
      setRole("contributor");
      onInvited?.();
      onOpenChange(false);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to send invitation.";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a member</DialogTitle>
          <DialogDescription>
            We&apos;ll email them a link to join this workspace. Fabric will
            apply the selected role when they accept.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Input
            type="email"
            placeholder="name@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSubmit();
            }}
            autoFocus
            disabled={submitting}
          />
          <div className="space-y-1.5">
            <label
              htmlFor="invite-member-role"
              className="text-xs font-medium text-muted-foreground"
            >
              Role
            </label>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as Role)}
              disabled={submitting}
            >
              <SelectTrigger id="invite-member-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option} className="capitalize">
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !email.trim()}>
            {submitting ? "Sending..." : "Send invite"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
