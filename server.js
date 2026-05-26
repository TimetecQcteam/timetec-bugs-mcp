import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CookieJar, Cookie } from "tough-cookie";
import setCookieParser from "set-cookie-parser";
import { execSync, execFileSync, spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

// ─── Configuration ──────────────────────────────────────────────────────────
// Credentials are loaded in this priority order:
//   1. Environment variables (set by install.ps1 / .claude.json env block)
//   2. ~/.timetec-bugs-mcp/config.json (written by the `setup_credentials` tool)
//   3. Empty — login() will throw a credentials_required error that Claude
//      Code can recover from by prompting the user and calling setup_credentials.
const CONFIG_DIR = join(homedir(), ".timetec-bugs-mcp");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

function loadStoredConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, "utf8");
      return raw.trim() ? JSON.parse(raw) : {};
    }
  } catch (e) {
    process.stderr.write(`[timetec-bugs-mcp] warning: failed to read ${CONFIG_FILE}: ${e.message}\n`);
  }
  return {};
}

function saveStoredConfig(cfg) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

const storedConfig = loadStoredConfig();
let BASE_URL = process.env.TIMETEC_BASE_URL || storedConfig.base_url || "https://dt-dev.timeteccloud.com";
let EMAIL = process.env.TIMETEC_EMAIL || storedConfig.email || "";
let PASSWORD = process.env.TIMETEC_PASSWORD || storedConfig.password || "";

// ─── Session Management ────────────────────────────────────────────────────
const cookieJar = new CookieJar();
let csrfToken = null;
let inertiaVersion = null;
let isAuthenticated = false;
let currentUserName = null;  // Authenticated user's display name (matches bug.reporter)

async function fetchWithCookies(url, options = {}) {
  const fullUrl = url.startsWith("http") ? url : `${BASE_URL}${url}`;
  const cookies = await cookieJar.getCookieString(fullUrl);

  const headers = {
    "User-Agent": "TimetecBugsMCP/1.0",
    "Accept": "application/json",
    ...(cookies ? { Cookie: cookies } : {}),
    ...(options.headers || {}),
  };

  // Add XSRF token for mutating requests (Laravel decrypts X-XSRF-TOKEN from the cookie)
  if (["POST", "PUT", "PATCH", "DELETE"].includes((options.method || "GET").toUpperCase())) {
    const xsrfCookie = await cookieJar.getCookies(fullUrl);
    const xsrf = xsrfCookie.find(c => c.key === "XSRF-TOKEN");
    if (xsrf) {
      headers["X-XSRF-TOKEN"] = decodeURIComponent(xsrf.value);
    }
  }

  const res = await fetch(fullUrl, { ...options, headers, redirect: "manual" });

  // Store cookies from response
  const setCookies = setCookieParser.parse(setCookieParser.splitCookiesString(res.headers.get("set-cookie") || ""));
  for (const c of setCookies) {
    const cookie = new Cookie({
      key: c.name,
      value: c.value,
      domain: c.domain || new URL(fullUrl).hostname,
      path: c.path || "/",
      httpOnly: c.httpOnly,
      secure: c.secure,
    });
    await cookieJar.setCookie(cookie, fullUrl);
  }

  return res;
}

async function login() {
  if (!EMAIL || !PASSWORD) {
    throw new Error(
      "credentials_required: TimeTec credentials are not configured. " +
      "Call the `setup_credentials` tool with { environment: 'live'|'sit'|'custom', email, password } " +
      "to configure. The values will be persisted to ~/.timetec-bugs-mcp/config.json for future sessions."
    );
  }

  // Step 1: GET login page to get CSRF token
  const loginPage = await fetchWithCookies("/login", {
    headers: { Accept: "text/html" },
  });
  const html = await loginPage.text();

  // Extract CSRF token from meta tag or hidden input
  const csrfMatch = html.match(/name="csrf-token"\s+content="([^"]+)"/) ||
                    html.match(/name="_token"\s+value="([^"]+)"/);
  if (csrfMatch) {
    csrfToken = csrfMatch[1];
  }

  // Also get XSRF-TOKEN from cookies
  const xsrfCookie = await cookieJar.getCookies(BASE_URL);
  const xsrf = xsrfCookie.find(c => c.key === "XSRF-TOKEN");
  if (xsrf) {
    // Laravel expects decoded XSRF token in header
    const decodedXsrf = decodeURIComponent(xsrf.value);
    csrfToken = csrfToken || decodedXsrf;
  }

  // Step 2: POST login (fetchWithCookies auto-adds X-XSRF-TOKEN from cookie)
  const loginRes = await fetchWithCookies("/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-CSRF-TOKEN": csrfToken,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  if (loginRes.status >= 400) {
    const body = await loginRes.text();
    throw new Error(`Login failed (${loginRes.status}): ${body}`);
  }

  // Note: csrfToken stays as the plain token from the meta tag.
  // The XSRF-TOKEN cookie (encrypted) is handled by fetchWithCookies via X-XSRF-TOKEN header.

  isAuthenticated = true;

  // Step 3: Get Inertia version + authenticated user name from bugs page
  const bugsPage = await fetchWithCookies("/bugs", {
    headers: { Accept: "text/html" },
  });
  const bugsHtml = await bugsPage.text();
  const versionMatch = bugsHtml.match(/data-page="([^"]+)"/);
  if (versionMatch) {
    try {
      const pageData = JSON.parse(versionMatch[1].replace(/&quot;/g, '"'));
      inertiaVersion = pageData.version;
      currentUserName = pageData.props?.auth?.user?.name || null;
    } catch (e) { /* ignore */ }
  }

  return true;
}

async function ensureAuth() {
  if (!isAuthenticated) {
    await login();
  }
}

async function reAuth() {
  isAuthenticated = false;
  csrfToken = null;
  inertiaVersion = null;
  currentUserName = null;
  // Clear all cookies to avoid stale session conflicts
  await cookieJar.removeAllCookies();
  await login();
}

async function inertiaGet(url) {
  await ensureAuth();

  const headers = {
    "Accept": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "X-Inertia": "true",
  };
  if (inertiaVersion) {
    headers["X-Inertia-Version"] = inertiaVersion;
  }

  const res = await fetchWithCookies(url, { headers });

  // Handle Inertia version mismatch (409) — re-fetch with new version
  if (res.status === 409) {
    const location = res.headers.get("x-inertia-location");
    if (location) {
      // Get new version from full page load
      const fullPage = await fetchWithCookies(location, { headers: { Accept: "text/html" } });
      const html = await fullPage.text();
      const match = html.match(/data-page="([^"]+)"/);
      if (match) {
        const pageData = JSON.parse(match[1].replace(/&quot;/g, '"'));
        inertiaVersion = pageData.version;
        return pageData;
      }
    }
  }

  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${await res.text()}`);
  }

  return await res.json();
}

async function inertiaPost(url, data, _retried = false) {
  await ensureAuth();

  const res = await fetchWithCookies(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-Inertia": "true",
      ...(inertiaVersion ? { "X-Inertia-Version": inertiaVersion } : {}),
    },
    body: JSON.stringify(data),
  });

  // Handle CSRF token mismatch — re-authenticate and retry once
  if (res.status === 419 && !_retried) {
    await reAuth();
    return inertiaPost(url, data, true);
  }

  // Handle redirect (302/303) — Inertia redirect after successful mutation
  if (res.status === 302 || res.status === 303) {
    const location = res.headers.get("location");
    if (location) {
      return await inertiaGet(location);
    }
    return { success: true, status: res.status };
  }

  if (res.status === 422) {
    const errors = await res.json();
    return { success: false, errors };
  }

  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${await res.text()}`);
  }

  return await res.json();
}

async function inertiaPut(url, data, _retried = false) {
  await ensureAuth();

  const res = await fetchWithCookies(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-Inertia": "true",
      ...(inertiaVersion ? { "X-Inertia-Version": inertiaVersion } : {}),
    },
    body: JSON.stringify(data),
  });

  if (res.status === 419 && !_retried) {
    await reAuth();
    return inertiaPut(url, data, true);
  }

  if (res.status === 302 || res.status === 303) {
    const location = res.headers.get("location");
    if (location) return await inertiaGet(location);
    return { success: true, status: res.status };
  }

  if (res.status === 422) {
    return { success: false, errors: await res.json() };
  }

  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${await res.text()}`);
  }

  return await res.json();
}

async function inertiaPatch(url, data, _retried = false) {
  await ensureAuth();

  const res = await fetchWithCookies(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify(data),
  });

  if (res.status === 419 && !_retried) {
    await reAuth();
    return inertiaPatch(url, data, true);
  }

  if (res.status === 302 || res.status === 303) {
    const location = res.headers.get("location");
    if (location) return await inertiaGet(location);
    return { success: true, status: res.status };
  }

  if (res.status === 422) {
    return { success: false, errors: await res.json() };
  }

  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${await res.text()}`);
  }

  return await res.json();
}

async function inertiaDelete(url, _retried = false) {
  await ensureAuth();

  const res = await fetchWithCookies(url, {
    method: "DELETE",
    headers: {
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-Inertia": "true",
      ...(inertiaVersion ? { "X-Inertia-Version": inertiaVersion } : {}),
    },
  });

  if (res.status === 419 && !_retried) {
    await reAuth();
    return inertiaDelete(url, true);
  }

  if (res.status === 302 || res.status === 303) {
    return { success: true, status: res.status };
  }

  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${await res.text()}`);
  }

  return { success: true };
}

// ─── Lookup cache (so we don't re-fetch /bugs on every create) ─────────────
let bugLookupCache = null;
let bugLookupCacheTime = 0;
const LOOKUP_TTL_MS = 60 * 1000;

async function getBugLookups() {
  if (bugLookupCache && Date.now() - bugLookupCacheTime < LOOKUP_TTL_MS) {
    return bugLookupCache;
  }
  const data = await inertiaGet("/bugs");
  bugLookupCache = {
    products: data.props?.products || [],
    modules: data.props?.modules || [],
    assignees: data.props?.assignees || [],
    bugCategories: data.props?.bugCategories || [],
  };
  bugLookupCacheTime = Date.now();
  return bugLookupCache;
}

// Resolve a name (or numeric id) to a numeric id via fuzzy match.
// Throws helpful errors when the name is ambiguous or unknown.
function resolveLookup(table, value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return parseInt(value, 10);

  if (!Array.isArray(table) || table.length === 0) {
    throw new Error(`No ${label} lookup data available — pass a numeric ID instead.`);
  }

  const needle = String(value).toLowerCase().trim();
  const nameOf = (item) => (item.name || item.email || "").toLowerCase();

  const exact = table.find((item) => nameOf(item) === needle);
  if (exact) return exact.id;

  const partial = table.filter((item) => nameOf(item).includes(needle));
  if (partial.length === 1) return partial[0].id;
  if (partial.length > 1) {
    const matches = partial.slice(0, 6).map((p) => `"${p.name || p.email}"`).join(", ");
    throw new Error(`Multiple ${label}s match "${value}": ${matches}. Be more specific.`);
  }

  const available = table.slice(0, 12).map((l) => l.name || l.email).join(", ");
  const more = table.length > 12 ? ` (and ${table.length - 12} more)` : "";
  throw new Error(`No ${label} matches "${value}". Available: ${available}${more}`);
}

// ─── Helper ─────────────────────────────────────────────────────────────────
function formatBug(bug) {
  return {
    id: bug.id,
    bug_id: bug.bug_id,
    title: bug.title,
    description: bug.description?.replace(/<[^>]+>/g, "") || "",
    severity: bug.severity,
    status: bug.status,
    product: bug.product?.name || null,
    solution: bug.solution?.name || null,
    module: bug.module?.name || null,
    sub_module: bug.sub_module?.name || null,
    category: bug.category?.name || null,
    reporter: bug.reporter?.name || null,
    assignees: bug.assignee_names || [],
    related_task_id: bug.related_task_id,
    created_at: bug.created_at,
    updated_at: bug.updated_at,
  };
}

function formatTask(task) {
  return {
    id: task.id,
    task_id: task.task_id,
    title: task.title,
    description: task.description?.replace(/<[^>]+>/g, "") || "",
    status: task.status,
    priority: task.priority?.name || null,
    priority_id: task.priority_id,
    task_size: task.task_size,
    product: task.product?.name || null,
    solution: task.solution?.name || null,
    module: task.module?.name || null,
    sub_module: task.sub_module?.name || null,
    requestor: task.requestor?.name || null,
    assignees: task.assignee_names || [],
    assignee_ids: task.assignee_ids || [],
    start_date: task.start_date,
    due_date: task.due_date,
    completion_date: task.completion_date,
    related_ticket_id: task.related_ticket_id,
    parent_task_id: task.parent_task_id,
    subtasks_count: task.subtasks_count || 0,
    bugs: (task.bugs || []).map(b => ({ id: b.id, bug_id: b.bug_id, title: b.title, severity: b.severity, status: b.status })),
    remarks: task.remarks,
    platform: task.platform || [],
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

function textResult(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

// ─── MCP Server ─────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "timetec-bugs",
  version: "1.0.0",
});

// ── Tool: setup_credentials ─────────────────────────────────────────────────
// First-class onboarding path. When any other tool throws "credentials_required",
// Claude Code should collect email/password from the user and call this tool.
// Verifies creds by performing a login, then persists to ~/.timetec-bugs-mcp/config.json
// so future sessions skip the prompt.
server.tool(
  "setup_credentials",
  "Configure or update TimeTec credentials and persist them to ~/.timetec-bugs-mcp/config.json. " +
  "Use this when other tools return a `credentials_required` error, or to switch environment / change account. " +
  "The new credentials are validated by performing a login before being saved.",
  {
    environment: z.enum(["live", "sit", "custom"]).describe("'live' = dt.timeteccloud.com, 'sit' = dt-dev.timeteccloud.com, 'custom' = use base_url."),
    base_url: z.string().optional().describe("Required only when environment='custom'. Full base URL, e.g. https://internal.timeteccloud.com."),
    email: z.string().describe("TimeTec login email."),
    password: z.string().describe("TimeTec login password."),
  },
  async (params) => {
    let newBaseUrl;
    if (params.environment === "live") newBaseUrl = "https://dt.timeteccloud.com";
    else if (params.environment === "sit") newBaseUrl = "https://dt-dev.timeteccloud.com";
    else {
      if (!params.base_url) {
        return textResult({ error: "base_url is required when environment='custom'." });
      }
      newBaseUrl = params.base_url.replace(/\/+$/, "");
    }

    const prev = { BASE_URL, EMAIL, PASSWORD, isAuthenticated, csrfToken, inertiaVersion, currentUserName };

    BASE_URL = newBaseUrl;
    EMAIL = params.email;
    PASSWORD = params.password;
    isAuthenticated = false;
    csrfToken = null;
    inertiaVersion = null;
    currentUserName = null;
    await cookieJar.removeAllCookies();

    try {
      await login();
    } catch (e) {
      BASE_URL = prev.BASE_URL;
      EMAIL = prev.EMAIL;
      PASSWORD = prev.PASSWORD;
      isAuthenticated = prev.isAuthenticated;
      csrfToken = prev.csrfToken;
      inertiaVersion = prev.inertiaVersion;
      currentUserName = prev.currentUserName;
      await cookieJar.removeAllCookies();
      return textResult({
        error: "credentials_invalid",
        message: `Login failed against ${newBaseUrl} — ${e.message}`,
        hint: "Re-call setup_credentials with the correct email/password. Previous credentials (if any) have been restored.",
      });
    }

    try {
      saveStoredConfig({ base_url: newBaseUrl, email: params.email, password: params.password });
    } catch (e) {
      return textResult({
        status: "ok_session_only",
        warning: `Logged in successfully, but failed to persist credentials to ${CONFIG_FILE}: ${e.message}. They will be lost when the MCP server restarts.`,
        base_url: newBaseUrl,
        email: params.email,
        authenticated_user: currentUserName,
      });
    }

    return textResult({
      status: "ok",
      base_url: newBaseUrl,
      email: params.email,
      authenticated_user: currentUserName,
      config_file: CONFIG_FILE,
      message: "Credentials saved and verified. Other tools will now work.",
    });
  }
);

// ── Tool: list_bugs ─────────────────────────────────────────────────────────
server.tool(
  "list_bugs",
  "List bugs reported by the authenticated user. By default this MCP only surfaces bugs where `reporter` matches the login credentials — bugs reported by other people are filtered out. Pass `include_all_reporters: true` to bypass the filter. Returns paginated bug list with details.",
  {
    status: z.enum(["All", "New", "Reopen", "QC - In Progress", "RND - In Progress", "Ready For Testing", "Ready For Live", "Live", "Closed", "Rejected"]).optional().describe("Filter by bug status"),
    severity: z.enum(["Critical", "High", "Medium", "Low"]).optional().describe("Filter by severity"),
    product: z.string().optional().describe("Filter by product name"),
    module: z.string().optional().describe("Filter by module name"),
    search: z.string().optional().describe("Search by bug name or ID"),
    view: z.enum(["all", "my"]).optional().default("all").describe("View all bugs ('all', default) or only the logged-in user's bugs ('my'). Server's default view is 'my', which hides bugs not assigned to you — so we default to 'all' here."),
    include_all_reporters: z.boolean().optional().default(false).describe("Bypass the reporter filter and return bugs reported by anyone. Default false — the MCP only surfaces the authenticated user's reported bugs."),
    page: z.number().optional().default(1).describe("Page number"),
    per_page: z.number().optional().default(25).describe("Items per page"),
  },
  async (params) => {
    const queryParts = [];
    if (params.status && params.status !== "All") queryParts.push(`status=${encodeURIComponent(params.status)}`);
    if (params.severity) queryParts.push(`severity=${encodeURIComponent(params.severity)}`);
    if (params.product) queryParts.push(`product=${encodeURIComponent(params.product)}`);
    if (params.module) queryParts.push(`module=${encodeURIComponent(params.module)}`);
    if (params.search) queryParts.push(`search=${encodeURIComponent(params.search)}`);
    if (params.view) queryParts.push(`view=${params.view}`);
    if (params.page) queryParts.push(`page=${params.page}`);
    if (params.per_page) queryParts.push(`per_page=${params.per_page}`);

    // Ensure auth so currentUserName is populated before we filter
    await ensureAuth();

    const url = `/bugs${queryParts.length ? "?" + queryParts.join("&") : ""}`;
    const data = await inertiaGet(url);
    const bugs = data.props?.bugs;

    if (!bugs?.data) {
      return textResult({ error: "Could not retrieve bugs", raw: Object.keys(data.props || {}) });
    }

    // Reporter-scoped by default: the Laravel API doesn't support a reporter filter,
    // so we filter client-side on `bug.reporter.name === currentUserName`.
    const applyReporterFilter = !params.include_all_reporters && currentUserName;
    const rawData = applyReporterFilter
      ? bugs.data.filter(b => (b.reporter?.name || null) === currentUserName)
      : bugs.data;

    const formatted = rawData.map(formatBug);
    return textResult({
      bugs: formatted,
      pagination: {
        current_page: bugs.current_page,
        total: applyReporterFilter ? formatted.length : bugs.total,
        per_page: bugs.per_page,
        last_page: bugs.last_page,
        ...(applyReporterFilter ? {
          reporter_filter: currentUserName,
          server_side_total: bugs.total,
          note: `Showing only bugs reported by ${currentUserName}. Pass include_all_reporters:true to see everyone's bugs. Note: pagination is across the pre-filter page, so some pages may appear partially empty after filtering.`,
        } : {}),
      },
      status_counts: data.props?.statusCounts,
    });
  }
);

// ── Tool: get_bug ───────────────────────────────────────────────────────────
server.tool(
  "get_bug",
  "Get detailed information about a specific bug by its numeric ID.",
  {
    bug_id: z.number().describe("The numeric ID of the bug (e.g., 1720)"),
  },
  async ({ bug_id }) => {
    const bugSlug = `BG-${String(bug_id).padStart(4, "0")}`;
    let data;
    try {
      data = await inertiaGet(`/bugs/${bugSlug}/edit`);
    } catch (e) {
      const listData = await inertiaGet(`/bugs?view=all&search=${bugSlug}`);
      const found = listData.props?.bugs?.data?.find(b => b.bug_id === bugSlug);
      if (found) return textResult(formatBug(found));
      return textResult({ error: `Bug ${bug_id} not found` });
    }
    const bug = data.props?.bug;
    if (!bug) {
      const listData = await inertiaGet(`/bugs?view=all&search=${bugSlug}`);
      const found = listData.props?.bugs?.data?.find(b => b.bug_id === bugSlug);
      if (found) return textResult(formatBug(found));
      return textResult({ error: `Bug ${bug_id} not found` });
    }
    return textResult(formatBug(bug));
  }
);

// ── Tool: create_bug ────────────────────────────────────────────────────────
server.tool(
  "create_bug",
  "Create a new bug. Title is auto-built by joining: product - solution - platform - bug_summary (e.g. 'PM V1 - TimeTec Maintenance - App - Lacking indicator...'). Description is auto-built from steps_to_reproduce, expected_result, and actual_result. Accepts NAMES or numeric IDs for product/module/category/assignees. Pass related_task as 'TS-RND-0309' or a numeric id to link a task.\n\n**BUG ROUTING RULE (must read before calling):** Before invoking this tool, you MUST ask the user where to file the bug. Possible answers:\n  • `tracker_only` — file only to dt.timeteccloud.com (the TimeTec Project dashboard).\n  • `tracker_and_excel` — file to dt.timeteccloud.com AND append a row to PMv2- Test Result.xlsx.\n  • `excel_only` — DO NOT use create_bug; use `sheet_append_row` directly instead.\n  • `neither` — DO NOT call any filing tool.\n\nThe required `destination` parameter MUST match the user's confirmed choice. This tool will refuse to run without it.\n\n**TASK ID RULE (must read before calling):** Before invoking this tool you MUST also ask the user whether this bug links to a Task ID (e.g. TS-RND-0309). Acceptable answers:\n  • `with_task` — yes, link it; the user provided a Task ID → pass it via `related_task`.\n  • `no_task`   — no Task ID for this bug; do NOT pass `related_task`.\n\nThe required `task_decision` parameter MUST match the user's confirmed choice. The tool refuses to run if the contract is broken (e.g. `task_decision: 'with_task'` but `related_task` is missing, or `task_decision: 'no_task'` but `related_task` is set). Silently omitting the question is forbidden — every bug filing must record an explicit task-link decision.\n\n**OWNERSHIP RULE (must read before calling):** Every bug needs SOMEONE to route to — either a Task (which carries assignees) or an explicit assignee. The tool rejects calls where BOTH `related_task` and `assignees` are missing/empty. If the user gives a Task ID → set task_decision='with_task' and pass related_task; ownership is inherited from the task. If the user gives a developer/team name → set task_decision='no_task' and pass it via `assignees` (name/email/id). If the user provides neither, do NOT call this tool — re-prompt them for one of the two and only file when they answer.",
  {
    product: z.union([z.string(), z.number()]).describe("Product name (e.g. 'TimeTec HR - Version 2', 'PM V1') or numeric ID"),
    solution: z.string().optional().describe("Solution name for the title (e.g. 'TimeTec Maintenance', 'TimeTec VMS', 'iNeighbour'). Omit if not applicable."),
    platform: z.string().optional().describe("Platform for the title (e.g. 'App', 'Web'). Omit if not applicable."),
    bug_summary: z.string().describe("Short bug summary for the title (e.g. 'Lacking indicator to differentiate required fields when adding/editing work order or request.')"),
    severity: z.enum(["Critical", "High", "Medium", "Low"]).describe("Bug severity"),
    steps_to_reproduce: z.array(z.string()).describe("Steps to reproduce the bug (e.g. ['Open TimeTec Maintenance App', 'Click + button at center', 'Choose either Work Order/Request'])"),
    expected_result: z.string().describe("What should happen (e.g. 'There should be signs such as red star to indicate which fields are required.')"),
    actual_result: z.string().describe("What actually happens (e.g. 'Missing indicators for required fields.')"),
    module: z.union([z.string(), z.number()]).optional().describe("Module name (e.g. 'Appraisal') or numeric ID"),
    category: z.union([z.string(), z.number()]).optional().describe("Bug category name (e.g. 'UI/UX Issues') or numeric ID"),
    assignees: z.union([
      z.string(),
      z.number(),
      z.array(z.union([z.string(), z.number()]))
    ]).optional().describe("Assignee name(s)/email(s) or ID(s). Accepts a single value or an array."),
    related_task: z.union([z.string(), z.number()]).optional().describe("Related task as 'TS-RND-0309' display id, title keyword, or numeric id"),
    attachment_links: z.array(z.union([
      z.string(),
      z.object({ url: z.string(), label: z.string().optional() }),
    ])).optional().describe("OneDrive or other links to attach. Each item can be a URL string or {url, label}. These are embedded as clickable links in the description."),
    sub_module_id: z.number().optional().describe("Sub-module numeric ID (advanced — name resolution not yet supported)"),
    solution_id: z.number().optional().describe("Solution numeric ID (advanced — name resolution not yet supported)"),
    sub_module: z.string().optional().describe("Free-text sub-module name written ONLY to the Excel `Sub module` column (does not affect the bug tracker record)."),
    dev_incharge: z.string().optional().describe("Free-text developer name written ONLY to the Excel `Dev incharge` column (does not affect the bug tracker record)."),
    destination: z.enum(["tracker_only", "tracker_and_excel"]).describe("REQUIRED. Where to file the bug — MUST be confirmed with the user FIRST per the bug-routing rule. 'tracker_only' = dt.timeteccloud.com only. 'tracker_and_excel' = dashboard plus an Excel row. If the user wants Excel-only, call sheet_append_row instead. If neither, do not call this tool at all."),
    task_decision: z.enum(["with_task", "no_task"]).describe("REQUIRED. Whether this bug links to a Task ID — MUST be confirmed with the user FIRST per the TASK ID RULE. 'with_task' = user supplied a Task ID (also pass `related_task`). 'no_task' = user explicitly said no Task ID (DO NOT pass `related_task`). Silently omitting the question is forbidden; the tool will refuse to run if the contract is broken."),
  },
  async (params) => {
    // Enforce TASK ID RULE — the agent MUST have asked the user about a
    // Task ID. The decision must match the related_task argument.
    if (params.task_decision === "with_task" && params.related_task == null) {
      return textResult({
        error: "task_decision='with_task' requires a related_task value. Either pass the Task ID (e.g. 'TS-RND-0309') in related_task, or set task_decision='no_task' if the user did not provide one.",
      });
    }
    if (params.task_decision === "no_task" && params.related_task != null) {
      return textResult({
        error: "task_decision='no_task' must NOT be combined with a related_task value. Either remove related_task, or set task_decision='with_task' to confirm the user supplied a Task ID.",
      });
    }
    // Enforce OWNERSHIP RULE — every TimeTec project bug needs SOMEONE
    // it routes to: either a Task (which carries assignees implicitly) or
    // an explicit assignee. A bug with neither is ownerless and gets lost
    // in the queue. Re-prompt the user for one of the two.
    const hasAssignees = params.assignees != null && (
      Array.isArray(params.assignees) ? params.assignees.length > 0 : true
    );
    const hasTask = params.related_task != null;
    if (!hasTask && !hasAssignees) {
      return textResult({
        error: "Bug must have an owner: pass either a related_task (Task ID like 'TS-RND-0309') OR at least one assignee (name/email/id). The current call has neither — the bug would be filed with no one to route it to. Ask the user for one of: (a) the Task ID this bug belongs to, or (b) the developer/team to assign it to. If they don't know either, do NOT file the bug — defer until they do.",
      });
    }
    let lookups;
    try {
      lookups = await getBugLookups();
    } catch (e) {
      return textResult({ error: `Could not load lookup tables: ${e.message}` });
    }

    let product_id, module_id, category_id, assignee_ids, product_name;
    try {
      product_id = resolveLookup(lookups.products, params.product, "product");
      // Resolve product name for title building
      const productEntry = lookups.products.find((p) => p.id === product_id);
      product_name = productEntry ? productEntry.name : String(params.product);
      module_id = params.module ? resolveLookup(lookups.modules, params.module, "module") : null;
      category_id = params.category ? resolveLookup(lookups.bugCategories, params.category, "category") : null;

      if (params.assignees != null) {
        const list = Array.isArray(params.assignees) ? params.assignees : [params.assignees];
        assignee_ids = list.map((a) => resolveLookup(lookups.assignees, a, "assignee"));
      } else {
        assignee_ids = [];
      }
    } catch (e) {
      return textResult({ error: e.message });
    }

    // Resolve related task (search by display id or keyword)
    let related_task_id = null;
    if (params.related_task != null) {
      if (typeof params.related_task === "number") {
        related_task_id = params.related_task;
      } else if (/^\d+$/.test(params.related_task)) {
        related_task_id = parseInt(params.related_task, 10);
      } else {
        try {
          const taskSearch = await inertiaGet(`/tasks?search=${encodeURIComponent(params.related_task)}&view=all`);
          const matches = taskSearch.props?.tasks?.data || [];
          if (matches.length === 0) {
            return textResult({ error: `No task matches "${params.related_task}". Use search_tasks to find one.` });
          }
          if (matches.length > 1) {
            return textResult({
              error: `Multiple tasks match "${params.related_task}". Be more specific or pass a numeric id.`,
              candidates: matches.slice(0, 5).map((t) => ({ id: t.id, task_id: t.task_id, title: t.title })),
            });
          }
          const matchedTask = matches[0];
          if (matchedTask.status === "Completed") {
            return textResult({
              error: `Task "${matchedTask.task_id}" (${matchedTask.title}) is already Completed. No more bugs can be added to a completed task.`,
              task_id: matchedTask.task_id,
              status: matchedTask.status,
            });
          }
          related_task_id = matchedTask.id;
        } catch (e) {
          return textResult({ error: `Failed to resolve related task: ${e.message}` });
        }
      }
    }

    // Build title from parts: product - solution - platform - bug_summary
    const titleParts = [product_name];
    if (params.solution) titleParts.push(params.solution);
    if (params.platform) titleParts.push(params.platform);
    titleParts.push(params.bug_summary);
    const title = titleParts.join(" - ");

    // Build description from structured fields
    const stepsHtml = params.steps_to_reproduce
      .map((step, i) => `${i + 1}. ${step}`)
      .join("<br>");
    let description = `<b>Steps to Reproduce:</b><br>${stepsHtml}<br><br><b>Expected Result:</b><br>${params.expected_result}<br><br><b>Actual Result:</b><br>${params.actual_result}`;

    // Append attachment links if provided
    if (params.attachment_links && params.attachment_links.length > 0) {
      const linksHtml = params.attachment_links.map((link) => {
        const url = typeof link === "string" ? link : link.url;
        const label = typeof link === "string" ? url : (link.label || url);
        return `<a href="${url}" target="_blank">${label}</a>`;
      }).join("<br>");
      description += `<br><br><b>Attachments:</b><br>${linksHtml}`;
    }

    const result = await inertiaPost("/bugs", {
      title,
      description,
      product_id,
      module_id,
      sub_module_id: params.sub_module_id || null,
      solution_id: params.solution_id || null,
      severity: params.severity,
      category_id,
      assignee_ids,
      related_task: related_task_id,
    });

    if (result.success === false) {
      return textResult({ error: "Failed to create bug", details: result.errors });
    }

    // Check for Inertia-level validation errors (returned inside props.errors, not as 422)
    const propsErrors = result.props?.errors;
    if (propsErrors && Object.keys(propsErrors).length > 0) {
      return textResult({ error: "Failed to create bug", details: propsErrors });
    }

    // Try to surface the newly created bug from the redirected list response
    const created = result.props?.bugs?.data?.find((b) => b.title === title);

    // ── Mirror to PMv2 Bug list Excel (best-effort) ────────────────────────
    // Failures here don't roll back the bug; we surface the outcome in `sheet`.
    // Controlled by `destination` — only 'tracker_and_excel' triggers the mirror.
    let sheetOutcome = { logged: false, skipped: true, reason: `destination=${params.destination}` };
    if (params.destination === "tracker_and_excel") {
      try {
        const moduleName = params.module
          ? (typeof params.module === "string"
              ? params.module
              : (lookups.modules.find((m) => m.id === module_id)?.name || ""))
          : "";
        const categoryName = params.category
          ? (typeof params.category === "string"
              ? params.category
              : (lookups.bugCategories.find((c) => c.id === category_id)?.name || ""))
          : "";

        // Severity → Bug Priority: Critical collapses to High (sheet only has H/M/L).
        const priorityMap = { Critical: "High", High: "High", Medium: "Medium", Low: "Low" };

        const stepsPlain = params.steps_to_reproduce
          .map((s, i) => `${i + 1}. ${s}`)
          .join("\n");
        const descriptionPlain =
          `Steps to Reproduce:\n${stepsPlain}\n\n` +
          `Expected Result:\n${params.expected_result}\n\n` +
          `Actual Result:\n${params.actual_result}`;

        let screenshot = "";
        if (params.attachment_links && params.attachment_links.length > 0) {
          const first = params.attachment_links[0];
          screenshot = typeof first === "string" ? first : first.url;
        }

        const sheetValues = {
          "Date Reported": new Date().toISOString().slice(0, 10),
          "Module": moduleName,
          "Sub module": params.sub_module || "",
          "Title": title,
          "Category": categoryName,
          "Description": descriptionPlain,
          "Steps": stepsPlain,
          "Actual Result": params.actual_result,
          "Expected Result": params.expected_result,
          "Screenshot": screenshot,
          "Bug Priority": priorityMap[params.severity] || params.severity,
          "Dev incharge": params.dev_incharge || "",
        };

        const sheetRes = await callSheetFlow("append", 0, sheetValues);
        sheetOutcome = sheetRes.ok
          ? { logged: true, ...sheetRes.result }
          : { logged: false, error: sheetRes.error };
      } catch (e) {
        sheetOutcome = { logged: false, error: String((e && e.message) || e) };
      }
    }

    return textResult({
      success: true,
      message: "Bug created successfully",
      resolved: { product_id, module_id, category_id, assignee_ids, related_task_id },
      bug: created ? formatBug(created) : null,
      sheet: sheetOutcome,
    });
  }
);

// ── Tool: update_bug ────────────────────────────────────────────────────────
server.tool(
  "update_bug",
  "Update an existing bug. Uses PATCH /bugs/BG-{id}. Only provide fields you want to change. Status changes are role-gated — this MCP is authenticated as a QC user, so only QC-side transitions work (see `status` field for the allowed list).",
  {
    bug_id: z.number().describe("The numeric ID of the bug to update (e.g. 1724 for BG-1724)"),
    title: z.string().optional().describe("New bug title"),
    description: z.string().optional().describe("New description (HTML allowed)"),
    severity: z.enum(["Critical", "High", "Medium", "Low"]).optional().describe("New severity"),
    status: z.string().optional().describe("New status. Valid QC-side transitions this MCP can perform: Ready For Testing → QC - In Progress, QC - In Progress → Reopen, QC - In Progress → Ready For Live, Live → Closed. Any other transition (e.g. New → RND - In Progress, RND - In Progress → Ready For Testing, Ready For Live → Live) is an RND-side action and will be rejected with an error explaining the precondition mismatch. If the user needs an RND-side transition, ask them to have the RND/dev account do it in the dashboard."),
    product_id: z.number().optional().describe("New product ID"),
    module_id: z.number().optional().describe("New module ID"),
    sub_module_id: z.number().optional().describe("New sub-module ID"),
    solution_id: z.number().optional().describe("New solution ID"),
    category_id: z.number().optional().describe("New category ID"),
    assignee_ids: z.array(z.number()).optional().describe("New assignee user IDs"),
  },
  async (params) => {
    const { bug_id, status, ...rest } = params;
    const bugSlug = `BG-${String(bug_id).padStart(4, "0")}`;

    // Status goes through the dedicated PATCH /bugs/BG-{id}/status endpoint
    // with a `new_status` field (matches the web UI's status-change route).
    if (status !== undefined) {
      await ensureAuth();
      const res = await fetchWithCookies(`/bugs/${bugSlug}/status`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({ new_status: status, update_task: false }),
      });
      if (res.status === 419) {
        await reAuth();
        const retry = await fetchWithCookies(`/bugs/${bugSlug}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" },
          body: JSON.stringify({ new_status: status, update_task: false }),
        });
        if (!retry.ok) return textResult({ error: "Failed to update status", details: await retry.text() });
      } else if (res.status === 422) {
        return textResult({ error: "Failed to update status", details: await res.json() });
      } else if (!res.ok && res.status !== 302 && res.status !== 303) {
        return textResult({ error: "Failed to update status", details: `HTTP ${res.status}: ${await res.text()}` });
      }

      // Verify — the API returns 302/303 even when a workflow rule silently blocks the transition.
      // Match by display slug (bug_id) since list_bugs' response uses `id` for the internal row id
      // and `bug_id` for the display slug (e.g. "BG-1964"). The old comparison `b.id === bug_id`
      // compared an internal id (2394) to the display number (1964), so it never matched and the
      // check silently short-circuited — every invalid transition returned success: true.
      try {
        const check = await inertiaGet(`/bugs?view=all&search=${bugSlug}`);
        const current = check.props?.bugs?.data?.find(b => b.bug_id === bugSlug)?.status;
        if (current && current !== status) {
          return textResult({
            error: "Status did not change",
            details: `Backend accepted the request but status is still "${current}" (expected "${status}"). The transition is unavailable because the current status doesn't match the required precondition — it's likely blocked by workflow rules for this account's role (QC).`,
            current_status: current,
            requested_status: status,
          });
        }
      } catch { /* if verification fails, assume success */ }
    }

    // Remaining fields go through the general bug update endpoint
    const cleanUpdates = Object.fromEntries(Object.entries(rest).filter(([_, v]) => v !== undefined));
    if (Object.keys(cleanUpdates).length > 0) {
      const result = await inertiaPatch(`/bugs/${bugSlug}`, cleanUpdates);
      if (result.success === false) {
        return textResult({ error: "Failed to update bug", details: result.errors });
      }
      const propsErrors = result.props?.errors;
      if (propsErrors && Object.keys(propsErrors).length > 0) {
        return textResult({ error: "Failed to update bug", details: propsErrors });
      }
    }

    return textResult({ success: true, message: `Bug ${bugSlug} updated successfully` });
  }
);

// ── Tool: add_task_comment ──────────────────────────────────────────────────
server.tool(
  "add_task_comment",
  "Add a comment to a task. Uses the task display ID (e.g. TS-QC-0200).",
  {
    task_id: z.string().describe("Task display ID (e.g. 'TS-QC-0200') or numeric ID"),
    comment: z.string().describe("Comment text to add"),
  },
  async ({ task_id, comment }) => {
    // If numeric, resolve to display ID
    let displayId = task_id;
    if (/^\d+$/.test(task_id)) {
      const searchData = await inertiaGet(`/tasks?search=${task_id}&view=all`);
      const task = searchData.props?.tasks?.data?.find(t => t.id === parseInt(task_id));
      if (!task) return textResult({ error: `Task ${task_id} not found.` });
      displayId = task.task_id;
    }

    const result = await inertiaPost(`/task/${displayId}/comments`, { comment, attachments: [] });

    if (result.success === false) {
      return textResult({ error: "Failed to add comment", details: result.errors });
    }

    const propsErrors = result.props?.errors;
    if (propsErrors && Object.keys(propsErrors).length > 0) {
      return textResult({ error: "Failed to add comment", details: propsErrors });
    }

    return textResult({ success: true, message: `Comment added to ${displayId}.` });
  }
);

// ── Tool: add_bug_comment ──────────────────────────────────────────────────
server.tool(
  "add_bug_comment",
  "Add a comment to a bug. Uses the bug display ID (e.g. BG-1724).",
  {
    bug_id: z.number().describe("Numeric bug ID (e.g. 1724 for BG-1724)"),
    comment: z.string().describe("Comment text to add"),
  },
  async ({ bug_id, comment }) => {
    const result = await inertiaPost(`/bugs/BG-${bug_id}/comments`, { comment, attachments: [] });

    if (result.success === false) {
      return textResult({ error: "Failed to add comment", details: result.errors });
    }

    const propsErrors = result.props?.errors;
    if (propsErrors && Object.keys(propsErrors).length > 0) {
      return textResult({ error: "Failed to add comment", details: propsErrors });
    }

    return textResult({ success: true, message: `Comment added to BG-${bug_id}.` });
  }
);

// ── Tool: delete_bug ────────────────────────────────────────────────────────
server.tool(
  "delete_bug",
  "Delete a bug by its numeric ID. This action cannot be undone.",
  {
    bug_id: z.number().describe("The numeric ID of the bug to delete"),
  },
  async ({ bug_id }) => {
    const result = await inertiaDelete(`/bugs/${bug_id}`);
    return textResult({ success: true, message: `Bug ${bug_id} deleted successfully` });
  }
);

// ── Tool: get_filter_options ────────────────────────────────────────────────
server.tool(
  "get_filter_options",
  "Get all available filter options for bugs (products, solutions, modules, severities, statuses, categories).",
  {},
  async () => {
    const data = await inertiaGet("/bugs");
    return textResult({
      filter_options: data.props?.filterOptions,
      products: data.props?.products?.map(p => ({ id: p.id, name: p.name })),
      bug_categories: data.props?.bugCategories?.map(c => ({ id: c.id, name: c.name })),
      status_counts: data.props?.statusCounts,
    });
  }
);

// ── Tool: search_bugs ───────────────────────────────────────────────────────
server.tool(
  "search_bugs",
  "Search bugs by keyword reported by the authenticated user. Searches bug name/title and ID. Like list_bugs, only surfaces bugs where `reporter` matches the login credentials; pass include_all_reporters:true to bypass.",
  {
    query: z.string().describe("Search keyword"),
    include_all_reporters: z.boolean().optional().default(false).describe("Bypass the reporter filter and return matches by any reporter. Default false."),
  },
  async ({ query, include_all_reporters }) => {
    await ensureAuth();
    const data = await inertiaGet(`/bugs?search=${encodeURIComponent(query)}`);
    const bugs = data.props?.bugs;
    if (!bugs?.data) {
      return textResult({ error: "Search failed", results: [] });
    }
    const applyReporterFilter = !include_all_reporters && currentUserName;
    const rawData = applyReporterFilter
      ? bugs.data.filter(b => (b.reporter?.name || null) === currentUserName)
      : bugs.data;
    return textResult({
      results: rawData.map(formatBug),
      total: applyReporterFilter ? rawData.length : bugs.total,
      ...(applyReporterFilter ? {
        reporter_filter: currentUserName,
        server_side_total: bugs.total,
      } : {}),
    });
  }
);

// ── Tool: list_tasks ───────────────────────────────────────────────────────
server.tool(
  "list_tasks",
  "List all tasks with optional filters. Returns paginated task list with details.",
  {
    status: z.string().optional().describe("Filter by task status (e.g. New, Reopen, QC - In Progress, RND - In Progress, Ready For Testing, Completed, Live, Closed, etc.)"),
    priority: z.string().optional().describe("Filter by priority name (Highest, High, Medium, Low)"),
    product: z.string().optional().describe("Filter by product name"),
    module: z.string().optional().describe("Filter by module name"),
    search: z.string().optional().describe("Search by task name or ID"),
    page: z.number().optional().default(1).describe("Page number"),
    per_page: z.number().optional().default(10).describe("Items per page"),
  },
  async (params) => {
    const queryParts = [];
    if (params.status) queryParts.push(`status=${encodeURIComponent(params.status)}`);
    if (params.priority) queryParts.push(`priority=${encodeURIComponent(params.priority)}`);
    if (params.product) queryParts.push(`product=${encodeURIComponent(params.product)}`);
    if (params.module) queryParts.push(`module=${encodeURIComponent(params.module)}`);
    if (params.search) queryParts.push(`search=${encodeURIComponent(params.search)}`);
    if (params.page) queryParts.push(`page=${params.page}`);
    if (params.per_page) queryParts.push(`per_page=${params.per_page}`);

    const url = `/tasks${queryParts.length ? "?" + queryParts.join("&") : ""}`;
    const data = await inertiaGet(url);
    const tasks = data.props?.tasks;

    if (!tasks?.data) {
      return textResult({ error: "Could not retrieve tasks", raw: Object.keys(data.props || {}) });
    }

    return textResult({
      tasks: tasks.data.map(formatTask),
      pagination: {
        current_page: tasks.current_page,
        total: tasks.total,
        per_page: tasks.per_page,
        last_page: tasks.last_page,
      },
      status_counts: data.props?.statusCounts,
    });
  }
);

// ── Tool: get_task ─────────────────────────────────────────────────────────
server.tool(
  "get_task",
  "Get detailed information about a specific task by its numeric ID.",
  {
    task_id: z.number().describe("The numeric ID of the task"),
  },
  async ({ task_id }) => {
    const data = await inertiaGet(`/tasks/${task_id}/edit`);
    const task = data.props?.task;
    if (!task) {
      return textResult({ error: `Task ${task_id} not found` });
    }
    return textResult(formatTask(task));
  }
);

// ── Tool: create_task ──────────────────────────────────────────────────────
server.tool(
  "create_task",
  "Create a new task. Returns the created task details.",
  {
    title: z.string().describe("Task title/name"),
    description: z.string().describe("Task description (can include HTML)"),
    product_id: z.number().describe("Product ID"),
    assignee_ids: z.array(z.number()).describe("Array of assignee user IDs (required)"),
    start_date: z.string().describe("Start date (YYYY-MM-DD)"),
    module_id: z.number().optional().describe("Module ID"),
    sub_module_id: z.number().optional().describe("Sub-module ID"),
    solution_id: z.number().optional().describe("Solution ID"),
    priority_id: z.number().optional().default(3).describe("Priority ID (1=Highest, 2=High, 3=Medium, 4=Low)"),
    task_size: z.enum(["small", "medium", "large", "major"]).optional().default("small").describe("Task size"),
    due_date: z.string().optional().describe("Due date (YYYY-MM-DD)"),
    parent_task_id: z.number().optional().describe("Parent task ID for subtasks"),
    related_ticket_id: z.number().optional().describe("Related ticket ID"),
    platform: z.array(z.string()).optional().describe("Platform tags"),
    remarks: z.string().optional().describe("Remarks"),
  },
  async (params) => {
    const result = await inertiaPost("/tasks", {
      title: params.title,
      description: params.description || "",
      product_id: params.product_id,
      module_id: params.module_id || null,
      sub_module_id: params.sub_module_id || null,
      solution_id: params.solution_id || null,
      priority_id: params.priority_id,
      task_size: params.task_size,
      assignee_ids: params.assignee_ids || [],
      start_date: params.start_date || null,
      due_date: params.due_date || null,
      parent_task_id: params.parent_task_id || null,
      related_ticket_id: params.related_ticket_id || null,
      platform: params.platform || [],
      remarks: params.remarks || null,
    });

    if (result.success === false) {
      return textResult({ error: "Failed to create task", details: result.errors });
    }

    return textResult({ success: true, message: "Task created successfully", data: result.props?.tasks?.data?.[0] || result });
  }
);

// ── Tool: update_task ──────────────────────────────────────────────────────
server.tool(
  "update_task",
  "Update an existing task. Only provide fields you want to change.",
  {
    task_id: z.number().describe("The numeric ID of the task to update"),
    title: z.string().optional().describe("New task title"),
    description: z.string().optional().describe("New description"),
    status: z.string().optional().describe("New status"),
    priority_id: z.number().optional().describe("New priority ID (1=Highest, 2=High, 3=Medium, 4=Low)"),
    task_size: z.enum(["small", "medium", "large", "major"]).optional().describe("New task size"),
    product_id: z.number().optional().describe("New product ID"),
    module_id: z.number().optional().describe("New module ID"),
    sub_module_id: z.number().optional().describe("New sub-module ID"),
    solution_id: z.number().optional().describe("New solution ID"),
    assignee_ids: z.array(z.number()).optional().describe("New assignee user IDs"),
    start_date: z.string().optional().describe("New start date (YYYY-MM-DD)"),
    due_date: z.string().optional().describe("New due date (YYYY-MM-DD)"),
    remarks: z.string().optional().describe("New remarks"),
  },
  async (params) => {
    const { task_id, ...updates } = params;
    const cleanUpdates = Object.fromEntries(Object.entries(updates).filter(([_, v]) => v !== undefined));

    // Resolve display ID — /tasks/{numeric}/edit returns the task with its task_id (e.g. TS-QC-0200)
    let displayId;
    try {
      const editData = await inertiaGet(`/tasks/${task_id}/edit`);
      displayId = editData.props?.task?.task_id;
    } catch (e) {
      // Fall back to search (covers older tasks or alternate paths)
      const searchData = await inertiaGet(`/tasks?search=${task_id}&view=all`);
      const task = searchData.props?.tasks?.data?.find(t => t.id === task_id);
      displayId = task?.task_id;
    }
    if (!displayId) {
      return textResult({ error: `Task with numeric ID ${task_id} not found.` });
    }

    const result = await inertiaPatch(`/tasks/${displayId}`, cleanUpdates);

    if (result.success === false) {
      return textResult({ error: "Failed to update task", details: result.errors });
    }

    const propsErrors = result.props?.errors;
    if (propsErrors && Object.keys(propsErrors).length > 0) {
      return textResult({ error: "Failed to update task", details: propsErrors });
    }

    return textResult({ success: true, message: `Task ${displayId} updated successfully` });
  }
);

// ── Tool: delete_task ──────────────────────────────────────────────────────
server.tool(
  "delete_task",
  "Delete a task by its numeric ID. This action cannot be undone.",
  {
    task_id: z.number().describe("The numeric ID of the task to delete"),
  },
  async ({ task_id }) => {
    await inertiaDelete(`/tasks/${task_id}`);
    return textResult({ success: true, message: `Task ${task_id} deleted successfully` });
  }
);

// ── Tool: get_task_filter_options ───────────────────────────────────────────
server.tool(
  "get_task_filter_options",
  "Get all available filter options for tasks (products, priorities, sizes, statuses, modules).",
  {},
  async () => {
    const data = await inertiaGet("/tasks");
    return textResult({
      filter_options: data.props?.filterOptions,
      products: data.props?.products,
      task_priorities: data.props?.taskPriorities,
      task_sizes: data.props?.taskSizes,
      status_options: data.props?.statusOptions,
      status_counts: data.props?.statusCounts,
      users: data.props?.users?.map(u => ({ id: u.id, name: u.name })),
    });
  }
);

// ── Tool: search_tasks ─────────────────────────────────────────────────────
server.tool(
  "search_tasks",
  "Search tasks by keyword (matches task title or task_id like 'TS-RND-0309'). Use this to find a task when you only know part of its name or its display ID — returns each match with its numeric id so you can then use get_task/update_task/delete_task.",
  {
    query: z.string().describe("Search keyword — can be a task_id like 'TS-RND-0309', a title fragment, or any keyword"),
  },
  async ({ query }) => {
    const data = await inertiaGet(`/tasks?search=${encodeURIComponent(query)}&view=all`);
    const tasks = data.props?.tasks;
    if (!tasks?.data) {
      return textResult({ error: "Search failed", results: [] });
    }
    return textResult({
      results: tasks.data.map(formatTask),
      total: tasks.total,
      hint: tasks.data.length > 0
        ? `Found ${tasks.data.length} match(es). Use the 'id' field (not task_id) with get_task/update_task/delete_task.`
        : "No matches found. Try a different keyword.",
    });
  }
);

// ── Tool: get_my_workspace ─────────────────────────────────────────────────
server.tool(
  "get_my_workspace",
  "Returns the current user's active tasks and bugs — i.e. 'what am I working on right now'. Use this when the user says 'my task', 'the task I'm on', 'what I'm working on', etc.",
  {
    include_bugs: z.boolean().optional().default(true).describe("Also include the user's active bugs"),
    only_active: z.boolean().optional().default(true).describe("Only include items in active statuses (New, Reopen, In Progress, Ready For Testing). Set false for all."),
  },
  async ({ include_bugs, only_active }) => {
    const activeTaskStatuses = ["New", "Reopen", "QC - In Progress", "RND - In Progress", "Ready For Testing"];
    const activeBugStatuses = ["New", "Reopen", "QC - In Progress", "RND - In Progress", "Ready For Testing"];

    // Fetch my tasks
    const tasksData = await inertiaGet("/tasks?view=my&per_page=100");
    const allMyTasks = tasksData.props?.tasks?.data || [];
    const myUser = tasksData.props?.auth?.user;

    const filteredTasks = only_active
      ? allMyTasks.filter(t => activeTaskStatuses.includes(t.status))
      : allMyTasks;

    const result = {
      current_user: myUser ? { id: myUser.id, name: myUser.name, email: myUser.email } : null,
      active_tasks: filteredTasks.map(formatTask),
      task_count: filteredTasks.length,
    };

    if (include_bugs) {
      const bugsData = await inertiaGet("/bugs?view=my&per_page=100");
      const allMyBugs = bugsData.props?.bugs?.data || [];
      const filteredBugs = only_active
        ? allMyBugs.filter(b => activeBugStatuses.includes(b.status))
        : allMyBugs;

      result.active_bugs = filteredBugs.map(formatBug);
      result.bug_count = filteredBugs.length;
    }

    result.hint = `Showing ${only_active ? "active" : "all"} items assigned to you. Use the 'id' field with get_task/get_bug/update_task/update_bug to operate on a specific item.`;

    return textResult(result);
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// ── Photo Tools (ADB pull → OneDrive sync folder → SharePoint URLs) ────────
// ══════════════════════════════════════════════════════════════════════════════

const ADB = process.env.ADB_PATH || join(homedir(), "AppData/Local/Android/Sdk/platform-tools/adb.exe");
const IOS_CLI = process.env.IOS_CLI_PATH || join(homedir(), "AppData/Roaming/npm/bin/ios.exe");
const TRACKER_FILE = join(homedir(), ".photo-pull-tracker.json");
const ONEDRIVE_SYNC_FOLDER = process.env.ONEDRIVE_SYNC_FOLDER || "";
const SHAREPOINT_BASE_URL = process.env.SHAREPOINT_BASE_URL || "";
const ALLOWED_SERIALS = (process.env.ALLOWED_DEVICES || "").split(",").map(s => s.trim()).filter(Boolean);
const BLOCKED_SERIALS = ["192.168.5.208:5555"]; // Horus - DO NOT TOUCH

const PHOTO_FOLDERS = [
  "/sdcard/DCIM/Camera",
  "/sdcard/DCIM/Screenshots",
  "/sdcard/Pictures",
  "/sdcard/Pictures/Screenshots",
  "/sdcard/Movies",
  "/sdcard/Download",
];
const IOS_PHOTO_FOLDERS = [
  "DCIM",
];
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".bmp"];
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".3gp", ".mkv", ".webm", ".avi"];
const PHOTO_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]; // back-compat alias; covers all media
const VIDEO_EXT_SET = new Set(VIDEO_EXTENSIONS);
const IMAGE_EXT_SET = new Set(IMAGE_EXTENSIONS);

function isVideoPath(p) { return VIDEO_EXT_SET.has((p.match(/\.[^.\\/]+$/)?.[0] || "").toLowerCase()); }
function isImagePath(p) { return IMAGE_EXT_SET.has((p.match(/\.[^.\\/]+$/)?.[0] || "").toLowerCase()); }
function mediaPredicate(mediaMode) {
  if (mediaMode === "photo") return isImagePath;
  if (mediaMode === "video") return isVideoPath;
  return () => true;
}

function loadTracker() {
  if (existsSync(TRACKER_FILE)) return JSON.parse(readFileSync(TRACKER_FILE, "utf-8"));
  return {};
}
function saveTracker(tracker) { writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2)); }

function parseDate(dateStr) {
  const now = new Date();
  const lower = dateStr.toLowerCase().trim();
  if (lower === "today") return { start: startOfDay(now), end: endOfDay(now) };
  if (lower === "yesterday") { const d = new Date(now); d.setDate(d.getDate() - 1); return { start: startOfDay(d), end: endOfDay(d) }; }
  const lastN = lower.match(/^last\s+(\d+)\s+days?$/);
  if (lastN) { const s = new Date(now); s.setDate(s.getDate() - parseInt(lastN[1]) + 1); return { start: startOfDay(s), end: endOfDay(now) }; }
  const iso = lower.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) { const d = new Date(iso[1], iso[2] - 1, iso[3]); return { start: startOfDay(d), end: endOfDay(d) }; }
  const range = lower.match(/^(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})$/);
  if (range) { const [, f, t] = range; const [fy, fm, fd] = f.split("-").map(Number); const [ty, tm, td] = t.split("-").map(Number); return { start: startOfDay(new Date(fy, fm - 1, fd)), end: endOfDay(new Date(ty, tm - 1, td)) }; }
  return null;
}
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0); }
function endOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999); }

// Wait for OneDrive to finish uploading a file to SharePoint.
// Polls the URL via HEAD request. 404 = not yet synced; 401/403/200/302 = exists.
async function waitForSharePointSync(url, maxWaitMs = 60000, pollIntervalMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const code = execSync(
        `curl -s -I -o /dev/null -w "%{http_code}" --max-time 5 "${url.replace(/"/g, '\\"')}"`,
        { encoding: "utf-8", timeout: 8000 }
      ).trim();
      const status = parseInt(code);
      // 404 = file not yet in SharePoint; any other status (401/403/200/302) = exists
      if (status && status !== 404 && status !== 0) {
        return { synced: true, waitedMs: Date.now() - start, finalStatus: status };
      }
    } catch (e) { /* ignore network errors during poll */ }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  return { synced: false, waitedMs: Date.now() - start };
}

// Check whether the OneDrive client is actually running. Returns true on probe
// failure (we'd rather try to sync than block on a flaky tasklist). Skip
// entirely on non-Windows hosts.
function isOneDriveRunning() {
  if (process.platform !== "win32") return true;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq OneDrive.exe" /NH', {
      encoding: "utf-8",
      timeout: 5000,
    });
    return /onedrive\.exe/i.test(out);
  } catch {
    return true;
  }
}

// Pick the right sync timeout based on file type. Photos are tiny (1-3MB) and
// usually sync in <10s; videos can be 100+MB and legitimately need longer.
function syncTimeoutFor(filename) {
  return /\.(mp4|mov|avi|mkv|webm|m4v|3gp)$/i.test(filename) ? 120000 : 60000;
}

// Poll all SharePoint URLs in parallel. The original sequential loop turned
// `N × timeout` worst-case into wall-clock time; this caps it at `max(timeout)`.
async function waitForAllSyncsParallel(results) {
  return Promise.all(
    results.map((r) =>
      waitForSharePointSync(r.url, syncTimeoutFor(r.file), 2000).then((s) => ({
        file: r.file,
        ...s,
      }))
    )
  );
}

function adb(args, timeout = 30000) {
  try { return execSync(`"${ADB}" ${args}`, { encoding: "utf-8", timeout }).trim(); }
  catch (e) { return e.stdout?.trim() || e.message; }
}

// Throws when adb itself fails (device offline, unauthorized, not connected) so
// callers don't silently parse error messages as file listings. Use only for
// commands where an empty / errored result should NOT be treated as "no files".
function adbStrict(args, timeout = 30000) {
  let out;
  try { out = execSync(`"${ADB}" ${args}`, { encoding: "utf-8", timeout }).trim(); }
  catch (e) {
    const msg = (e.stderr?.toString() || e.stdout?.toString() || e.message || "").trim();
    throw new Error(`adb failed (${args}): ${msg}`);
  }
  if (/^error:|device (offline|unauthorized)|no devices\/emulators found/i.test(out)) {
    throw new Error(`adb reported device error (${args}): ${out}`);
  }
  return out;
}

function getAllDevices() {
  const output = adb("devices -l");
  const lines = output.split("\n").slice(1);
  const allowed = [], pending = [];
  for (const line of lines) {
    const match = line.match(/^(\S+)\s+device\s+(.*)/);
    if (!match) continue;
    const transport = match[1];
    if (BLOCKED_SERIALS.includes(transport)) continue;
    const info = match[2];
    const model = info.match(/model:(\S+)/)?.[1] || "unknown";
    const physicalSerial = adb(`-s ${transport} shell getprop ro.serialno`).replace(/[\r\n]/g, "").trim() || transport;
    const manufacturer = adb(`-s ${transport} shell getprop ro.product.manufacturer`).replace(/[\r\n]/g, "").trim();
    const marketName = adb(`-s ${transport} shell getprop ro.product.marketname`).replace(/[\r\n]/g, "").trim();
    const productModel = adb(`-s ${transport} shell getprop ro.product.model`).replace(/[\r\n]/g, "").trim();
    const name = marketName ? `${manufacturer} ${marketName}`.trim() : productModel ? `${manufacturer} ${productModel}`.trim() : model;
    const device = { serial: transport, physicalSerial, model, name };
    if (ALLOWED_SERIALS.length === 0 || ALLOWED_SERIALS.includes(transport) || ALLOWED_SERIALS.includes(physicalSerial)) {
      allowed.push(device);
    } else {
      pending.push(device);
    }
  }
  return { allowed, pending };
}

function getConnectedDevices() {
  const all = getAllDevices().allowed;
  const groups = new Map();
  for (const d of all) { const k = d.physicalSerial || d.serial; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); }
  const isWifi = (d) => d.serial.includes(":");
  return Array.from(groups.values()).map(g => g.find(isWifi) || g[0]);
}


function listPhotosWithDates(serial, folder) {
  const output = adbStrict(`-s ${serial} shell "ls -1 '${folder}/' 2>/dev/null"`);
  if (!output || output.includes("No such file")) return [];
  const files = output.split("\n").map(f => f.trim()).filter(f => PHOTO_EXTENSIONS.some(ext => f.toLowerCase().endsWith(ext)));
  return files.map(file => {
    const remotePath = `${folder}/${file}`;
    const epoch = parseInt(adb(`-s ${serial} shell "stat -c '%Y' '${remotePath}' 2>/dev/null"`));
    return { file, remotePath, modDate: isNaN(epoch) ? null : new Date(epoch * 1000) };
  });
}

// Default 30s is fine for photos; video files can be hundreds of MB and need
// a much larger ceiling, especially over WiFi-ADB.
function pullTimeoutFor(remotePath) {
  return isVideoPath(remotePath) ? 600000 : 60000;
}

// Returns the on-device size in bytes, or null if the stat failed. Used to
// detect truncated pulls (adb timeout / dropped connection writes a partial
// local file that otherwise looks valid).
function remoteSize(serial, remotePath) {
  try {
    const out = adb(`-s ${serial} shell "stat -c '%s' '${remotePath}' 2>/dev/null"`).trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// Pulls a file from device, verifying size on completion. Returns true on a
// good pull. On size mismatch (truncation) deletes the partial file and
// returns false so callers know NOT to upload or mark it as pulled.
function pullFile(serial, remotePath, localPath) {
  const expected = remoteSize(serial, remotePath);
  try { execSync(`"${ADB}" -s ${serial} pull "${remotePath}" "${localPath}"`, { encoding: "utf-8", timeout: pullTimeoutFor(remotePath) }); }
  catch (e) {
    // Pull failed (timeout or transport error). Drop any partial file.
    try { unlinkSync(localPath); } catch {}
    return false;
  }
  if (!existsSync(localPath)) return false;
  if (expected !== null) {
    const actual = statSync(localPath).size;
    if (actual !== expected) {
      try { unlinkSync(localPath); } catch {}
      return false;
    }
  }
  return true;
}

// Fallback: query MediaStore for indexed images sorted by date_modified DESC.
// Catches OEM-specific paths (Vivo /sdcard/Pictures/Screenshots, Xiaomi /sdcard/MIUI/...)
// that aren't in the hardcoded PHOTO_FOLDERS list.
function listPhotosViaMediaStore(serial) {
  const photos = [];
  const queryTable = (uri) => {
    let output;
    try {
      output = adbStrict(`-s ${serial} shell "content query --uri ${uri} --projection _data:date_modified --sort 'date_modified DESC LIMIT 50'"`, 30000);
    } catch { return; }
    if (!output || !output.includes("Row:")) return;
    for (const line of output.split("\n")) {
      const m = line.match(/_data=([^,]+),\s*date_modified=(\d+)/);
      if (!m) continue;
      const remotePath = m[1].trim().replace(/^\/storage\/emulated\/0\//, "/sdcard/");
      if (!PHOTO_EXTENSIONS.some(ext => remotePath.toLowerCase().endsWith(ext))) continue;
      photos.push({ file: basename(remotePath), remotePath, modDate: new Date(parseInt(m[2]) * 1000) });
    }
  };
  // Images and videos live in separate MediaStore tables on Android.
  queryTable("content://media/external/images/media");
  queryTable("content://media/external/video/media");
  return photos;
}

// ── iOS helpers (go-ios) ──────────────────────────────────────────────────
function iosCli(args, timeout = 30000) {
  try { return execSync(`"${IOS_CLI}" ${args}`, { encoding: "utf-8", timeout }).trim(); }
  catch (e) { return e.stdout?.trim() || e.message; }
}

function getIosDevices() {
  try {
    const output = iosCli("list");
    const parsed = JSON.parse(output.split("\n").filter(l => l.includes("deviceList"))[0] || "{}");
    return (parsed.deviceList || []).map(d => ({
      serial: d.serialNumber || d.udid || "unknown",
      udid: d.udid || d.serialNumber,
      name: d.deviceName || d.ProductType || "iOS Device",
      model: d.ProductType || "unknown",
      platform: "ios",
    }));
  } catch { return []; }
}

// go-ios `fsync tree` doesn't expose mtimes, so iOS results have null modDate.
// To bound the result set (DCIM can hold thousands of files), sort by filename
// descending — iOS uses sequential IMG_NNNN/IMG_E_NNNN naming, so newest sorts
// first — and cap. Callers that pass a `date` filter on iOS get a best-effort
// result with this cap; precise date filtering needs pymobiledevice3.
const IOS_LIST_CAP = 100;
function iosListPhotos(udid, folder) {
  const output = iosCli(`fsync --udid=${udid} tree --path=/${folder}`);
  if (!output || output.includes("error") || output.includes("Error")) return [];
  const files = output.split("\n").map(l => l.trim())
    .filter(f => PHOTO_EXTENSIONS.some(ext => f.toLowerCase().endsWith(ext)));
  files.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
  return files.slice(0, IOS_LIST_CAP).map(file => {
    const remotePath = `/${folder}/${file}`;
    return { file: basename(file), remotePath, modDate: null };
  });
}

function iosPullFile(udid, remotePath, localPath) {
  iosCli(`fsync --udid=${udid} pull --srcPath="${remotePath}" --dstPath="${localPath}"`);
}

function iosScreenshot(udid, localPath) {
  iosCli(`screenshot --udid=${udid} --output="${localPath}"`);
}

function resolveDevice(deviceQuery) {
  const androidDevices = getConnectedDevices();
  const iosDevices = getIosDevices();
  const allDevices = [...androidDevices.map(d => ({ ...d, platform: "android" })), ...iosDevices];
  if (allDevices.length === 0) return { error: "No devices connected (Android or iOS)." };
  if (!deviceQuery) {
    const list = allDevices.map(d => `- ${d.name} (${d.platform})`).join("\n");
    return { error: `DEVICE SELECTION REQUIRED: Ask the user which device to use.\n\nConnected:\n${list}` };
  }
  const q = deviceQuery.toLowerCase().trim();
  const found = allDevices.find(d => d.serial === deviceQuery || d.udid === deviceQuery || d.physicalSerial === deviceQuery)
    || allDevices.find(d => d.name.toLowerCase() === q)
    || (() => { const m = allDevices.filter(d => d.name.toLowerCase().includes(q)); return m.length === 1 ? m[0] : null; })();
  if (!found) {
    const list = allDevices.map(d => `- ${d.name} (${d.platform})`).join("\n");
    return { error: `Device "${deviceQuery}" not found:\n${list}` };
  }
  if (BLOCKED_SERIALS.includes(found.serial)) return { error: `Device "${found.name}" is blocked.` };
  return { serial: found.serial, udid: found.udid, physicalSerial: found.physicalSerial, name: found.name, platform: found.platform || "android" };
}

// Stable tracker key independent of connection mode (USB serial vs WiFi IP:port).
// For Android prefer the hardware serial; for iOS, the UDID. Falls back to the
// transport serial only when neither is available.
function trackerKey(device) {
  return (device.physicalSerial || device.udid || device.serial).replace(/[:.]/g, "_");
}

// Merge any legacy tracker entries (keyed by transport serial like
// `192_168_5_90_5555`) into the canonical key for this device. Returns the
// merged `pulled` array; caller is responsible for saving the tracker.
function getMergedPulled(tracker, device) {
  const canonical = trackerKey(device);
  const legacy = [device.serial, device.udid].filter(Boolean).map(s => s.replace(/[:.]/g, "_"));
  const merged = new Set(tracker[canonical] || []);
  let didMerge = false;
  for (const k of legacy) {
    if (k === canonical) continue;
    if (Array.isArray(tracker[k])) {
      for (const p of tracker[k]) merged.add(p);
      delete tracker[k];
      didMerge = true;
    }
  }
  if (didMerge) tracker[canonical] = Array.from(merged);
  return tracker[canonical] || [];
}

// ── Tool: list_devices ─────────────────────────────────────────────────────
server.tool(
  "list_devices",
  "List all connected Android and iOS devices.",
  {},
  async () => {
    const allowed = getConnectedDevices();
    const { pending } = getAllDevices();
    const iosDevices = getIosDevices();
    if (allowed.length === 0 && pending.length === 0 && iosDevices.length === 0) {
      return textResult({ error: "No devices connected." });
    }
    let text = "";
    if (allowed.length > 0) text += `Android devices:\n${allowed.map(d => `- ${d.name} [${d.serial.includes(":") ? "WiFi" : "USB"}]`).join("\n")}`;
    if (iosDevices.length > 0) text += `${text ? "\n\n" : ""}iOS devices:\n${iosDevices.map(d => `- ${d.name} [${d.udid.substring(0, 12)}...] (${d.model})`).join("\n")}`;
    if (pending.length > 0) text += `\n\nPending (not allowed):\n${pending.map(d => `- ${d.name} (${d.serial})`).join("\n")}`;
    return textResult({ devices: text });
  }
);

// ── Tool: scan_photos ──────────────────────────────────────────────────────
server.tool(
  "scan_photos",
  "Scan a connected Android or iOS device for photos and/or videos filtered by date.",
  {
    device: z.string().optional().describe("Device name, serial, or UDID"),
    date: z.string().optional().describe("Date filter: 'today', 'yesterday', '2026-04-07', 'last 3 days'"),
    folder: z.enum(["all", "camera", "screenshots", "pictures", "download"]).optional(),
    media: z.enum(["photo", "video", "both"]).optional().describe("Which media types to include. Default: photo. Pass 'video' to scan for screen recordings / camera videos, or 'both' for everything."),
  },
  async ({ device: deviceQuery, date, folder, media }) => {
    const device = resolveDevice(deviceQuery);
    if (device.error) return textResult({ error: device.error });
    let dateRange = date ? parseDate(date) : null;
    if (date && !dateRange) return textResult({ error: `Could not parse date: "${date}"` });

    const tracker = loadTracker();
    const deviceKey = trackerKey(device);
    const pulled = getMergedPulled(tracker, device);
    const matchesMedia = mediaPredicate(media || "photo");
    const found = [];

    if (device.platform === "ios") {
      const foldersToScan = IOS_PHOTO_FOLDERS;
      for (const f of foldersToScan) {
        for (const photo of iosListPhotos(device.udid, f)) {
          if (pulled.includes(photo.remotePath)) continue;
          if (!matchesMedia(photo.remotePath)) continue;
          found.push(photo);
        }
      }
    } else {
      const folderMap = { camera: ["/sdcard/DCIM/Camera"], screenshots: ["/sdcard/DCIM/Screenshots", "/sdcard/Pictures/Screenshots"], pictures: ["/sdcard/Pictures"], download: ["/sdcard/Download"] };
      const foldersToScan = folder && folder !== "all" ? folderMap[folder] : PHOTO_FOLDERS;
      try {
        for (const f of foldersToScan) {
          for (const photo of listPhotosWithDates(device.serial, f)) {
            if (pulled.includes(photo.remotePath)) continue;
            if (!matchesMedia(photo.remotePath)) continue;
            if (dateRange && photo.modDate && (photo.modDate < dateRange.start || photo.modDate > dateRange.end)) continue;
            found.push(photo);
          }
        }
        if (found.length === 0) {
          for (const photo of listPhotosViaMediaStore(device.serial)) {
            if (pulled.includes(photo.remotePath)) continue;
            if (!matchesMedia(photo.remotePath)) continue;
            if (dateRange && photo.modDate && (photo.modDate < dateRange.start || photo.modDate > dateRange.end)) continue;
            found.push(photo);
          }
        }
      } catch (e) {
        return textResult({ error: `Could not read photos from ${device.name}: ${e.message}. If the device is on WiFi-ADB, the tunnel may be stale — try \`adb disconnect\` + \`adb connect <ip:port>\`, or replug via USB.` });
      }
    }

    if (found.length === 0) return textResult({ message: `No new media found on ${device.name}${date ? ` for ${date}` : ""}.` });
    return textResult({ count: found.length, platform: device.platform, photos: found.map(p => ({ path: p.remotePath, date: p.modDate?.toISOString().split("T")[0], kind: isVideoPath(p.remotePath) ? "video" : "image" })) });
  }
);

// ── Tool: pull_photos ──────────────────────────────────────────────────────
server.tool(
  "pull_photos",
  "Pull photos and/or videos from a connected Android or iOS device to OneDrive sync folder and return SharePoint URLs. Supports images (.jpg/.png/.heic/...) and videos (.mp4/.mov/...). The returned URLs can be passed directly to create_bug's attachment_links parameter.",
  {
    device: z.string().optional().describe("Device name, serial, or UDID"),
    date: z.string().optional().describe("Date filter: 'today', 'yesterday', '2026-04-07', 'last 3 days'"),
    folder: z.enum(["all", "camera", "screenshots", "pictures", "download"]).optional(),
    media: z.enum(["photo", "video", "both"]).optional().describe("Which media types to include. Default: photo. Pass 'video' to pull screen recordings / camera videos, or 'both' for everything."),
    subfolder: z.string().optional().describe("Optional subfolder (e.g. 'BG-1722'). Created if it doesn't exist."),
  },
  async ({ device: deviceQuery, date, folder, media, subfolder }) => {
    if (!ONEDRIVE_SYNC_FOLDER) return textResult({ error: "ONEDRIVE_SYNC_FOLDER env var not set." });
    if (!SHAREPOINT_BASE_URL) return textResult({ error: "SHAREPOINT_BASE_URL env var not set." });

    const device = resolveDevice(deviceQuery);
    if (device.error) return textResult({ error: device.error });
    let dateRange = date ? parseDate(date) : null;
    if (date && !dateRange) return textResult({ error: `Could not parse date: "${date}"` });

    const destDir = subfolder ? join(ONEDRIVE_SYNC_FOLDER, subfolder) : ONEDRIVE_SYNC_FOLDER;
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

    const baseUrl = subfolder ? `${SHAREPOINT_BASE_URL}/${encodeURIComponent(subfolder)}` : SHAREPOINT_BASE_URL;

    const tracker = loadTracker();
    const deviceKey = trackerKey(device);
    const pulled = getMergedPulled(tracker, device);
    const tempDir = join(homedir(), "Desktop", "Photo under process");
    if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

    const mediaMode = media || "photo";
    const matchesMedia = mediaPredicate(mediaMode);

    let count = 0;
    const results = [];
    const failed = [];

    if (device.platform === "ios") {
      for (const f of IOS_PHOTO_FOLDERS) {
        for (const photo of iosListPhotos(device.udid, f)) {
          if (pulled.includes(photo.remotePath)) continue;
          if (!matchesMedia(photo.remotePath)) continue;

          let localName = photo.file;
          if (existsSync(join(destDir, localName))) localName = `ios_${photo.file}`;

          const tempPath = join(tempDir, localName);
          iosPullFile(device.udid, photo.remotePath, tempPath);
          if (existsSync(tempPath)) {
            copyFileSync(tempPath, join(destDir, localName));
            const url = `${baseUrl}/${encodeURIComponent(localName)}`;
            results.push({ file: localName, url });
            pulled.push(photo.remotePath);
            count++;
          } else {
            failed.push({ file: photo.file, reason: "iOS pull produced no file" });
          }
        }
      }
    } else {
      const folderMap = { camera: ["/sdcard/DCIM/Camera"], screenshots: ["/sdcard/DCIM/Screenshots", "/sdcard/Pictures/Screenshots"], pictures: ["/sdcard/Pictures"], download: ["/sdcard/Download"] };
      const foldersToScan = folder && folder !== "all" ? folderMap[folder] : PHOTO_FOLDERS;

      const pullOne = (photo, nameCollisionPrefix) => {
        let localName = photo.file;
        if (existsSync(join(destDir, localName))) localName = `${nameCollisionPrefix}_${photo.file}`;
        const tempPath = join(tempDir, localName);
        // pullFile now verifies size and returns false on truncation/timeout.
        // Truncated pulls are NOT copied to OneDrive and NOT added to the
        // tracker, so a future call can retry them.
        const ok = pullFile(device.serial, photo.remotePath, tempPath);
        if (ok && existsSync(tempPath)) {
          copyFileSync(tempPath, join(destDir, localName));
          const url = `${baseUrl}/${encodeURIComponent(localName)}`;
          results.push({ file: localName, url });
          pulled.push(photo.remotePath);
          count++;
        } else {
          failed.push({ file: photo.file, reason: isVideoPath(photo.remotePath) ? "pull failed or truncated (large video?) — will retry on next call" : "pull failed or truncated — will retry on next call" });
        }
      };

      try {
        for (const f of foldersToScan) {
          for (const photo of listPhotosWithDates(device.serial, f)) {
            if (pulled.includes(photo.remotePath)) continue;
            if (!matchesMedia(photo.remotePath)) continue;
            if (dateRange && photo.modDate && (photo.modDate < dateRange.start || photo.modDate > dateRange.end)) continue;
            pullOne(photo, basename(f));
          }
        }

        if (count === 0) {
          for (const photo of listPhotosViaMediaStore(device.serial)) {
            if (pulled.includes(photo.remotePath)) continue;
            if (!matchesMedia(photo.remotePath)) continue;
            if (dateRange && photo.modDate && (photo.modDate < dateRange.start || photo.modDate > dateRange.end)) continue;
            pullOne(photo, "media");
          }
        }
      } catch (e) {
        return textResult({ error: `Could not read photos from ${device.name}: ${e.message}. If the device is on WiFi-ADB, the tunnel may be stale — try \`adb disconnect\` + \`adb connect <ip:port>\`, or replug via USB.` });
      }
    }

    tracker[deviceKey] = pulled;
    saveTracker(tracker);

    if (count === 0) {
      const msg = `No new ${mediaMode === "both" ? "media" : mediaMode + "s"} to pull from ${device.name} (${device.platform})${date ? ` for ${date}` : ""}.`;
      return textResult(failed.length > 0 ? { message: msg, failed } : { message: msg });
    }

    // Pre-flight: if OneDrive isn't running, files are copied but will never sync.
    // Bail out loudly instead of burning the full timeout per file waiting.
    if (!isOneDriveRunning()) {
      return textResult({
        error: "OneDrive client is not running. Start it from the system tray and retry.",
        files_copied: results.map(r => r.destPath),
        hint: "Files were already copied to the OneDrive sync folder; they'll upload once OneDrive is back. Re-run this tool after starting OneDrive to get the SharePoint URLs.",
      });
    }

    // Wait for OneDrive to finish syncing each file to SharePoint before returning URLs.
    // Polled in parallel and per-type timeouts (photos 60s, videos 120s) to avoid
    // multi-minute stalls on multi-file pulls.
    const syncStatuses = await waitForAllSyncsParallel(results);
    const unsynced = syncStatuses.filter(s => !s.synced);
    const mostlyFailed = unsynced.length > 0 && unsynced.length >= Math.ceil(results.length / 2);

    return textResult({
      // Loud warning first so callers actually notice when sync degraded.
      ...(mostlyFailed ? { warning: `${unsynced.length}/${results.length} file(s) failed to sync within timeout. URLs may 404 — verify OneDrive is healthy before relying on these links.` } : {}),
      count,
      platform: device.platform,
      synced_to: destDir,
      attachment_links: results.map(r => ({ url: r.url, label: r.file })),
      sync_status: syncStatuses.map(s => ({ file: s.file, synced: s.synced, waited_ms: s.waitedMs })),
      ...(failed.length > 0 ? { failed } : {}),
      ...(unsynced.length > 0 && !mostlyFailed ? { warning: `${unsynced.length} file(s) did not finish syncing within timeout. URL may 404 briefly — retry in a moment.` } : {}),
      hint: "Pass the attachment_links array directly to create_bug's attachment_links parameter.",
    });
  }
);

// ── Tool: pull_pc_media ────────────────────────────────────────────────────
// Copies photos/videos from a LOCAL PC directory into the OneDrive sync folder
// and returns SharePoint URLs — same output shape as pull_photos so results
// can be passed directly to create_bug's attachment_links.
const PHOTO_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".heic", ".heif"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".3gp"]);

function isPhotoPath(p) {
  return PHOTO_EXTS.has((p.match(/\.[^.\\/]+$/)?.[0] || "").toLowerCase());
}

// Merge multiple photos into one horizontal side-by-side PNG using PowerShell + System.Drawing.
// Used to enforce "evidence pairs are delivered as one merged image" per
// feedback_merge_evidence_screenshots.md. Windows-only (matches deployment target).
function mergePhotosHorizontal(paths, outputPath) {
  if (!paths || paths.length === 0) throw new Error("mergePhotosHorizontal: no input paths");
  if (paths.length === 1) {
    copyFileSync(paths[0], outputPath);
    return outputPath;
  }
  // PowerShell's -Command flag swallows trailing tokens into the script body, so we
  // can't pass paths as positional args. Inline them as a single-quoted PS array
  // (single-quote escapes by doubling).
  const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const inPathsLiteral = paths.map(psQuote).join(",");
  const outPathLiteral = psQuote(outputPath);
  const script = `
$ErrorActionPreference = 'Stop';
Add-Type -AssemblyName System.Drawing;
$inPaths = @(${inPathsLiteral});
$outPath = ${outPathLiteral};
$imgs = @();
foreach ($p in $inPaths) { $imgs += [System.Drawing.Image]::FromFile($p) }
$totalW = 0; $maxH = 0;
foreach ($img in $imgs) { $totalW += $img.Width; if ($img.Height -gt $maxH) { $maxH = $img.Height } }
$bmp = New-Object System.Drawing.Bitmap $totalW, $maxH;
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.Clear([System.Drawing.Color]::White);
$x = 0;
foreach ($img in $imgs) { $g.DrawImage($img, $x, 0, $img.Width, $img.Height); $x += $img.Width }
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png);
foreach ($img in $imgs) { $img.Dispose() }
$g.Dispose(); $bmp.Dispose();
`.trim();
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { stdio: "pipe" }
  );
  if (!existsSync(outputPath)) throw new Error(`mergePhotosHorizontal: output not created at ${outputPath}`);
  return outputPath;
}

function defaultPcSources() {
  const home = homedir();
  return [
    join(home, "Pictures", "Screenshots"),
    join(home, "Pictures"),
    join(home, "Videos"),
    join(home, "Desktop"),
  ].filter(existsSync);
}

function parsePcDate(s) {
  if (!s) return null;
  return parseDate(s); // reuse existing parseDate helper
}

server.tool(
  "pull_pc_media",
  "Copy photos and/or videos from a LOCAL PC directory to the OneDrive sync folder and return SharePoint URLs (for create_bug's attachment_links). If source_dir is omitted, the tool returns a list of candidate directories so you can prompt the user to pick one. Works like pull_photos but for PC files. ENFORCEMENT: when 2+ photo files are pulled, you MUST pass merge_horizontal explicitly — true (preferred for bug-evidence pairs: combines them side-by-side into ONE merged image with one URL) or false (uploads separately). Calls with 2+ photos and no merge_horizontal will be rejected with a clarifying error.",
  {
    source_dir: z.string().optional().describe("Absolute path to a folder on the PC (e.g. 'C:\\\\Users\\\\X\\\\Pictures\\\\Screenshots'). Omit to get a list of candidate folders to prompt the user with."),
    files: z.array(z.string()).optional().describe("Optional explicit list of absolute file paths to upload. Overrides source_dir filtering."),
    date: z.string().optional().describe("Date filter: 'today', 'yesterday', '2026-04-07', 'last 3 days'"),
    media: z.enum(["photo", "video", "both"]).optional().describe("Which media types to include. Default: both"),
    subfolder: z.string().optional().describe("Subfolder inside OneDrive sync folder (e.g. 'BG-2064'). Created if missing."),
    recursive: z.boolean().optional().describe("Recurse into subdirectories of source_dir. Default: false"),
    merge_horizontal: z.boolean().optional().describe("REQUIRED when 2+ photo files are picked. true → combine all picked photos side-by-side into ONE merged PNG (preferred for bug-evidence: PMv2-reality on the left, app-observation on the right). false → keep them as separate uploads. Single-photo or video-only calls don't need this."),
    merge_filename: z.string().optional().describe("Output filename for the merged image when merge_horizontal=true. Defaults to evidence-merged-<timestamp>.png. Should end in .png."),
  },
  async ({ source_dir, files, date, media, subfolder, recursive, merge_horizontal, merge_filename }) => {
    if (!ONEDRIVE_SYNC_FOLDER) return textResult({ error: "ONEDRIVE_SYNC_FOLDER env var not set." });
    if (!SHAREPOINT_BASE_URL) return textResult({ error: "SHAREPOINT_BASE_URL env var not set." });

    // If nothing specified, return candidates so the caller can prompt the user.
    if (!source_dir && (!files || files.length === 0)) {
      return textResult({
        needs_user_input: true,
        prompt: "Which PC folder should I pull media from? Provide an absolute path or pick one of the candidates.",
        candidates: defaultPcSources(),
      });
    }

    const mediaMode = media || "both";
    const wantPhoto = mediaMode === "photo" || mediaMode === "both";
    const wantVideo = mediaMode === "video" || mediaMode === "both";
    const dateRange = date ? parsePcDate(date) : null;
    if (date && !dateRange) return textResult({ error: `Could not parse date: "${date}"` });

    // Collect candidate files
    const candidates = [];
    if (files && files.length > 0) {
      for (const f of files) {
        if (existsSync(f) && statSync(f).isFile()) candidates.push(f);
      }
    } else {
      if (!existsSync(source_dir)) return textResult({ error: `source_dir does not exist: ${source_dir}` });
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          let st;
          try { st = statSync(full); } catch { continue; }
          if (st.isDirectory()) { if (recursive) walk(full); continue; }
          candidates.push(full);
        }
      };
      walk(source_dir);
    }

    // Filter by extension + date
    const picked = [];
    for (const full of candidates) {
      const ext = (full.match(/\.[^.\\/]+$/)?.[0] || "").toLowerCase();
      const isPhoto = PHOTO_EXTS.has(ext);
      const isVideo = VIDEO_EXTS.has(ext);
      if (!(isPhoto && wantPhoto) && !(isVideo && wantVideo)) continue;
      if (dateRange) {
        const mtime = statSync(full).mtime;
        if (mtime < dateRange.start || mtime > dateRange.end) continue;
      }
      picked.push(full);
    }

    if (picked.length === 0) {
      return textResult({ message: "No matching media files found.", searched: source_dir || "(explicit files)" });
    }

    // Enforcement: 2+ photos requires explicit merge_horizontal decision (per
    // feedback_merge_evidence_screenshots.md). Default to true for bug-evidence pairs.
    const photosPicked = picked.filter(isPhotoPath);
    if (photosPicked.length >= 2 && merge_horizontal === undefined) {
      return textResult({
        error: "merge_horizontal is required when 2+ photos are pulled. Pass merge_horizontal: true to combine them side-by-side into ONE evidence image (preferred for bug-evidence pairs — PMv2-reality on the left, app-observation on the right), or merge_horizontal: false to upload separately.",
        photos_count: photosPicked.length,
        picked_photos: photosPicked.map(p => basename(p)),
      });
    }

    // Auto-merge into a single horizontal PNG when requested.
    let mergedNoteFile = null;
    if (merge_horizontal === true && photosPicked.length >= 2) {
      const tmpDir = process.env.TEMP || join(homedir(), "AppData", "Local", "Temp");
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      const outName = (merge_filename && /\.png$/i.test(merge_filename))
        ? merge_filename
        : `evidence-merged-${Date.now()}.png`;
      const tempMerged = join(tmpDir, outName);
      try {
        mergePhotosHorizontal(photosPicked, tempMerged);
      } catch (e) {
        return textResult({
          error: `merge_horizontal failed: ${e.message}`,
          hint: "If PowerShell / System.Drawing isn't available, retry with merge_horizontal: false.",
        });
      }
      mergedNoteFile = { input_count: photosPicked.length, merged_path: tempMerged };
      // Replace the photo entries with the single merged file; keep videos as-is.
      const videosPicked = picked.filter(p => !isPhotoPath(p));
      picked.length = 0;
      picked.push(tempMerged, ...videosPicked);
    }

    const destDir = subfolder ? join(ONEDRIVE_SYNC_FOLDER, subfolder) : ONEDRIVE_SYNC_FOLDER;
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    const baseUrl = subfolder ? `${SHAREPOINT_BASE_URL}/${encodeURIComponent(subfolder)}` : SHAREPOINT_BASE_URL;

    const results = [];
    for (const src of picked) {
      let localName = basename(src);
      let destPath = join(destDir, localName);
      if (existsSync(destPath)) {
        const dot = localName.lastIndexOf(".");
        const stem = dot > 0 ? localName.slice(0, dot) : localName;
        const ext = dot > 0 ? localName.slice(dot) : "";
        localName = `${stem}_${Date.now()}${ext}`;
        destPath = join(destDir, localName);
      }
      copyFileSync(src, destPath);
      results.push({ file: localName, url: `${baseUrl}/${encodeURIComponent(localName)}`, destPath });
    }

    // Pre-flight: if OneDrive isn't running, files are copied but will never sync.
    // Bail out loudly instead of burning the full timeout per file waiting.
    if (!isOneDriveRunning()) {
      return textResult({
        error: "OneDrive client is not running. Start it from the system tray and retry.",
        files_copied: results.map(r => r.destPath),
        hint: "Files were already copied to the OneDrive sync folder; they'll upload once OneDrive is back. Re-run this tool after starting OneDrive to get the SharePoint URLs.",
      });
    }

    // Wait for OneDrive to finish syncing each file to SharePoint before returning URLs.
    // Polled in parallel and per-type timeouts (photos 60s, videos 120s) to avoid
    // multi-minute stalls on multi-file pulls.
    const syncStatuses = await waitForAllSyncsParallel(results);
    const unsynced = syncStatuses.filter(s => !s.synced);
    const mostlyFailed = unsynced.length > 0 && unsynced.length >= Math.ceil(results.length / 2);

    return textResult({
      // Loud warning first so callers actually notice when sync degraded.
      ...(mostlyFailed ? { warning: `${unsynced.length}/${results.length} file(s) failed to sync within timeout. URLs may 404 — verify OneDrive is healthy before relying on these links.` } : {}),
      count: results.length,
      synced_to: destDir,
      attachment_links: results.map(r => ({ url: r.url, label: r.file })),
      sync_status: syncStatuses.map(s => ({ file: s.file, synced: s.synced, waited_ms: s.waitedMs })),
      ...(mergedNoteFile ? { merged: mergedNoteFile } : {}),
      ...(unsynced.length > 0 && !mostlyFailed ? { warning: `${unsynced.length} file(s) did not finish syncing within timeout. URL may 404 briefly — retry in a moment.` } : {}),
      hint: "Pass the attachment_links array directly to create_bug's attachment_links parameter.",
    });
  }
);

// ── Tool: merge_screenshots ────────────────────────────────────────────────
// Standalone helper for pre-merging without triggering an upload — useful when
// you want to inspect the merged result before pulling, or to merge into a
// custom location.
server.tool(
  "merge_screenshots",
  "Merge 2+ screenshots horizontally (side-by-side) into one PNG. Used for bug-evidence pairs: source-of-truth on the left, observed reality on the right. Returns the local path; pass it to pull_pc_media when ready to upload.",
  {
    files: z.array(z.string()).min(2).describe("Absolute paths to 2 or more PNG/JPG files. Drawn left→right in the order given."),
    output_path: z.string().optional().describe("Optional output absolute path (must end in .png). Defaults to %TEMP%\\evidence-merged-<timestamp>.png."),
  },
  async ({ files, output_path }) => {
    for (const f of files) {
      if (!existsSync(f)) return textResult({ error: `Input not found: ${f}` });
      if (!isPhotoPath(f)) return textResult({ error: `Not a supported photo extension: ${f}` });
    }
    const tmpDir = process.env.TEMP || join(homedir(), "AppData", "Local", "Temp");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const out = output_path && /\.png$/i.test(output_path)
      ? output_path
      : join(tmpDir, `evidence-merged-${Date.now()}.png`);
    try {
      mergePhotosHorizontal(files, out);
    } catch (e) {
      return textResult({ error: `merge failed: ${e.message}` });
    }
    return textResult({
      merged_path: out,
      input_count: files.length,
      hint: "Pass merged_path to pull_pc_media (files: [merged_path]) to upload to OneDrive and get a SharePoint URL.",
    });
  }
);

// ── Tool: reset_tracker ────────────────────────────────────────────────────
server.tool(
  "reset_tracker",
  "Reset the photo tracker for a device so all photos are treated as new again.",
  {
    device: z.string().optional().describe("Device name or serial. Omit to reset all devices."),
  },
  async ({ device: deviceQuery }) => {
    if (!deviceQuery) {
      saveTracker({});
      return textResult({ message: "Tracker reset for all devices." });
    }
    const device = resolveDevice(deviceQuery);
    if (device.error) return textResult({ error: device.error });
    const tracker = loadTracker();
    const deviceKey = trackerKey(device);
    delete tracker[deviceKey];
    // Also clear any legacy keys for this device (transport-serial keys from
    // before we keyed on physicalSerial). Match against current transport serial
    // and any IP:port form for the same physical device.
    const legacyKeys = [device.serial, device.udid].filter(Boolean).map(s => s.replace(/[:.]/g, "_"));
    for (const k of legacyKeys) if (k !== deviceKey) delete tracker[k];
    saveTracker(tracker);
    return textResult({ message: `Tracker reset for ${device.name}.` });
  }
);

// ════════════════════════════════════════════════════════════════════════════
// SHEET MODULE — edits the "PMV2 Bug list" workbook via a Power Automate flow.
//
// The MCP holds ONLY the flow URL — no Microsoft credentials, no Graph, no
// OAuth. It POSTs { action, rowNo, valuesJson } to the flow; the flow runs the
// `BugSheetOp` Office Script, which performs the read / update / append on the
// spreadsheet (QCTest SharePoint site) and returns a JSON result.
//
// Configure the flow URL via the SHEET_FLOW_URL env var (a default is baked in).
// ════════════════════════════════════════════════════════════════════════════

const SHEET_FLOW_URL = process.env.SHEET_FLOW_URL ||
  "https://defaultdb45ae3039214816bd8498cf14d5a1.7b.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/be69b98b1a5d4adea6369a34c61464f8/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=GPYOJQ8WCUa1MtF4tfJpcPZ7Vq4kjKyFkJj0erBPcJo";

// POST { action, rowNo, valuesJson, sheetName, colorsJson } to the Power Automate
// flow and return the parsed BugSheetOp result as { ok: true, result } — or
// { ok: false, error }.
// sheetName defaults to "" (the script falls back to "Bug list").
// colors is an optional { columnName: hex } map; passed to BugSheetOp's colorsJson
// param which fills the matching cells with the hex colors.
async function callSheetFlow(action, rowNo, values, sheetName, colors) {
  if (!SHEET_FLOW_URL) {
    return { ok: false, error: "SHEET_FLOW_URL is not configured." };
  }
  const body = {
    action,
    rowNo: rowNo == null ? 0 : rowNo,
    valuesJson: values == null ? "" : JSON.stringify(values),
    sheetName: sheetName == null ? "" : String(sheetName),
    colorsJson: colors == null ? "" : JSON.stringify(colors),
  };
  let res;
  try {
    res = await fetch(SHEET_FLOW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `Could not reach the flow: ${String((e && e.message) || e)}` };
  }
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: `Flow returned HTTP ${res.status}: ${text.slice(0, 500)}` };
  }
  // Empty body on a 2xx = the flow ran asynchronously (HTTP 202) — it has no
  // Response action. Writes still take effect server-side; reads can't return.
  if (!text || !text.trim()) {
    if (action === "read") {
      return {
        ok: false,
        error: "The flow accepted the request (HTTP 202) but returned no data. " +
          "`sheet_read` needs the flow to have a Response action, which it currently does not.",
      };
    }
    return {
      ok: true,
      result: {
        submitted: true,
        async: true,
        action,
        message: `Request submitted — the flow ran asynchronously (HTTP 202) and the ${action} ` +
          `was applied to the sheet. The flow has no Response action, so the detailed result ` +
          `cannot be confirmed here; check the sheet or the flow run history if needed.`,
      },
    };
  }
  // Body present — a real synchronous result. BugSheetOp returns a JSON string,
  // so the body may need one or two JSON.parse passes.
  let result;
  try {
    result = JSON.parse(text);
    if (typeof result === "string") result = JSON.parse(result);
  } catch {
    return { ok: false, error: `Flow returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}` };
  }
  return { ok: true, result };
}

// Excel serial-date for today (UTC midnight), matching the format used in the
// PMV2 Bug list workbook's date columns (e.g. "Date Closed by QC" = 46160).
// Serial 0 = 1899-12-30 (Excel's epoch, accounting for the 1900 leap-year bug).
function excelSerialToday() {
  const now = new Date();
  const utcMidnight = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const excelEpoch = Date.UTC(1899, 11, 30);
  return Math.floor((utcMidnight - excelEpoch) / 86400000);
}

// ── Tool: sheet_update_row ──────────────────────────────────────────────────
server.tool(
  "sheet_update_row",
  "Update cells of an existing row in the PMV2 Bug list spreadsheet. Identify the row by its `No` column value and pass `values` keyed by column header name — only those cells are written. Pass `sheet_name` to target a tab other than `Bug list`. Runs through the Power Automate flow (no Microsoft login needed).\n\n**AUTO-STAMP (Bug list only):** When `values.Status` is set to a closed-equivalent value (case-insensitive match against `Closed`/`CLOSED`/`closed`) AND the caller did NOT supply `Date Closed by QC` in the same payload, the tool auto-pairs `Date Closed by QC = <today's Excel serial>` so the verification date is recorded automatically. Pass an explicit `Date Closed by QC` to override.\n\n**AUTO-COLOR (release tabs only):** On a release tab (any `sheet_name` other than `Bug list`), when `values.Status` is set to `REOPEN` or `CLOSED` (case-insensitive) AND the caller did NOT pass `colors`, the tool auto-injects a fill on the row's `#` cell: `#FF0000` (red) for REOPEN, `#20ff1c` (green) for CLOSED. Pass an explicit `colors` object to override.",
  {
    no: z.number().describe("The target row's `No` column value."),
    values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .describe("Object of { columnHeaderName: newValue }. Only these columns are written; everything else is left untouched."),
    sheet_name: z.string().optional().describe("Worksheet tab name (e.g. '26.5.1.x'). Defaults to 'Bug list' if omitted."),
    colors: z.record(z.string(), z.string()).optional()
      .describe("Optional { columnHeaderName: hexColor } map (e.g. { \"#\": \"#FF0000\" }) — fills the matching cells on the target row with the given fill colors. Pass an empty object {} to suppress the release-tab auto-color."),
  },
  async ({ no, values, sheet_name, colors }) => {
    // Auto-stamp Date Closed by QC when Status is being set to "Closed"
    // on the Bug list master tab. Release tabs (v26.5.1.x etc.) don't
    // have this column, so injecting it there would fail the whole
    // update with "Unknown column: Date Closed by QC" — restrict the
    // auto-stamp to Bug list (the default tab when sheet_name is unset).
    const enriched = { ...values };
    const statusVal = enriched["Status"];
    const targetTab = (sheet_name == null ? "" : String(sheet_name)).trim().toLowerCase();
    const isBugList = targetTab === "" || targetTab === "bug list";
    if (isBugList
        && typeof statusVal === "string"
        && statusVal.trim().toLowerCase() === "closed"
        && !("Date Closed by QC" in enriched)) {
      enriched["Date Closed by QC"] = excelSerialToday();
    }
    // Auto-color the # cell on release-tab Status writes. Skipped when the
    // caller passed an explicit `colors` (treat as override — even {} means
    // "no colors, don't auto-inject"). Skipped on Bug list (no # column —
    // it uses `No` — and the Status colour convention is release-tab only).
    let effectiveColors = colors;
    if (!isBugList && colors === undefined && typeof statusVal === "string") {
      const statusUpper = statusVal.trim().toUpperCase();
      if (statusUpper === "REOPEN") {
        effectiveColors = { "#": "#FF0000" };
      } else if (statusUpper === "CLOSED") {
        effectiveColors = { "#": "#20ff1c" };
      }
    }
    const r = await callSheetFlow("update", no, enriched, sheet_name, effectiveColors);
    if (!r.ok) return textResult({ error: "flow_call_failed", message: r.error });
    return textResult(r.result);
  }
);

// ── Tool: sheet_append_row ──────────────────────────────────────────────────
server.tool(
  "sheet_append_row",
  "Add a new row to the PMV2 Bug list spreadsheet. The `No` value is auto-assigned (highest existing + 1). Pass `values` keyed by column header name. By default the row is appended at the bottom; pass `insert_after_no` to insert it directly after an existing row instead. Pass `sheet_name` to target a tab other than `Bug list`. Runs through the Power Automate flow.\n\n**BUG ROUTING REMINDER:** If you are calling this to log a bug surfaced during discovery, you MUST have first asked the user whether to file it to Excel, the tracker, both, or neither. Use this tool only if the answer was 'excel_only' or as part of an 'tracker_and_excel' decision (in which case `create_bug` with destination='tracker_and_excel' would have handled it automatically). For non-bug data (test-run logs, version tracking, etc.) no confirmation needed.",
  {
    values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .describe("Object of { columnHeaderName: value } for the new row. The `No` column is auto-assigned and ignored if passed."),
    insert_after_no: z.number().optional()
      .describe("If set, insert the new row directly after the row with this `No` (rows below shift down). Omit to append at the bottom."),
    sheet_name: z.string().optional().describe("Worksheet tab name (e.g. '26.5.1.x'). Defaults to 'Bug list' if omitted."),
  },
  async ({ values, insert_after_no, sheet_name }) => {
    const r = await callSheetFlow("append", insert_after_no || 0, values, sheet_name);
    if (!r.ok) return textResult({ error: "flow_call_failed", message: r.error });
    return textResult(r.result);
  }
);

// ── Tool: sheet_read ────────────────────────────────────────────────────────
server.tool(
  "sheet_read",
  "Read rows from the PMV2 Bug list workbook. Pass `no` to fetch a single row by its `No` value; omit it (or pass 0) to return every row plus the column headers. Pass `sheet_name` to read a tab other than the default `Bug list` (e.g. a version tab like '26.5.1.x'). Runs through the Power Automate flow.",
  {
    no: z.number().optional().describe("A row's `No` value to fetch one row. Omit or pass 0 to return all rows."),
    sheet_name: z.string().optional().describe("Worksheet tab name (e.g. '26.5.1.x'). Defaults to 'Bug list' if omitted."),
  },
  async ({ no, sheet_name }) => {
    const r = await callSheetFlow("read", no || 0, null, sheet_name);
    if (!r.ok) return textResult({ error: "flow_call_failed", message: r.error });
    return textResult(r.result);
  }
);

// ── Tool: sheet_get_release_modules ─────────────────────────────────────────
// Read a single sub-version section from a release tab and return ONLY the
// Modules + Changes Summary columns as a markdown table — plus a prompt_to_user
// that forces the agent into the next step (per-module knowledge check via
// student-mcp's recall, then a discover-vs-manual ask for any not-found
// modules). This is the entry point for "verify release notes" workflows.
//
// Enforcement shape mirrors student-mcp's recall_srs / report_knowledge_mismatch
// — the response's prompt_to_user field MUST be surfaced to the user verbatim;
// the agent must not proceed to verification without the knowledge check.
server.tool(
  "sheet_get_release_modules",
  "Read the Modules + Changes Summary for one sub-version section inside a PMv2 release tab, formatted as a markdown table for the user.\n\n**Tab routing:** given `release_version` like 'v26.5.1.2', the tool reads tab `v26.5.1.x` (strip the last dot-segment, append `.x`). Versions MUST start with `v` and have exactly 4 dot-segments — e.g. 'v26.5.1.2', 'v26.4.1.1'. Anything else is rejected.\n\n**Section parsing:** the tab has multiple sub-version sections separated by `Bug Fix` markers; the section starts at a row whose `#` column equals the requested version (e.g. `v26.5.1.2`) and ends at the next `v*.*.*.*` header row or end of tab. Only data rows (numeric `#`) within that range are returned — section markers and version headers are filtered out.\n\n**Response shape (always includes both):**\n- `table_markdown` — a 3-column markdown table (#, Modules, Changes Summary) for the agent to render to the user.\n- `prompt_to_user` — the next-step instructions the agent MUST follow: for EACH module listed, call student-mcp's `recall` to check if knowledge exists. For NOT-FOUND modules, ASK the user whether to discover via student-mcp first or verify manually. Do NOT begin verification without this check.\n\nReturns `{ error: 'invalid_release_version' | 'section_not_found' | ... }` on failure — no partial output.",
  {
    release_version: z.string().describe("Full sub-version with v-prefix and 4 dot-segments, e.g. 'v26.5.1.2'. The tool derives the parent tab (v26.5.1.x) and locates this exact section within it."),
  },
  async ({ release_version }) => {
    // ── Validate version format ─────────────────────────────────────────
    const versionPattern = /^v\d+\.\d+\.\d+\.\d+$/;
    if (!versionPattern.test(release_version)) {
      return textResult({
        error: "invalid_release_version",
        message: `release_version must match /^v\\d+\\.\\d+\\.\\d+\\.\\d+$/ (e.g. 'v26.5.1.2'). Got: '${release_version}'. The 'v' prefix is mandatory; all four segments must be digits.`,
        example_valid: ["v26.5.1.1", "v26.5.1.2", "v26.4.1.1"],
      });
    }

    // ── Derive tab name: strip last segment, append '.x' ───────────────
    // 'v26.5.1.2' → ['v26', '5', '1', '2'] → ['v26', '5', '1'] → 'v26.5.1' → 'v26.5.1.x'
    const parts = release_version.split(".");
    const tabName = parts.slice(0, -1).join(".") + ".x";

    // ── Read the whole release tab (one call; parsing distills it) ─────
    const r = await callSheetFlow("read", 0, null, tabName);
    if (!r.ok) {
      return textResult({
        error: "flow_call_failed",
        message: r.error,
        tab_attempted: tabName,
      });
    }
    const data = r.result;
    if (!data || data.success === false) {
      return textResult({
        error: "tab_read_failed",
        message: (data && data.message) || `Failed to read tab '${tabName}'. Verify the tab exists in the PMV2 workbook.`,
        tab_attempted: tabName,
        underlying: data,
      });
    }

    const allRows = Array.isArray(data.rows) ? data.rows : [];
    const headers = Array.isArray(data.headers) ? data.headers : [];
    // Required columns for this tool — fail loudly if missing
    const missingCols = ["#", "Modules", "Changes Summary"].filter((c) => !headers.includes(c));
    if (missingCols.length > 0) {
      return textResult({
        error: "missing_required_columns",
        message: `Release tab '${tabName}' is missing required column(s): ${missingCols.join(", ")}. This tool needs '#', 'Modules', and 'Changes Summary' to build the verification table.`,
        headers_seen: headers,
      });
    }

    // ── Walk rows: find section header, collect RELEASES only ──────────
    //
    // Real layout (verified 2026-05-26 on v26.5.1.x):
    //   Version header row:  # == "Version:",  Status == "v26.5.1.2"
    //   Release rows:        TS-RND-* task IDs in #, Modules + Changes Summary
    //                        — these are the FEATURES/TASKS being released
    //   "Bug Fix*" marker:   # ~ /^Bug Fix\b/ (variants: "Bug Fix",
    //                        "Bug Fix QC", "Bug Fix Support & PDT", ...)
    //                        — this row SEPARATES releases from bug titles
    //   Bug-title rows:      numeric # with bug descriptions in Modules
    //                        — these belong to a SEPARATE verification flow
    //                        (Bug list), NOT release-note verification
    //   Empty padding rows:  all cells blank
    //
    // For release-note verification we collect ONLY the release rows:
    //   start: Status cell of a "Version:" row == release_version
    //   end:   FIRST occurrence of either (a) a "Bug Fix*" marker, or
    //          (b) the next "Version:" header
    // Anything below the "Bug Fix" marker is bug titles, not releases.
    let inSection = false;
    const sectionRows = [];
    const taskIdPattern = /^TS-RND-\d+$/i;
    let endReason = null;       // "bug_fix" | "next_version" | "end_of_tab"
    let endMarker = null;       // verbatim # cell text of the boundary row (bug_fix case)
    let bugTitlesScope = null;  // "qc" | "support_pdt" | "other"  — guidance for the future Bug list flow
    for (const row of allRows) {
      const hashCell = String(row["#"] ?? "").trim();
      const statusCell = String(row["Status"] ?? "").trim();
      const isVersionHeader = hashCell === "Version:";
      if (!inSection) {
        if (isVersionHeader && statusCell === release_version) {
          inSection = true;
        }
        continue;
      }
      // Section end (1): row whose # cell CONTAINS "Bug Fix" anywhere
      // (not strictly prefixed). Variants observed: "Bug Fix",
      // "Bug Fix QC", "Bug Fix Support & PDT", and potentially others
      // where "Bug Fix" sits mid-string. Bug titles begin below this row.
      //
      // Classify the marker so any downstream flow (e.g. the future Bug list
      // verification) knows whether the bug rows below are in-scope:
      //   - "qc"          → QC verification scope. Covers plain "Bug Fix",
      //                     "Bug Fix QC", and anything else without a
      //                     Support/PDT label. This is the default when
      //                     the marker doesn't explicitly opt out.
      //   - "support_pdt" → IGNORE rows below entirely (out of QC scope).
      //                     Triggered by any of "support", "pdt" appearing
      //                     in the marker cell.
      if (/bug\s*fix/i.test(hashCell)) {
        endReason = "bug_fix";
        endMarker = hashCell;
        bugTitlesScope = /support|pdt/i.test(hashCell) ? "support_pdt" : "qc";
        break;
      }
      // Section end (2): next "Version:" header
      if (isVersionHeader) {
        endReason = "next_version";
        break;
      }
      // Within the releases block: keep TS-RND-* task rows; drop blank padding
      // (numeric-# rows shouldn't appear above the Bug Fix marker, but if
      // they do, defensive-skip them rather than mislabel as a release)
      const isTaskRow = taskIdPattern.test(hashCell);
      if (!isTaskRow) {
        continue;
      }
      sectionRows.push({
        "#": hashCell,
        "Modules": String(row["Modules"] ?? "").trim(),
        "Changes Summary": String(row["Changes Summary"] ?? "").trim(),
      });
    }
    if (inSection && endReason === null) endReason = "end_of_tab";

    if (!inSection) {
      return textResult({
        error: "section_not_found",
        message: `Version header '${release_version}' was not found in tab '${tabName}'. Scanned ${allRows.length} rows. Verify the version exists in the workbook (case-sensitive, exact match against the # column).`,
        tab: tabName,
      });
    }
    if (sectionRows.length === 0) {
      return textResult({
        error: "empty_section",
        message: `Found version header '${release_version}' in tab '${tabName}' but no data rows follow it before the next version header. The section is empty — nothing to verify.`,
        tab: tabName,
      });
    }

    // ── Format as markdown table ───────────────────────────────────────
    const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
    let tableMarkdown = `| # | Modules | Changes Summary |\n|---|---|---|\n`;
    for (const r of sectionRows) {
      tableMarkdown += `| ${r["#"]} | ${esc(r.Modules)} | ${esc(r["Changes Summary"])} |\n`;
    }

    // ── Build the prompt_to_user (the enforcement payload) ─────────────
    // Unique-ified, normalized module list for the knowledge-check step.
    const moduleSet = new Set();
    for (const r of sectionRows) {
      const m = r.Modules.trim();
      if (m) moduleSet.add(m);
    }
    const uniqueModules = Array.from(moduleSet);

    const promptToUser = [
      `Show the markdown table above to the user verbatim — it lists every bug/change in release ${release_version} that needs verification.`,
      ``,
      `Then, for EACH unique module in the table, call student-mcp's recall to check if knowledge exists:`,
      `  recall({ app: "pmv2", module_contains: "<module>", full: false })`,
      ``,
      `Unique modules to check (${uniqueModules.length}):`,
      ...uniqueModules.map((m, i) => `  ${i + 1}. ${m}`),
      ``,
      `Report per-module: "FOUND" (with rule count) or "NOT FOUND".`,
      ``,
      `For each NOT-FOUND module, you MUST ask the user:`,
      `  "Module '<name>' has no rules in student-mcp yet. Do you want me to (a) DISCOVER the module first via student-mcp before verifying the release changes, or (b) verify the release changes MANUALLY without prior knowledge? Pick a/b."`,
      ``,
      `Do NOT begin verifying any release changes until every NOT-FOUND module has been adjudicated. Skipping this step risks verifying against guessed behaviour instead of grounded knowledge.`,
    ].join("\n");

    return textResult({
      success: true,
      release: release_version,
      tab: tabName,
      count: sectionRows.length,
      end_reason: endReason, // "bug_fix" (most common) | "next_version" | "end_of_tab"
      end_marker: endMarker, // verbatim # cell text when end_reason === "bug_fix"
      bug_titles_scope: bugTitlesScope, // "qc" | "support_pdt" | "other" | null — guidance for the future Bug list flow
      unique_modules: uniqueModules,
      rows: sectionRows,
      table_markdown: tableMarkdown,
      prompt_to_user: promptToUser,
    });
  }
);

// ── Start Server ────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
