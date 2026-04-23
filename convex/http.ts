import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { getActiveOrgClaims } from "./lib/orgAuth";

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

// Audio proxy: streams MP3 audio from ElevenLabs without exposing the API key.
// Frontend calls GET /audio/{clerkOrgId}/{elevenlabsConversationId} — path is
// org-scoped so one tenant can never serve another tenant's audio. The
// `<audio>` element can't attach JWT headers, so authorization relies on the
// DB-existence check scoped by clerkOrgId. An attacker would need both a
// valid Clerk org id AND a valid ElevenLabs conversation id (both
// non-enumerable).
http.route({
  pathPrefix: "/audio/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    // Path is /audio/{clerkOrgId}/{elevenlabsConversationId}
    const suffix = url.pathname.replace(/^\/audio\//, "");
    const slashIdx = suffix.indexOf("/");
    if (slashIdx <= 0 || slashIdx === suffix.length - 1) {
      return new Response("Missing org or conversation ID", { status: 400 });
    }
    const clerkOrgId = suffix.substring(0, slashIdx);
    const elevenlabsConversationId = suffix.substring(slashIdx + 1);

    // If the caller has a session, require their active org to match the URL.
    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      const { orgId: tokenOrgId } = getActiveOrgClaims(identity);
      if (tokenOrgId && tokenOrgId !== clerkOrgId) {
        // Don't distinguish wrong-org from not-found — same 404 response.
        return new Response("Not found", { status: 404 });
      }
    }

    // Always verify the conversation exists in the given org. This is the
    // primary enforcement for unauthenticated <audio> element loads.
    const exists: boolean = await ctx.runQuery(
      internal.postCall.conversationExistsByElevenLabsId,
      { elevenlabsConversationId, clerkOrgId },
    );
    if (!exists) {
      return new Response("Not found", { status: 404 });
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return new Response("Server configuration error", { status: 500 });
    }

    const elevenLabsUrl = `https://api.elevenlabs.io/v1/convai/conversations/${elevenlabsConversationId}/audio`;

    const upstream = await fetch(elevenLabsUrl, {
      headers: { "xi-api-key": apiKey },
    });

    if (!upstream.ok) {
      return new Response("Audio not available", {
        status: upstream.status,
      });
    }

    // Buffer the full response — Convex HTTP actions don't support
    // streaming a ReadableStream body directly.
    const audioBytes = await upstream.arrayBuffer();
    const totalSize = audioBytes.byteLength;

    // Support Range requests so the browser can seek within the audio.
    const rangeHeader = req.headers.get("Range");
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
        const chunk = audioBytes.slice(start, end + 1);

        return new Response(chunk, {
          status: 206,
          headers: withCors(req, {
            "Content-Type": "audio/mpeg",
            "Content-Length": chunk.byteLength.toString(),
            "Content-Range": `bytes ${start}-${end}/${totalSize}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
          }),
        });
      }
    }

    return new Response(audioBytes, {
      status: 200,
      headers: withCors(req, {
        "Content-Type": "audio/mpeg",
        "Content-Length": totalSize.toString(),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
      }),
    });
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
