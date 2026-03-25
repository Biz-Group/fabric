# Fabric — Phased Task List

Derived from [PRD.md](PRD.md) v0.6 (POC — Audio Streamed from ElevenLabs)

---

## Phase 1: Project Setup & Infrastructure

- [ ] **Initialize Next.js project with TypeScript and Tailwind CSS**
  - Create the Next.js app with the App Router (`create-next-app`)
  - Configure TypeScript (`tsconfig.json`) and Tailwind CSS (`tailwind.config.ts`)
  - Set up project folder structure: `app/`, `components/`, `lib/`, `types/`, `hooks/`
  - Verify the dev server runs cleanly on `localhost:3000`

- [ ] **Install and configure shadcn/ui**
  - Run `npx shadcn@latest init` to scaffold the shadcn/ui setup (sets up `components.json`, `lib/utils.ts`, CSS variables)
  - Add required shadcn/ui primitives that will be used across the app: `Button`, `Dialog`, `Card`, `Input`, `Collapsible`, `Breadcrumb`, `ScrollArea`, `Separator`
  - Confirm Tailwind theme and CSS variable integration is working

- [ ] **Install ElevenLabs packages and add all ElevenLabs UI components**
  - Install the core React SDK: `npm i @elevenlabs/react`
  - Add all ElevenLabs UI components (these install as source files into the project since they're built on shadcn/ui):
    ```
    npx @elevenlabs/cli@latest components add conversation orb message waveform voice-button transcript-viewer shimmering-text conversation-bar audio-player scrub-bar
    ```
  - Verify each component's source file is present and imports resolve correctly
  - Components to confirm: **Conversation** (chat container with `ConversationContent`, `ConversationEmptyState`, `ConversationScrollButton`), **Conversation Bar** (mic controls + text input + waveform), **Orb** (3D Three.js audio-reactive animation), **Message** (user/assistant chat bubbles), **Waveform** (canvas-based audio visualization), **Voice Button** (mic toggle), **Transcript Viewer** (historical transcript display), **Audio Player** (inline audio playback), **Scrub Bar** (seek/scrub through recordings), **Shimmering Text** (loading state indicator)

- [ ] **Set up Supabase project and install client**
  - Create a new Supabase project (or connect to an existing one)
  - Install the JS client: `npm i @supabase/supabase-js`
  - Create a Supabase client utility (`lib/supabase.ts`) that initializes with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - Initialize the Supabase CLI locally for Edge Function development: `npx supabase init` and `npx supabase login`

- [ ] **Configure all environment variables**
  - Create `.env.local` with the following keys:
    - `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
    - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anonymous/public key
    - `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` — the ElevenLabs agent ID (safe to expose client-side)
  - Store secrets exclusively in Supabase Edge Function environment variables (never client-side):
    - `ELEVENLABS_API_KEY` (`xi-api-key`) — used by `fetch-conversation` and `get-audio` Edge Functions
    - `ANTHROPIC_API_KEY` — used by `regenerate-process-summary` Edge Function to call Claude Sonnet
  - Add `.env.local` to `.gitignore`
  - Create a `.env.example` file documenting all required variables (without values)

---

## Phase 2: Database & Seed Data

- [ ] **Create all Supabase PostgreSQL tables with exact schema from PRD**
  - Write a migration SQL file that creates the following tables:
  - **`functions`** table — organizational functions (top-level hierarchy):
    - `id` uuid PK (default `gen_random_uuid()`)
    - `name` text NOT NULL
    - `sort_order` int
    - `created_at` timestamptz DEFAULT `now()`
  - **`departments`** table — departments within a function:
    - `id` uuid PK (default `gen_random_uuid()`)
    - `function_id` uuid FK → `functions.id` (ON DELETE CASCADE)
    - `name` text NOT NULL
    - `sort_order` int
    - `created_at` timestamptz DEFAULT `now()`
  - **`processes`** table — processes within a department:
    - `id` uuid PK (default `gen_random_uuid()`)
    - `department_id` uuid FK → `departments.id` (ON DELETE CASCADE)
    - `name` text NOT NULL
    - `sort_order` int
    - `rolling_summary` text (nullable — populated after first conversation)
    - `created_at` timestamptz DEFAULT `now()`
  - **`conversations`** table — individual voice session records:
    - `id` uuid PK (default `gen_random_uuid()`)
    - `process_id` uuid FK → `processes.id` (ON DELETE CASCADE)
    - `elevenlabs_conversation_id` text NOT NULL — globally unique ID from `startSession()` return
    - `contributor_name` text NOT NULL
    - `transcript` jsonb — full structured transcript from ElevenLabs (list of message objects with `role`, `content`, `time_in_call_secs`)
    - `summary` text — from `analysis.transcript_summary` (ElevenLabs-generated, no Claude call needed)
    - `analysis` jsonb — ElevenLabs evaluation results + data collection results (steps_described, tools_mentioned, dependencies, frequency, edge_cases)
    - `duration_seconds` int
    - `status` text DEFAULT `'processing'` — valid values: `processing` | `done` | `failed`
    - `created_at` timestamptz DEFAULT `now()`
  - Add foreign key constraints and appropriate indexes (e.g., index on `conversations.process_id`, `conversations.status`)
  - **Row Level Security disabled for POC** (per PRD section 3.2 — to be enabled in Phase 2 with auth)

- [ ] **Create `seed.sql` with realistic organizational hierarchy and sample data**
  - Populate **3–4 functions** (e.g., Finance, Operations, Human Resources, Technology)
  - Each function gets **2–3 departments** (e.g., Finance → Payroll, Accounts Payable, Treasury)
  - Each department gets **2–4 processes** (e.g., Payroll → Compensation, Commissions, Bank Transfers)
  - Use meaningful `sort_order` values so columns display in a logical order
  - Pre-populate **1–2 sample conversations** with mock data so the UI is not empty on first load:
    - Realistic `contributor_name` values (e.g., "Sarah K.", "Ahmed R.")
    - Mock `summary` text (e.g., "Described the monthly salary calculation process including data sourcing from HRIS...")
    - Mock `transcript` JSONB (structured list of message objects with role/content/time_in_call_secs)
    - Mock `analysis` JSONB with sample data collection fields
    - `status: 'done'` and realistic `duration_seconds`
    - Placeholder `elevenlabs_conversation_id` values
  - Pre-populate at least one `processes.rolling_summary` so the Process Summary Box is visible in the demo

- [ ] **Enable Supabase Realtime on the `conversations` table**
  - Enable `postgres_changes` Realtime on the `conversations` table via Supabase dashboard or migration
  - Specifically enable events: `INSERT` and `UPDATE` (need UPDATE to catch `status` changing from `processing` to `done`)
  - Confirm Realtime is active and broadcasting change events

---

## Phase 3: Frontend — Miller Columns Navigation

- [ ] **Build the single-page layout shell with Miller columns + Process Detail panel**
  - Create the main page component as a single-page interface (no routing between pages)
  - Implement a four-panel horizontal layout matching the PRD wireframe (Screen 1):
    - **Column 1**: Functions list
    - **Column 2**: Departments list (populated based on selected function)
    - **Column 3**: Processes list (populated based on selected department)
    - **Column 4**: Process Detail Panel (slide-over or fourth column, populated based on selected process)
  - Use shadcn/ui `ScrollArea` for each column to handle overflow
  - Style the columns with clear visual boundaries (borders or background contrast)
  - Each column should have a header label ("Functions", "Departments", "Processes")
  - Selected items in each column should have a highlighted/active state (e.g., `►` indicator as shown in wireframe)

- [ ] **Implement column selection and drill-down logic**
  - Manage selection state: `selectedFunctionId`, `selectedDepartmentId`, `selectedProcessId`
  - Clicking a Function:
    - Highlights it in Column 1
    - Fetches departments for that function from Supabase (ordered by `sort_order`)
    - Populates Column 2 with results
    - Clears Column 3 and closes Process Detail Panel (reset child selections)
  - Clicking a Department:
    - Highlights it in Column 2
    - Fetches processes for that department from Supabase (ordered by `sort_order`)
    - Populates Column 3 with results
    - Clears/closes Process Detail Panel (reset process selection)
  - Clicking a Process:
    - Highlights it in Column 3 (use `●` filled indicator for selected process as in wireframe)
    - Opens the Process Detail Panel with that process's data
  - Fetch hierarchy data from Supabase using the `@supabase/supabase-js` client
  - Pre-load all functions on initial page load (they're the entry point)

- [ ] **Implement responsive layout for mobile/tablet (< 768px)**
  - On viewports below ~768px, collapse Miller columns into a stacked drill-down pattern:
    - Show a single full-screen column at a time
    - **Level 1**: Full-screen list of Functions
    - **Level 2**: Tap a Function → full-screen list of Departments (with back button to Functions)
    - **Level 3**: Tap a Department → full-screen list of Processes (with back button to Departments)
    - **Level 4**: Tap a Process → full-screen Process Detail Panel (with back button to Processes)
  - Implement a back button at each level for navigation
  - Use a responsive breakpoint (Tailwind `md:` or custom) to switch between layouts
  - The recording modal should work identically on all screen sizes (no layout change needed)
  - Test that three taps can reach any process from the top level (PRD success criterion #1)

- [ ] **Add empty states at every hierarchy level**
  - Every level needs a friendly, inviting zero-data state (not just blank space):
    - **No function selected**: Welcome/instruction message in the Departments column (e.g., "Select a function to see its departments")
    - **No department selected**: Instruction in Processes column (e.g., "Select a department to see its processes")
    - **No process selected**: Instruction in Detail Panel area (e.g., "Select a process to view details")
    - **Department with no processes**: "No processes defined yet."
    - **Process with no conversations**: "No conversations yet — be the first to record how this process works."
    - **Process with no rolling summary**: Process Summary Box should show a placeholder (e.g., "No summary yet — record a conversation to get started.")
  - Style these as helpful prompts, not error messages — they should feel inviting

---

## Phase 4: Process Detail Panel

- [ ] **Build the Process Detail Panel layout**
  - Implement as the fourth column (or slide-over) matching the PRD wireframe (Screen 1, rightmost panel)
  - **Breadcrumb** at the top showing full path: `Function > Department > Process` (e.g., "Finance > Payroll > Compensation") — use shadcn/ui `Breadcrumb` component
  - **"Record a Conversation" button** — prominent, clearly styled action button (mic icon + label as shown in wireframe)
  - **Process Summary Box** — a prominent, always-visible card (shadcn/ui `Card`) at the top of the panel:
    - Displays the `processes.rolling_summary` text
    - This is the AI-generated rolling summary that synthesizes all conversation summaries for this process
    - Visually prominent — this is the "at a glance" view of how the process works
    - If no summary exists yet, show the empty state placeholder
    - Must auto-update when `rolling_summary` changes (via Realtime or refetch)

- [ ] **Build the conversation log**
  - Display a **reverse-chronological list** of all past conversations for the selected process
  - Fetch conversations from Supabase filtered by `process_id`, ordered by `created_at DESC`
  - Only show conversations with `status = 'done'` (or show `processing` ones with a loading indicator)
  - Each conversation entry displays:
    - **Contributor name** (from `conversations.contributor_name`)
    - **Date and time** (formatted from `conversations.created_at`)
    - **AI-generated summary** — collapsible section (default collapsed), showing `conversations.summary`
    - **Audio Player** — inline playback using **ElevenLabs UI Audio Player / Scrub Bar** components. Source URL points to the `get-audio` proxy endpoint: `/api/audio/{elevenlabs_conversation_id}`. Show duration from `conversations.duration_seconds` (formatted as `m:ss`, e.g., "4:32")
    - **Full transcript** — collapsible section, nested under summary (default collapsed). Rendered using the **ElevenLabs UI Transcript Viewer** component with the `conversations.transcript` JSONB data
  - Use shadcn/ui `Collapsible` for expand/collapse behavior on summary and transcript sections
  - Section header "Conversations" with a separator line (matching wireframe)

- [ ] **Integrate Supabase Realtime for live conversation updates**
  - Subscribe to `postgres_changes` on the `conversations` table, filtered by `process_id=eq.{selectedProcessId}`
  - Listen for both `INSERT` events (new conversation added) and `UPDATE` events (status changing from `processing` to `done`)
  - On receiving a change event, refresh the conversation list and the process rolling summary without a page reload
  - Properly **unsubscribe** when the selected process changes or component unmounts (prevent stale subscriptions)
  - Also subscribe to changes on the `processes` table for the selected process to catch `rolling_summary` updates
  - Reference implementation from PRD section 3.5:
    ```tsx
    supabase
      .channel('conversations')
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'conversations',
        filter: `process_id=eq.${selectedProcessId}`,
      }, (payload) => { refreshConversationList(); })
      .subscribe();
    ```

---

## Phase 5: ElevenLabs Voice Agent — Recording Flow

- [ ] **Build the contributor name prompt dialog**
  - When the user clicks "Record a Conversation", first show a **shadcn Dialog** (modal) before launching the recording
  - Dialog contains a single text input field: "What's your name?"
  - The entered name is stored in component state and used for:
    - Passing as `userId` in `conversation.startSession()` for ElevenLabs analytics filtering
    - Injecting into the agent's `firstMessage` override: `"Hi ${contributorName}, I'm Fabric. Let's talk about ${processName}."`
    - Injecting into the dynamic system prompt context: `Contributor: {{contributor_name}}`
    - Storing on the `conversations.contributor_name` field in the database
  - Validate that the name field is not empty before proceeding
  - After submission, transition to the consent banner / recording modal

- [ ] **Build the consent banner**
  - Display a simple, non-intrusive notice before the first recording begins:
    > "This conversation will be recorded, transcribed, and stored to help document our processes."
  - Show this as a one-line banner inside the recording modal (not a legal wall — per PRD section 8.3)
  - This should appear **before** the agent session starts
  - Consider persisting a "seen consent" flag in localStorage so it doesn't appear on every recording (or show it every time — POC is fine either way)

- [ ] **Build the recording modal with ElevenLabs UI components**
  - Create a full-screen or large modal matching the PRD wireframe (Screen 2)
  - Layout from top to bottom:
    - **Breadcrumb** at the top: `Function > Department > Process` (shadcn Breadcrumb)
    - **Orb** — ElevenLabs UI `Orb` component (3D Three.js, audio-reactive). Drives animation from `conversation.getOutputVolume()` for agent speech and `conversation.getInputVolume()` for user speech
    - **Conversation area** — ElevenLabs UI `Conversation` component containing `Message` components. Messages appear in real-time via the `onMessage` callback. Auto-styling for user vs. assistant messages. Include `ConversationScrollButton` for auto-scrolling
    - **Waveform** — ElevenLabs UI `Waveform` component showing canvas-based audio visualization during recording
    - **Controls row**:
      - **Voice Button** — ElevenLabs UI `VoiceButton` for mic toggle (start/stop)
      - **End Call button** — triggers `conversation.endSession()`
    - **Text input fallback** — shadcn `Input` + send icon for `conversation.sendUserMessage(text)` (alternative to voice)
  - Alternatively, evaluate using the **Conversation Bar** component which bundles mic controls, text input, and waveform into one pre-built interface
  - The modal should work identically on all screen sizes (mobile and desktop)

- [ ] **Integrate `useConversation` hook with full configuration**
  - Import `useConversation` from `@elevenlabs/react`
  - Configure the hook with:
    - `agentId`: from `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` env var
    - `overrides.agent.prompt.prompt`: dynamic system prompt injecting process context:
      - Contributor name
      - Process path: `{{function_name}} > {{department_name}} > {{process_name}}`
      - Existing process summary: `{{existing_process_summary}}` (from `processes.rolling_summary`)
      - Prior contributor summaries (if any — query previous conversations by this contributor for this process)
    - `overrides.agent.firstMessage`: `"Hi ${contributorName}, I'm Fabric. Let's talk about ${processName}."`
    - `overrides.agent.language`: `"en"` (English only for POC)
  - Implement all event handlers:
    - **`onConnect({ conversationId })`**: Store `conversationId` in state — this is the globally unique ID needed for all post-call API calls
    - **`onMessage({ message, source })`**: Append to live transcript display in the recording modal. `source` is `"user"` or `"ai"`. Feed into the `Message` components for real-time chat display
    - **`onDisconnect(details)`**: Check `details.reason` (`"user"` | `"agent"` | `"error"`). If `"user"` or `"agent"`, trigger the post-call processing pipeline. If `"error"`, show error recovery UI (see Phase 8)
    - **`onError(message, context)`**: Log error, show user-facing error state
  - Call `conversation.startSession()` with:
    - `connectionType: "webrtc"` (preferred for audio quality)
    - `userId: contributorName` (for ElevenLabs analytics filtering)
  - Use `conversation.status` (`"connected"` | `"disconnected"` | `"connecting"` | `"disconnecting"`) to drive UI states (connecting spinner, active call, etc.)
  - Use `conversation.isSpeaking` to provide visual feedback when the agent is speaking (e.g., Orb animation intensity)
  - Wire `conversation.getInputVolume()` and `conversation.getOutputVolume()` to drive Orb animation and Waveform visualization

- [ ] **Add microphone permission pre-check**
  - Before attempting to start a session, check if microphone access is available using `navigator.mediaDevices.getUserMedia({ audio: true })`
  - If the browser prompts for permission and the user **denies**, show a clear, helpful message explaining how to enable the microphone in their browser settings
  - If the page is served over HTTP (not HTTPS), `getUserMedia` will fail — show a message about requiring HTTPS (Vercel handles this in production, but important for local dev)
  - Handle the case where `navigator.mediaDevices` is undefined (very old browsers)
  - Show the check result before attempting `conversation.startSession()` to avoid a confusing silent failure

---

## Phase 6: Post-Call Pipeline (Supabase Edge Functions)

- [ ] **Create `fetch-conversation` Edge Function**
  - **Trigger**: Called by the frontend via HTTP POST after `onDisconnect` fires (polling path — recommended for POC)
  - **Input**: `elevenlabs_conversation_id` and `process_id` and `contributor_name` from the frontend
  - **Logic**:
    1. Poll `GET https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}` with `xi-api-key` header
    2. Poll every ~2 seconds until the response `status` field = `done`
    3. Implement max-retry counter: 30 retries × 2s = 60s timeout (Supabase Edge Function default timeout is ~60s)
    4. If max retries exceeded and still `processing`, insert a record with `status: 'processing'` so the frontend can poll Supabase later
    5. On `status: 'done'`, extract from the response:
       - `transcript` → store in `conversations.transcript` (JSONB — list of message objects with role, content, `time_in_call_secs`)
       - `analysis.transcript_summary` → store in `conversations.summary` (text — this is the ElevenLabs-generated summary, **no Claude call needed**)
       - `analysis` (full object including success evaluation + data collection results) → store in `conversations.analysis` (JSONB)
       - `metadata.call_duration_secs` → store in `conversations.duration_seconds`
    6. Insert a new row into `conversations` table with all extracted fields + `process_id`, `contributor_name`, `elevenlabs_conversation_id`, `status: 'done'`
    7. After successful insert, call `regenerate-process-summary` (either invoke directly or via HTTP)
    8. On `status: 'failed'` from ElevenLabs, insert record with `status: 'failed'`
  - **Security**: `xi-api-key` stored exclusively in Edge Function environment variables — never exposed to the client
  - **Error handling**: Return appropriate HTTP status codes; log errors for debugging

- [ ] **Create `regenerate-process-summary` Edge Function**
  - **Trigger**: Called after `fetch-conversation` (or `post-call-webhook`) successfully inserts a conversation
  - **Input**: `process_id`
  - **Logic**:
    1. Fetch ALL conversation summaries for the given `process_id` from the `conversations` table (WHERE `status = 'done'`, ordered by `created_at`)
    2. Construct a prompt for Claude Sonnet API with the synthesis instruction from PRD section 3.4:
       > "You are synthesizing multiple employee accounts of a single business process. Combine these into a coherent narrative that describes the full process end-to-end, noting which contributors handle which parts, and highlighting any overlaps or gaps."
    3. Include all conversation summaries as input context (these are short summary strings, not full transcripts — lightweight call)
    4. Call Claude Sonnet API (`ANTHROPIC_API_KEY` from environment variables) to generate the rolling summary
    5. Update `processes.rolling_summary` with Claude's response for the given `process_id`
  - **Cost note**: This is the **only LLM cost** in the system — ElevenLabs handles all conversation-level summarization natively
  - **Concurrency note (PRD section 8.1)**: For POC, accept last-write-wins if two summaries fire near-simultaneously. The second call will include both conversation summaries anyway. Production would add Postgres advisory lock or 5s debounce.

- [ ] **Wire the complete post-call data flow (end-to-end)**
  - Implement the full sequence from PRD section 3.5 "Data flow (POC — polling path)":
    1. User starts session → `conversation.startSession()` → `onConnect` stores `conversationId`
    2. User ends session → `onDisconnect` fires with `reason`
    3. Frontend calls `fetch-conversation` Edge Function with `{ elevenlabs_conversation_id, process_id, contributor_name }`
    4. Edge Function polls ElevenLabs API until `status = done`
    5. Edge Function extracts transcript + summary (from `analysis`) + data collection results → inserts into `conversations` table
    6. Edge Function calls `regenerate-process-summary` → Claude synthesizes all summaries → updates `processes.rolling_summary`
    7. Supabase Realtime pushes both changes to frontend → UI refreshes with new conversation + updated summary
  - Handle the case where the Edge Function times out (insert `processing` record, frontend falls back to polling Supabase)

- [ ] **Build the post-call loading state**
  - After `onDisconnect` with `reason: "user"` or `"agent"`, transition the recording modal to a loading/processing state:
    - Show **ShimmeringText** component: "Processing your conversation..."
    - Show the **Orb** in a subtle idle animation (low-energy visual feedback)
    - Do NOT close the modal — the user needs to see that something is happening
  - This state persists for 10–30+ seconds while ElevenLabs processes the transcript + analysis
  - Transition to the post-call review screen when:
    - The `fetch-conversation` Edge Function returns successfully, OR
    - Supabase Realtime delivers the conversation insert/update event

- [ ] **Build the post-call review screen**
  - Displayed inside the modal after processing completes, matching PRD wireframe (Screen 3):
    - Success indicator: "Conversation Recorded" with a checkmark
    - **Summary** display: show the `conversations.summary` text (from ElevenLabs analysis)
    - **"View Full Transcript"** link/button — expands to show the full transcript (can use Transcript Viewer component)
    - **"Done" button** — closes the modal and returns to the Process Detail Panel
  - The conversation should already be visible in the conversation log (via Realtime) by the time the user clicks "Done"

---

## Phase 7: Audio Playback

- [ ] **Create `get-audio` Edge Function (audio proxy)**
  - **Trigger**: Called by the frontend's Audio Player component when the user clicks play on a conversation
  - **Endpoint pattern**: `GET /api/audio/{elevenlabs_conversation_id}`
  - **Logic**:
    1. Receive `elevenlabs_conversation_id` as a URL parameter
    2. Call `GET https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}/audio` with `xi-api-key` header
    3. **Stream** the raw audio response (MP3) directly back to the client — do not buffer the entire file
    4. Set appropriate response headers (`Content-Type: audio/mpeg`, etc.)
  - **Security**: The `xi-api-key` is added server-side only — the frontend never touches it. The `agentId` can be public, but the API key must not be exposed client-side (PRD section 8.1)
  - **No storage**: Fabric does NOT store audio files — no Supabase Storage bucket needed. Audio is served on-demand from ElevenLabs. The URL is deterministic from `elevenlabs_conversation_id` (no `audio_url` column in the database). No additional ElevenLabs credits consumed — retrieval is a read operation (PRD section 3.3.5)
  - **Tradeoff acknowledged**: Playback depends on ElevenLabs API availability — acceptable for POC

- [ ] **Integrate Audio Player and Scrub Bar into the conversation log**
  - In each conversation entry in the conversation log, add an inline audio player using the **ElevenLabs UI Audio Player** and **Scrub Bar** components
  - Point the audio source URL at the `get-audio` proxy: `/api/audio/{elevenlabs_conversation_id}`
  - Display the duration from `conversations.duration_seconds` formatted as `m:ss` (e.g., "4:32", "6:15") next to the scrub bar
  - The player should support play/pause and seeking through the recording
  - Match the wireframe layout: `▶ ──●─────────── 4:32` style inline with each conversation entry
  - Handle loading states (buffering) and error states (ElevenLabs API unavailable) gracefully

---

## Phase 8: Polish, Error Handling & Platform Configuration

- [ ] **Add error recovery for voice agent disconnects**
  - In the `onDisconnect` handler, check `details.reason`:
    - `"user"`: Normal end — proceed to post-call processing pipeline
    - `"agent"`: Agent ended the call — proceed to post-call processing pipeline
    - `"error"`: Connection error — show a **friendly error message** (not just silently close the modal):
      > "Something went wrong with the connection. If your conversation was long enough, it may still have been captured — check back in a minute. Otherwise, try again."
    - Include a **"Try Again"** button to restart the recording flow
    - Include a **"Close"** button to dismiss and return to the Process Detail Panel
  - Also handle `onError(message, context)` from the `useConversation` hook — log the error and show appropriate UI feedback

- [ ] **Add polling timeout mitigation on `fetch-conversation`**
  - Implement max-retry counter: 30 retries × 2-second intervals = 60 seconds maximum
  - If ElevenLabs still returns `processing` after max retries:
    1. Insert a conversation record into Supabase with `status: 'processing'` (so it's tracked)
    2. Return a response indicating timeout to the frontend
    3. Frontend should then poll the Supabase `conversations` table on a short interval (e.g., every 5s) until `status` changes to `done`
    4. Alternatively, rely on Supabase Realtime to notify when the record updates
  - Handle `status: 'failed'` from ElevenLabs — insert record with `status: 'failed'` and show appropriate error in the UI
  - Handle network errors / ElevenLabs API outages gracefully with retry logic

- [ ] **Implement on-demand department and function level summaries**
  - Per PRD section 3.4: Department and Function summaries are generated **on-demand** (not stored) to avoid cascading re-summarizations
  - When viewing a department or function level, concatenate all child process `rolling_summary` values and pass through a Claude synthesis prompt (similar to the process-level prompt)
  - These can be triggered via a button ("Generate Summary") or displayed automatically when a department/function is selected
  - This is a lightweight call — concatenating short summary strings
  - Can be upgraded to stored + incrementally updated summaries in Phase 2

- [ ] **Configure ElevenLabs Conversation Analysis on the platform**
  - Log into the ElevenLabs platform and configure the agent's analysis settings:
  - **Success Evaluation** — define custom criteria to assess each conversation:
    - "Did the contributor describe specific steps in their process?"
    - "Did the contributor mention tools or systems they use?"
    - "Did the contributor identify dependencies on other people or teams?"
  - **Data Collection** — configure extraction of structured data points:
    - `steps_described` (list of strings)
    - `tools_mentioned` (list of strings)
    - `dependencies` (list of strings)
    - `frequency` (string — e.g., "weekly", "monthly")
    - `edge_cases` (list of strings)
  - These results are returned in the `analysis` field of the Conversations API response and stored in `conversations.analysis` JSONB column
  - **Confirm ElevenLabs pricing tier** supports Conversation Analysis (Success Evaluation, Data Collection, transcript summary) — these may not be available on starter/free tier (PRD section 8.3)

- [ ] **Configure the ElevenLabs agent system prompt on the platform**
  - Set the base system prompt on the ElevenLabs platform agent configuration (PRD section 4):
    ```
    You are Fabric, a friendly and curious AI interviewer helping an organization
    capture how its business processes work. You are speaking with an employee who
    is about to describe their role in a specific process.

    Your job is to:
    1. Make the person feel comfortable — this is a conversation, not an interrogation.
    2. Ask them to walk you through what they do, step by step.
    3. Probe for detail: What tools do they use? Who do they depend on? How often
       do they do this? What happens when things go wrong?
    4. Listen for gaps — if something sounds incomplete, ask a follow-up.
    5. Keep the conversation focused on the process at hand.
    6. When the person seems done, summarize back what you heard and ask if
       anything was missed.

    Keep your responses concise and conversational. You are not lecturing —
    you are learning.
    ```
  - Set the agent language to `"en"` (English only for POC)
  - Dynamic context is injected at runtime via `useConversation` overrides (not baked into the platform prompt):
    - `Contributor: {{contributor_name}}`
    - `Process: {{function_name}} > {{department_name}} > {{process_name}}`
    - `What we already know about this process: {{existing_process_summary}}`
    - `Previous conversations from this contributor: {{prior_contributor_summaries}}`

- [ ] **Final UI polish and responsive verification**
  - Verify all shadcn/ui component styling is consistent and clean across the app
  - Test responsive breakpoints:
    - Desktop (≥ 768px): Miller columns layout with four panels visible simultaneously
    - Mobile/Tablet (< 768px): Stacked drill-down with back buttons at each level
  - Verify the recording modal works identically on mobile and desktop
  - Test all empty states display correctly and feel inviting
  - Verify the Process Summary Box is always visible and prominently styled (shadcn Card)
  - Test collapsible summary and transcript sections in the conversation log
  - Confirm all breadcrumbs display correct hierarchy paths
  - General visual cleanup: spacing, typography, color consistency, loading states

---

## Phase 9: Deploy & End-to-End Verification

- [ ] **Deploy frontend to Vercel**
  - Connect the repo to Vercel for automatic deployments
  - Configure environment variables on Vercel: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_ELEVENLABS_AGENT_ID`
  - Verify the app is served over **HTTPS** (required for `getUserMedia` / microphone access — Vercel provides this by default)
  - Confirm the deployed build runs without errors

- [ ] **Deploy Supabase Edge Functions and run seed data**
  - Deploy all four Edge Functions to Supabase:
    - `fetch-conversation`
    - `regenerate-process-summary`
    - `get-audio`
    - `post-call-webhook` (optional for POC, but good to have ready)
  - Set Edge Function environment secrets: `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`
  - Run `seed.sql` against the Supabase database to populate the organizational hierarchy and sample conversations
  - Verify Edge Functions are reachable and responding correctly

- [ ] **End-to-end verification against all 9 POC success criteria (PRD section 7)**
  1. **Three-click navigation**: Verify a user can navigate the org hierarchy in three clicks (desktop) or three taps (mobile) to reach any process
  2. **Voice conversation initiation**: Verify a user can initiate a voice conversation with the ElevenLabs agent from any process in the hierarchy
  3. **Consent notice**: Verify a consent notice ("This conversation will be recorded, transcribed, and stored") is shown before the first recording
  4. **Coherent contextual interview**: Verify the agent conducts a coherent, contextual interview about the selected process (uses contributor name, process context, existing summary)
  5. **Post-call data visible**: Verify that after the call, a transcript and summary are visible in the UI, with audio available for inline playback
  6. **Historical playback**: Verify a user can play back any historical conversation directly from the process detail panel via the Audio Player / Scrub Bar
  7. **Multi-contributor accumulation**: Verify multiple conversations from different contributors accumulate under a single process in the conversation log
  8. **Process Summary Box**: Verify a synthesized process summary box is visible at the top of each process and updates automatically with each new conversation
  9. **Mobile usability**: Verify the app is usable on mobile viewports (stacked navigation with back buttons) and desktop (Miller columns)
