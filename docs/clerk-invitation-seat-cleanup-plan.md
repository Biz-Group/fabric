# Clerk Invitation Seat Cleanup Plan

Status: Ready to execute
Created: 2026-08-10
Trigger: `POST /organizations/org_.../invitations` returned 403
`organization_membership_quota_exceeded` — *"You have reached your limit of 20
organization memberships, including outstanding invitations."*
Executor: Claude (Opus). Work through phases in order; each phase has a gate.
Related: `docs/tenancy-architecture-decision.md` (not yet written — the
larger "should we keep Clerk organizations at all" question). **This plan is
independent of that decision and worth doing either way.**

## Context: what the 20 actually is

Three separate Clerk limits, commonly conflated:

| Limit | Value (Free & Pro) | Kind |
| --- | --- | --- |
| Monthly Retained Users (MRU) | 50,000 | Billing meter, app-wide |
| Monthly Retained Organizations (MRO) | 100 | Billing meter |
| **Members per organization** | **20** | **Feature gate, not a meter** |

The member cap does **not** scale with plan tier — Free and Pro are both 20.
Only the **B2B Authentication add-on** (~$100/mo, ~$85/mo annual, and it
requires a paid base plan) removes it. Since each Fabric tenant is one Clerk
org, the binding constraint is *20 people per client workspace*, and pending
invitations count against it.

The per-org membership limit is also a dashboard setting whose **default is 5**,
with 20 as the plan ceiling. Orgs provisioned before anyone raised the global
default may fail at 5, which reads like the same problem but is just an unset
setting. Check the global default in the Clerk dashboard before diagnosing.

## Phase 0 findings (recorded 2026-08-10)

Read as a dated record. Two of these corrected an earlier reading of the code.

1. **The Convex side is already correct.** `handleClerkWebhook` *does* handle
   `organizationMembership.created` (`convex/users.ts:1285`), and
   `upsertUserAndMembership` already patches the matching `membershipIntents`
   row to `status: "accepted"` and decrements the pending-invite stat
   (`convex/users.ts:463-472`). An earlier pass through only the first ~55
   lines of the webhook handler concluded it handled `user.*` events only —
   that was wrong.

2. **The leak is exactly one missing step: nothing revokes the Clerk-side
   invitation object.** Open subdomain enrollment calls
   `createOrganizationMembership` directly
   (`src/app/api/join-subdomain-organization/route.ts:222`). Clerk does **not**
   mark an existing invitation accepted when membership is created by that
   path — the app's own comment says so at `convex/invitations.ts:189-191`. So
   an invited user who joins via the subdomain consumes **two** of the 20
   slots: their membership *and* an invitation that stays `pending` forever.

3. **The admin UI hides the evidence.** `invitations.list` filters out pending
   invitations whose email already holds a membership
   (`convex/invitations.ts:206-208`). The seat is consumed and the only object
   an admin could revoke to free it is invisible to them.

4. **The platform console does not filter.** `tenants.listTenantInvitations`
   returns all pending rows (`convex/tenants.ts:837-841`), so a super-admin can
   already see and revoke ghosts from `/tenants-console/[tenantId]`. That is
   the manual escape hatch; Phase 1 replaces it with something idempotent.

5. **Structural consumption is significant.** `fanOutSuperAdminMemberships`
   places every super-admin in every tenant org, and
   `PLATFORM_STAFF_EMAIL_DOMAINS` (default `bizgroup.ae`) auto-joins any staff
   address on first visit
   (`src/app/api/join-subdomain-organization/route.ts:9-14`). With 6 staff,
   every client workspace starts at 6/20 before a single client user.

6. **Clerk's other B2B add-on features are already hand-rolled or unused.**
   All Clerk memberships are `org:member` (`convex/invitations.ts:138`,
   `route.ts:225`) because Fabric owns roles; domain gating is implemented in
   the join route rather than via Clerk verified domains; org-level SSO is
   unused. The add-on would be bought for the member cap alone.

---

## Phase 1 — Build the sweep (this also performs the initial reclaim)

New internal action in `convex/invitations.ts`:

```ts
sweepFulfilledInvitations({ clerkOrgId?: string })  // internalAction
```

Behaviour:

- Resolve target orgs: the one passed, else every non-`deleted` row in
  `tenants`.
- Per org, `GET /organizations/:id/invitations?status=pending&limit=100`.
  **Paginate** — do not assume ≤100. The existing call sites cap at 100 and
  that assumption is already thin for a busy tenant.
- Reuse `internal.invitations.getMemberEmailsAmong`
  (`convex/invitations.ts:93-108`) to determine which of those emails already
  hold a membership. Match on `emailLower` — trim and lowercase both sides, as
  that helper already expects.
- `POST /organizations/:id/invitations/:invId/revoke` for the intersection.
  Clerk requires `requesting_user_id` in the body; use the org's first admin
  membership, or a designated platform Clerk user id from a new env var.
- Tolerate 404 / already-revoked as success, mirroring the
  `already_a_member_in_organization` handling at
  `src/app/api/join-subdomain-organization/route.ts:20-28`.
- Return `{ orgId, scanned, revoked, errors[] }` per org so a run is auditable
  from `npx convex logs`.

### Hazard — do NOT reuse `markInvitationRevoked`

`convex/users.ts:1150-1153` patches the intent to `status: "revoked"`
**unconditionally**. The intents this sweep touches are already correctly
`accepted`. Flipping them to `revoked` would corrupt accept history and
mis-drive `patchStatsIfPresent`. Write an `authAuditEvents` row instead:

```ts
{ clerkOrgId, targetEmailLower, action: "inviteRevoked",
  detail: "fulfilled by direct join" }
```

### Reclaim seats

```
npx convex run invitations:sweepFulfilledInvitations
```

Preferred over clicking through the console: idempotent, covers every tenant in
one pass, logs what it did, and it is the same code that then runs on a
schedule.

**Gate:** a second consecutive run reports `revoked: 0` and `errors: []` for
every org.

---

## Phase 2 — Stop the leak at the source

In `upsertUserAndMembership`, inside the new-membership branch where
`matchedIntent` is patched to `accepted` (`convex/users.ts:463`):

```ts
if (matchedIntent?.clerkInvitationId) {
  await ctx.scheduler.runAfter(0, internal.invitations.revokeFulfilledInvitation, {
    clerkOrgId: orgId,
    clerkInvitationId: matchedIntent.clerkInvitationId,
  });
}
```

Scheduled, not inline: this is a mutation and cannot `fetch`. The new
`revokeFulfilledInvitation` internal action performs the single Clerk revoke
with the same 404-tolerance as the sweep.

This fires **once per new membership**, not per request — the intent patch only
runs in the insert branch, so there is no per-request overhead on `users.store`.

**Why Phase 1's sweep is still needed afterwards:** this trigger only catches
invitations linked via `clerkInvitationId`. Invitations created directly in the
Clerk dashboard, or whose email never matched an intent, have no link. The
sweep matches on membership email instead and catches those.

**Gate:** integration test — a membership insert with a linked intent schedules
a revoke carrying the correct `clerkOrgId` and invitation id, and the intent
remains `accepted`.

---

## Phase 3 — Schedule the sweep

Add to `convex/crons.ts`, following the existing reaper convention:

```ts
crons.daily(
  "revoke fulfilled Clerk invitations",
  { hourUTC: 4, minuteUTC: 0 },
  internal.invitations.sweepFulfilledInvitations,
  {},
);
```

Daily is right — this is drift correction, not a hot path. 04:00 UTC keeps it
clear of the 00:30 usage fold and the 03:00 prune.

### Open decision (not in v1)

Should the sweep also revoke invitations that are pending but **never
accepted** past some age (e.g. 30 days)? Those consume seats too. Deliberately
excluded from v1: silently revoking a genuine pending invite is worse than a
wasted seat. Phase 4c makes the seat count visible so an admin decides instead.

**Gate:** one scheduled run completes in prod logs with zero errors.

---

## Phase 4 — Make the wall visible before it is hit

Independent of the Clerk-orgs decision; (a) and (b) are live bugs.

### 4a — Clean error instead of raw JSON

`convex/lib/clerkApi.ts:53-58` throws the Clerk response body verbatim, which
is what lands in the admin's toast via
`src/features/admin/invite-member-dialog.tsx:57-60`. Parse `errors[].code` and
map `organization_membership_quota_exceeded` to an actionable message:

> This workspace has reached its 20-member limit. Remove a member or revoke a
> pending invitation.

Keep the raw body in the server-side log.

### 4b — Stop the 500 on the join path

`src/app/api/join-subdomain-organization/route.ts:227-232` swallows only
`already_a_member_in_organization` and rethrows everything else. Once an org is
full, a legitimate allowed-domain user gets an **unhandled 500 on sign-up**.
Add a quota branch returning 403 with a readable message, plus
`logBlockedJoin({ reason: "membership_quota_exceeded" })` so it surfaces
server-side rather than as a mystery support ticket.

### 4c — Seat counter in the admin UI

Show `members + pending invitations / 20` on
`src/app/[org]/admin/users/page.tsx`. This is the piece that turns a hard 403
into something someone noticed at 17/20.

**Gate:** invite into a full org shows the mapped message; join a full org via
subdomain returns 403 with a readable body and a `blockedJoin` audit row.

---

## Phase 5 — Reduce structural consumption

Make platform-staff access **lazy** — join on first actual access rather than
pre-fanning out via `fanOutSuperAdminMemberships` — or opt-in per tenant from
the console.

Largest single seat saving available (6 seats per workspace at current staff
count). It also removes the membership-pagination drain in
`src/app/[org]/layout.tsx:48-56`, which is O(tenants) per page load for staff
at 100 memberships per page.

**Trade-off, not a pure win:** eager fan-out is what makes staff access instant
and predictable. Lazy join costs a first-visit round-trip and is a behaviour
change. Worth doing, but sequence it after Phases 1–4 have landed.

---

## Tests

Build on the existing `stubClerkFetch` / `stubClerkFetchStatus` harness in
`convex/tenantIsolation.test.ts`.

1. New membership with a linked intent → schedules a revoke with the right
   `clerkOrgId` + invitation id.
2. **An `accepted` intent is never flipped to `revoked`** — guards the Phase 1
   hazard.
3. Sweep revokes only the member ∩ pending intersection; genuine pending
   invites survive.
4. Cross-tenant: sweeping org A issues no revoke against org B's invitations.
5. Sweep paginates — a stubbed 150-invitation org is fully scanned.
6. Sweep is idempotent — a second run revokes nothing, reports no errors.
7. Quota 403 surfaces as the mapped message (4a); the join route returns 403,
   not 500 (4b).

## Effort and ordering

| Step | Effort | Effect |
| --- | --- | --- |
| Phase 1 + run once | ~2–3h | Reclaims seats today |
| Phase 2 | ~1h | Leak stops recurring |
| Phase 4a/4b | ~1h | No more 500s or JSON toasts |
| Phase 3 | ~15min | Stays clean |
| Phase 4c | ~1–2h | Nobody is surprised again |
| Phase 5 | ~half day | Biggest structural saving |

Phases 1–4 are about a day's work. They remain worth doing after buying the
B2B add-on: the sweep and seat counter stay useful, and 4b is a live bug that
breaks sign-up for real users.

## Notes for whoever executes this

- `convex dev` pushes edits live, so a breaking schema change fails the push
  mid-session. Nothing here requires a schema change; if one becomes necessary,
  use widen → migrate → narrow via `convex/migrations.ts`.
- `CLERK_SECRET_KEY` lives in the **Convex** environment, not Next.js
  (`convex/lib/clerkApi.ts:14-23`). Any new env var this plan adds (e.g. the
  platform `requesting_user_id`) needs `npx convex env set` on both dev and
  prod deployments.
