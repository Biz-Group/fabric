import { auth, clerkClient } from "@clerk/nextjs/server";
import { fetchAction } from "convex/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { api } from "../../../../convex/_generated/api";
import { getTenantSubdomain } from "@/lib/subdomain";

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "";

type ClerkApiError = {
  errors?: Array<{ code?: string }>;
};

type ClerkUserForSelfJoin = {
  banned: boolean;
  locked: boolean;
};

function isAlreadyMemberError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const errors = (error as ClerkApiError).errors;
  return (
    Array.isArray(errors) &&
    errors.some((entry) => entry.code === "already_a_member_in_organization")
  );
}

function isSameOriginPost(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return (
        new URL(origin).host.toLowerCase() === req.nextUrl.host.toLowerCase()
      );
    } catch {
      return false;
    }
  }

  const fetchSite = req.headers.get("sec-fetch-site");
  return (
    fetchSite === null || fetchSite === "same-origin" || fetchSite === "none"
  );
}

async function syncFabricMembership(
  getToken: (options?: {
    organizationId?: string;
    skipCache?: boolean;
    template?: string;
  }) => Promise<string | null>,
  organizationId: string,
) {
  const token = await getToken({
    template: "convex",
    organizationId,
    skipCache: true,
  });
  if (!token) {
    throw new Error("Could not mint a Convex token for this organization.");
  }

  await fetchAction(api.users.syncCurrentUserFromClerk, {}, { token });
}

export async function POST(req: NextRequest) {
  if (!isSameOriginPost(req)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const slug = getTenantSubdomain(req.headers.get("host"), ROOT_DOMAIN);
  if (!slug) {
    return NextResponse.json(
      { error: "A workspace subdomain is required." },
      { status: 400 },
    );
  }

  const { userId, getToken } = await auth({
    treatPendingAsSignedOut: false,
  });
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const client = await clerkClient();
  let organization;
  try {
    organization = await client.organizations.getOrganization({ slug });
  } catch {
    return NextResponse.json(
      { error: "Workspace not found for this subdomain." },
      { status: 404 },
    );
  }

  const targetMembership =
    await client.organizations.getOrganizationMembershipList({
      organizationId: organization.id,
      userId: [userId],
      limit: 1,
    });

  if (targetMembership.data.length === 0) {
    const existingMemberships =
      await client.users.getOrganizationMembershipList({
        userId,
        limit: 1,
      });

    if (existingMemberships.totalCount > 0) {
      return NextResponse.json(
        {
          error:
            "This account already belongs to another workspace. Ask an admin to add you here.",
        },
        { status: 403 },
      );
    }

    const user = await client.users.getUser(userId);
    if (user.banned || user.locked) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    try {
      await client.organizations.createOrganizationMembership({
        organizationId: organization.id,
        userId,
        role: "org:member",
      });
    } catch (error) {
      if (!isAlreadyMemberError(error)) throw error;
    }
  }

  try {
    await syncFabricMembership(getToken, organization.id);
  } catch (error) {
    console.error("Failed to sync Fabric membership after Clerk join", error);
    return NextResponse.json(
      {
        error:
          "We joined you to the workspace, but could not finish setting up your Fabric profile. Please try again.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    organizationId: organization.id,
    slug: organization.slug,
  });
}
