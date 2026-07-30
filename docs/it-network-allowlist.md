# IT network allowlist for Fabric

What a corporate firewall / web proxy has to permit for Fabric to work on an
employee's machine. Everything below is **outbound from the browser** — that is
the only traffic corporate IT can block. Fabric's own server-side calls (to
ElevenLabs, Azure AI Foundry, OpenRouter, the Clerk backend API) originate from
Convex's cloud, not from the user's network, so they are out of scope for an
allowlist. See [Not needed on the allowlist](#not-needed-on-the-allowlist).

Replace `bizfabric.ai` with the root domain actually deployed
(`NEXT_PUBLIC_ROOT_DOMAIN`) and `<deployment>` with the Convex deployment name
in `NEXT_PUBLIC_CONVEX_URL`.

## Required — the app will not load without these

| Domain | Protocol / port | Purpose |
| --- | --- | --- |
| `bizfabric.ai` | HTTPS 443 | Marketing/landing page (apex). |
| `*.bizfabric.ai` | HTTPS 443 | The workspace itself. Each tenant is a subdomain (e.g. `biz-group.bizfabric.ai`), and `tenants.bizfabric.ai` is the internal admin console. Wildcard is required — new tenants get new subdomains. |
| `<deployment>.convex.cloud` | **HTTPS 443 + WebSocket (WSS) 443** | Convex backend: all queries, mutations, and file uploads. The client holds a **long-lived WebSocket** for live updates — see [WebSocket note](#websockets-are-not-optional). `*.convex.cloud` is the safe wildcard. |
| `<deployment>.convex.site` | HTTPS 443 | Convex HTTP endpoints — recorded-conversation audio playback (`/audio/...`) and webhook intake. Same deployment, different domain; allowlisting only `.convex.cloud` breaks audio playback. |
| `clerk.bizfabric.ai` | HTTPS 443 | Clerk Frontend API — authentication. In production this is a CNAME on your own domain, so it is covered by `*.bizfabric.ai`; list it explicitly if the proxy filters by exact host. |
| `img.clerk.com` | HTTPS 443 | User and organization avatars. |
| `*.protect.clerk.com` | HTTPS 443 | Clerk bot/fraud protection. |
| `challenges.cloudflare.com` | HTTPS 443 | Cloudflare Turnstile challenge used by Clerk during sign-in/sign-up. Blocking it can hard-block login. |
| `*.clerk.accounts.dev` | HTTPS 443 | Only for non-production (dev/preview) Clerk instances. Not needed if staff only use production. |

## Required for voice capture (the core feature)

Fabric captures processes through a spoken conversation with an ElevenLabs
agent, over **WebRTC**. This is the part most likely to be broken by a
restrictive network, and it fails as "the orb connects then there's no audio"
rather than as an obvious block.

| Domain | Protocol / port | Purpose |
| --- | --- | --- |
| `api.elevenlabs.io` | HTTPS 443 | Mints the WebRTC conversation token that starts a session. |
| `livekit.rtc.elevenlabs.io` | **WSS 443** | WebRTC signalling (ElevenLabs runs LiveKit for transport). |
| `*.host.livekit.cloud` | **UDP 3478** (and UDP 443) | Preferred real-time audio media path. |
| `*.turn.livekit.cloud` | TCP 443 (TLS) | TURN relay fallback when UDP is blocked. Allow this if the network blocks all outbound UDP, otherwise voice sessions connect with no audio. |
| `storage.googleapis.com` | HTTPS 443 | ElevenLabs public CDN — the texture asset for the animated voice orb (`eleven-public-cdn`). Cosmetic only; blocking it degrades the recording UI, it does not break recording. |

Also required on the endpoint itself, not the firewall:

- **Microphone permission** for `https://*.bizfabric.ai` in the browser
  (Chrome/Edge policy `AudioCaptureAllowedUrls` if mic access is centrally
  managed).
- Outbound UDP for WebRTC, or the TURN fallback above.
- A modern Chromium or Safari browser; the voice UI uses WebRTC and WebGL.

## WebSockets are not optional

Fabric's UI is driven by Convex live subscriptions over a persistent WebSocket
to `*.convex.cloud`. Proxies that terminate TLS but do not support the
WebSocket upgrade, or that kill idle connections, produce a workspace that
loads and then never updates — no new steps appear, and a recording never
appears to finish. If the estate uses an inspecting proxy, either allow the
WebSocket upgrade for `*.convex.cloud` or add it to the TLS-inspection bypass
list.

## Not needed on the allowlist

These are called by Fabric's backend from Convex's infrastructure, not by the
employee's browser, so they do not belong in a corporate egress rule:

- `api.elevenlabs.io` transcript/audio/Scribe fetches (server-side; the
  browser-side use above is separate and is required)
- `*.services.ai.azure.com` — Azure AI Foundry, for summarisation and safety
  checks
- `openrouter.ai` — legacy AI provider, retained only for rollback
- `api.clerk.com` — Clerk backend API

Inbound webhooks (ElevenLabs → `<deployment>.convex.site`, Clerk →
`<deployment>.convex.site`) also terminate at Convex, never inside the
corporate network, so no inbound firewall rules are needed.

## Minimal copy-paste list for IT

```
# App
https://bizfabric.ai
https://*.bizfabric.ai

# Backend (HTTPS + WebSocket)
https://*.convex.cloud
wss://*.convex.cloud
https://*.convex.site

# Authentication
https://img.clerk.com
https://*.protect.clerk.com
https://challenges.cloudflare.com

# Voice capture
https://api.elevenlabs.io
wss://livekit.rtc.elevenlabs.io
udp://*.host.livekit.cloud:3478
https://*.turn.livekit.cloud        # TCP 443 TURN fallback
https://storage.googleapis.com      # cosmetic (orb texture)
```

## How to verify

1. Open `https://<tenant>.bizfabric.ai` — sign-in page renders (Clerk +
   Turnstile reachable).
2. Sign in and load a process — content appears and updates without a refresh
   (Convex WebSocket healthy).
3. Start a recording — the orb connects and the agent speaks back (ElevenLabs
   WebRTC + media path healthy).
4. Play back a finished conversation's audio — `convex.site` reachable.

If step 3 connects but is silent, UDP is being blocked and
`*.turn.livekit.cloud` on TCP/443 has not been allowed.

## Sources

- [Clerk CSP / required domains](https://clerk.com/docs/security/clerk-csp)
- [Clerk production deployment](https://clerk.com/docs/guides/development/deployment/production)
- [ElevenLabs WebRTC for Conversational AI](https://elevenlabs.io/blog/conversational-ai-webrtc)
- [ElevenLabs conversation token API](https://elevenlabs.io/docs/api-reference/conversations/get-webrtc-token)
- [LiveKit firewall configuration](https://docs.livekit.io/deploy/admin/firewall/)
- [LiveKit media connection / firewall troubleshooting](https://kb.livekit.io/articles/1724892785-establishing-media-connection-firewall-troubleshooting)
