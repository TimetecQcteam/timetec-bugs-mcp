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
