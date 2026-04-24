"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { useConversation } from "@elevenlabs/react";
import type { Status } from "@elevenlabs/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ui/conversation";
import { Message, MessageContent } from "@/components/ui/message";
import { Orb } from "@/components/ui/orb";
import { ShimmeringText } from "@/components/ui/shimmering-text";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Mic,
  MicOff,
  PhoneOff,
  AlertTriangle,
  Shield,
  ArrowRight,
  Send,
  Keyboard,
  CheckCircle2,
  ChevronRight,
  RotateCcw,
  Upload,
} from "lucide-react";

// --- Types ---

type ModalStep = "name" | "consent" | "recording" | "processing" | "review";
export type RecordingMode = "agent" | "voiceRecord";
type VoiceRecordState = "idle" | "recording" | "stopped" | "uploading" | "success" | "error";

interface LiveMessage {
  id: number;
  source: "user" | "ai";
  content: string;
}

interface RecordingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  processId: Id<"processes">;
  processName: string;
  functionName: string;
  departmentName: string;
  mode?: RecordingMode;
}

// --- Mic Permission Check ---
// Returns the stream on success so it can be kept alive for WebRTC

async function acquireMicStream(): Promise<
  { status: "granted"; stream: MediaStream } | { status: "denied" | "unavailable"; stream: null }
> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    return { status: "unavailable", stream: null };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return { status: "granted", stream };
  } catch (err: unknown) {
    const error = err as DOMException;
    if (
      error.name === "NotAllowedError" ||
      error.name === "PermissionDeniedError"
    ) {
      return { status: "denied", stream: null };
    }
    return { status: "unavailable", stream: null };
  }
}

function getSupportedRecordingMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/mpeg",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function formatRecordingDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// --- Main Component ---

export function RecordingModal({
  open,
  onOpenChange,
  processId,
  processName,
  functionName,
  departmentName,
  mode = "agent",
}: RecordingModalProps) {
  // Step state
  const [step, setStep] = useState<ModalStep>("name");

  // Name prompt state
  const user = useQuery(api.users.getMe);
  const membership = useQuery(api.users.getMyMembership);
  const userRole = membership?.role ?? "viewer";

  const [contributorName, setContributorName] = useState("");
  const [nameInitialized, setNameInitialized] = useState(false);

  // Mic state — start as "prompt" (unchecked); only set to "checking" while acquiring
  const [micPermission, setMicPermission] = useState<
    "granted" | "denied" | "prompt" | "unavailable" | "checking"
  >("prompt");

  // Recording state
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const messageIdRef = useRef(0);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingStartedAtRef = useRef(0);
  const recordingMimeTypeRef = useRef("audio/webm");
  const [voiceRecordState, setVoiceRecordState] =
    useState<VoiceRecordState>("idle");
  const [voiceRecordSeconds, setVoiceRecordSeconds] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [voiceRecordError, setVoiceRecordError] = useState<string | null>(null);

  // Post-call state
  const [postCallResult, setPostCallResult] = useState<{
    status: "done" | "failed" | "timeout" | "processing";
    summary?: string;
    transcript?: { role: string; content: string; time_in_call_secs: number }[];
  } | null>(null);
  const fetchConversation = useAction(api.postCall.fetchConversation);
  const generateVoiceRecordingUploadUrl = useMutation(
    api.voiceRecordings.generateUploadUrl
  );
  const processVoiceRecording = useAction(
    api.voiceRecordings.processVoiceRecording
  );
  const conversationIdRef = useRef<string | null>(null);

  // Fetch process data for dynamic prompt context
  const selectedProcess = useQuery(
    api.processes.get,
    processId ? { processId } : "skip"
  );
  const existingConversations = useQuery(api.conversations.listByProcess, {
    processId,
  });

  // Pre-fill name from user profile
  useEffect(() => {
    if (user?.name && !nameInitialized) {
      setContributorName(user.name);
      setNameInitialized(true);
    }
  }, [user, nameInitialized]);

  // Reset state when modal opens; clean up mic stream when it closes
  useEffect(() => {
    if (open) {
      setStep("name");
      setMessages([]);
      setConversationId(null);
      conversationIdRef.current = null;
      setDisconnectError(null);
      setIsMuted(false);
      setTextMode(false);
      setTextInput("");
      setNameInitialized(false);
      setMicPermission("prompt");
      setPostCallResult(null);
      setVoiceRecordState("idle");
      setVoiceRecordSeconds(0);
      setRecordedBlob(null);
      setVoiceRecordError(null);
      audioChunksRef.current = [];
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        mediaRecorderRef.current.stop();
      }
      mediaRecorderRef.current = null;
      // Release mic stream when modal closes
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
    }
  }, [open]);

  // Cleanup mic stream on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        mediaRecorderRef.current.stop();
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
    };
  }, []);

  // Build dynamic variables for the ElevenLabs session.
  // These are injected into {{placeholder}} templates in the agent's
  // system prompt and first message on the ElevenLabs dashboard.
  const buildDynamicVariables = useCallback(() => {
    const existingSummary = selectedProcess?.rollingSummary || "None yet.";

    // Gather prior summaries from this contributor for this process
    const priorSummaries =
      existingConversations
        ?.filter(
          (c) =>
            c.contributorName === contributorName &&
            c.status === "done" &&
            c.summary
        )
        .map((c) => c.summary)
        .join("\n\n") || "None.";

    // Calculate tenure from hire date
    let tenure = "Unknown";
    if (user?.hireDate) {
      const hireDate = new Date(user.hireDate);
      const now = new Date();
      const years = Math.floor(
        (now.getTime() - hireDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
      );
      tenure = years < 1 ? "Less than 1 year" : `${years} year${years === 1 ? "" : "s"}`;
    }

    return {
      contributor_name: contributorName,
      job_title: user?.jobTitle || "Unknown",
      years_in_role: tenure,
      function_name: functionName,
      department_name: departmentName,
      process_name: processName,
      existing_summary: existingSummary,
      prior_conversations: priorSummaries,
    };
  }, [
    selectedProcess,
    existingConversations,
    contributorName,
    user,
    functionName,
    departmentName,
    processName,
  ]);

  // --- useConversation hook ---

  const conversation = useConversation({
    onConnect: ({ conversationId: id }) => {
      setConversationId(id);
      conversationIdRef.current = id;
    },
    onMessage: (payload) => {
      const newMsg: LiveMessage = {
        id: messageIdRef.current++,
        source: payload.source,
        content: payload.message,
      };
      setMessages((prev) => [...prev, newMsg]);
    },
    onDisconnect: (details) => {
      try {
        if (details?.reason === "error") {
          setDisconnectError(
            "Something went wrong with the connection. If your conversation was long enough, it may still have been captured — check back in a minute. Otherwise, try again."
          );
          return;
        }
      } catch {
        setDisconnectError("The connection was lost unexpectedly.");
        return;
      }
      // For "user" and "agent" disconnect — trigger post-call pipeline
      // conversationId is captured from onConnect; we read it via ref
      // to avoid stale closure issues
      const currentConvId = conversationIdRef.current;
      if (currentConvId) {
        setStep("processing");
        // Release mic stream since recording is over
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach((t) => t.stop());
          mediaStreamRef.current = null;
        }
        fetchConversation({
          elevenlabsConversationId: currentConvId,
          processId,
        })
          .then((result) => {
            setPostCallResult({ status: result.status });
            setStep("review");
          })
          .catch((err) => {
            console.error("fetchConversation failed:", err);
            setPostCallResult({ status: "failed" });
            setStep("review");
          });
      }
    },
    onError: (message, context) => {
      console.error("ElevenLabs error:", message, context);
      const errorMsg =
        typeof message === "string"
          ? message
          : "An unexpected error occurred.";
      setDisconnectError(errorMsg);
    },
    micMuted: isMuted,
  });

  const status: Status = conversation.status;
  const isConnected = status === "connected";
  const isConnecting = status === "connecting";
  const isDisconnected = status === "disconnected";

  // Start the ElevenLabs session
  const startSession = useCallback(async () => {
    const agentId = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;
    if (!agentId) {
      setDisconnectError("ElevenLabs Agent ID is not configured.");
      return;
    }

    try {
      await conversation.startSession({
        agentId,
        connectionType: "webrtc",
        userId: contributorName,
        dynamicVariables: buildDynamicVariables(),
      });
    } catch (err) {
      console.error("Failed to start session:", err);
      setDisconnectError(
        "Failed to start the conversation. Please check your microphone and try again."
      );
    }
  }, [conversation, contributorName, buildDynamicVariables]);

  // End the session
  const endSession = useCallback(async () => {
    try {
      await conversation.endSession();
    } catch (err) {
      console.error("Failed to end session:", err);
    }
  }, [conversation]);

  // Send text message
  const handleSendText = useCallback(() => {
    if (!textInput.trim() || !isConnected) return;
    conversation.sendUserMessage(textInput.trim());
    setTextInput("");
  }, [conversation, textInput, isConnected]);

  const clearVoiceTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startVoiceRecording = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (!stream) {
      setVoiceRecordError("Microphone stream is not available.");
      setVoiceRecordState("error");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setVoiceRecordError("Your browser does not support voice recording.");
      setVoiceRecordState("error");
      return;
    }

    try {
      const mimeType = getSupportedRecordingMimeType();
      recordingMimeTypeRef.current = mimeType || "audio/webm";
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      audioChunksRef.current = [];
      setRecordedBlob(null);
      setVoiceRecordError(null);
      setVoiceRecordSeconds(0);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        clearVoiceTimer();
        const blob = new Blob(audioChunksRef.current, {
          type: recordingMimeTypeRef.current,
        });
        setRecordedBlob(blob);
        setVoiceRecordState(blob.size > 0 ? "stopped" : "error");
        if (blob.size === 0) {
          setVoiceRecordError("No audio was captured. Please try again.");
        }
      };
      recorder.onerror = () => {
        clearVoiceTimer();
        setVoiceRecordState("error");
        setVoiceRecordError("Recording failed. Please try again.");
      };

      mediaRecorderRef.current = recorder;
      recordingStartedAtRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setVoiceRecordSeconds(
          Math.floor((Date.now() - recordingStartedAtRef.current) / 1000)
        );
      }, 500);
      recorder.start(1000);
      setVoiceRecordState("recording");
    } catch (err) {
      console.error("Failed to start voice recording:", err);
      setVoiceRecordState("error");
      setVoiceRecordError("Failed to start recording. Please try again.");
    }
  }, [clearVoiceTimer]);

  const stopVoiceRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      setVoiceRecordSeconds(
        Math.floor((Date.now() - recordingStartedAtRef.current) / 1000)
      );
      recorder.stop();
    }
    clearVoiceTimer();
  }, [clearVoiceTimer]);

  const discardVoiceRecording = useCallback(() => {
    stopVoiceRecording();
    audioChunksRef.current = [];
    setRecordedBlob(null);
    setVoiceRecordSeconds(0);
    setVoiceRecordError(null);
    setVoiceRecordState("idle");
  }, [stopVoiceRecording]);

  const submitVoiceRecording = useCallback(async () => {
    if (!recordedBlob) return;
    const mimeType =
      recordedBlob.type || recordingMimeTypeRef.current || "audio/webm";

    try {
      setVoiceRecordState("uploading");
      setStep("processing");

      const uploadUrl = await generateVoiceRecordingUploadUrl({ processId });
      const upload = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": mimeType },
        body: recordedBlob,
      });
      if (!upload.ok) {
        throw new Error(`Upload failed with status ${upload.status}`);
      }
      const { storageId } = (await upload.json()) as {
        storageId: Id<"_storage">;
      };

      const result = await processVoiceRecording({
        processId,
        storageId,
        durationSeconds: voiceRecordSeconds || undefined,
        mimeType,
      });
      setPostCallResult({ status: result.status });
      setVoiceRecordState("success");
      setStep("review");
    } catch (err) {
      console.error("Voice recording upload/processing failed:", err);
      setVoiceRecordError(
        "Something went wrong while uploading or processing the recording."
      );
      setPostCallResult({ status: "failed" });
      setVoiceRecordState("error");
      setStep("review");
    }
  }, [
    recordedBlob,
    generateVoiceRecordingUploadUrl,
    processId,
    processVoiceRecording,
    voiceRecordSeconds,
  ]);

  // Handle name submission → acquire mic → show consent
  const handleNameSubmit = useCallback(async () => {
    if (!contributorName.trim()) return;

    setMicPermission("checking");
    const result = await acquireMicStream();
    setMicPermission(result.status);

    if (result.status === "granted") {
      // Keep the stream alive — WebRTC needs it
      mediaStreamRef.current = result.stream;
      setStep("consent");
    }
    // If denied or unavailable, we show the error in the name step
  }, [contributorName]);

  // Handle consent acceptance → start recording
  const handleConsentAccept = useCallback(() => {
    setStep("recording");
    if (mode === "voiceRecord") {
      startVoiceRecording();
      return;
    }
    startSession();
  }, [mode, startSession, startVoiceRecording]);

  // Close handler — end session if active and release mic
  const handleClose = useCallback(() => {
    if (isConnected || isConnecting) {
      conversation.endSession();
    }
    stopVoiceRecording();
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    onOpenChange(false);
  }, [
    isConnected,
    isConnecting,
    conversation,
    stopVoiceRecording,
    onOpenChange,
  ]);

  // --- Render ---

  // Defense-in-depth: viewers should never reach this component
  if (userRole === "viewer") return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className={cn(
          "flex flex-col gap-0 p-0",
          step === "recording"
            ? "h-[90vh] max-h-[90vh] sm:max-w-2xl"
            : "sm:max-w-md"
        )}
      >
        {/* Step 1: Name Prompt */}
        {step === "name" && (
          <div className="p-6">
            <DialogHeader>
              <DialogTitle>
                {mode === "voiceRecord"
                  ? "Record Your Voice"
                  : "Record a Conversation"}
              </DialogTitle>
              <DialogDescription>
                {mode === "voiceRecord"
                  ? "You're about to record yourself describing "
                  : "You're about to record a conversation about "}
                <span className="font-medium text-foreground">
                  {processName}
                </span>
                . Confirm your name to get started.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-4">
              <div className="space-y-2">
                <label
                  htmlFor="contributor-name"
                  className="text-sm font-medium"
                >
                  Your Name
                </label>
                <Input
                  id="contributor-name"
                  value={contributorName}
                  onChange={(e) => setContributorName(e.target.value)}
                  placeholder="Enter your name"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleNameSubmit();
                  }}
                />
              </div>

              {/* Mic permission errors */}
              {micPermission === "denied" && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-medium">Microphone access denied</p>
                    <p className="mt-1 text-xs text-destructive/80">
                      Please enable microphone access in your browser settings
                      and try again.
                    </p>
                  </div>
                </div>
              )}
              {micPermission === "unavailable" && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-medium">Microphone unavailable</p>
                    <p className="mt-1 text-xs text-destructive/80">
                      Your browser doesn&apos;t support microphone access, or
                      the page isn&apos;t served over HTTPS.
                    </p>
                  </div>
                </div>
              )}
            </div>
            <DialogFooter className="mt-6">
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                onClick={handleNameSubmit}
                disabled={
                  !contributorName.trim() || micPermission === "checking"
                }
                className="gap-2"
              >
                Continue
                <ArrowRight className="h-4 w-4" />
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 2: Consent Banner */}
        {step === "consent" && (
          <div className="p-6">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5 text-primary" />
                Before we begin
              </DialogTitle>
            </DialogHeader>
            <div className="mt-4 space-y-4">
              <div className="rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed">
                <p className="font-medium">Recording notice</p>
                <p className="mt-1 text-muted-foreground">
                  {mode === "voiceRecord"
                    ? "Your recording will be transcribed and stored to help document our processes."
                    : "This conversation will be recorded, transcribed, and stored to help document our processes."}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed">
                <p className="font-medium">Content guidelines</p>
                <p className="mt-1 text-muted-foreground">
                  Please focus on how the process works — the steps, tools, and
                  handoffs involved. Avoid sharing sensitive information such as
                  specific salaries, personal situations, confidential outcomes,
                  or negative comments about individuals.
                </p>
              </div>
            </div>
            <DialogFooter className="mt-6">
              <Button variant="outline" onClick={() => setStep("name")}>
                Back
              </Button>
              <Button onClick={handleConsentAccept} className="gap-2">
                <Mic className="h-4 w-4" />
                {mode === "voiceRecord" ? "Start Voice Record" : "Start Recording"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 3A: Direct voice recording */}
        {step === "recording" && mode === "voiceRecord" && (
          <div className="flex h-full flex-col overflow-hidden">
            <div className="shrink-0 border-b px-4 py-3">
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbPage className="text-xs text-muted-foreground">
                      {functionName}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage className="text-xs text-muted-foreground">
                      {departmentName}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage className="text-xs font-medium">
                      {processName}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </div>

            <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {voiceRecordState === "recording"
                    ? "Recording your process notes"
                    : recordedBlob
                      ? "Recording ready"
                      : "Voice record mode"}
                </p>
                <p className="text-3xl font-semibold tabular-nums">
                  {formatRecordingDuration(voiceRecordSeconds)}
                </p>
                <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                  Speak naturally through the process steps, tools, handoffs,
                  exceptions, and anything that would help someone understand
                  how this work gets done.
                </p>
              </div>

              <Button
                variant={
                  voiceRecordState === "recording" ? "destructive" : "default"
                }
                size="lg"
                className="min-h-12 w-full max-w-sm gap-2 rounded-xl"
                onClick={() => {
                  if (voiceRecordState === "recording") {
                    stopVoiceRecording();
                  } else if (
                    voiceRecordState === "idle" ||
                    voiceRecordState === "error"
                  ) {
                    startVoiceRecording();
                  }
                }}
                disabled={
                  voiceRecordState === "uploading" ||
                  voiceRecordState === "stopped" ||
                  voiceRecordState === "success"
                }
              >
                {voiceRecordState === "recording" ? (
                  <>
                    <PhoneOff className="h-4 w-4" />
                    Stop Recording
                  </>
                ) : recordedBlob ? (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    Recording Captured
                  </>
                ) : (
                  <>
                    <Mic className="h-4 w-4" />
                    {voiceRecordState === "error"
                      ? "Try Again"
                      : "Start Recording"}
                  </>
                )}
              </Button>

              {voiceRecordError && (
                <div className="flex max-w-sm items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-left text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>{voiceRecordError}</p>
                </div>
              )}
            </div>

            <div className="shrink-0 border-t bg-background p-3">
              {recordedBlob ? (
                <div className="flex items-center justify-center gap-2">
                  <Button
                    variant="outline"
                    onClick={discardVoiceRecording}
                    className="gap-2 rounded-xl"
                    disabled={voiceRecordState === "uploading"}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Discard
                  </Button>
                  <Button
                    onClick={submitVoiceRecording}
                    className="gap-2 rounded-xl"
                    disabled={voiceRecordState === "uploading"}
                  >
                    <Upload className="h-4 w-4" />
                    Submit Recording
                  </Button>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2">
                  <Button variant="outline" onClick={handleClose}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Step 3B: AI interview recording */}
        {step === "recording" && mode === "agent" && (
          <div className="flex h-full flex-col overflow-hidden">
            {/* Breadcrumb header */}
            <div className="shrink-0 border-b px-4 py-3">
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbPage className="text-xs text-muted-foreground">
                      {functionName}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage className="text-xs text-muted-foreground">
                      {departmentName}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage className="text-xs font-medium">
                      {processName}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </div>

            {/* Error state */}
            {disconnectError && isDisconnected && (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
                <div className="rounded-full bg-destructive/10 p-4">
                  <AlertTriangle className="h-8 w-8 text-destructive" />
                </div>
                <div className="max-w-sm space-y-2">
                  <p className="text-sm font-medium">Connection Error</p>
                  <p className="text-sm text-muted-foreground">
                    {disconnectError}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={handleClose}>
                    Close
                  </Button>
                  <Button
                    onClick={() => {
                      setDisconnectError(null);
                      setMessages([]);
                      startSession();
                    }}
                  >
                    Try Again
                  </Button>
                </div>
              </div>
            )}

            {/* Connecting state */}
            {isConnecting && !disconnectError && (
              <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
                <div className="h-32 w-32">
                  <Orb
                    agentState="thinking"
                    colors={["#6366f1", "#8b5cf6"]}
                  />
                </div>
                <ShimmeringText
                  text="Connecting to Fabric..."
                  className="text-sm text-muted-foreground"
                />
              </div>
            )}

            {/* Active conversation */}
            {(isConnected ||
              (isDisconnected && !disconnectError && messages.length > 0)) && (
              <>
                {/* Orb */}
                <div className="flex shrink-0 items-center justify-center py-4">
                  <div className="h-24 w-24">
                    <Orb
                      agentState={
                        conversation.isSpeaking
                          ? "talking"
                          : isConnected
                            ? "listening"
                            : null
                      }
                      colors={["#6366f1", "#8b5cf6"]}
                      getInputVolume={conversation.getInputVolume}
                      getOutputVolume={conversation.getOutputVolume}
                    />
                  </div>
                </div>

                {/* Messages area */}
                <Conversation className="flex-1 border-t">
                  <ConversationContent className="space-y-1 p-4">
                    {messages.map((msg) => (
                      <Message
                        key={msg.id}
                        from={msg.source === "ai" ? "assistant" : "user"}
                      >
                        <MessageContent
                          variant={
                            msg.source === "ai" ? "flat" : "contained"
                          }
                        >
                          <p>{msg.content}</p>
                        </MessageContent>
                      </Message>
                    ))}
                  </ConversationContent>
                  <ConversationScrollButton />
                </Conversation>

                {/* Controls */}
                <div className="shrink-0 border-t bg-background p-3">
                  {/* Text input row */}
                  {textMode && isConnected && (
                    <div className="mb-3 flex items-center gap-2">
                      <Input
                        value={textInput}
                        onChange={(e) => setTextInput(e.target.value)}
                        placeholder="Type a message..."
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleSendText();
                          }
                        }}
                        className="flex-1"
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={handleSendText}
                        disabled={!textInput.trim()}
                      >
                        <Send className="h-4 w-4" />
                      </Button>
                    </div>
                  )}

                  {/* Button row */}
                  <div className="flex items-center justify-center gap-3">
                    {isConnected && (
                      <>
                        {/* Mute toggle */}
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => setIsMuted((prev) => !prev)}
                          className={cn(
                            "h-10 w-10 rounded-full",
                            isMuted && "bg-destructive/10 text-destructive"
                          )}
                        >
                          {isMuted ? (
                            <MicOff className="h-4 w-4" />
                          ) : (
                            <Mic className="h-4 w-4" />
                          )}
                        </Button>

                        {/* Keyboard toggle */}
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => setTextMode((prev) => !prev)}
                          className={cn(
                            "h-10 w-10 rounded-full",
                            textMode && "bg-primary/10 text-primary"
                          )}
                        >
                          <Keyboard className="h-4 w-4" />
                        </Button>

                        {/* End call */}
                        <Button
                          variant="destructive"
                          onClick={endSession}
                          className="gap-2 rounded-full px-6"
                        >
                          <PhoneOff className="h-4 w-4" />
                          End Call
                        </Button>
                      </>
                    )}

                    {/* Session ended without post-call pipeline (no conversationId) */}
                    {isDisconnected && !disconnectError && !conversationId && (
                      <Button onClick={handleClose} className="gap-2">
                        Done
                      </Button>
                    )}
                  </div>

                  {/* Status indicator */}
                  {isConnected && (
                    <div className="mt-2 flex items-center justify-center gap-1.5">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
                      <span className="text-xs text-muted-foreground">
                        {conversation.isSpeaking
                          ? "Fabric is speaking..."
                          : isMuted
                            ? "Microphone muted"
                            : "Listening..."}
                      </span>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Disconnected with no messages and no error (initial state or clean disconnect) */}
            {isDisconnected && !disconnectError && messages.length === 0 && (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
                <ShimmeringText
                  text="Starting conversation..."
                  className="text-sm text-muted-foreground"
                />
              </div>
            )}
          </div>
        )}

        {/* Step 4: Processing — post-call pipeline running */}
        {step === "processing" && (
          <div className="flex h-[50vh] flex-col items-center justify-center gap-6 p-8">
            <div className="h-32 w-32">
              <Orb
                agentState="thinking"
                colors={["#6366f1", "#8b5cf6"]}
              />
            </div>
            <ShimmeringText
              text={
                mode === "voiceRecord"
                  ? "Transcribing your recording..."
                  : "Processing your conversation..."
              }
              className="text-sm text-muted-foreground"
            />
            <p className="max-w-xs text-center text-xs text-muted-foreground/70">
              This may take up to a minute while we transcribe and analyze the
              recording.
            </p>
          </div>
        )}

        {/* Step 5: Review — post-call results */}
        {step === "review" && (
          <div className="p-6">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {postCallResult?.status === "done" ? (
                  <>
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                    {mode === "voiceRecord"
                      ? "Recording Submitted"
                      : "Conversation Recorded"}
                  </>
                ) : postCallResult?.status === "timeout" ||
                  postCallResult?.status === "processing" ? (
                  <>
                    <AlertTriangle className="h-5 w-5 text-amber-500" />
                    Still Processing
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-5 w-5 text-destructive" />
                    Processing Failed
                  </>
                )}
              </DialogTitle>
              <DialogDescription>
                {postCallResult?.status === "done"
                  ? mode === "voiceRecord"
                    ? "Your recording has been saved and will appear in the process detail panel after transcription finishes."
                    : "Your conversation has been saved and will appear in the process detail panel."
                  : postCallResult?.status === "timeout" ||
                      postCallResult?.status === "processing"
                    ? mode === "voiceRecord"
                      ? "The recording is being transcribed and analyzed. It will appear automatically once ready."
                      : "The conversation is still being processed. It will appear automatically once ready."
                    : "Something went wrong while processing the recording. Please try again."}
              </DialogDescription>
            </DialogHeader>

            {/* Show live transcript from the session as a review */}
            {messages.length > 0 && (
              <div className="mt-4">
                <Collapsible>
                  <CollapsibleTrigger className="group flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
                    <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[panel-open]:rotate-90" />
                    View Conversation ({messages.length} messages)
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-3 max-h-60 space-y-2 overflow-y-auto rounded-lg border bg-muted/20 p-3">
                      {messages.map((msg) => (
                        <div key={msg.id} className="text-sm leading-relaxed">
                          <span
                            className={cn(
                              "font-medium",
                              msg.source === "ai"
                                ? "text-primary"
                                : "text-foreground"
                            )}
                          >
                            {msg.source === "ai" ? "Fabric" : contributorName}
                          </span>
                          <span className="text-muted-foreground">
                            {" \u2014 "}
                            {msg.content}
                          </span>
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}

            <DialogFooter className="mt-6">
              <Button onClick={handleClose}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
