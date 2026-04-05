import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();

// Audio proxy: streams MP3 audio from ElevenLabs without exposing the API key.
// Frontend calls GET /audio/{elevenlabsConversationId} — we use pathPrefix
// routing and extract the ID from the URL path.
http.route({
  pathPrefix: "/audio/",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    const url = new URL(req.url);
    // Path is /audio/{id} — grab everything after "/audio/"
    const elevenlabsConversationId = url.pathname.replace(/^\/audio\//, "");

    if (!elevenlabsConversationId) {
      return new Response("Missing conversation ID", { status: 400 });
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

    return new Response(audioBytes, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": audioBytes.byteLength.toString(),
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }),
});

// CORS preflight for the audio endpoint
http.route({
  pathPrefix: "/audio/",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }),
});

export default http;
