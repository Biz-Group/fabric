export type ReleaseNoteItem = {
  title: string;
  description: string;
};

export type MonthlyReleaseNote = {
  id: string;
  month: string;
  shortMonth: string;
  monthNumber: string;
  year: string;
  headline: string;
  summary: string;
  newFeatures: ReleaseNoteItem[];
  enhancements: ReleaseNoteItem[];
};

export const monthlyReleaseNotes: MonthlyReleaseNote[] = [
  {
    id: "august-2026",
    month: "August",
    shortMonth: "Aug",
    monthNumber: "08",
    year: "2026",
    headline: "Evidence you can follow",
    summary:
      "Overviews now connect every important finding to its source, while process flows are easier to explore and trust.",
    newFeatures: [
      {
        title: "Evidence-backed overviews",
        description:
          "See clear findings, key facts, and source links for every process, department, and function.",
      },
      {
        title: "Connected source trails",
        description:
          "Jump from an overview or PDF report to the source conversation or process-flow step.",
      },
      {
        title: "More flexible process flows",
        description:
          "Use owner lanes, layout controls, spotlights, keyboard navigation, and a resizable details panel.",
      },
      {
        title: "Workspace usage metering",
        description:
          "The platform team can now understand AI and voice usage and cost by workspace.",
      },
      {
        title: "A new public website",
        description:
          "Explore Fabric's product journey, capabilities, common uses, and frequently asked questions.",
      },
    ],
    enhancements: [
      {
        title: "Staged flow generation",
        description:
          "Progress appears sooner, and interrupted flow generation can recover safely.",
      },
      {
        title: "Automatic knowledge updates",
        description:
          "Summary and flow updates begin when a conversation finishes without blocking each other.",
      },
      {
        title: "Smarter rebuild controls",
        description:
          "An overview can be rebuilt only when there is new information to include.",
      },
      {
        title: "Clearer executive briefs",
        description:
          "Important facts stand out, while status and rebuild details take up less space.",
      },
      {
        title: "More reliable roll-ups",
        description:
          "Large summaries, usage reports, insight counts, and workspace branding are clearer and steadier.",
      },
    ],
  },
  {
    id: "july-2026",
    month: "July",
    shortMonth: "Jul",
    monthNumber: "07",
    year: "2026",
    headline: "A stronger foundation for growth",
    summary:
      "Workspace creation, joining, and administration became easier to manage as Fabric prepared for more organizations and contributors.",
    newFeatures: [
      {
        title: "Tenant management console",
        description:
          "Create and manage workspaces, invitations, email domains, logos, and staff access in one place.",
      },
      {
        title: "Approved workspace joining",
        description:
          "Join through an invitation or an allowed company email domain.",
      },
      {
        title: "Record on someone's behalf",
        description:
          "Admins can capture the subject, submitter, and consent as separate, clear details.",
      },
      {
        title: "Meaningful conversation titles",
        description:
          "Conversation lists now describe what was discussed instead of only showing the recording type.",
      },
    ],
    enhancements: [
      {
        title: "Contributor access by default",
        description:
          "New workspace members can begin capturing knowledge right away.",
      },
      {
        title: "Accurate workspace totals",
        description:
          "Member, admin, and pending-invitation counts remain correct for new and existing workspaces.",
      },
      {
        title: "More dependable workspace loading",
        description:
          "Joining, conversation lists, media playback, and error recovery are more resilient.",
      },
      {
        title: "Unified AI processing",
        description:
          "Provider monitoring, rollback options, and timeout handling are now managed consistently.",
      },
      {
        title: "Platform maintenance",
        description:
          "Core libraries and install safeguards were refreshed for security and compatibility.",
      },
    ],
  },
  {
    id: "june-2026",
    month: "June",
    shortMonth: "Jun",
    monthNumber: "06",
    year: "2026",
    headline: "A new way to move through Fabric",
    summary:
      "The redesigned workbench made process knowledge faster to find, easier to share, and ready to take offline.",
    newFeatures: [
      {
        title: "Redesigned app shell and workbench",
        description:
          "Move more easily between the process tree, overviews, conversations, flows, and insights.",
      },
      {
        title: "Search and shareable views",
        description:
          "Press Ctrl+K to search the hierarchy and share a link to the same selection and tab.",
      },
      {
        title: "Installable Fabric app",
        description:
          "Install Fabric on your device and keep basic access when you are offline.",
      },
      {
        title: "Complete process PDFs",
        description:
          "Download overviews, insights, conversations, and readable process-flow cards in one report.",
      },
      {
        title: "Admin recovery tools",
        description:
          "Choose invitation roles and retry failed audio transcription or analysis.",
      },
    ],
    enhancements: [
      {
        title: "Consistent workspace colors",
        description:
          "Organization colors now carry across navigation, controls, conversations, flows, and insights.",
      },
      {
        title: "Predictable hierarchy navigation",
        description:
          "Ordering, direct links, deleted selections, long names, and responsive layouts behave more reliably.",
      },
      {
        title: "Cleaner overview actions",
        description:
          "Edit and delete controls moved into headers, while long summaries can expand and collapse.",
      },
      {
        title: "Safer delete guidance",
        description:
          "Dialogs explain what can be removed and guide admins through required cleanup.",
      },
      {
        title: "Resilient process-flow generation",
        description:
          "More response formats are supported, cut-off results are detected, and failures are clearer.",
      },
      {
        title: "Interaction polish",
        description:
          "Audio, waveforms, profile editing, keyboard access, and responsive layouts received a broad refinement pass.",
      },
    ],
  },
  {
    id: "may-2026",
    month: "May",
    shortMonth: "May",
    monthNumber: "05",
    year: "2026",
    headline: "More ways to bring conversations in",
    summary:
      "Teams gained flexible audio capture, speaker review, and workspace theming without giving up privacy or control.",
    newFeatures: [
      {
        title: "Workspace accent themes",
        description:
          "Create a theme from the organization logo or choose and approve a color manually.",
      },
      {
        title: "Speaker-label review",
        description:
          "Identify speakers in voice recordings before their conversation is analyzed.",
      },
      {
        title: "Audio file uploads",
        description:
          "Process existing audio through the same transcription and analysis flow as a live recording.",
      },
    ],
    enhancements: [
      {
        title: "Private audio playback",
        description:
          "Signed playback links keep workspace audio protected when it is streamed or revisited.",
      },
      {
        title: "Safer descriptions",
        description:
          "Checks reduce the chance of unsafe or instruction-like text affecting AI results.",
      },
      {
        title: "Clean recording abandonment",
        description:
          "Closing an unfinished recording removes its temporary conversation and audio safely.",
      },
      {
        title: "Clear conversation types",
        description:
          "Badges distinguish AI interviews, voice recordings, and audio uploads at a glance.",
      },
    ],
  },
  {
    id: "april-2026",
    month: "April",
    shortMonth: "Apr",
    monthNumber: "04",
    year: "2026",
    headline: "From conversations to a living process map",
    summary:
      "Fabric expanded from captured conversations into structured knowledge, interactive flows, and complete workspace administration.",
    newFeatures: [
      {
        title: "Manage the full hierarchy",
        description:
          "Create, rename, move, and manage functions, departments, and processes in the workspace.",
      },
      {
        title: "Structured AI overviews",
        description:
          "Summaries now cover processes, departments, and functions with clear refresh controls.",
      },
      {
        title: "Interactive process-flow maps",
        description:
          "Visualize steps, decisions, handoffs, tools, and issues found in conversations.",
      },
      {
        title: "Workspace roles",
        description:
          "Viewer, contributor, and admin roles control who can view, capture, edit, and manage content.",
      },
      {
        title: "Protected organization workspaces",
        description:
          "Each organization has its own subdomain with guided joining and workspace switching.",
      },
      {
        title: "Conversation administration",
        description:
          "Admins can invite members and review, export, retry, or remove conversations.",
      },
      {
        title: "Standalone voice recordings",
        description:
          "Capture a voice recording as an alternative to an AI-guided interview.",
      },
    ],
    enhancements: [
      {
        title: "Automatic summary freshness",
        description:
          "Overviews ask for attention only after their source material changes.",
      },
      {
        title: "Hierarchy safeguards",
        description:
          "Delete checks protect child records, while repair tools preserve content if a link is lost.",
      },
      {
        title: "Richer audio controls",
        description:
          "Seek, skip, change speed, use a mini-player, and click through a synced transcript.",
      },
      {
        title: "Clear recording progress",
        description:
          "Background voice processing now shows processing, success, and failure states.",
      },
      {
        title: "More resilient workspace access",
        description:
          "Routing, sign-in, tenant isolation, audio access, and organization activation are steadier.",
      },
      {
        title: "Consistent organization branding",
        description:
          "Logos or initials now appear across sign-in, headers, and the workspace shell.",
      },
    ],
  },
  {
    id: "march-2026",
    month: "March",
    shortMonth: "Mar",
    monthNumber: "03",
    year: "2026",
    headline: "Fabric takes shape",
    summary:
      "The first release established a secure workspace for capturing how an organization really works through conversation.",
    newFeatures: [
      {
        title: "A clear process hierarchy",
        description:
          "Organize company knowledge into functions, departments, and processes.",
      },
      {
        title: "Secure account setup",
        description:
          "Sign in, complete guided onboarding, and create a Fabric profile.",
      },
      {
        title: "AI-guided process interviews",
        description:
          "Turn recorded interviews into conversation records and early process summaries.",
      },
    ],
    enhancements: [
      {
        title: "Guided recording setup",
        description:
          "Microphone access and consent are confirmed before a session begins.",
      },
      {
        title: "Conversation playback foundations",
        description:
          "Playback includes transcripts, waveforms, and essential audio controls.",
      },
      {
        title: "Authenticated workspace data",
        description:
          "Workspace information and backend actions are protected from the first release.",
      },
    ],
  },
];
