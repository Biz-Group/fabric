import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Seed a development org with a realistic Function → Department → Process
 * hierarchy and sample conversations. Every row is stamped with the given
 * `clerkOrgId` so the seed is safe in a multi-tenant deployment.
 *
 * Run with:
 *   npx convex run seed:seed '{"clerkOrgId":"org_xxx"}'
 *
 * Idempotent: skips if the target org already has any functions.
 */
export const seed = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const orgId = args.clerkOrgId;

    const existing = await ctx.db
      .query("functions")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", orgId))
      .take(1);
    if (existing.length > 0) {
      console.log(
        `Seed data already exists for org ${orgId} — skipping.`,
      );
      return;
    }

    // ── Functions ──────────────────────────────────────────────
    const finance = await ctx.db.insert("functions", {
      name: "Finance",
      sortOrder: 1,
      clerkOrgId: orgId,
    });
    const operations = await ctx.db.insert("functions", {
      name: "Operations",
      sortOrder: 2,
      clerkOrgId: orgId,
    });
    const hr = await ctx.db.insert("functions", {
      name: "Human Resources",
      sortOrder: 3,
      clerkOrgId: orgId,
    });
    const technology = await ctx.db.insert("functions", {
      name: "Technology",
      sortOrder: 4,
      clerkOrgId: orgId,
    });

    // ── Finance Departments ───────────────────────────────────
    const payroll = await ctx.db.insert("departments", {
      functionId: finance,
      name: "Payroll",
      sortOrder: 1,
      clerkOrgId: orgId,
    });
    const accountsPayable = await ctx.db.insert("departments", {
      functionId: finance,
      name: "Accounts Payable",
      sortOrder: 2,
      clerkOrgId: orgId,
    });
    const treasury = await ctx.db.insert("departments", {
      functionId: finance,
      name: "Treasury",
      sortOrder: 3,
      clerkOrgId: orgId,
    });

    // ── Operations Departments ────────────────────────────────
    const supplyChain = await ctx.db.insert("departments", {
      functionId: operations,
      name: "Supply Chain",
      sortOrder: 1,
      clerkOrgId: orgId,
    });
    const facilities = await ctx.db.insert("departments", {
      functionId: operations,
      name: "Facilities",
      sortOrder: 2,
      clerkOrgId: orgId,
    });

    // ── HR Departments ────────────────────────────────────────
    const recruitment = await ctx.db.insert("departments", {
      functionId: hr,
      name: "Recruitment",
      sortOrder: 1,
      clerkOrgId: orgId,
    });
    const employeeRelations = await ctx.db.insert("departments", {
      functionId: hr,
      name: "Employee Relations",
      sortOrder: 2,
      clerkOrgId: orgId,
    });
    const learningDev = await ctx.db.insert("departments", {
      functionId: hr,
      name: "Learning & Development",
      sortOrder: 3,
      clerkOrgId: orgId,
    });

    // ── Technology Departments ─────────────────────────────────
    const engineering = await ctx.db.insert("departments", {
      functionId: technology,
      name: "Engineering",
      sortOrder: 1,
      clerkOrgId: orgId,
    });
    const itSupport = await ctx.db.insert("departments", {
      functionId: technology,
      name: "IT Support",
      sortOrder: 2,
      clerkOrgId: orgId,
    });

    // ── Finance > Payroll Processes ───────────────────────────
    const compensation = await ctx.db.insert("processes", {
      departmentId: payroll,
      name: "Compensation",
      sortOrder: 1,
      clerkOrgId: orgId,
      rollingSummary:
        "Compensation is handled by three team members who collectively manage monthly salary calculations, variable pay adjustments, and statutory deductions. Sarah K. pulls headcount and salary data from the HRIS on the 15th of each month, runs validation checks against the approved compensation bands, and flags discrepancies to the Payroll Manager. Ahmed R. handles bank transfer setup and coordinates with Treasury to ensure funds are available two business days before pay date. Both contributors noted that the HRIS export occasionally includes terminated employees, requiring a manual cross-reference with the HR termination log — a gap that causes 2–3 hours of rework each cycle.",
    });
    await ctx.db.insert("processes", {
      departmentId: payroll,
      name: "Commissions",
      sortOrder: 2,
      clerkOrgId: orgId,
    });
    await ctx.db.insert("processes", {
      departmentId: payroll,
      name: "Bank Transfers",
      sortOrder: 3,
      clerkOrgId: orgId,
    });

    // ── Finance > Accounts Payable Processes ──────────────────
    await ctx.db.insert("processes", {
      departmentId: accountsPayable,
      name: "Invoice Processing",
      sortOrder: 1,
      clerkOrgId: orgId,
    });
    await ctx.db.insert("processes", {
      departmentId: accountsPayable,
      name: "Vendor Onboarding",
      sortOrder: 2,
      clerkOrgId: orgId,
    });

    // ── Finance > Treasury Processes ──────────────────────────
    await ctx.db.insert("processes", {
      departmentId: treasury,
      name: "Cash Flow Forecasting",
      sortOrder: 1,
      clerkOrgId: orgId,
    });
    await ctx.db.insert("processes", {
      departmentId: treasury,
      name: "Bank Reconciliation",
      sortOrder: 2,
      clerkOrgId: orgId,
    });

    // ── Operations > Supply Chain Processes ────────────────────
    await ctx.db.insert("processes", {
      departmentId: supplyChain,
      name: "Procurement",
      sortOrder: 1,
      clerkOrgId: orgId,
    });
    await ctx.db.insert("processes", {
      departmentId: supplyChain,
      name: "Inventory Management",
      sortOrder: 2,
      clerkOrgId: orgId,
    });
    await ctx.db.insert("processes", {
      departmentId: supplyChain,
      name: "Logistics & Shipping",
      sortOrder: 3,
      clerkOrgId: orgId,
    });

    // ── Operations > Facilities Processes ──────────────────────
    await ctx.db.insert("processes", {
      departmentId: facilities,
      name: "Office Maintenance",
      sortOrder: 1,
      clerkOrgId: orgId,
    });
    await ctx.db.insert("processes", {
      departmentId: facilities,
      name: "Access & Security",
      sortOrder: 2,
      clerkOrgId: orgId,
    });

    // ── HR > Recruitment Processes ─────────────────────────────
    await ctx.db.insert("processes", {
      departmentId: recruitment,
      name: "Job Posting & Sourcing",
      sortOrder: 1,
      clerkOrgId: orgId,
    });
    await ctx.db.insert("processes", {
      departmentId: recruitment,
      name: "Interview Scheduling",
      sortOrder: 2,
      clerkOrgId: orgId,
    });
    await ctx.db.insert("processes", {
      departmentId: recruitment,
      name: "Offer Management",
      sortOrder: 3,
      clerkOrgId: orgId,
    });

    // ── HR > Employee Relations Processes ──────────────────────
    await ctx.db.insert("processes", {
      departmentId: employeeRelations,
      name: "Onboarding",
      sortOrder: 1,
      clerkOrgId: orgId,
    });
    await ctx.db.insert("processes", {
      departmentId: employeeRelations,
      name: "Performance Reviews",
      sortOrder: 2,
      clerkOrgId: orgId,
    });

    // ── HR > Learning & Development Processes ─────────────────
    await ctx.db.insert("processes", {
      departmentId: learningDev,
      name: "Training Programs",
      sortOrder: 1,
      clerkOrgId: orgId,
    });
    await ctx.db.insert("processes", {
      departmentId: learningDev,
      name: "Compliance Training",
      sortOrder: 2,
      clerkOrgId: orgId,
    });

    // ── Technology > Engineering Processes ─────────────────────
    await ctx.db.insert("processes", {
      departmentId: engineering,
      name: "Sprint Planning",
      sortOrder: 1,
      clerkOrgId: orgId,
    });
    await ctx.db.insert("processes", {
      departmentId: engineering,
      name: "Code Review",
      sortOrder: 2,
      clerkOrgId: orgId,
    });
    await ctx.db.insert("processes", {
      departmentId: engineering,
      name: "Release Management",
      sortOrder: 3,
      clerkOrgId: orgId,
    });

    // ── Technology > IT Support Processes ──────────────────────
    await ctx.db.insert("processes", {
      departmentId: itSupport,
      name: "Helpdesk Ticketing",
      sortOrder: 1,
      clerkOrgId: orgId,
    });
    await ctx.db.insert("processes", {
      departmentId: itSupport,
      name: "Hardware Provisioning",
      sortOrder: 2,
      clerkOrgId: orgId,
    });

    // ── Sample Conversations (for Finance > Payroll > Compensation) ──
    await ctx.db.insert("conversations", {
      processId: compensation,
      clerkOrgId: orgId,
      elevenlabsConversationId: "seed-conv-001",
      contributorName: "Sarah K.",
      transcript: [
        {
          role: "ai",
          content:
            "Hi Sarah, I'm Fabric. Let's talk about how the Compensation process works. Can you walk me through what you do?",
          time_in_call_secs: 0,
        },
        {
          role: "user",
          content:
            "Sure! So every month around the 15th, I pull the headcount and salary data from our HRIS — we use Workday. I export the active employee list with their base salary, any variable pay adjustments, and statutory deduction codes.",
          time_in_call_secs: 5,
        },
        {
          role: "ai",
          content:
            "Got it. Once you have that export, what's the next step? Do you do any validation?",
          time_in_call_secs: 28,
        },
        {
          role: "user",
          content:
            "Yes, I run it against the approved compensation bands that HR maintains in a shared spreadsheet. If anyone's salary falls outside the band for their grade, I flag it and send it to the Payroll Manager for review before we process.",
          time_in_call_secs: 35,
        },
        {
          role: "ai",
          content:
            "What happens when things go wrong? Are there common issues you run into?",
          time_in_call_secs: 55,
        },
        {
          role: "user",
          content:
            "The biggest issue is that the Workday export sometimes includes employees who were recently terminated but haven't been fully offboarded in the system yet. I have to cross-reference with the HR termination log, which is a separate spreadsheet. That alone takes me about 2 to 3 hours each cycle.",
          time_in_call_secs: 62,
        },
        {
          role: "ai",
          content:
            "That sounds like a significant pain point. Who do you depend on to get that termination data?",
          time_in_call_secs: 88,
        },
        {
          role: "user",
          content:
            "That comes from the Employee Relations team. They update the log, but sometimes there's a lag of a few days. I've asked if we can get a real-time feed but it hasn't been prioritized yet.",
          time_in_call_secs: 95,
        },
        {
          role: "ai",
          content:
            "Let me summarize what I've heard. You pull salary data from Workday on the 15th, validate it against compensation bands, flag outliers for the Payroll Manager, and then cross-reference terminations manually — which is a 2-3 hour rework each month because of lag in the HR termination log. Does that capture it?",
          time_in_call_secs: 115,
        },
        {
          role: "user",
          content:
            "That's exactly right. I think that covers the main flow.",
          time_in_call_secs: 140,
        },
      ],
      summary:
        "Sarah described the monthly salary calculation process including data sourcing from Workday HRIS on the 15th, validation against approved compensation bands, and flagging discrepancies to the Payroll Manager. She highlighted a recurring issue where terminated employees appear in the export due to offboarding lag in the HR system, requiring 2–3 hours of manual cross-referencing with the Employee Relations termination log each cycle.",
      analysis: {
        transcript_summary:
          "Sarah described the monthly salary calculation process including data sourcing from Workday HRIS on the 15th, validation against approved compensation bands, and flagging discrepancies to the Payroll Manager.",
        data_collection: {
          steps_described: [
            "Pull headcount and salary data from Workday HRIS on the 15th",
            "Export active employees with base salary, variable pay, and deduction codes",
            "Validate against approved compensation bands spreadsheet",
            "Flag outliers and send to Payroll Manager for review",
            "Cross-reference with HR termination log to remove terminated employees",
          ],
          tools_mentioned: [
            "Workday HRIS",
            "Shared compensation bands spreadsheet",
            "HR termination log spreadsheet",
          ],
          dependencies: [
            "Employee Relations team (termination log updates)",
            "Payroll Manager (outlier approvals)",
            "HR (compensation band maintenance)",
          ],
          frequency: "monthly",
          edge_cases: [
            "Terminated employees appearing in Workday export due to offboarding lag",
            "Salary falling outside approved compensation bands",
          ],
        },
        success_evaluation: {
          described_specific_steps: true,
          mentioned_tools_or_systems: true,
          identified_dependencies: true,
        },
      },
      durationSeconds: 272,
      status: "done",
    });

    await ctx.db.insert("conversations", {
      processId: compensation,
      clerkOrgId: orgId,
      elevenlabsConversationId: "seed-conv-002",
      contributorName: "Ahmed R.",
      transcript: [
        {
          role: "ai",
          content:
            "Hi Ahmed, I'm Fabric. Let's talk about the Compensation process. I know Sarah has already described some of the early steps — can you tell me about your part?",
          time_in_call_secs: 0,
        },
        {
          role: "user",
          content:
            "Yeah, so I pick up after Sarah does the validation. My main job is setting up the bank transfers. Once the payroll file is approved, I format it for our banking portal — we use HSBC — and upload it.",
          time_in_call_secs: 6,
        },
        {
          role: "ai",
          content:
            "What does the formatting involve? Is it automated or manual?",
          time_in_call_secs: 25,
        },
        {
          role: "user",
          content:
            "It's semi-manual. I run a macro that converts the Workday export into the HSBC BACS format, but I still have to manually verify the sort codes and account numbers for any new starters that month. If someone joined mid-cycle, their banking details might not have been verified yet.",
          time_in_call_secs: 32,
        },
        {
          role: "ai",
          content:
            "And how do you coordinate with Treasury on funding?",
          time_in_call_secs: 58,
        },
        {
          role: "user",
          content:
            "I send Treasury the total amount two business days before pay date. They confirm the funds are available in the payroll account. If there's a shortfall — which has happened once or twice — they move funds from the reserve account. I can't submit the BACS file until I get their confirmation email.",
          time_in_call_secs: 65,
        },
        {
          role: "ai",
          content:
            "So to summarize: you take the approved payroll file, format it for HSBC BACS using a macro, verify banking details for new starters, coordinate with Treasury for funding confirmation, and then submit. The main dependency is Treasury's funding confirmation, and the risk is unverified banking details for new hires. Sound right?",
          time_in_call_secs: 95,
        },
        {
          role: "user",
          content: "Spot on. That's the full flow from my side.",
          time_in_call_secs: 125,
        },
      ],
      summary:
        "Ahmed explained the bank transfer setup phase of compensation. After Sarah's validation, he formats the approved payroll file for HSBC BACS using a conversion macro, manually verifies sort codes and account numbers for new starters, coordinates with Treasury to ensure funds are available two business days before pay date, and submits the BACS file only after receiving Treasury's confirmation. He noted that unverified banking details for mid-cycle joiners are a recurring risk.",
      analysis: {
        transcript_summary:
          "Ahmed explained the bank transfer setup phase of the compensation process, covering BACS file formatting, banking detail verification for new starters, and Treasury funding coordination.",
        data_collection: {
          steps_described: [
            "Receive approved payroll file from validation step",
            "Run macro to convert Workday export to HSBC BACS format",
            "Manually verify sort codes and account numbers for new starters",
            "Send total amount to Treasury two business days before pay date",
            "Wait for Treasury funding confirmation email",
            "Submit BACS file to HSBC banking portal",
          ],
          tools_mentioned: [
            "HSBC banking portal",
            "BACS format conversion macro",
            "Workday export",
          ],
          dependencies: [
            "Sarah K. (validated payroll file)",
            "Treasury team (funding confirmation)",
            "HR (new starter banking details)",
          ],
          frequency: "monthly",
          edge_cases: [
            "Unverified banking details for mid-cycle new starters",
            "Funding shortfall requiring reserve account transfer",
          ],
        },
        success_evaluation: {
          described_specific_steps: true,
          mentioned_tools_or_systems: true,
          identified_dependencies: true,
        },
      },
      durationSeconds: 375,
      status: "done",
    });

    console.log(
      `Seed data inserted for org ${orgId}: 4 functions, 10 departments, ~25 processes, 2 sample conversations.`,
    );
  },
});
