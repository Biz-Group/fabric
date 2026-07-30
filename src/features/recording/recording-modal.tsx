"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { useConversation } from "@elevenlabs/react";
import type { Status } from "@elevenlabs/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { SpeakerLabelReview } from "@/features/recording/speaker-label-review";
import {
  Mic,
  MicOff,
  PhoneOff,
  AlertTriangle,
  Shield,
  Send,
  Keyboard,
  CheckCircle2,
  ChevronRight,
  RotateCcw,
  Upload,
} from "lucide-react";

// --- Types ---

type ModalStep =
  | "name"
  | "recording"
  | "speakerLabels"
  | "processing"
  | "review";
export type RecordingMode = "agent" | "voiceRecord" | "audioUpload";

/**
 * Who the recording is about. "self" is the default and the only option for
 * non-admins. "member" links a verified org member; "external" is free text for
 * interviewees who have no Fabric account.
 */
type SubjectMode = "self" | "member" | "external";

const SUBJECT_MODE_OPTIONS: { id: SubjectMode; label: string }[] = [
  { id: "self", label: "Myself" },
  { id: "member", label: "A team member" },
  { id: "external", label: "Someone else" },
];

/** Attribution sent to the server; empty for ordinary self-recordings. */
type AttributionArgs = {
  contributorName?: string;
  subjectUserId?: Id<"users">;
  consentAttested?: boolean;
};

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

// Mirrors MAX_CONTRIBUTOR_NAME_LENGTH in convex/lib/contributorAttribution.ts,
// which is the enforcing copy — this only stops the input growing past it.
const MAX_CONTRIBUTOR_NAME_LENGTH = 120;

/**
 * Whether a stored conversation is about the same person as the one about to be
 * recorded, used to decide which prior summaries to feed the agent.
 *
 * Prefers account identity over the display name. Matching on the name alone
 * splits "Jane Doe" / "jane doe" into different contributors, and — worse —
 * merges two members who happen to share a name, which would inject one
 * employee's prior summaries into the other's interview prompt. Rows written
 * before `subjectUserId` existed carry the subject in `userId`, so fall back to
 * that; the name is only consulted for subjects with no account at all.
 */
function isSameSubject(
  conversation: {
    contributorName: string;
    userId?: Id<"users"> | null;
    subjectUserId?: Id<"users"> | null;
    submittedByName?: string | null;
  },
  subjectUserId: Id<"users"> | null,
  subjectName: string,
): boolean {
  if (subjectUserId) {
    if (conversation.subjectUserId) {
      return conversation.subjectUserId === subjectUserId;
    }
    // Legacy row: no subjectUserId, so the submitting account is the subject.
    return (
      !conversation.submittedByName && conversation.userId === subjectUserId
    );
  }
  return (
    !conversation.subjectUserId &&
    conversation.contributorName.trim().toLowerCase() ===
      subjectName.trim().toLowerCase()
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function probeAudioDuration(file: File): Promise<number | undefined> {
  if (typeof window === "undefined") return undefined;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = url;
    const cleanup = () => URL.revokeObjectURL(url);
    audio.onloadedmetadata = () => {
      cleanup();
      const d = audio.duration;
      resolve(Number.isFinite(d) && d > 0 ? Math.round(d) : undefined);
    };
    audio.onerror = () => {
      cleanup();
      resolve(undefined);
    };
  });
}
type VoiceRecordState =
  | "idle"
  | "recording"
  | "stopped"
  | "uploading"
  | "processing"
  | "success"
  | "error";

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
  departmentDescription?: string;
  processDescription?: string;
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
  departmentDescription,
  processDescription,
  mode = "agent",
}: RecordingModalProps) {
  // Step state
  const [step, setStep] = useState<ModalStep>("name");

  // Name prompt state
  const user = useQuery(api.users.getMe);
  const membership = useQuery(api.users.getMyMembership);
  const userRole = membership?.role ?? "viewer";
  const isStoredAudio = mode === "voiceRecord" || mode === "audioUpload";

  // Only admins may attribute a recording to someone other than themselves —
  // the recording notice is consent from whoever is at the keyboard, so letting
  // any contributor file under a colleague's name would let them put words in
  // that colleague's mouth with nothing recording who actually submitted it.
  const canRecordForOthers = userRole === "admin";
  const accountName = user?.name ?? "";
  const accountUserId = membership?.userId ?? null;

  const [subjectMode, setSubjectMode] = useState<SubjectMode>("self");
  const [subjectMemberId, setSubjectMemberId] = useState<Id<"users"> | null>(
    null,
  );
  const [externalName, setExternalName] = useState("");
  const [consentAttested, setConsentAttested] = useState(false);

  const orgMembers = useQuery(
    api.users.listOrgMemberOptions,
    canRecordForOthers && open ? {} : "skip",
  );
  const selectedMember = useMemo(
    () => orgMembers?.find((m) => m.userId === subjectMemberId) ?? null,
    [orgMembers, subjectMemberId],
  );

  const isOnBehalf = subjectMode !== "self";
  // The person the recording is about: drives the agent's greeting, the
  // prior-interview lookup, and what is stored as contributorName.
  const contributorName =
    subjectMode === "member"
      ? (selectedMember?.name ?? "")
      : subjectMode === "external"
        ? externalName
        : accountName;
  const subjectUserId: Id<"users"> | null =
    subjectMode === "member"
      ? subjectMemberId
      : subjectMode === "self"
        ? accountUserId
        : null;
  const attributionReady =
    Boolean(contributorName.trim()) && (!isOnBehalf || consentAttested);

  // Locked in when the user leaves the name step. The attribution fields unmount
  // at that point, while the submit and onDisconnect handlers that need these
  // values run later — capturing here keeps them from drifting or going stale.
  const submittedAttributionRef = useRef<AttributionArgs>({});

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
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [uploadedFileSize, setUploadedFileSize] = useState<number | null>(null);
  const [voiceRecordError, setVoiceRecordError] = useState<string | null>(null);
  const [submittedVoiceConversationId, setSubmittedVoiceConversationId] =
    useState<Id<"conversations"> | null>(null);
  const [speakerLabelsSubmitted, setSpeakerLabelsSubmitted] = useState(false);
  const wasOpenRef = useRef(false);

  // Post-call state
  const [postCallResult, setPostCallResult] = useState<{
    status:
      | "done"
      | "failed"
      | "timeout"
      | "processing"
      | "needs_speaker_labels";
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
  const abandonVoiceRecording = useMutation(
    api.voiceRecordings.abandonVoiceRecording
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
  const submittedVoiceConversation = useMemo(
    () =>
      submittedVoiceConversationId && existingConversations
        ? existingConversations.find(
            (conversation) => conversation._id === submittedVoiceConversationId
          )
        : null,
    [existingConversations, submittedVoiceConversationId]
  );

  const resetModalState = useCallback(() => {
    setStep("name");
    setSubjectMode("self");
    setSubjectMemberId(null);
    setExternalName("");
    setConsentAttested(false);
    submittedAttributionRef.current = {};
    setMessages([]);
    setConversationId(null);
    conversationIdRef.current = null;
    setDisconnectError(null);
    setIsMuted(false);
    setTextMode(false);
    setTextInput("");
    setMicPermission("prompt");
    setPostCallResult(null);
    setVoiceRecordState("idle");
    setVoiceRecordSeconds(0);
    setRecordedBlob(null);
    setUploadedFileName(null);
    setUploadedFileSize(null);
    setVoiceRecordError(null);
    setSubmittedVoiceConversationId(null);
    setSpeakerLabelsSubmitted(false);
    audioChunksRef.current = [];
  }, []);

  const cleanupRecordingResources = useCallback(() => {
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
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
  }, []);

  // Reset state only for a closed -> open transition; clean up resources on close.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      resetModalState();
    }
    if (!open && wasOpenRef.current) {
      cleanupRecordingResources();
    }
    wasOpenRef.current = open;
  }, [cleanupRecordingResources, open, resetModalState]);

  // Cleanup mic stream on unmount
  useEffect(() => {
    return () => {
      cleanupRecordingResources();
    };
  }, [cleanupRecordingResources]);

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
            c.status === "done" &&
            c.summary &&
            isSameSubject(c, subjectUserId, contributorName)
        )
        .map((c) => c.summary)
        .join("\n\n") || "None.";

    // Calculate tenure from hire date. Profile-derived context describes the
    // account holder, so it only applies when they are the one being
    // interviewed — telling the agent the submitting consultant's tenure while
    // it interviews someone else would put wrong facts in the prompt. The
    // member picker carries a job title but no hire date, hence "Unknown".
    let tenure = "Unknown";
    if (!isOnBehalf && user?.hireDate) {
      const hireDate = new Date(user.hireDate);
      const now = new Date();
      const years = Math.floor(
        (now.getTime() - hireDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
      );
      tenure = years < 1 ? "Less than 1 year" : `${years} year${years === 1 ? "" : "s"}`;
    }
    const jobTitle = isOnBehalf
      ? selectedMember?.jobTitle || "Unknown"
      : user?.jobTitle || "Unknown";

    return {
      contributor_name: contributorName,
      job_title: jobTitle,
      years_in_role: tenure,
      function_name: functionName,
      department_name: departmentName,
      process_name: processName,
      department_description: departmentDescription || "None provided.",
      process_description: processDescription || "None provided.",
      existing_summary: existingSummary,
      prior_conversations: priorSummaries,
    };
  }, [
    selectedProcess,
    existingConversations,
    contributorName,
    subjectUserId,
    isOnBehalf,
    selectedMember,
    user,
    functionName,
    departmentName,
    processName,
    departmentDescription,
    processDescription,
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
          ...submittedAttributionRef.current,
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
    setUploadedFileName(null);
    setUploadedFileSize(null);
    setVoiceRecordSeconds(0);
    setVoiceRecordError(null);
    setSubmittedVoiceConversationId(null);
    setSpeakerLabelsSubmitted(false);
    setVoiceRecordState("idle");
  }, [stopVoiceRecording]);

  const handleAudioFileSelected = useCallback(
    async (file: File | null) => {
      if (!file) return;
      if (!file.type.startsWith("audio/")) {
        setVoiceRecordError("Please choose an audio file.");
        setVoiceRecordState("error");
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setVoiceRecordError("Audio files must be 100 MB or smaller.");
        setVoiceRecordState("error");
        return;
      }
      setVoiceRecordError(null);
      setRecordedBlob(file);
      setUploadedFileName(file.name);
      setUploadedFileSize(file.size);
      recordingMimeTypeRef.current = file.type || "audio/mpeg";
      const duration = await probeAudioDuration(file);
      if (duration) setVoiceRecordSeconds(duration);
      setVoiceRecordState("stopped");
    },
    [],
  );

  const submitVoiceRecording = useCallback(async () => {
    if (!recordedBlob) return;
    const mimeType =
      recordedBlob.type || recordingMimeTypeRef.current || "audio/webm";

    try {
      setVoiceRecordState("uploading");
      setStep("processing");
      setSpeakerLabelsSubmitted(false);

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
        source: mode === "audioUpload" ? "upload" : "record",
        ...submittedAttributionRef.current,
      });
      setPostCallResult({ status: result.status });
      setSubmittedVoiceConversationId(result.conversationId);
      setVoiceRecordState("processing");
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
    mode,
  ]);

  useEffect(() => {
    if (
      !isStoredAudio ||
      step !== "processing" ||
      !submittedVoiceConversationId ||
      !submittedVoiceConversation
    ) {
      return;
    }

    const nextState =
      submittedVoiceConversation.status === "needs_speaker_labels" &&
      !speakerLabelsSubmitted
        ? ("speakerLabels" as const)
        : submittedVoiceConversation.status === "done"
          ? ("done" as const)
          : submittedVoiceConversation.status === "failed"
            ? ("failed" as const)
            : null;
    if (!nextState) return;

    const timer = window.setTimeout(() => {
      if (nextState === "speakerLabels") {
        setPostCallResult({ status: "needs_speaker_labels" });
        setStep("speakerLabels");
      } else if (nextState === "done") {
        setPostCallResult({ status: "done" });
        setVoiceRecordState("success");
        setStep("review");
      } else {
        setPostCallResult({ status: "failed" });
        setVoiceRecordState("error");
        setStep("review");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    isStoredAudio,
    speakerLabelsSubmitted,
    step,
    submittedVoiceConversation,
    submittedVoiceConversationId,
  ]);

  // Handle name submission → acquire mic (if needed) → move to recording step
  const handleNameSubmit = useCallback(async () => {
    if (!attributionReady) return;

    // Freeze attribution before leaving the step that collects it. Self
    // recordings send nothing and the server derives attribution from the
    // account, exactly as before this flow existed.
    submittedAttributionRef.current = isOnBehalf
      ? {
          contributorName: contributorName.trim(),
          subjectUserId: subjectUserId ?? undefined,
          consentAttested: true,
        }
      : {};

    // Audio upload mode never needs the microphone; file picker handles capture
    if (mode === "audioUpload") {
      setMicPermission("granted");
      setStep("recording");
      return;
    }

    setMicPermission("checking");
    const result = await acquireMicStream();
    setMicPermission(result.status);

    if (result.status !== "granted") return;
    // Keep the stream alive — WebRTC / MediaRecorder needs it
    mediaStreamRef.current = result.stream;
    setStep("recording");
    if (mode === "voiceRecord") {
      startVoiceRecording();
    } else {
      startSession();
    }
  }, [
    attributionReady,
    contributorName,
    isOnBehalf,
    subjectUserId,
    mode,
    startSession,
    startVoiceRecording,
  ]);

  // If the user bails before approving speaker labels, drop the conversation
  // row + audio so we don't retain half-processed inputs. The server gates
  // on status, so this is a no-op for already-finalized rows.
  const handleClose = useCallback(() => {
    if (isConnected || isConnecting) {
      conversation.endSession();
    }
    stopVoiceRecording();
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (isStoredAudio && submittedVoiceConversationId && !speakerLabelsSubmitted) {
      void abandonVoiceRecording({
        conversationId: submittedVoiceConversationId,
      }).catch((err) => {
        console.error("Failed to clean up abandoned recording:", err);
      });
    }
    onOpenChange(false);
  }, [
    isConnected,
    isConnecting,
    conversation,
    stopVoiceRecording,
    onOpenChange,
    isStoredAudio,
    submittedVoiceConversationId,
    speakerLabelsSubmitted,
    abandonVoiceRecording,
  ]);

  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        handleClose();
      }
    },
    [handleClose]
  );

  // --- Render ---

  // Defense-in-depth: viewers should never reach this component
  if (userRole === "viewer") return null;

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        className={cn(
          "flex max-h-[calc(100dvh-1rem)] flex-col gap-0 overflow-hidden p-0",
          step === "recording" || step === "speakerLabels"
            ? "h-[min(90dvh,48rem)] sm:max-w-2xl"
            : "overflow-y-auto sm:max-w-md"
        )}
      >
        {/* Step 1: Name + Consent */}
        {step === "name" && (
          <div className="p-6">
            <DialogHeader>
              <DialogTitle>
                {mode === "audioUpload"
                  ? "Upload an Audio File"
                  : mode === "voiceRecord"
                    ? isOnBehalf
                      ? "Record a Voice Note"
                      : "Record Your Voice"
                    : "Record a Conversation"}
              </DialogTitle>
              <DialogDescription>
                {mode === "audioUpload"
                  ? "You're about to upload an audio recording about "
                  : mode === "voiceRecord"
                    ? isOnBehalf
                      ? "You're about to record them describing "
                      : "You're about to record yourself describing "
                    : "You're about to record a conversation about "}
                <span className="font-medium text-foreground">
                  {processName}
                </span>
                {isOnBehalf
                  ? ". Confirm who is being recorded and review the notices below to get started."
                  : ". Confirm your name and review the notices below to get started."}
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-4">
              {canRecordForOthers && (
                <div className="space-y-2">
                  <span className="text-sm font-medium">
                    Who is being recorded?
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {SUBJECT_MODE_OPTIONS.map((option) => (
                      <Button
                        key={option.id}
                        type="button"
                        size="sm"
                        variant={
                          subjectMode === option.id ? "default" : "outline"
                        }
                        className="rounded-full"
                        onClick={() => {
                          setSubjectMode(option.id);
                          // Consent is specific to the person named, so a change
                          // of subject must be attested again.
                          setConsentAttested(false);
                        }}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <label
                  htmlFor="contributor-name"
                  className="text-sm font-medium"
                >
                  {isOnBehalf ? "Person being recorded" : "Your Name"}
                </label>
                {subjectMode === "member" ? (
                  <Select
                    value={subjectMemberId ?? undefined}
                    onValueChange={(value) => {
                      setSubjectMemberId(value as Id<"users">);
                      setConsentAttested(false);
                    }}
                  >
                    <SelectTrigger id="contributor-name" className="w-full">
                      <SelectValue
                        placeholder={
                          orgMembers === undefined
                            ? "Loading team members…"
                            : "Select a team member"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {(orgMembers ?? [])
                        .filter((m) => m.userId !== accountUserId)
                        .map((member) => (
                          <SelectItem key={member.userId} value={member.userId}>
                            {member.jobTitle
                              ? `${member.name} — ${member.jobTitle}`
                              : member.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id="contributor-name"
                    value={subjectMode === "external" ? externalName : accountName}
                    readOnly={subjectMode === "self"}
                    maxLength={MAX_CONTRIBUTOR_NAME_LENGTH}
                    placeholder={
                      subjectMode === "external"
                        ? "Enter their full name"
                        : "Enter your name"
                    }
                    onChange={(e) => setExternalName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleNameSubmit();
                    }}
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  {subjectMode === "self"
                    ? "Taken from your Fabric profile."
                    : `This recording will be attributed to them, and recorded as submitted by ${accountName || "your account"}.`}
                </p>
              </div>

              {isOnBehalf && (
                <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm leading-relaxed">
                  <Checkbox
                    id="consent-attestation"
                    checked={consentAttested}
                    onCheckedChange={(checked) =>
                      setConsentAttested(checked === true)
                    }
                    aria-labelledby="consent-attestation-label"
                    className="mt-0.5"
                  />
                  {/* The text toggles too, for a usable hit area. It sits beside
                      the checkbox rather than wrapping it, so a click can never
                      reach both handlers and cancel itself out. */}
                  <span
                    id="consent-attestation-label"
                    className="cursor-pointer"
                    onClick={() => setConsentAttested((prev) => !prev)}
                  >
                    <span className="font-medium">Consent confirmation</span>
                    <span className="mt-1 block text-muted-foreground">
                      I confirm that{" "}
                      {contributorName.trim() || "this person"} was shown the
                      recording notice below and consented to being recorded,
                      transcribed, and analysed. This confirmation is stored
                      against your account.
                    </span>
                  </span>
                </div>
              )}

              <div className="rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed">
                <p className="flex items-center gap-1.5 font-medium">
                  <Shield className="h-4 w-4 text-primary" />
                  Recording notice
                </p>
                <p className="mt-1 text-muted-foreground">
                  {mode === "audioUpload"
                    ? "The uploaded audio will be transcribed and stored to help document our processes."
                    : mode === "voiceRecord"
                      ? "This recording will be transcribed and stored to help document our processes."
                      : "This conversation will be recorded, transcribed, and stored to help document our processes."}
                </p>
                {isOnBehalf && (
                  // The notice is only meaningful to the person whose voice is
                  // captured, and they are not the one reading this screen.
                  <p className="mt-2 text-muted-foreground">
                    Because you are recording on someone else&apos;s behalf, show
                    or read this notice to{" "}
                    {contributorName.trim() || "the person being recorded"}{" "}
                    {mode === "audioUpload"
                      ? "before uploading their audio."
                      : "before you start."}
                  </p>
                )}
              </div>
              <div className="rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed">
                <p className="font-medium">Content guidelines</p>
                <p className="mt-1 text-muted-foreground">
                  Please focus on how the process works — the steps, tools, and
                  handoffs involved. Avoid sharing sensitive information such
                  as specific salaries, personal situations, confidential
                  outcomes, or negative comments about individuals.
                </p>
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
                disabled={!attributionReady || micPermission === "checking"}
                className="gap-2"
              >
                {mode === "audioUpload" ? (
                  <Upload className="h-4 w-4" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
                {mode === "audioUpload"
                  ? "Choose Audio File"
                  : mode === "voiceRecord"
                    ? "Start Voice Record"
                    : "Start Recording"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 3A: Direct voice recording or audio file upload */}
        {step === "recording" && isStoredAudio && (
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
              {mode === "audioUpload" ? (
                <>
                  <div className="space-y-2">
                    <p className="text-sm font-medium">
                      {recordedBlob
                        ? "Audio file ready"
                        : "Choose an audio file"}
                    </p>
                    {voiceRecordSeconds > 0 && (
                      <p className="text-3xl font-semibold tabular-nums">
                        {formatRecordingDuration(voiceRecordSeconds)}
                      </p>
                    )}
                    <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                      Upload an existing audio recording (e.g. an interview,
                      meeting capture, or voice memo). Up to 100 MB. We&apos;ll
                      transcribe and analyze it the same way as a live
                      recording.
                    </p>
                  </div>

                  <label className="flex w-full max-w-sm cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-muted-foreground/30 bg-muted/20 p-6 text-sm transition-colors hover:bg-muted/40">
                    <Upload className="h-6 w-6 text-muted-foreground" />
                    {recordedBlob && uploadedFileName ? (
                      <div className="space-y-1">
                        <p className="font-medium">{uploadedFileName}</p>
                        {uploadedFileSize !== null && (
                          <p className="text-xs text-muted-foreground">
                            {formatFileSize(uploadedFileSize)}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          Click to choose a different file
                        </p>
                      </div>
                    ) : (
                      <p className="text-muted-foreground">
                        Click to select an audio file
                      </p>
                    )}
                    <input
                      type="file"
                      accept="audio/*"
                      className="sr-only"
                      onChange={(e) =>
                        handleAudioFileSelected(e.target.files?.[0] ?? null)
                      }
                      disabled={
                        voiceRecordState === "uploading" ||
                        voiceRecordState === "processing"
                      }
                    />
                  </label>
                </>
              ) : (
                <>
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
                      voiceRecordState === "recording"
                        ? "destructive"
                        : "default"
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
                </>
              )}

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
                    disabled={
                      voiceRecordState === "uploading" ||
                      voiceRecordState === "processing"
                    }
                  >
                    <Upload className="h-4 w-4" />
                    {mode === "audioUpload"
                      ? "Upload & Process"
                      : "Submit Recording"}
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
                        aria-label="Send message"
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
                          aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
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
                          aria-label={textMode ? "Hide text input" : "Show text input"}
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

        {/* Step 4: Speaker labels for diarized voice recordings */}
        {step === "speakerLabels" &&
          isStoredAudio &&
          submittedVoiceConversation && (
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
              <div className="flex-1 overflow-y-auto p-6">
                <SpeakerLabelReview
                  conversation={submittedVoiceConversation}
                  onSubmitted={() => {
                    setSpeakerLabelsSubmitted(true);
                    setPostCallResult({ status: "processing" });
                    setVoiceRecordState("processing");
                    setStep("processing");
                  }}
                />
              </div>
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
                mode === "audioUpload"
                  ? "Processing your upload..."
                  : mode === "voiceRecord"
                    ? "Processing your recording..."
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
                    {mode === "audioUpload"
                      ? "Audio Uploaded"
                      : mode === "voiceRecord"
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
                  ? mode === "audioUpload"
                    ? "Your audio file has been transcribed, analyzed, and saved to the process detail panel."
                    : mode === "voiceRecord"
                      ? "Your recording has been transcribed, analyzed, and saved to the process detail panel."
                      : "Your conversation has been saved and will appear in the process detail panel."
                  : postCallResult?.status === "timeout" ||
                      postCallResult?.status === "processing"
                    ? mode === "audioUpload"
                      ? "The upload is being transcribed and analyzed. It will appear automatically once ready."
                      : mode === "voiceRecord"
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
