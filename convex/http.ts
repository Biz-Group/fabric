import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { getActiveOrgClaims } from "./lib/orgAuth";
import type { Id } from "./_generated/dataModel";

const http = httpRouter();

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
          "Cache-Control": "public, max-age=3600",
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
      "Cache-Control": "public, max-age=3600",
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

    // If the caller has a session, require their active org to match the URL.
    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      const { orgId: tokenOrgId } = getActiveOrgClaims(identity);
      if (tokenOrgId && tokenOrgId !== clerkOrgId) {
        // Don't distinguish wrong-org from not-found — same 404 response.
        return new Response("Not found", { status: 404 });
      }
    }

    let source:
      | null
      | {
          inputMode: "agent";
          elevenlabsConversationId: string;
        }
      | {
          inputMode: "voiceRecord";
          audioStorageId: Id<"_storage">;
          audioMimeType: string;
        };
    try {
      source = await ctx.runQuery(internal.postCall.getConversationAudioSource, {
        conversationId,
        clerkOrgId,
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }

    if (!source) {
      return new Response("Not found", { status: 404 });
    }

    if (source.inputMode === "voiceRecord") {
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

    const elevenLabsUrl =
      `https://api.elevenlabs.io/v1/convai/conversations/${source.elevenlabsConversationId}/audio`;
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
