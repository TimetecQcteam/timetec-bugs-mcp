# timetec-bugs-mcp — Initialization Guide

> Structured for slide generation — each `##` section below is one slide.
> Covers the three things you must set up before the MCP is usable.

---

## What you are setting up

Three pieces of initialization:

1. **TimeTec project credentials** — the login the MCP uses to read/file bugs.
2. **A SharePoint folder synced to your desktop** — where screenshots land so the
   MCP can hand back a shareable link for bug attachments.
3. **A manual fallback** — how to put a picture into SharePoint by hand and get
   the link yourself, for when the automated upload is unavailable.

All three are stored as environment variables on the MCP entry — no code changes.

---

## Part 0 — Two bug stores: which one for which product

Before the install, know **which bug store the product you're testing actually
uses**. The MCP can route to either, but the *user must say which* — the agent
will not guess.

| Store | Where it lives | Mostly used for | MCP tools |
|---|---|---|---|
| **Excel bug recording** | `PMV2- Test Result.xlsx` on QC Test SharePoint | **PMv2** (admin web) | `sheet_read`, `sheet_append_row`, `sheet_update_row` |
| **TimeTec project** | `dt.timeteccloud.com` (Live) / `dt-dev.timeteccloud.com` (SIT) | **Everything else** — Maintenance, HRv2, iNeighbour, iVizit, parking, etc. | `create_bug`, `list_bugs`, `search_bugs`, `update_bug`, `add_bug_comment` |

The split is **per-product, not per-environment** — PMv2 bugs go to the Excel
sheet whether you're testing on appuat or LIVE; Maintenance bugs go to the
TimeTec project whether SIT or Live.

### What the user must say when filing

Because both routes are wired into the same MCP, the agent needs the product
named explicitly:

✅ Good: *"File a bug against PMv2: …"* → routes to Excel
✅ Good: *"File a bug in TimeTec project for Maintenance: …"* → routes to `create_bug`
❌ Bad: *"File a bug: …"* → agent has to ask which store; pick the product first

If you genuinely want both (rare — e.g. a cross-product issue), say so
explicitly: *"File this in TimeTec project AND mirror it to the PMv2 Excel
sheet."*

### Why two stores

Historical: PMv2's QC verification log was already in Excel before the TimeTec
bug-tracker rollout, and migrating 900+ rows mid-flight would have broken
verification cadence. The two have coexisted ever since — same MCP, two
backends, one prompt convention to keep them straight.

> 🧭 **Routing default:** without an explicit product, the MCP defaults to
> asking. There is no fallback "if unsure, use X" — silence is treated as
> ambiguity. This is intentional (see [[feedback_student_mcp_bug_routing_confirm]]
> in student-mcp memory) — auto-filing to the wrong store creates duplicate
> tracking pain that's harder to clean up than asking once.

---

## Part 0.5 — Prompt-style: verify a bug by ID (both stores)

The MCP enforces a **hard block** at the tool level — the agent cannot log a
status change to either store without confirming with you first. So your job
when prompting is just: name the bug ID, name the store, and let the agent
walk the verification + ask before writing.

This section teaches the **prompt shape** that works on both stores. The
underlying status-update mechanics differ (covered below), but the prompt
you type stays roughly the same.

### The flow, regardless of store

```
you say:        "verify bug <ID> on <product>"
       ↓
agent:          fetches the bug (sheet_read for Excel, get_bug for TimeTec)
       ↓
agent:          surfaces Title + Steps + Expected Result so you confirm
                it's the right row
       ↓
agent:          reproduces the Steps in the live app — uses student-mcp
                rules for that module to ground the verification
       ↓
agent:          reports verdict — "still broken" / "fixed" / "not reproducible"
       ↓
HARD BLOCK:     agent must ask before any status write. Two-step prompt
                (want to update? → which value?)
       ↓
you confirm  →  agent writes per store-specific rules below
```

---

### Excel — prompt + confirmation flow

**Example prompts:**

> Verify bug **No. 655** on PMv2 — release **v26.5.1.x**.

> Re-check PMv2 bug **No. 655** against the current build. If fixed, prep to
> close it.

> Read bug **No. 655** from `Bug list`, then try to reproduce the Steps in
> PMv2 appuat.

What the agent does:

1. `sheet_read({ sheet_name: "Bug list", no: 655 })` — **always from `Bug
   list`**, never the release tab (release tabs have no Steps column).
2. Pulls the relevant `student-mcp` rules for the module the bug touches.
3. **Asks permission** before opening the app and reproducing.
4. After reproducing, reports verdict + asks the **two-step status prompt**:

   > Step 1: *"Want me to update row No 655's `Status` column? (yes / no)"*
   >
   > Step 2 (only if yes): *"Set `Status` to **Closed** or **Reopen**?"*

5. On `Closed`, the MCP **auto-pairs** `Date Closed by QC = <today>` for the
   `Bug list` write (see Part 4 for the exact auto-stamp rules).
6. **Asks which tabs to update.** Default is *both* (`Bug list` master +
   `v<release>.x` release tab), with status casing translated per tab:
   - `Bug list` → `Closed` / `Reopen` (proper case)
   - `v<release>.x` → `CLOSED` / `REOPEN` (uppercase) — and the `#` cell
     **auto-colors** per the rule below: `REOPEN` → red (`#FF0000`),
     `CLOSED` → green (`#20ff1c`). Only the `Status` cell and the `#`
     cell are touched on the release tab — every other column on that row
     is left alone (those belong to RnD / PM, not QC).
7. **Asks a final time** about a `QC Remark` on `Bug list` (yes/no), and if
   yes, prefixes the user's text with `QC Remark: ` and appends to the
   existing Remark cell.

> 🪪 **Why two-step.** The agent never auto-writes status based on its own
> verdict — the user owns the close/reopen decision. Even if the bug clearly
> still reproduces, the agent reports and asks. This is enforced in the MCP,
> not just a guideline (see Part 4 for the rationale).

---

### TimeTec project — prompt + confirmation flow

**Example prompts:**

> Verify bug **BG-1234** on Maintenance.

> Re-check TimeTec project bug **BG-1234**. If the fix held, ready it for live.

> Get bug **BG-1234**, reproduce the Steps from its description in the
> Maintenance SIT build, then ask me how to status it.

What the agent does:

1. `get_bug({ bug_id: "BG-1234" })` — fetches the bug record from
   `dt.timeteccloud.com` (Live) or `dt-dev.timeteccloud.com` (SIT) based on
   which MCP entry you addressed (`timetec-bugs-live` vs `timetec-bugs-sit`).
2. **Parses the Steps from the bug's `description` field** — TimeTec project
   bugs don't have separate Steps/Expected/Actual columns like Excel; the
   structured fields are embedded in the description body (per the standard
   bug template — Steps → Expected → Actual → Attachments).
3. Pulls relevant `student-mcp` rules for the module.
4. **Auto-claims the bug** to `QC - In Progress` if it's currently at
   `Ready For Testing` — this is a mechanical precondition (see *The
   QC - In Progress claim step* below), not a decision the user needs to
   make. Reports it: *"Claimed BG-1234 from Ready For Testing → QC - In
   Progress so I can verdict it afterward."*
5. **Asks permission** before reproducing.
6. After reproducing, reports verdict + asks the **two-step status prompt**:

   > Step 1: *"Want me to update bug BG-1234's status? (yes / no)"*
   >
   > Step 2 (only if yes): *"Set status to **Ready For Live** (verified
   > fixed) or **Reopen** (still broken)?"*

7. Calls `update_bug({ bug_id: "BG-1234", status: <value> })` — which hits
   `PATCH /bugs/BG-1234/status` with `{ new_status: <value> }`. The MCP then
   re-reads the bug to **verify the transition actually took effect** (the
   backend can accept the request but silently refuse the transition if the
   QC role lacks permission for that move — the MCP catches this and returns
   `current_status: <unchanged>` with an explanation).

**Status values on TimeTec project — accepted enum** (from
[`server.js:550`](server.js)):

```
"New", "Reopen", "QC - In Progress", "RND - In Progress",
"Ready For Testing", "Ready For Live", "Live", "Closed", "Rejected"
```

For QC-side verification, the two values that matter are:

| User intent | TimeTec project status |
|---|---|
| Bug is **fixed** — verified good | `Ready For Live` |
| Bug is **still broken** — reopen for RND | `Reopen` |

> 🪪 **Why "Ready For Live", not "Closed"?** In TimeTec project, **Closed**
> is a terminal state set by the manager/RND after the fix actually ships
> to Live. QC's verification verdict is "the fix held, ready to ship" —
> which is `Ready For Live`. Setting `Closed` from the QC side is usually
> rejected by the role gate (`current_status` returns unchanged).

---

### The QC - In Progress claim step (two-POST chain)

The QC-side verification flow is **two `update_bug` calls, not one**. A bug
at `Ready For Testing` cannot go directly to `Ready For Live` or `Reopen` —
the role gate requires it to be at `QC - In Progress` first. The MCP's
`update_bug` enforces this server-side; if you skip the claim, the second
write succeeds at the HTTP layer but the status doesn't actually change,
and the MCP returns:

```json
{
  "error": "Status did not change",
  "current_status": "Ready For Testing",
  "requested_status": "Ready For Live"
}
```

**The full QC transition graph** (from `update_bug`'s tool description):

| From | To | Who can do it |
|---|---|---|
| `Ready For Testing` | `QC - In Progress` | ✅ QC account |
| `QC - In Progress` | `Ready For Live` | ✅ QC account |
| `QC - In Progress` | `Reopen` | ✅ QC account |
| `Live` | `Closed` | ✅ QC account |
| `Reopen` | `Ready For Testing` | ❌ **RND account only** — ask dev to re-fix and move it back |
| `Ready For Live` | `Live` | ❌ **RND account only** — deploy + dev moves to Live |
| `New` | `RND - In Progress` | ❌ **RND account only** |
| Anything → `Ready For Testing` | | ❌ **RND account only** — QC cannot reset a bug for retest |

The dev account is documented in [[reference_sit_dashboard_dev_account]] —
use only when explicitly told *"login as dev account"*.

---

### Prompt-style — by transition scenario

**Scenario 1: Claim a bug (no verdict yet, just take ownership)**

> Please claim BG-1234 to QC - In Progress so I can start testing it.

> Move BG-1234 from Ready For Testing to QC - In Progress.

Agent action: single `update_bug({ bug_id: 1234, status: "QC - In Progress" })`.
No claim asks required — the user already named the target status explicitly.

**Scenario 2: Verdict a bug already at QC - In Progress**

> BG-1234 is fixed — set it to Ready For Live.

> The fix didn't hold for BG-1234. Reopen it.

Agent action: single `update_bug({ bug_id: 1234, status: <verdict> })`. The
agent should still surface a one-line confirm (*"Setting BG-1234 to Ready For
Live, confirm?"*) since this is a terminal-for-QC state, but no claim is
needed — the bug's already at QC - In Progress.

**Scenario 3: End-to-end verify-and-verdict (the common case)**

> Verify BG-1234. If it's fixed, set it to Ready For Live; if it's still
> broken, Reopen it.

Agent action:
1. `get_bug({ bug_id: 1234 })` → confirm Title + Steps.
2. If status is `Ready For Testing`, auto-claim via
   `update_bug({ status: "QC - In Progress" })` and report it.
3. (Reproduce — the verify step proper.)
4. Two-step status prompt: *"Want to update?"* → *"Ready For Live or Reopen?"*.
5. `update_bug({ status: <verdict> })`. Two POSTs total when starting from
   Ready For Testing; one POST if already at QC - In Progress.

**Scenario 4: Batch-claim all Ready For Testing bugs under one Task ID**

> 🚨 **Wait for the RnD signal before suggesting this.** Only batch-claim
> when **RnD has explicitly said the task's fixes are deployed and ready
> for QC to verify on live** (Slack, Teams, in-person — whatever your
> team uses). Without that signal:
>
> - Fixes may not be deployed yet → every verdict fails spuriously, queue
>   gets polluted with false `Reopen`s.
> - RnD may still be working bugs back-and-forth between `RND - In
>   Progress` and `Ready For Testing` → claiming mid-flight steps on
>   their work and creates merge-conflict-style status thrash.
> - Bugs may be at `Ready For Testing` from an *older* deploy that's no
>   longer the current build → verifying them now tests stale code.
>
> The agent should NOT proactively recommend batch-claim. It only kicks
> in when the user types something like *"RnD says task TS-RND-0530 is
> ready to verify on live"* or *"the fix for TS-RND-0530 is in — claim
> them all"*. If the user asks to batch-claim without mentioning the
> RnD signal, the agent must ask: *"Has RnD confirmed the fixes are
> deployed to live? I'd rather not claim until they have — otherwise
> verdicts may fail on stale code."*

When you sit down to verify a task's worth of bugs (one feature, one
sprint, one release) **and RnD has signalled the deploy is live**, claim
them all at once — but **always scoped to a specific Task ID**. The
recommendation is *task-scoped*, not "all my bugs"; an entire-backlog
sweep is almost never what you want (the queue mixes tasks, claiming
everything claims things you weren't going to test this session).

> Please claim every Ready For Testing bug under **task TS-RND-0530** to
> QC - In Progress.

> Batch-promote all Ready For Testing bugs in **TS-RND-0530** so I can
> start verifying that task.

Agent action:
1. `get_task({ task_id: 530 })` — returns the task with its associated
   `bugs[]` array (each entry has `bug_id`, `title`, `severity`,
   `status`). This is the source of truth for "which bugs belong to this
   task" — more reliable than filtering `list_bugs` client-side.
2. Filter the `bugs[]` array client-side to `status === "Ready For Testing"`.
3. Surface the count and titles: *"Task TS-RND-0530 has 8 bugs at Ready
   For Testing (out of 12 total). Claim all 8? (yes / no)"* — single
   confirmation, not per-bug.
4. On `yes`, iterate `update_bug({ bug_id, status: "QC - In Progress" })`
   for each. The MCP doesn't expose a batch endpoint today — it's sequential
   calls with the MCP's verify-after-write firing per bug.
5. Reports a final summary: *"Claimed 7/8. BG-1880 rejected (role-gate —
   already in non-QC state)."* Don't silently skip failures.

> 💡 **Why batch by task.** A task is the natural unit of QC work — bugs
> under one task ship together, were fixed in the same sprint, and get
> verified in one session. Batching by task means: queue stays sane (RND
> sees "QC is on task X" not "QC randomly claimed 40 bugs"), session scope
> stays clean, and the verdict pass at the end maps 1:1 to the task's
> sign-off.

> ❌ **Don't recommend whole-backlog batch.** *"Claim all my Ready For
> Testing bugs"* without a task scope is almost always wrong — it pulls
> in bugs from older tasks the user wasn't planning to verify, claims
> bugs they may want to defer, and inflates the QC - In Progress queue
> visibly to RND. If the user asks for it anyway, the agent should
> push back once (*"Want to scope to a Task ID instead? Otherwise I'll
> claim N bugs across M tasks — confirm?"*) before proceeding.

> ⚠️ **Filter scope.** Even with a task scope, `get_task` returns the
> task's bugs regardless of reporter — so a lead doing a sprint sweep
> doesn't need `include_all_reporters`. But the *claim* action still
> writes under the QC account's identity; if other testers are working
> the same task, coordinate first so two people don't both claim
> mid-flight.

---

### Quick reference — verdict → status value

| Store | "Bug is fixed" | "Bug still broken" |
|---|---|---|
| Excel `Bug list` | `Closed` (auto-stamps `Date Closed by QC`) | `Reopen` |
| Excel `v<release>.x` | `CLOSED` | `REOPEN` |
| TimeTec project | `Ready For Live` | `Reopen` |

The agent must translate the user's plain-English verdict into the
store-correct value at write time, not ask you to spell it out — but it
must still **confirm via the two-step prompt** before writing.

---

## Part 1 — TimeTec project credentials

### What they are

The MCP logs into the TimeTec bug tracker on your behalf. It needs **three values**:

| Variable | Meaning |
|---|---|
| `TIMETEC_BASE_URL` | Which environment to talk to |
| `TIMETEC_EMAIL` | Your TimeTec bug-tracker login email |
| `TIMETEC_PASSWORD` | That account's password |

### Two environments — separate accounts

| Environment | `TIMETEC_BASE_URL` | Use for |
|---|---|---|
| **Live** | `https://dt.timeteccloud.com` | Real bugs filed against shipping products |
| **SIT** | `https://dt-dev.timeteccloud.com` | Testing / staging bugs |

Each environment has its **own** account — Live and SIT credentials are not interchangeable.

---

## Part 1 — Which account to use

- Use **your own** TimeTec project account — the same email + password you use to
  log into the bug-list website by hand.
- The MCP only surfaces bugs whose **reporter = this account** (`list_bugs`,
  `search_bugs`). Other people's bugs are hidden unless you pass
  `include_all_reporters: true`.
- The account is **QC-side**: bug status changes are role-gated, so only
  QC-allowed transitions will succeed.
- **Recommended:** register the MCP twice — one entry per environment:
  - `timetec-bugs-live` → Live account
  - `timetec-bugs-sit` → SIT account

---

## Part 1 — Entering the credentials

Run the installer from the `timetec-bugs-mcp` folder:

```
install.cmd                                  →  entry "timetec-bugs"
powershell -File install.ps1 -Name timetec-bugs-sit
powershell -File install.ps1 -Name timetec-bugs-live
```

It prompts for **environment → email → password** (password input is hidden).
Re-run any time to change them — old values appear as defaults, Enter keeps them.

**Restart Claude Code** after installing so the entry loads.

### Prompt-style install — from a GitHub link (no local clone yet)

If you don't have the repo on disk yet, give the agent just the GitHub
URL and let it handle the clone + install in one prompt. This is the
shortest path from zero to a working MCP entry.

> 🪧 **Git is required.** This flow runs `git clone` under the hood.
> If you don't have `git` installed, Claude Code will surface a *"git
> is not recognised"* error during the clone step and prompt you to
> install it. **Install it** — there's no fallback path. Download from
> <https://git-scm.com/download/win> (Windows) and accept the default
> options; the installer adds `git` to your PATH. Once installed, ask
> the agent to re-run the original prompt — it picks up from the clone
> step. If you'd rather avoid installing git entirely, download the
> repo as a ZIP from GitHub, extract it, and use the
> *already-cloned* prompt-style install below instead.

**Example prompts:**

> Please install timetec-bugs-mcp from
> <https://github.com/TimetecQcteam/timetec-bugs-mcp> into
> `C:\Users\Low Mun Hou\Testing\timetec-bugs-mcp`. Live environment,
> my account.

> Install this MCP for me: <https://github.com/TimetecQcteam/timetec-bugs-mcp>.
> Use a temp folder — I don't need it permanent.

What the agent does:

1. **Confirms the repo URL is one of the trusted sources** — the official
   TimetecQcteam org repo. The agent should NOT clone arbitrary URLs
   without checking; ask the user to confirm if the URL looks unfamiliar.
2. **Resolves the target directory:**
   - If you named one (`into C:\path\...`), use that. Reject if the path
     already exists with files in it (don't clobber an existing clone).
   - If you said *"temp folder"* or didn't specify, use
     `C:\Users\LOWMUN~1\AppData\Local\Temp\timetec-bugs-mcp-<short-hash>`.
   - **Recommendation**: prefer a stable path you'll remember — temp
     folders get wiped by Disk Cleanup / reboots, which can break the MCP
     registration silently.
3. **Clones** the repo:
   ```
   git clone https://github.com/TimetecQcteam/timetec-bugs-mcp <target-dir>
   ```
   On clone failure (404, network, permission), reports the exact `git`
   error and stops — does not fall back to other URLs.
4. **Hands off to the local-path install flow below** — same agent
   actions from Step 2 of the next section: ask for environment + email
   + password, run `install.ps1`, verify creds, register the MCP entry.
5. **Reminds you to restart Claude Code** before the entry goes live.

> 🔒 **Trust check.** Only clone from repos you control or trust. An
> MCP entry runs `server.js` on your machine with your credentials — a
> hostile repo can read your TimeTec password, OneDrive paths, and
> anything else passed to the installer. If you're unsure about a URL,
> decline and run `install.cmd` from a manually-vetted clone instead.

> 🧹 **Temp folder cleanup.** If you went with the temp option and want
> to remove the install later, you have to do both: (a) delete the
> folder, AND (b) remove the entry from `~/.claude.json`'s `mcpServers`
> map. The folder alone leaves a dangling MCP registration that will
> error on the next Claude Code startup.

---

### Prompt-style install (ask Claude to do it)

If you already have Claude Code running and just cloned the repo, you
can skip the interactive installer by prompting:

> Please install timetec-bugs-mcp from
> `C:\path\to\timetec-bugs-mcp` for the **Live** environment, account
> `xavier.low@timeteccloud.com`. I'll give you the password when you
> ask.

What the agent does:

1. Folder sanity check (`install.ps1`, `server.js`, `package.json`)
2. Asks you — via the harness's question UI — for **environment**
   (Live / SIT / Custom URL), **email**, and **password**. Password is
   collected via the secure question prompt, not echoed in chat
3. Runs the installer non-interactively with every value as a flag:
   ```
   powershell -ExecutionPolicy Bypass -File install.ps1 `
     -Name timetec-bugs-live `
     -Environment Live `
     -Email xavier.low@timeteccloud.com `
     -Password '<collected from you>'
   ```
4. **Installer verifies the creds against the TimeTec login endpoint
   before persisting them** (no domain whitelist — the actual auth
   call IS the gate). If login fails, the installer exits with a
   *"Login failed for `<email>` — credentials rejected by `<baseUrl>`"*
   message
5. On installer-side login failure, the agent **re-asks** you for the
   credentials and re-runs Step 3 — looping until login succeeds. Any
   typo, expired password, or wrong account routes back to you without
   leaving a half-configured entry on disk
6. Repeats Steps 2–5 for the **SIT** account if you also want SIT
   registered (entry name `timetec-bugs-sit`, base URL
   `https://dt-dev.timeteccloud.com`)
7. Optionally asks for OneDrive/SharePoint paths to wire Part 2 in
   the same install (passed as `-OneDriveSyncFolder` and
   `-SharepointBaseUrl`)
8. Reminds you to **restart Claude Code** before the entry goes live

Every installer prompt has a matching parameter — pass any subset to
override, leave the rest to fall back to the interactive flow:

| Installer parameter | Replaces this prompt |
|---|---|
| `-Environment Live` / `-SIT` / `-Custom` | Environment picker (1/2/3) |
| `-BaseUrl <url>` | Custom URL (only with `-Environment Custom`) |
| `-Email <addr>` | Email |
| `-Password <pw>` | Password (the hidden one) |
| `-AdbPath <path>` | ADB path |
| `-OneDriveSyncFolder <path>` | OneDrive sync folder |
| `-SharepointBaseUrl <url>` | SharePoint base URL |

> 🔒 **Password handling.** Passing `-Password` puts the value on the
> PowerShell command line. PowerShell's history is usually disabled
> for sensitive flags but it CAN be visible to `Get-Process` /
> `tasklist` during the few seconds the installer runs. If that's a
> concern, decline the agent's offer and run `install.cmd` yourself
> — the hidden `Read-Host` is safer.

---

## Part 2 — Why a SharePoint folder is needed

The media tools (`pull_photos`, `pull_pc_media`) attach screenshots to bugs.
A bug attachment must be a **web link**, not a local file — so the flow is:

```
screenshot  →  copied into a OneDrive-synced folder
            →  OneDrive uploads it to SharePoint
            →  MCP returns a SharePoint link
            →  link goes into the bug as an attachment
```

Two environment variables make this work — they are **two views of the same folder**:

| Variable | What it is |
|---|---|
| `ONEDRIVE_SYNC_FOLDER` | The folder's **local path** on your PC |
| `SHAREPOINT_BASE_URL` | The same folder's **web address** in SharePoint |

---

## Part 2 — Step 0: Get SharePoint access (new testers only)

Before you can sync any folder, your Microsoft account needs **Edit access** to
the QC Test SharePoint site. New testers don't have this by default.

**What to do:**

1. **Try opening the site first** — paste this URL in your browser while signed
   in to your TimeTec Microsoft account:
   `https://timeteccloud0.sharepoint.com/sites/QCTest`
2. **If it loads** → skip to Step A. You're already in.
3. **If you see "Access denied" or "Request access"** → click the **Request
   access** button SharePoint shows. In the message box, write something like:

   > Hi, I'm a new tester (\<your name\>) being onboarded into the QC team.
   > Please grant me Edit access to the QCTest site so I can upload bug
   > screenshots via OneDrive sync.

4. **Ping whoever already has access** in person / on Teams so the request
   doesn't sit in their email — usually your team lead, the QC team owner, or
   anyone currently using timetec-bugs-mcp. Ask them to **approve the request
   and grant Edit (not just Read)** — Read-only can't upload, which silently
   breaks `pull_pc_media`.
5. **Wait for the approval email** (usually minutes — Microsoft mails you when
   access is granted). Re-open the site URL to confirm.

> 🪪 **Why "Edit"?** Read access lets you view files but blocks OneDrive sync
> from uploading new ones. The sync just silently fails on upload — no error,
> just files that never get a green check. If `pull_pc_media` returns a link
> but the link 404s, this is almost always the cause.

Once you can open the site and see the **Documents** library, continue to
Step A below.

---

## Part 2 — Step A: Create the folder in SharePoint

1. Open the SharePoint site in a browser — e.g. the QC Test site:
   `https://timeteccloud0.sharepoint.com/sites/QCTest`
2. Open the **Documents** library.
3. Click **+ New → Folder**.
4. Name it something personal and unique (e.g. your name — `Xavier Low`).

This folder will hold every screenshot the MCP uploads.

---

## Part 2 — Step B: Sync the folder to your desktop

1. In the SharePoint **Documents** library, click **Sync** in the toolbar
   (or **Add shortcut to OneDrive**).
2. The OneDrive desktop client pulls the library down and shows a green check.
3. It now appears in File Explorer under your org's OneDrive root, e.g.:

   ```
   C:\Users\<you>\TimeTec Cloud Sdn Bhd\QC Test - Documents\<your folder>
   ```

4. That full path → this is your **`ONEDRIVE_SYNC_FOLDER`**.

> The OneDrive client must be **running and signed in** for uploads to work.

---

## Part 2 — Step C: Get the folder's web link

1. In SharePoint (browser), open **into** your folder.
2. Copy the URL from the address bar, keeping it up to and including the folder name.
3. Strip any `?` query string. The result is your **`SHAREPOINT_BASE_URL`**.

**Example pair (currently configured):**

```
ONEDRIVE_SYNC_FOLDER = C:\Users\Low Mun Hou\TimeTec Cloud Sdn Bhd\QC Test - Documents\Xavier Low
SHAREPOINT_BASE_URL  = https://timeteccloud0.sharepoint.com/sites/QCTest/Shared%20Documents/Xavier%20Low
```

Spaces in the URL must be `%20`. `Documents` shows in the URL as `Shared%20Documents`.

---

## Part 2 — Step D: Save both values & verify

1. Re-run the installer — at the **OneDrive sync folder** and **SharePoint base URL**
   prompts, paste the two values from Step B and Step C.
2. **Restart Claude Code.**
3. Verify: run `pull_pc_media` (or `pull_photos`). A returned `attachment_links`
   URL that opens the image in a browser = setup is correct.

### How the link is built

```
final link  =  SHAREPOINT_BASE_URL  +  "/"  +  <filename, spaces as %20>
```

The MCP waits for OneDrive to finish syncing before handing the link back, so the
URL is live the moment you receive it.

---

## Part 3 — Manual fallback: upload a picture yourself

Use this when the automated upload **can't produce a link**, e.g.:

- The OneDrive client is not running / not signed in.
- The sign-in token has expired and sync is stalled.
- The MCP tool times out, or you just want to attach an image by hand.

**Goal:** put the picture into the *same* SharePoint folder and get a link in the
*same* format the MCP would have returned.

---

## Part 3 — Method A: via the synced desktop folder

Fastest if OneDrive sync is healthy.

1. Copy or save the screenshot into the local synced folder:
   `C:\Users\<you>\...\QC Test - Documents\<your folder>\`
2. Wait for the file to show a **green check** in File Explorer (sync done).
3. Build the link by hand:

   ```
   SHAREPOINT_BASE_URL  +  /  +  filename
   e.g.  https://timeteccloud0.sharepoint.com/sites/QCTest/Shared%20Documents/Xavier%20Low/bug123.png
   ```

4. Replace every space in the filename with `%20`. Paste the link into the bug.

---

## Part 3 — Method B: via the SharePoint website

Use this when OneDrive sync itself is broken — the browser bypasses it entirely.

1. Open your folder in SharePoint:
   `https://timeteccloud0.sharepoint.com/sites/QCTest` → **Documents** → your folder.
2. **Drag the picture** into the file list, or click **Upload → Files**.
3. Get the link — two options:
   - **Direct path link** (matches the MCP format): take `SHAREPOINT_BASE_URL`,
     append `/` and the filename (`%20` for spaces).
   - **Copy link button**: select the file → **Copy link** → set access to
     *People in your organization* → **Copy**. This is a longer tokenised URL but
     works the same in a bug.
4. Paste the link into the bug's attachment field.

---

## Part 4 — Verification workflow (Bug list ↔ release tabs)

The `PMV2- Test Result.xlsx` workbook has **two kinds of tabs**, with
different schemas — agents must treat them differently:

| Tab | Naming | Identifier column | Purpose | Carries Steps / Expected / Actual? |
|---|---|---|---|---|
| **`Bug list`** | literal `Bug list` | `No` | Master bug detail store | ✅ Yes — full detail |
| **Release tab** | `v<version>.x` (e.g. `v26.5.1.x`, **note the leading `v`**) | `#` | Release notes for that build | ❌ No — only Title (in `Modules`), Status, dev/QC owner, change summary, dates |

A bug is a row on `Bug list` **and** a corresponding row on the relevant
`v<release>.x` tab. The two must stay in sync, but the *content* is
different — Steps to reproduce only ever live on `Bug list`.

### Release tab internal structure — verified layout

A release tab like `v26.5.1.x` is **not** a flat list. Each sub-version is
its own section split into **two halves** by a `Bug Fix*` marker row: the
upper half lists release tasks (verified by `sheet_get_release_modules`),
the lower half lists individual bug titles (verified by the future Bug list
flow). Verified layout, captured from the live workbook 2026-05-26:

```
v26.5.1.x  tab
├─ Version: │ Status: v26.5.1.2          ← sub-version header row
│  ├─ TS-RND-2638  E-Form - Add/Edit role share ...   ┐
│  ├─ TS-RND-3055  Building -> Unit - Add User ...    │
│  ├─ TS-RND-3068  Entrypass Integration              ├─ RELEASES (above)
│  ├─ TS-RND-3274  Dashboard - E-info ...             │
│  └─ TS-RND-0024  Report Module ...                  ┘
│  ├─ Bug Fix                                         ← boundary (QC scope)
│  ├─ 108   PM V2 - User - Admin Management ...       ┐
│  ├─ 109   ...                                       ├─ BUG TITLES (below,
│  └─ ...                                             │   QC verifies these
│  └─ Bug Fix Support & PDT                           ┘   in Bug list flow)
│                                                     ─── below this: IGNORE
├─ Version: │ Status: v26.5.1.1          ← next sub-version header
│  └─ ... same structure ...
```

**Verified parsing rules:**

| Element | How it actually appears in the sheet |
|---|---|
| Sub-version header | `# == "Version:"` literal, `Status == "v26.5.1.2"`. The version string lives in the **Status column**, not `#`. |
| Release row | `# == "TS-RND-NNNN"` (task ID). Carries Modules + Changes Summary. |
| QC bug-fix boundary | `#` cell **contains** `"Bug Fix"` (variants: `Bug Fix`, `Bug Fix QC`). Marks the end of releases / start of bug titles. |
| Bug-title row | `#` is numeric (e.g. `108`, `109`). Carries Modules + Changes Summary; verified by the Bug list flow, not this tool. |
| Out-of-scope boundary | `#` cell contains `"Bug Fix"` AND any of `Support` / `PDT` (e.g. `Bug Fix Support & PDT`). Everything below this row is **ignored entirely** (not in QC's verification scope). |
| Empty padding | All cells blank — skipped. |

The version `v` prefix is mandatory. The parser rejects bare `26.5.1.2`
with `invalid_release_version` so you catch the typo before it silently
hits a missing tab.

> 🧱 **Note to RnD team — could you keep this layout stable?** The
> `sheet_get_release_modules` parser hard-codes these conventions (version
> in the Status column, `Bug Fix*` as the release/bug boundary, `Support`
> or `PDT` in a Bug Fix marker as the ignore-below cutoff). If the
> workbook conventions change — e.g. the version string moves to a
> different column, or a new boundary marker is introduced — the parser
> will silently return wrong data (empty section, or releases mixed with
> bug titles). It's a quiet failure mode, not a loud one. **Suggestion**:
> if the layout needs to change, give QC a heads-up so the parser can be
> updated in the same release — otherwise verification flows will look
> like they work but the data will be off.

### Prompt-style — verify a release's modules (`sheet_get_release_modules`)

When a user wants to verify a specific release before sign-off, the entry
point is `sheet_get_release_modules`. It encapsulates: tab routing,
section parsing, table rendering, and the **enforced next-step prompt**.

**Example prompt:**

> Please give me modules to verify in release **v26.5.1.2**.

What happens under the hood:

1. Tool validates the version format — must match `/^v\d+\.\d+\.\d+\.\d+$/`.
   `v26.5.1.2` ✅, `26.5.1.2` ❌, `v26.5.1` ❌.
2. Tool derives the parent tab: strip the last segment, append `.x` →
   `v26.5.1.x`. (Tab routing is automatic; the agent never has to compute
   this.)
3. Tool reads the whole release tab once, walks rows to find the section
   whose `Status` cell equals `v26.5.1.2` (with `# == "Version:"`), then
   collects every `TS-RND-NNNN` row that follows — **stopping at the first
   row whose `#` contains `"Bug Fix"`** (which separates releases from bug
   titles).
4. Tool **returns these payloads:**
   - `table_markdown` — 3-column markdown table (`#`, Modules, Changes
     Summary) the agent renders verbatim to the user.
   - `prompt_to_user` — the enforced next-step block (see below).
   - `end_reason` — `"bug_fix"` / `"next_version"` / `"end_of_tab"`, why
     scanning stopped.
   - `end_marker` — verbatim text of the boundary row (e.g. `"Bug Fix"`,
     `"Bug Fix Support & PDT"`).
   - `bug_titles_scope` — `"qc"` / `"support_pdt"` / `null`. Routes the
     future Bug list flow: `"qc"` means bug rows below are in-scope for
     verification; `"support_pdt"` means ignore them entirely.

**Sample response (real, from `v26.5.1.2`):**

```
| #            | Modules                                                   | Changes Summary               |
|--------------|-----------------------------------------------------------|-------------------------------|
| TS-RND-2638  | E-Form - Add/Edit role share with 'Master Tenant', ...    |                               |
| TS-RND-3055  | Building -> Unit - Add User Member Drawer for Unit Owner  | *Residential only             |
| TS-RND-3069  | E-Document Enhancement                                    | General/Unit/Unit Details tab |
| TS-RND-3068  | Entrypass Integration                                     | Settings, Access Control, ... |
| TS-RND-3274  | Dashboard - E-info, Notice, E-doc, E-form, Emergency      | Admin only                    |
| TS-RND-0024  | Report Module                                             | Generate Report :: ...        |
```

7 release rows, `end_marker: "Bug Fix"`, `bug_titles_scope: "qc"` — the
boundary was a plain `Bug Fix` (QC scope), so the bug rows below are
in-scope for the (future) Bug list flow but **not** returned by this tool.

### The enforced next-step block (server-side)

After returning the table, the tool's `prompt_to_user` field instructs the
agent to:

1. **Surface the table verbatim** to the user — no summarising, no editing.
2. **For each unique module** in the table, call student-mcp's `recall`:
   ```
   recall({ app: "pmv2", module_contains: "<module>", full: false })
   ```
3. **Report per-module**: `FOUND (<N> rules)` or `NOT FOUND`.
4. **For every NOT-FOUND module**, ASK the user, verbatim:
   > *"Module '\<name\>' has no rules in student-mcp yet. Do you want me to (a) DISCOVER the module first via student-mcp before verifying the release changes, or (b) verify the release changes MANUALLY without prior knowledge? Pick a/b."*
5. **Do NOT begin verification** until every NOT-FOUND module has been
   adjudicated.

> 🛡️ **Server-side enforcement.** The `prompt_to_user` field is part of
> every successful response — the agent is required to follow it before
> any verification step. Skipping the knowledge-check risks verifying
> against guessed behaviour instead of grounded rules. This mirrors the
> enforcement pattern used by student-mcp's `recall_srs` and
> `report_knowledge_mismatch`.

### Failure modes — what to do when it fails

| Error code | Meaning | Fix |
|---|---|---|
| `invalid_release_version` | Missing `v` prefix or wrong segment count | Re-prompt with the correct format (`v26.5.1.2`, not `26.5.1.2`) |
| `flow_call_failed` (HTTP 504) | Power Automate flow returned `UnexpectedError` | Most common cause: workbook is open in Excel desktop in edit mode (locks the script session). Close it. Other causes: throttling, BugSheetOp runtime error — check the flow's Run history. |
| `tab_read_failed` | Derived tab doesn't exist in the workbook | Verify the parent release tab (`v26.5.1.x`) was created — usually new majors get a fresh tab |
| `section_not_found` | Tab exists but the requested sub-version header isn't in it. Scanned-row count is in the message. | Open the workbook, scan the `Status` column on `Version:` rows for the exact `v*.*.*.*` string; case-sensitive. Common cause: the version exists but is one tab over (e.g. you asked for `v26.5.1.5` which is in `v26.5.1.x`, but it hasn't been added yet). |
| `empty_section` | Header found but no `TS-RND-*` rows above the Bug Fix marker | Either nothing has been logged for that sub-version yet, or the Bug Fix marker appears immediately below the header (section is empty by design) |
| `missing_required_columns` | The tab is missing `#`, `Modules`, or `Changes Summary` | Schema drift — surface to the workbook owner, don't auto-fix |

> 🧠 **Reading the `bug_titles_scope` field.** Even on success, check this
> field before triggering downstream Bug list verification:
> - `"qc"` → bug rows below the boundary are in QC scope, verify them.
> - `"support_pdt"` → bug rows below are Support/PDT noise; do NOT pull them.
> - `null` → boundary wasn't a Bug Fix row (`end_reason` was
>   `"next_version"` or `"end_of_tab"`); no bug rows exist for this section.

### Verification reads MUST come from `Bug list`

Release tabs **do not** have `Steps`, `Expected Result`, or `Actual
Result` columns. Reading the release tab to fetch reproduction steps is
a category error — those fields aren't there.

```
sheet_read({ sheet_name: "Bug list", no: 655 })
  → full row: { No, Title, Steps, Expected Result, Actual Result, Status, ... }
```

The release tab is **only** useful for the release-context columns:
`Project`, `Modules`, `Changes Summary`, `Changes Details`, `Ready to Test
In (SIT)`, `Planned Release Date (Live)`, `Developer In Charge`,
`QC In Charge`, `Status`.

### How reads are scoped — one row at a time, keyed by the identifier column

**Rule: always pass a `No` (or `#`).** `sheet_read` is intended for
*single-row* reads. The identifier column is column A — labelled `No`
on `Bug list` and `#` on every `v<release>.x` tab. Either way it's the
first column.

```
sheet_read({ sheet_name: "Bug list",   no: 655 })   // row keyed by No=655
sheet_read({ sheet_name: "v26.5.1.x",  no: 655 })   // same key matches '#'=655
```

Users can also ask by **`Module`** — e.g. *"read the `Visitor` row from
`v26.5.1.x`"* — but the lookup is still single-row: ask the user for
the specific `#` once you have a `Module` hint, not iterate the tab.

### Header-row anchoring (handled automatically)

Release tabs aren't a flat header + rows layout — they prepend section
markers (`Bug Fix`, etc.) and sometimes start the header on row 2
instead of row 1. The Office Script scans column A for the first cell
containing the identifier label (`No` or `#`) and treats that row as
the headers. Every success response surfaces where the scan landed:

```
{
  "success": true,
  "headerRow": 1,      // 1-based row in Excel — handy for sanity-checking
  "idColumn":  "#",    // which label was matched
  ...
}
```

If `headerRow` comes back as something unexpected, the script picked up a
stray `No` / `#` cell — flag the tab to the user, don't auto-correct.

> ⚠️ **Do NOT omit `no` on any tab.** Calling
> `sheet_read({ sheet_name: "v26.5.1.x" })` with no key dumps the whole
> tab. The `Bug list` tab alone holds **900+ rows (~1 MB+ of JSON per call)**.
> Two things will go wrong:
>
> 1. **Model-context flood** — the response exceeds the assistant's token
>    limit and gets shunted to a side file, so the agent can no longer
>    reason over the rows inline.
> 2. **Power Automate throttling** — the underlying flow has per-minute and
>    per-24-hour run/quota caps on its tier. Repeated whole-tab pulls (or a
>    tight `1..N` scan loop) **will trip throttling** and return HTTP 429
>    mid-run, breaking any verification pass in flight.
>
> If you need to discover which `No`s exist, ask the user — they're sitting
> in the spreadsheet anyway — rather than scanning the tab from the agent.

### Prompt-style usage

The most natural way to ask — short, in your own words:

> Can you fetch bug **No. 655** at release **`v26.5.1.x`** to check if
> it still happens?

Or, more explicit when you want the verification grounded in taught
behaviour:

> Please read row **No 655** from `Bug list` (release `v26.5.1.x`),
> then verify the bug's *Steps* against the current PMv2 build using
> student-mcp knowledge for `<module>`. Ask my permission before
> reproducing.

What the agent does:

1. Calls `sheet_read({ sheet_name: "Bug list", no: 655 })` — **read from
   the master tab, NOT the release tab** (the release tab lacks Steps).
2. Surfaces the bug's **Title**, **Steps**, and **Expected Result** so
   you can confirm it's the right row.
3. Pulls the relevant student-mcp rules for the module the bug touches
   (`recall` / `audit_path`) so the verification is grounded in the
   currently-taught behaviour, not a blind re-run.
4. **Stops and asks for permission** before reproducing —
   e.g. *"Reproduce these steps in PMv2 now? Reply yes / no."*
5. Only on confirmation does it open PMv2, follow the Steps, and report
   *still-broken / fixed / not-reproducible* against the Expected Result.
6. **After reporting the result, ALWAYS ask the user — in two steps —
   whether to update the row's `Status` column.** The agent must NOT
   auto-update and must NOT skip either prompt.

### Strict rule — two-step Status update prompt

After **every** verification pass, the agent must ask, in this order:

**Step 1 — ask if they want to update at all.**

> *"Want me to update row No \<N\>'s `Status` column? (yes / no)"*

If the answer is **no**, do nothing — don't call `sheet_update_row`,
don't infer a status, don't leave a "noted" comment elsewhere. The row
stays exactly as it is.

**Step 2 — only if Step 1 was yes, ask which value.**

> *"Set `Status` to **`Closed`** or **`Reopen`**?"*

### Status value casing differs per tab

The two tabs use **different casing** for the same logical status —
each matches what's bound to that tab's data-validation dropdown. Sending
the wrong case breaks the dropdown and breaks any downstream filter
referencing the value:

| Tab | `Status` accepted values |
|---|---|
| `Bug list` | `Closed`, `Reopen` (proper case) |
| `v<release>.x` | `CLOSED`, `REOPEN` (uppercase) |

When the user picks one logical value, the agent must translate per
tab. On confirmation, write to **both tabs** — `Bug list` (master) AND
`v<release>.x` (release note) — in two calls with the correct casing
each:

```
// User said "Reopen":
sheet_update_row({ sheet_name: "Bug list",   no: <N>, values: { Status: "Reopen" } })
sheet_update_row({ sheet_name: "v26.5.1.x",  no: <N>, values: { Status: "REOPEN" } })

// User said "Closed":
sheet_update_row({ sheet_name: "Bug list",   no: <N>, values: { Status: "Closed" } })
sheet_update_row({ sheet_name: "v26.5.1.x",  no: <N>, values: { Status: "CLOSED" } })
```

Updating only one leaves the two views out of sync.

This two-step shape is non-negotiable, even when the answer seems
obvious (e.g. sheet already says `Closed` and the fix clearly held, or
the bug clearly still reproduces). The user owns the status decision;
the agent's role is to report and ask. Auto-writing `Status` based on
the agent's own verdict is forbidden — bug status is a QC-ownership
boundary, not a tool-side inference.

### Auto-stamp — `Date Closed by QC` on `Closed` (Bug list only)

When `sheet_update_row` is called with `values.Status` matching `Closed`
(case-insensitive — covers both `Closed` and `CLOSED`) **and** the
caller didn't pass `Date Closed by QC` in the same payload, the MCP
automatically pairs in `Date Closed by QC = <today's Excel serial>` so
the QC verification date is recorded without an extra round-trip.

```
// Caller passes only:
sheet_update_row({ sheet_name: "Bug list", no: 655, values: { Status: "Closed" } })

// Tool actually sends to the flow:
{ Status: "Closed", "Date Closed by QC": 46190 }   // 46190 = today
```

### Auto-color — `#` cell on release-tab Status writes (release tabs only)

The mirror rule to the `Bug list` auto-stamp. When `sheet_update_row` is called
on a **release tab** (any `sheet_name` other than `Bug list`) with
`values.Status` set to `REOPEN` or `CLOSED` (case-insensitive), the MCP
auto-injects a `colors` payload to paint the row's `#` cell:

| Status written | `#` cell colour |
|---|---|
| `REOPEN` | 🟥 `#FF0000` (red) |
| `CLOSED` | 🟩 `#20ff1c` (green) |

Other Status values (e.g. `IN PROGRESS`) → no auto-color. Pass an explicit
`colors` argument to override; pass `colors: {}` to suppress the auto-color
on a release-tab Status write you don't want painted.

```
// Caller passes only:
sheet_update_row({ sheet_name: "v26.5.1.x", no: 655, values: { Status: "REOPEN" } })

// Tool actually sends to the flow:
{
  values: { Status: "REOPEN" },
  colors: { "#": "#FF0000" }
}
```

> 🎨 **Rule: only `Status` and the `#` cell are touched on release tabs.**
> The verify-and-verdict flow does NOT write `Remark`, `QC In Charge`,
> `Changes Summary`, or any other release-tab column — those belong to
> RnD / PM, not QC. The `Bug list` master tab is where Remark / Date Closed
> live; the release tab is a release-notes view that just needs the colour-
> coded Status flip.

> ⚙️ **End-to-end dependency.** The auto-color only renders if the
> Power Automate flow's *"Run Script"* action has the `colorsJson` input
> bound to `triggerBody()?['colorsJson']`. If you migrate `BugSheetOp.ts`
> or rebuild the flow, re-check that binding — without it, the MCP sends
> the colour payload but the script never receives it (writes still
> succeed; colours just don't apply).

> ℹ️ **Auto-stamp is gated to `Bug list` only.** Release tabs
> (`v26.5.1.x`, etc.) don't have a `Date Closed by QC` column — their
> schema is Project / Modules / Changes Summary / Ready to Test In (SIT)
> / Planned Release Date (Live) / Developer In Charge / QC In Charge /
> Remark. The tool detects the target tab from `sheet_name` (defaulting
> to `Bug list` when omitted or set to `"Bug list"`); the auto-stamp
> fires only on that tab. On any other `sheet_name`, only `Status` is
> sent — `Date Closed by QC` is NOT injected, so the release-tab write
> succeeds cleanly.

Explicit `Date Closed by QC` from the caller always wins — pass it in
the same payload to override (e.g. backfilling a historical close
date). The auto-stamp is **only** triggered by a closed-equivalent
Status value; setting `Status` to `Reopen` / `REOPEN` does NOT touch
the date column.

### Step 3 — offer to leave a QC Remark on `Bug list`

After the Status update (or after the user says "no" to a status
change), the agent must ask one more thing:

> *"Want to leave a `QC Remark` on the `Bug list` row? (yes / no)"*

If yes, collect the wording from the user and write it to the `Remark`
column on the **`Bug list` tab** (not the release tab — Remark history
is consolidated on the master), always prefixed with `QC Remark: `:

```
sheet_update_row({
  sheet_name: "Bug list",
  no: <N>,
  values: { Remark: "QC Remark: <user-supplied wording>" }
})
```

The `QC Remark: ` prefix is mandatory — it makes the remark
distinguishable from dev/manager notes elsewhere in the Remark cell.
If the cell already has content, ask whether to **append** (recommended
— preserves history) or **overwrite** before writing.

### Operational note — Power Automate Office Script

The MCP sends `sheetName` in its request body, but the **deployed**
`BugSheetOp` Office Script in the Power Automate flow must also accept
it as a parameter and the flow's *Run Script* action must pass it
through, otherwise writes fall back to `Bug list` regardless of the
`sheet_name` argument. The current canonical source is at
[`BugSheetOp.ts`](../../../Desktop/BugSheetOp.ts) (function signature:
`main(workbook, action, rowNo, valuesJson, sheetName, colorsJson)`).
If your release-tab writes keep landing in `Bug list`, redeploy the
script to the flow and re-bind the `sheetName` input on the *Run
Script* step.

**Any tab name works except `Bug list`.** The default `Bug list` tab is
reserved for the bug-filing flow (`create_bug`, `sheet_append_row` etc.)
and should be driven through the bug-routing prompt, not through this
read-and-verify shortcut. Always pass an explicit release tab name like
`26.5.1.x`.

> 🔒 **PMv2-only.** The sheet reader is hard-wired to the PMv2 Bug list
> workbook (`PMV2- Test Result.xlsx`) via a single Power Automate flow.
> It cannot read sheets for other products (TimeTec Maintenance, HRv2,
> iNeighbour, etc.). If your team needs a similar read-and-verify flow
> for another product's spreadsheet, **ask the IT team to provision a
> separate Power Automate flow** for that workbook — it's not something
> the MCP can route to on its own.

---

## Part 5 — Prompt patterns: upload latest media on demand

Once Parts 1-3 are wired, the agent can pull the **latest** photo/video from
either your phone or your PC and return a OneDrive link in one prompt. This
section teaches the prompt shapes that actually work — the agent won't auto-pick
the source if your wording is ambiguous.

### Two sources, two tools, one decision

| Source | Tool | When to use |
|---|---|---|
| **Your phone** (Android via ADB, iOS via AFC) | `pull_photos` | You just took a screenshot on your test device |
| **Your PC** (`C:\Users\Low Mun Hou\Pictures\Screenshots`) | `pull_pc_media` | You used Win+Shift+S or PrtSc on the desktop |

The wording in your prompt picks the source. The agent should **never assume**
when the source isn't obvious — it asks.

### Prompt-style — latest screenshot from phone

> Pull the latest screenshot from my phone.

> Send me the OneDrive link of the most recent screenshot on the Samsung Tab.

> Get the link for the screenshot I just took on Vivo.

What the agent does:

1. Runs `pull_photos` (the connected device is resolved automatically — by
   default Samsung Galaxy Tab A7 or Vivo V2327 per [[user_device_vivo]]).
2. **Surfaces the OneDrive URL immediately** — this is enforced by the
   pull-photos-link rule ([[feedback_pull_photos_link]]). The link IS the
   deliverable.
3. Flags any sync-pending files with a 404 warning if OneDrive hadn't finished
   syncing.

If your phone wording mentions **video** explicitly ("the screen recording",
"the video clip I just made"), the agent passes `media: video` instead of the
default `media: photo`. For both at once, ask explicitly: *"pull the latest
photo AND video."*

### Prompt-style — latest screenshot from PC

> Pull the latest screenshot from my PC.

> Send me the OneDrive link for the screenshot I just took on the computer.

> Get the link for the most recent screenshot on Windows.

What the agent does:

1. Runs `pull_pc_media` with `source_dir: "C:\Users\Low Mun Hou\Pictures\Screenshots"`
   and `date: "today"` (per [[reference_pc_screenshot_dir]] — fixed default,
   no prompting needed).
2. **Surfaces the OneDrive URL immediately**, same as the phone flow.

> 📌 **Trigger words.** "PC", "computer", "Windows", "on the desktop", "PrtSc",
> "Snipping Tool", "Win+Shift+S" → PC source. "Phone", "tablet", "device",
> "Samsung", "Vivo", "iPhone", "iPad" → phone source. Mixed wording → agent
> asks.

### Prompt-style — iOS specifically

iOS screenshots **do not** come through `pull_photos` (the MCP's iOS reader
returns zero photos even with tunneld up). Use the AFC workaround:

> Pull the latest screenshot from my iPhone / iPad.

What the agent does ([[reference_ios_screenshot_source]]):

1. Lists `/DCIM/100APPLE` via `pymobiledevice3.exe afc ls` sorted descending.
2. Pulls the highest-numbered `.PNG` into the local staging dir
   (`C:\Users\LOWMUN~1\AppData\Local\Temp\ios-screenshots\`).
3. Hands the local file to `pull_pc_media` via the `files` parameter, which
   uploads it to OneDrive and returns the link.

The agent must NOT run `ios-connect.ps1` or poll tunneld first — AFC works
without it. Skip-tunneld is the default per
[[reference_ios_screenshot_source]].

### Prompt-style — multiple screenshots / merge as evidence

When a bug needs two screenshots compared side-by-side (e.g. PMv2 vs iVizit,
or before vs after), the agent must deliver them as **one merged image**, not
two links — enforced by [[feedback_merge_evidence_screenshots]]:

> Pull the latest 2 screenshots from my PC and merge them horizontally as
> evidence for a bug.

What the agent does:

1. Pulls both via `pull_pc_media` with `merge_horizontal: true` (or calls
   `merge_screenshots` if the files are already local).
2. Returns ONE OneDrive link to the merged side-by-side image.

> ⚠️ Asking for 2+ photos **without** `merge_horizontal` is rejected by
> `pull_pc_media` — the MCP enforces the merge convention to prevent reviewers
> ending up with disjoint evidence.

### When the link 404s

If the OneDrive link the agent hands back returns 404, the file hadn't finished
syncing to SharePoint. Wait 30-60 seconds and try the link again. If it still
404s after a minute:

- OneDrive client is paused / signed out → reopen the tray icon, sign in.
- Your SharePoint access is Read-only, not Edit → see Part 2 — Step 0.
- The local file vanished before sync (rare — antivirus quarantine) → re-take
  the screenshot.

### Don't pre-warn about slow pulls

There's a 3-min watchdog hook on `pull_photos` / `pull_pc_media`
([[reference_pull_watchdog_hook]]) — long pulls are expected, the hook covers
genuine hangs. The agent should NOT hedge with "this might take a few minutes"
or offer smaller batches per [[feedback_pull_no_preemptive_warning]]. Just
call the tool.

---

## Part 6 — Filing a newly-discovered bug (discovery → upload)

> 🚧 **PLACEHOLDER for the full discovery → routing flow.** Ignore the
> full discovery walkthrough for now — to be taught in a future pass.
> It will cover: agent surfaces an anomaly during discovery → confirms
> with user which store to file to (Excel / TimeTec project / both /
> neither, never auto-file per
> [[feedback_student_mcp_bug_routing_confirm]]) → gathers Task ID, Steps,
> Expected, Actual, Severity, attachments → submits via `create_bug` or
> `sheet_append_row`. The Excel-side specifics below are committed now;
> the discovery-to-routing fork above them is still pending.
>
> **For slide generation:** render the placeholder as a single "Coming
> soon" slide; the Excel-side notes below it as their own slide.

### Excel-side logging — what's committed so far

**1. Confirm-before-log — always.** When the agent finds an anomaly during
discovery, it does **NOT** auto-file to Excel. Ever. It surfaces the
finding to the user and waits for explicit *"yes, log it"* before calling
`sheet_append_row`. This matches the broader routing-confirm rule
([[feedback_student_mcp_bug_routing_confirm]]) — same posture, store-specific
phrasing:

> *"I found this anomaly on PMv2 — \<one-line summary\>. Log it to the
> Excel `Bug list` now? (yes / no)"*

If yes → proceed to field gathering. If no → drop it (don't quietly
queue, don't note-elsewhere; the user owns the decision).

**2. Two extra fields the user must provide for Excel.** Beyond the
standard bug template fields (Steps / Expected / Actual / Severity /
Category — see [CLAUDE.md](../CLAUDE.md) for the template), Excel's
`Bug list` requires two more that have **no sensible default** the agent
can infer:

| Field | Who fills it | Notes |
|---|---|---|
| `Testing Done By` | The user (the QC tester running verification) | Usually the user's own name; agent should default-suggest it but confirm |
| `Developer In Charge` | The user (RnD owner of the fixed area) | Agent cannot guess — must ask. If the user doesn't know, leave blank rather than fabricate |

The agent **must** prompt for both before calling `sheet_append_row` —
silent omission leaves the row half-blank and breaks downstream filters
(*"my open bugs"*, *"bugs Dev X owns"*).

### Excel-side verifying an existing bug (tutorial walkthrough)

Sister flow to logging — when a tester wants to **re-check an existing bug**
in Excel and update its status. The user identifies a bug by its `No`, the
agent reads it, the user validates, the agent reproduces in PMv2, then the
agent asks before any status write.

**Two prompt variants — pick the one that matches your intent:**

| Prompt | When to use | Status write goes to |
|---|---|---|
| *"Verify bug **\<ID\>** in PMv2 test result excel"* | Ad-hoc verification, no release context (e.g. checking an old bug, sanity-checking before a sprint) | `Bug list` master tab only |
| *"Verify bug **\<ID\>** from release **\<v.release\>**"* (e.g. `v26.5.1.x`) | Verifying as part of a release sign-off — the bug is supposed to appear in that release tab and you want both views updated | `Bug list` **AND** the named release tab |

The **release MUST be named explicitly** when you want the release-tab write.
The agent should NOT guess which release a bug belongs to and write blindly
— if no release was named, the release-tab side of the write is skipped
entirely.

**Walkthrough — step by step:**

**Step 1 — Read by ID.** Agent calls
`sheet_read({ sheet_name: "Bug list", no: <ID> })` — **always** the master
`Bug list` tab, never a release tab (release tabs don't carry the Steps
column).

```js
sheet_read({ sheet_name: "Bug list", no: 655 })
//  → { No: 655, Title: ..., Steps: ..., Expected Result: ..., Actual Result: ..., Status: ..., ... }
```

**Step 1b (release-variant only) — Check the bug exists in the named release.**
If the prompt named a release (`from release v26.5.1.x`), agent also calls
`sheet_read({ sheet_name: "v26.5.1.x", no: 655 })` to confirm the bug
appears in that release tab. Three outcomes:

- **Found** → continue to Step 2; the release-tab status write is in scope.
- **Not found in that release** → tell the user: *"Bug No. 655 isn't in
  release `v26.5.1.x`. Did you mean a different release, or skip the
  release-tab write and only update `Bug list`?"*. Don't silently fall
  back — the user owns the call.
- **Tab itself doesn't exist** → surface the underlying `tab_read_failed`
  error; likely a typo on the release name (forgot the `v` prefix or the
  `.x` suffix).

**Step 2 — Validate the row with the user.** Agent surfaces Title + Steps +
Expected Result back verbatim:

> *"Found No. 655: \"\<Title\>\". Steps: \<...\>. Expected: \<...\>. Is
> this the bug you want to verify? (yes / no)"*

If the user says no (wrong row, typo on the `No`), stop and re-ask the
correct `No`. Don't reproduce against a wrong bug.

**Step 3 — Verify in PMv2.** Agent navigates to the relevant module in PMv2
(`appuat` for staging, `app` for live — match the tester's intent), pulls
any taught student-mcp rules for the module via
`recall({ app: "pmv2", module_contains: <module> })`, walks the Steps
exactly as written, and observes the result against the Expected.

Verdict the agent reports:
- **Fixed** → live behaviour matches Expected (or no longer reproduces).
- **Still broken** → live behaviour matches the original Actual.
- **Not reproducible** → can't get the bug to occur either way; needs more
  info from the original reporter.

**Step 4 — Ask before any status write (two-step prompt — non-negotiable).**

Per Part 4 — even when the verdict feels obvious, the agent does NOT
auto-update. It asks in two steps:

> Step A: *"Want me to update row No 655's `Status` column? (yes / no)"*
>
> Step B (only if yes): *"Set `Status` to **Closed** or **Reopen**?
> (recommendation based on my verdict: \<Closed/Reopen\>)"*

The agent should **suggest the value matching its verdict** (Closed if
fixed, Reopen if still broken) but the user makes the final call. Even
"Not reproducible" doesn't auto-decide — the agent reports it and asks
the user how they want to status it.

**Step 5 — Write.** On confirmation, the write scope depends on which
prompt variant was used in Step 1:

| Prompt variant | Writes |
|---|---|
| *"Verify bug 655 in PMv2 test result excel"* (no release) | `Bug list` only — `Closed`/`Reopen` proper case, auto-pairs `Date Closed by QC` on Closed |
| *"Verify bug 655 from release v26.5.1.x"* (release named, bug confirmed present) | **Both** — `Bug list` (`Closed`/`Reopen` + auto-stamp) AND `v26.5.1.x` (`CLOSED`/`REOPEN` uppercase + auto-color `#` cell red for REOPEN, green for CLOSED) |

Then one more ask regardless of variant: *"Want to leave a `QC Remark` on
the Bug list row? (yes / no)"* — if yes, prefix `QC Remark: ` and append.

See Part 4 for the full mechanics (casing translation, auto-stamp, auto-color
rules, append-vs-overwrite for Remark).

> 🪞 **Why this is its own subsection in Part 6 (not just a cross-reference
> to Part 4):** the **logging** flow above and this **verifying** flow are
> the two sides of the same Excel coin — one creates rows, the other
> updates them. New testers benefit from seeing both walkthroughs in one
> place, with the same shape (confirm before writing). Part 4 is the
> reference; Part 6 is the tutorial.

### TimeTec project-side logging — what's committed so far

Same shape as the Excel-side logging above, but routes to
`dt.timeteccloud.com` (Live) / `dt-dev.timeteccloud.com` (SIT) via
`create_bug` instead of `sheet_append_row`. Used for everything except
PMv2 (Maintenance, HRv2, iNeighbour, iVizit, parking, etc. — see
[Part 0](#part-0--two-bug-stores-which-one-for-which-product) for the
routing table).

**1. Confirm-before-log — always.** Same posture as Excel. When the agent
finds an anomaly during discovery, it surfaces the finding and waits for
explicit *"yes, log it"* before calling `create_bug`. The destination
question is part of this prompt because `create_bug`'s `destination`
parameter is server-enforced:

> *"I found this anomaly on TimeTec Maintenance — \<one-line summary\>.
> File it to: (a) `tracker_only`, (b) `tracker_and_excel`,
> (c) `excel_only` — go through `sheet_append_row` instead, or
> (d) `neither`?"*

If `(d) neither` → drop, don't queue elsewhere. If `(c) excel_only` →
hand off to the Excel logging flow (sister section above). Otherwise
proceed to the next step.

**2. Task ID OR assignee — one of the two is REQUIRED (server-enforced).**
This is the rule Xavier flagged, and `create_bug` now refuses to file a
bug without it. Two acceptable shapes:

| User answer | Agent passes |
|---|---|
| *"Yes, Task ID is **TS-RND-0309**"* | `task_decision: "with_task"`, `related_task: "TS-RND-0309"` — ownership inherited from the task's assignees |
| *"No Task ID, assignee is **\<dev name\>**"* | `task_decision: "no_task"`, `assignees: ["<dev name>"]` (string, number, or array of either; name/email/id resolves server-side) |
| *"No Task ID and I don't know the assignee"* | **REFUSE TO FILE.** Re-prompt: *"I can't file without an owner — either a Task ID OR an assignee. Which do you want to give me?"* Don't fabricate, don't pick a default. |

The server returns this error if you try to file without either:

```
Bug must have an owner: pass either a related_task (Task ID like
'TS-RND-0309') OR at least one assignee (name/email/id). The current
call has neither — the bug would be filed with no one to route it to.
Ask the user for one of: (a) the Task ID this bug belongs to, or
(b) the developer/team to assign it to. If they don't know either,
do NOT file the bug — defer until they do.
```

> 🧭 **Why both rules sit on the server, not just in the agent's head:**
> agents forget. The server-side enforcement turns "should ask" into
> "literally cannot file without asking" — same enforcement pattern
> as student-mcp's strict validation. See
> [[feedback_bug_task_id_confirm]] for the original rule that led to
> the task_decision enum; the ownership-or-task rule is its natural
> sibling.

**3. The rest of the template** follows the standard CLAUDE.md bug
template — Steps (fenced code block), Expected (one short sentence),
Actual (one short sentence), Severity, Category, attachments. Title +
description are auto-built; do not ask for them separately.

### TimeTec project-side verifying an existing bug (tutorial walkthrough)

Sister to the Excel verifying walkthrough above — when a tester wants to
**re-check an existing bug** on `dt.timeteccloud.com` and update its
status. Maps to the same shape but uses `get_bug` + `update_bug` instead
of `sheet_read` + `sheet_update_row`.

**Example prompt:**

> Verify bug **BG-1234** on Maintenance.

**Walkthrough — step by step:**

**Step 1 — Read by ID.** Agent calls `get_bug({ bug_id: 1234 })` (numeric
ID without the `BG-` prefix). Response includes Title, Description,
Severity, Status, assignees, related_task_id, product, module.

**Step 2 — Parse Steps from `description`.** Unlike Excel's `Bug list`,
TimeTec project has no separate Steps / Expected / Actual columns —
they're embedded in the description body per the standard bug template
(`Test Steps: … Actual Result: … Expected Result: …`). The agent parses
the structured fields from prose. See Part 0.5 → "Description parsing
demo" for the gotchas (HTML-encoded apostrophes, digit-jamming where the
password ends in a digit and step 2 starts with `2.`, etc.).

**Step 3 — Validate the row with the user.** Same as Excel — agent
surfaces Title + Steps + Expected back verbatim, asks *"Is this the
bug you want to verify?"*. If `no`, stop and re-ask the correct ID.

**Step 4 — Auto-claim if currently `Ready For Testing`.** TimeTec's
QC-side role-gate requires the bug to be at `QC - In Progress` before
QC can verdict it. If the bug is currently at `Ready For Testing`, agent
mechanically transitions it via `update_bug({ status: "QC - In Progress" })`
and reports the claim: *"Claimed BG-1234 from Ready For Testing → QC -
In Progress so I can verdict it afterward."* If the bug is already at
`QC - In Progress`, skip this step. (See Part 0.5 → "The QC - In Progress
claim step" for the full transition graph.)

**Step 5 — Verify in the live product.** Agent navigates to the relevant
module in the appropriate product (Maintenance, HRv2, etc. — match the
bug's `product` field), pulls any taught student-mcp rules via
`recall({ app: <product-slug>, module_contains: <module> })`, walks the
Steps exactly, observes the result.

**Step 6 — Ask before any status write (two-step prompt — non-negotiable).**

> Step A: *"Want me to update BG-1234's status? (yes / no)"*
>
> Step B (only if yes): *"Set status to **Ready For Live** (verified
> fixed) or **Reopen** (still broken)? (recommendation based on my
> verdict: \<Ready For Live / Reopen\>)"*

Agent suggests the value matching its verdict; user makes the final
call. On confirmation, agent calls
`update_bug({ bug_id: 1234, status: <value> })` — which hits
`PATCH /bugs/BG-1234/status` with `{ new_status: <value> }`. The MCP
re-reads the bug to verify the transition actually took effect
(catches silent role-gate refusals).

**Step 7 — Surface the result.** Agent reports the final status with the
bug's URL on dt.timeteccloud.com for a permalink the user can paste into
Slack / handovers.

| QC verdict | TimeTec status to set | Notes |
|---|---|---|
| Fixed | `Ready For Live` | NOT `Closed` — Closed is a terminal state set by manager/RND after the fix actually ships to Live. QC sets `Ready For Live`, ship sets `Live`, manager sets `Closed`. |
| Still broken | `Reopen` | Bounces back to RND |
| Not reproducible | (ask user — usually `Ready For Live` with a Remark, or hold) | Don't auto-decide |

See Part 0.5 → "TimeTec project — prompt + confirmation flow" for the
full mechanics including role-gate failure messages.

> 🪞 **Same shape, two products.** Excel verifying + TimeTec project
> verifying are mechanically different (two sheets vs one API, casing
> translation vs role-gated transitions) but follow the same human
> contract: read by ID → validate with user → reproduce → two-step
> status prompt → write. That contract is what new testers should
> memorise; the per-store mechanics are reference.

### Attaching photos / videos to a bug being logged

Both stores (Excel + TimeTec project) need the same shape of evidence —
SharePoint-hosted URLs that survive being pasted into a bug record. There
are **two paths** into the attachment pipeline:

**Path A — Auto-extract during discovery.** When the agent is the one
that found the issue (it was running the test and observed the divergence),
it has the screen state in front of it. It pulls the evidence itself:
- If the agent was driving a mobile device via Appium → `pull_photos`
  (the screenshot or recording it just captured).
- If the agent was driving a browser via Playwright → it takes a
  screenshot to the OneDrive sync folder, then `pull_pc_media` to upload
  + return the link.

No user prompt needed beyond the original *"file this as a bug, yes?"* —
the attachments ride along with the bug-template gathering step.

**Path B — User requests the latest manually-taken media.** When the
**user** captured the evidence themselves (their eye saw it, not the
agent's), they ask explicitly:

> Give me latest photo/video link.

What the agent does — covered in detail in
[Part 5 — Prompt patterns for media upload](#part-5--prompt-patterns-upload-latest-media-on-demand)
— routes by source wording (phone vs PC vs iOS), calls the right tool,
surfaces the OneDrive link verbatim. The user then paste-includes that
link into their next *"file this as a bug"* prompt.

**🪺 Recommendation for manually-captured media — save to the OneDrive
sync folder directly.** When you take a screenshot or screen-recording
yourself (Win+Shift+S, Snipping Tool, phone screenshot, etc.), save it
straight into the **Local OneDrive folder that's linked to the SharePoint
shortcut** (see Part 2 for the folder setup). Why this matters:

- The `pull_pc_media` flow scans that folder for the latest file. If
  the screenshot lives in `Pictures\Screenshots` (the default capture
  location), one extra copy-step is needed before upload. If it lives
  directly in the OneDrive-synced folder, `pull_pc_media` picks it up
  on first scan — zero copies, zero rename, link returned in seconds.
- OneDrive begins syncing the file the moment it lands in the folder;
  by the time `pull_pc_media` finishes its scan, the SharePoint URL is
  usually already live (no 404 wait).
- It avoids the *"link 404s because OneDrive hasn't synced yet"*
  failure mode (see Part 5 → "When the link 404s").

If your capture tool always saves to `Pictures\Screenshots` and you
can't change the default, that's fine — `pull_pc_media` handles it
(per [[reference_pc_screenshot_dir]] the dir is the configured default).
The OneDrive-folder save is a *recommendation*, not a requirement.

> 🚦 **Path choice is determined by who saw the issue**, not by user
> preference. Agent saw it → Path A (no prompt needed). User saw it →
> Path B (user prompts for the link). Don't make the user dictate path
> when the answer is obvious from context.

---

### TimeTec project-side batch re-verify (Task ID or Bug ID)

The single-bug walkthrough above scales to **one** at a time. When you're
verifying an entire task's worth of fixes after an RnD signal — or
double-checking a specific bug's status before action — use the batch
re-verify flow. It's composable from `get_task` + `get_bug` + `update_bug`;
no new tool needed, but the prompt shape is fixed.

**Trigger prompt (use this wording — the agent recognises it):**

> Task/Bug ID **\<id\>**, are all the bug ready for testing?

`<id>` is either a **Task ID** (`TS-RND-0530`) → check every bug under
that task, or a **Bug ID** (`BG-1234`) → check that single bug.

**Walkthrough — step by step:**

**Step 1 — Resolve scope.**
- If id matches `TS-RND-*` → `get_task({ task_id: <numeric-portion> })`,
  pull `bugs[]` from the response.
- If id matches `BG-*` → `get_bug({ bug_id: <numeric> })`, wrap as a
  single-bug list for uniform handling.
- If neither pattern matches → reject: *"Couldn't parse `<id>` as a
  Task ID (TS-RND-NNNN) or Bug ID (BG-NNNN). Which is it?"*

**Step 2 — Report current readiness.** Agent surfaces a one-shot status
breakdown so the user sees what they're committing to:

> *"Task TS-RND-0530 has 8 bugs. Status breakdown:*
> - *5 at `Ready For Testing` — verifiable now*
> - *2 at `RND - In Progress` — not yet ready*
> - *1 at `Ready For Live` — already verified, will skip*
>
> *Proceed to re-verify the 5? (yes / no / wait for the 2 RND-side ones first)"*

If user says **wait** → stop. Don't auto-poll; the user re-prompts when
ready (per [[feedback_pull_no_preemptive_warning]] sibling — don't hedge
or schedule re-checks the user didn't ask for).

If user says **no** → drop.

If user says **yes** → continue to Step 3.

**Step 3 — Confirm the RnD signal (gate, not formality).**

> *"Just to confirm: has RnD signalled that all 5 fixes are deployed to
> the verification environment? (yes / no)"*

This mirrors the batch-claim warning from Part 0.5 — same reasoning,
verification fails spuriously if the fixes aren't actually live.
If **no** → stop, ask user to come back after RnD's signal.

**Step 4 — Auto-claim each Ready For Testing → QC - In Progress.**
Sequentially, per the QC role-gate (`Ready For Testing → QC - In Progress`
is the only legal next state for QC). Single confirmation upfront:

> *"Claiming all 5 from Ready For Testing → QC - In Progress so I can
> verdict them..."*

Then iterates `update_bug({ bug_id, status: "QC - In Progress" })` per
bug. Failures surfaced individually (don't skip silently).

**Step 5 — Reproduce each, generate the verdict table.** For every claimed
bug, agent:
1. Parses Steps from the bug's `description`.
2. Walks the steps in the live product (pulls student-mcp rules per
   module for grounding).
3. Records the verdict: `Ready For Live` (fixed) or `Reopen` (still
   broken) or `Not reproducible` (asks user — usually `Ready For Live`
   with a Remark).

Then surfaces a **markdown table** summarising the whole batch:

| Bug ID | Module | Verdict | Recommended status |
|---|---|---|---|
| BG-1234 | Maintenance > Work Order | Fixed (no longer reproduces) | `Ready For Live` |
| BG-1235 | Maintenance > Asset | Still broken (matches original Actual) | `Reopen` |
| BG-1236 | Maintenance > PM | Fixed | `Ready For Live` |
| BG-1237 | Maintenance > Report | Not reproducible — needs reporter | (ask user) |
| BG-1238 | Maintenance > Staff | Fixed | `Ready For Live` |

**Step 6 — Confirm before any status write (single batch prompt).** Unlike
the single-bug verify which uses the two-step prompt, the batch flow
collapses to **one** confirm because the user has the full table in front
of them:

> *"Apply the above statuses now? (yes / no / per-bug override)*
>
> *• `yes` — flip all 5 per the Recommended column above.*
> *• `no` — leave them all at QC - In Progress; you'll set status manually
>   later.*
> *• `per-bug override` — go through them one at a time so you can flip
>   individual verdicts before writing."*

**Step 7 — Write.** On confirmation, agent calls `update_bug` per row with
the chosen status. Verify-after-write is per-bug (MCP catches silent
role-gate refusals). Final report summarises successes + any rejections.

**Step 8 — Surface the bug URLs.** For every bug touched, output its
`dt.timeteccloud.com` URL alongside its final status — gives the user a
permalink stack to share in Slack / handover docs.

> 🚨 **Same RnD-signal warning as batch-claim in Part 0.5.** The agent
> should NOT proactively recommend this flow — it's reactive to an RnD
> signal. If the user types the trigger prompt without an explicit
> "RnD says these are ready", Step 3 catches it. If they bypass Step 3,
> the verification still runs, but spurious failures are on them, not
> on the system.

> 🪞 **Why a batch flow at all.** A 5-bug task verified one-by-one is 35
> prompts (1 read + 1 validate + 1 reproduce-permission + 1 status-step-A
> + 1 status-step-B + 1 remark + 1 done × 5). The batch flow collapses
> to ~6 prompts (1 trigger + 1 breakdown-confirm + 1 RnD-signal +
> 1 claim-confirm + 1 verdict-confirm + final). Same human contract,
> 6× less typing.

---

### 🚨 Hands off the column headers (RnD + workbook owner read this)

> **DO NOT rename any column header in `PMV2- Test Result.xlsx`.** Not on
> `Bug list`, not on any `v<release>.x` release tab. The MCP + the
> `BugSheetOp` Office Script key on column names **exactly** —
> case-sensitive, whitespace-sensitive, no aliases.
>
> Names the script depends on today (non-exhaustive):
>
> - **`Bug list` tab**: `No`, `Status`, `Modules`, `Changes Summary`,
>   `Date Closed by QC`, `Remark`, `Testing Done By`, `Developer In Charge`,
>   `QC In Charge`, and the standard bug-template columns.
> - **Release tabs (`v<version>.x`)**: `#`, `Status`, `Project`, `Modules`,
>   `Changes Summary`, `Changes Details`, `Ready to Test In (SIT)`,
>   `Planned Release Date (Live)`, `Remark`, `Developer In Charge`,
>   `QC In Charge`.
>
> **Silent failures if you rename:**
> - `sheet_append_row` lands values in wrong cells (or drops them entirely
>   for unknown column names) — no error, just bad data.
> - `sheet_read` returns wrong columns under the new label — agent verifies
>   against the wrong field.
> - Auto-stamp (`Date Closed by QC`) and auto-color (`#` red/green on
>   release tabs) silently skip when their target column is missing —
>   verification still appears to succeed.
> - `sheet_get_release_modules` parser keys on `#`, `Status`, `Modules`,
>   `Changes Summary` — rename any of those and the release-verification
>   flow returns empty or wrong rows.
>
> **Safe changes:** adding NEW columns at the end of the header row, or
> reordering existing columns within a row (the script looks up by name,
> not position). **Unsafe:** renaming, deleting, or splitting existing
> columns; renaming worksheet tabs in a way that breaks the `v<X.Y.Z>.x`
> pattern.
>
> If you genuinely need to rename a column (e.g. typo fix), coordinate
> with QC so the MCP + script can be updated in the same change — it's
> a 2-line edit in `server.js` and a 1-line edit in `BugSheetOp.ts`,
> but it has to happen at the same time as the workbook change.

---

## Quick reference

| You have | You need | Where it goes |
|---|---|---|
| TimeTec login email + password | The bug-tracker account | `TIMETEC_EMAIL`, `TIMETEC_PASSWORD` |
| Live or SIT | The environment | `TIMETEC_BASE_URL` |
| Local synced folder path | Where screenshots are dropped | `ONEDRIVE_SYNC_FOLDER` |
| SharePoint folder web URL | How links are built | `SHAREPOINT_BASE_URL` |

**Golden rules**

- `ONEDRIVE_SYNC_FOLDER` and `SHAREPOINT_BASE_URL` must point at the **same folder**.
- Keep the OneDrive client **running and signed in**.
- Restart Claude Code after any credential or path change.
- If the automated link fails → fall back to **Method A** (sync OK) or
  **Method B** (sync broken).
