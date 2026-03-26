"use client";

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Id } from "../../convex/_generated/dataModel";

export function ProfileOnboarding() {
  const { user: clerkUser } = useUser();
  const completeProfile = useMutation(api.users.completeProfile);
  const functions = useQuery(api.functions.list);

  const clerkName = [clerkUser?.firstName, clerkUser?.lastName]
    .filter(Boolean)
    .join(" ") || "Anonymous";
  const [jobTitle, setJobTitle] = useState("");
  const [selectedFunctionId, setSelectedFunctionId] =
    useState<Id<"functions"> | "">("");
  const [selectedFunctionName, setSelectedFunctionName] = useState("");
  const [selectedDepartmentName, setSelectedDepartmentName] = useState("");
  const [hireDate, setHireDate] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const departments = useQuery(
    api.departments.listByFunction,
    selectedFunctionId ? { functionId: selectedFunctionId } : "skip",
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (
      !jobTitle.trim() ||
      !selectedFunctionName ||
      !selectedDepartmentName ||
      !hireDate
    ) {
      setError("All fields are required.");
      return;
    }

    setLoading(true);
    try {
      await completeProfile({
        name: clerkName,
        jobTitle: jobTitle.trim(),
        function: selectedFunctionName,
        department: selectedDepartmentName,
        hireDate,
      });
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold tracking-tight">
            Welcome to Fabric
          </CardTitle>
          <CardDescription>
            Complete your profile to get started. This helps us personalize your
            experience.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="name"
                className="text-sm font-medium leading-none"
              >
                Full Name
              </label>
              <Input
                id="name"
                type="text"
                value={clerkName}
                disabled
                className="disabled:opacity-70"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="jobTitle"
                className="text-sm font-medium leading-none"
              >
                Job Title
              </label>
              <Input
                id="jobTitle"
                type="text"
                placeholder="e.g., Payroll Manager"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="function"
                className="text-sm font-medium leading-none"
              >
                Function
              </label>
              <select
                id="function"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={selectedFunctionId}
                onChange={(e) => {
                  const id = e.target.value as Id<"functions"> | "";
                  setSelectedFunctionId(id);
                  setSelectedDepartmentName("");
                  const fn = functions?.find((f) => f._id === id);
                  setSelectedFunctionName(fn?.name ?? "");
                }}
                required
              >
                <option value="">Select a function...</option>
                {functions?.map((fn) => (
                  <option key={fn._id} value={fn._id}>
                    {fn.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="department"
                className="text-sm font-medium leading-none"
              >
                Department
              </label>
              <select
                id="department"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={selectedDepartmentName}
                onChange={(e) => setSelectedDepartmentName(e.target.value)}
                required
                disabled={!selectedFunctionId}
              >
                <option value="">
                  {selectedFunctionId
                    ? "Select a department..."
                    : "Select a function first"}
                </option>
                {departments?.map((dept) => (
                  <option key={dept._id} value={dept.name}>
                    {dept.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="hireDate"
                className="text-sm font-medium leading-none"
              >
                Hire Date
              </label>
              <Input
                id="hireDate"
                type="date"
                value={hireDate}
                onChange={(e) => setHireDate(e.target.value)}
                required
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Saving..." : "Complete Profile"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
