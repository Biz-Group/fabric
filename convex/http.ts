import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  buildElevenLabsConversationUrl,
  isElevenLabsConversationId,
} from "./lib/elevenLabsConversation";
import { verifyAudioPlaybackToken } from "./lib/audioPlaybackToken";

function base64ToBytes(value: string): ArrayBuffer | null {
  try {
    const decoded = atob(value);
    const buf = new ArrayBuffer(decoded.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < decoded.length; i++) {
      view[i] = decoded.charCodeAt(i);
    }
    return buf;
  } catch {
    return null;
  }
}

function clerkWebhookSecretBytes(secret: string): ArrayBuffer {
  if (!secret.startsWith("whsec_")) {
    return new TextEncoder().encode(secret).buffer;
  }
  const decoded = base64ToBytes(secret.slice("whsec_".length));
  if (!decoded) throw new Error("Invalid Clerk webhook secret");
  return decoded;
}

function clerkWebhookSignatures(header: string): ArrayBuffer[] {
  return header
    .split(" ")
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter((part) => part && part !== "v1")
    .map(base64ToBytes)
    .filter((bytes): bytes is ArrayBuffer => bytes !== null);
}

async function verifyClerkWebhook(
  req: Request,
  body: string,
): Promise<{ ok: boolean; eventId: string | null }> {
  const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (!secret) return { ok: false, eventId: null };

  const eventId = req.headers.get("svix-id");
  const timestamp = req.headers.get("svix-timestamp");
  const signature = req.headers.get("svix-signature");
  if (!eventId || !timestamp || !signature) {
    return { ok: false, eventId };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, eventId };
  const ageMs = Math.abs(Date.now() - ts * 1000);
  if (ageMs > 5 * 60 * 1000) return { ok: false, eventId };

  const key = await crypto.subtle.importKey(
    "raw",
    clerkWebhookSecretBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const payload = new TextEncoder().encode(`${eventId}.${timestamp}.${body}`);
  const signatures = clerkWebhookSignatures(signature);
  for (const sig of signatures) {
    if (await crypto.subtle.verify("HMAC", key, sig, payload)) {
      return { ok: true, eventId };
    }
  }
  return { ok: false, eventId };
}

const http = httpRouter();

http.route({
  path: "/clerk/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await req.text();
    const verification = await verifyClerkWebhook(req, body);
    if (!verification.ok || !verification.eventId) {
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: { type?: unknown; data?: unknown };
    try {
      payload = JSON.parse(body) as { type?: unknown; data?: unknown };
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (typeof payload.type !== "string") {
      return new Response("Missing event type", { status: 400 });
    }

    const result: { status: string; error?: string } = await ctx.runMutation(
      internal.users.handleClerkWebhook,
      {
        eventId: verification.eventId,
        eventType: payload.type,
        data: payload.data,
      },
    );
    if (result.status === "failed") {
      return new Response(result.error ?? "Webhook processing failed", {
        status: 500,
      });
    }
    return new Response("ok", { status: 200 });
  }),
});

// Multi-tenant CORS: the browser's Origin is always a specific subdomain
// (e.g. `https://biz-group.bizfabric.ai`), not the apex. A single static
// `CLIENT_ORIGIN` therefore can't cover every tenant. Reflect the request's
// Origin iff its hostname matches `ROOT_DOMAIN` or `*.ROOT_DOMAIN`, otherwise
// return null (browser blocks the cross-origin load).
//
// Env:
//   ROOT_DOMAIN    — apex host without scheme/port, e.g. "bizfabric.ai" or
//                    "lvh.me" (dev). Optional; if unset we fall back to
//                    CLIENT_ORIGIN.
//   CLIENT_ORIGIN  — legacy apex origin; used as a fallback when ROOT_DOMAIN
//                    isn't set (e.g. early dev). Defaults to "*" only when
//                    neither is set, which should never be true in prod.
function allowedOriginFor(origin: string | null): string | null {
  const root = process.env.ROOT_DOMAIN;
  if (origin && root) {
    try {
      const host = new URL(origin).hostname;
      if (host === root || host.endsWith(`.${root}`)) return origin;
      return null;
    } catch {
      return null;
    }
  }
  return process.env.CLIENT_ORIGIN ?? "*";
}

/** Adds ACAO + Vary:Origin to a header bag iff the request Origin is allowed. */
function withCors(
  req: Request,
  headers: Record<string, string>,
): Record<string, string> {
  const allow = allowedOriginFor(req.headers.get("Origin"));
  if (allow) {
    headers["Access-Control-Allow-Origin"] = allow;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function audioResponse(
  req: Request,
  audioBytes: ArrayBuffer,
  contentType: string,
) {
  const totalSize = audioBytes.byteLength;
  const rangeHeader = req.headers.get("Range");

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
      const boundedEnd = Math.min(end, totalSize - 1);
      const chunk = audioBytes.slice(start, boundedEnd + 1);

      return new Response(chunk, {
        status: 206,
        headers: withCors(req, {
          "Content-Type": contentType,
          "Content-Length": chunk.byteLength.toString(),
          "Content-Range": `bytes ${start}-${boundedEnd}/${totalSize}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
          "Referrer-Policy": "no-referrer",
        }),
      });
    }
  }

  return new Response(audioBytes, {
    status: 200,
    headers: withCors(req, {
      "Content-Type": contentType,
      "Content-Length": totalSize.toString(),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    }),
  });
}

// Audio endpoint: serves a Fabric conversation's replay audio. Agent
// conversations proxy ElevenLabs audio; direct voice recordings stream the
// file retained in Convex storage. Frontend calls:
// GET /audio/{clerkOrgId}/{conversationId}
http.route({
  pathPrefix: "/audio/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    // Path is /audio/{clerkOrgId}/{conversationId}
    const suffix = url.pathname.replace(/^\/audio\//, "");
    const slashIdx = suffix.indexOf("/");
    if (slashIdx <= 0 || slashIdx === suffix.length - 1) {
      return new Response("Missing org or conversation ID", { status: 400 });
    }
    const clerkOrgId = suffix.substring(0, slashIdx);
    const conversationId = suffix.substring(slashIdx + 1) as Id<"conversations">;

    // The browser plays audio via crossOrigin="anonymous", so a short-lived,
    // membership-bound signature carries authorization. The signed membership
    // is also rechecked below, making removal immediately revoke old URLs.
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig");
    const membershipIdParam = url.searchParams.get("mid");
    if (
      !sig ||
      !membershipIdParam ||
      !Number.isFinite(exp) ||
      exp < Date.now()
    ) {
      return new Response("Not found", { status: 404 });
    }
    const membershipId = membershipIdParam as Id<"memberships">;
    const signingSecret = process.env.AUDIO_SIGNING_SECRET;
    if (!signingSecret) {
      return new Response("Server configuration error", { status: 500 });
    }
    const sigOk = await verifyAudioPlaybackToken(
      signingSecret,
      {
        clerkOrgId,
        conversationId,
        membershipId,
        expiresAt: exp,
      },
      sig,
    );
    if (!sigOk) {
      return new Response("Not found", { status: 404 });
    }

    let source:
      | null
      | {
          inputMode: "agent";
          elevenlabsConversationId: string;
        }
      | {
          inputMode: "voiceRecord" | "audioUpload";
          audioStorageId: Id<"_storage">;
          audioMimeType: string;
        };
    try {
      source = await ctx.runQuery(internal.postCall.getConversationAudioSource, {
        conversationId,
        clerkOrgId,
        membershipId,
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }

    if (!source) {
      return new Response("Not found", { status: 404 });
    }

    if (source.inputMode !== "agent") {
      const blob = await ctx.storage.get(source.audioStorageId);
      if (!blob) return new Response("Audio not available", { status: 404 });
      const audioBytes = await blob.arrayBuffer();
      return audioResponse(
        req,
        audioBytes,
        source.audioMimeType || blob.type || "audio/webm",
      );
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return new Response("Server configuration error", { status: 500 });
    }

    if (!isElevenLabsConversationId(source.elevenlabsConversationId)) {
      return new Response("Audio not available", { status: 404 });
    }

    const elevenLabsUrl = buildElevenLabsConversationUrl(
      source.elevenlabsConversationId,
      "audio",
    );
    const upstream = await fetch(elevenLabsUrl, {
      headers: { "xi-api-key": apiKey },
    });
    if (!upstream.ok) {
      return new Response("Audio not available", { status: upstream.status });
    }

    const audioBytes = await upstream.arrayBuffer();
    return audioResponse(req, audioBytes, "audio/mpeg");
  }),
});

/**
 * Cross-deployment AI usage ingest (dev → prod).
 *
 * Authenticated with a shared bearer secret rather than a signature: both ends
 * are our own deployments, the payload is not user-supplied, and the secret
 * never leaves Convex env vars. The comparison is constant-time anyway, because
 * a length-or-prefix-leaking compare on a long-lived shared secret is a free
 * mistake to avoid.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  // Compare a fixed number of bytes regardless of input, so neither the length
  // nor the position of the first mismatch is observable from timing.
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

http.route({
  path: "/ai-usage/ingest",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.USAGE_SINK_SECRET?.trim();
    if (!secret) {
      // 503, NOT 404. An earlier version returned 404 here to avoid advertising
      // the endpoint — but Convex also returns 404 for an unmatched route, which
      // made "this deployment isn't configured as a sink" indistinguishable from
      // "your URL is wrong". Those need completely different fixes, so the status
      // has to tell them apart. Knowing the route exists buys an attacker
      // nothing: it is bearer-authenticated and names no secret.
      return new Response(
        "ai-usage ingest is not configured on this deployment: set USAGE_SINK_SECRET",
        { status: 503 },
      );
    }

    const authorization = req.headers.get("authorization") ?? "";
    const presented = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    if (!presented || !timingSafeStringEqual(presented, secret)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const events = (body as { events?: unknown })?.events;
    if (!Array.isArray(events)) {
      return new Response("Expected { events: [...] }", { status: 400 });
    }
    if (events.length > 500) {
      return new Response("Batch too large", { status: 413 });
    }

    const localDeployment =
      process.env.USAGE_DEPLOYMENT_LABEL === "dev" ? "dev" : "prod";

    try {
      // The rows are checked by `ingestBatch`'s own argument validator — a
      // malformed one rejects the whole batch, which the sender then retries.
      // `?dryRun=1` validates auth, routing and row shape without writing, so
      // this endpoint can be diagnosed without putting probe rows into a
      // production billing ledger.
      const dryRun = new URL(req.url).searchParams.get("dryRun") !== null;
      const result = await ctx.runMutation(internal.aiUsage.ingestBatch, {
        events,
        localDeployment,
        ...(dryRun ? { dryRun: true } : {}),
      });
      return Response.json(result);
    } catch (error) {
      console.error("AI usage ingest failed", {
        count: events.length,
        errorType: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : undefined,
      });
      return new Response("Invalid batch", { status: 400 });
    }
  }),
});

// CORS preflight for the audio endpoint
http.route({
  pathPrefix: "/audio/",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, req) => {
    return new Response(null, {
      status: 204,
      headers: withCors(req, {
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Range",
        "Access-Control-Max-Age": "86400",
      }),
    });
  }),
});

export default http;
