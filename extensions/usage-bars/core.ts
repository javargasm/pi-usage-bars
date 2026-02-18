import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type ProviderKey = "codex" | "claude" | "zai" | "gemini" | "antigravity";
export type OAuthProviderId = "openai-codex" | "anthropic" | "google-gemini-cli" | "google-antigravity";

export interface AuthData {
  "openai-codex"?: { access?: string; refresh?: string; expires?: number };
  anthropic?: { access?: string; refresh?: string; expires?: number };
  zai?: { key?: string; access?: string; refresh?: string; expires?: number };
  "google-gemini-cli"?: { access?: string; refresh?: string; projectId?: string; expires?: number };
  "google-antigravity"?: { access?: string; refresh?: string; projectId?: string; expires?: number };
}

export interface UsageData {
  session: number;
  weekly: number;
  sessionResetsIn?: string;
  weeklyResetsIn?: string;
  extraSpend?: number;
  extraLimit?: number;
  error?: string;
}

export type UsageByProvider = Record<ProviderKey, UsageData | null>;

export interface UsageEndpoints {
  zai: string;
  gemini: string;
  antigravity: string;
  googleLoadCodeAssistEndpoints: string[];
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<any>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponseLike>;

export interface RequestConfig {
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export interface FetchConfig extends RequestConfig {
  endpoints?: UsageEndpoints;
  env?: NodeJS.ProcessEnv;
}

export interface OAuthApiKeyResult {
  newCredentials: Record<string, any>;
  apiKey: string;
}

export type OAuthApiKeyResolver = (
  providerId: OAuthProviderId,
  credentials: Record<string, Record<string, any>>,
) => Promise<OAuthApiKeyResult | null>;

export interface EnsureFreshAuthConfig {
  auth?: AuthData | null;
  authFile?: string;
  oauthResolver?: OAuthApiKeyResolver;
  nowMs?: number;
  persist?: boolean;
}

export interface FreshAuthResult {
  auth: AuthData | null;
  changed: boolean;
  refreshErrors: Partial<Record<OAuthProviderId, string>>;
}

export interface FetchAllUsagesConfig extends FetchConfig, EnsureFreshAuthConfig {
  auth?: AuthData | null;
  authFile?: string;
}

const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;

export const DEFAULT_AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");
export const DEFAULT_ZAI_USAGE_ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";
export const GOOGLE_QUOTA_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
export const GOOGLE_LOAD_CODE_ASSIST_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
];

export function resolveUsageEndpoints(): UsageEndpoints {
  return {
    zai: DEFAULT_ZAI_USAGE_ENDPOINT,
    gemini: GOOGLE_QUOTA_ENDPOINT,
    antigravity: GOOGLE_QUOTA_ENDPOINT,
    googleLoadCodeAssistEndpoints: GOOGLE_LOAD_CODE_ASSIST_ENDPOINTS,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "request timeout";
    return error.message || String(error);
  }
  return String(error);
}

function asObject(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, any>;
}

function normalizeUsagePair(session: number, weekly: number): { session: number; weekly: number } {
  const clean = (v: number) => {
    if (!Number.isFinite(v)) return 0;
    return Number(v.toFixed(2));
  };
  return { session: clean(session), weekly: clean(weekly) };
}

async function requestJson(url: string, init: RequestInit, config: RequestConfig = {}): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const fetchFn = config.fetchFn ?? ((fetch as unknown) as FetchLike);
  const timeoutMs = config.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };

    try {
      const data = await response.json();
      return { ok: true, data };
    } catch {
      return { ok: false, error: "invalid JSON response" };
    }
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0 && h > 0) return `${d}d ${h}h`;
  if (d > 0) return `${d}d`;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

export function formatResetsAt(isoDate: string, nowMs = Date.now()): string {
  const resetTime = new Date(isoDate).getTime();
  if (!Number.isFinite(resetTime)) return "";
  const diffSeconds = Math.max(0, (resetTime - nowMs) / 1000);
  return formatDuration(diffSeconds);
}

export function readAuth(authFile = DEFAULT_AUTH_FILE): AuthData | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile, "utf-8"));
    return asObject(parsed) as AuthData;
  } catch {
    return null;
  }
}

export function writeAuth(auth: AuthData, authFile = DEFAULT_AUTH_FILE): boolean {
  try {
    const dir = path.dirname(authFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${authFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(auth, null, 2));
    fs.renameSync(tmpPath, authFile);
    return true;
  } catch {
    return false;
  }
}

let cachedOAuthResolver: OAuthApiKeyResolver | null = null;

async function getDefaultOAuthResolver(): Promise<OAuthApiKeyResolver> {
  if (cachedOAuthResolver) return cachedOAuthResolver;

  const mod = await import("@mariozechner/pi-ai");
  if (typeof (mod as any).getOAuthApiKey !== "function") {
    throw new Error("oauth resolver unavailable");
  }

  cachedOAuthResolver = (providerId, credentials) =>
    (mod as any).getOAuthApiKey(providerId, credentials) as Promise<OAuthApiKeyResult | null>;

  return cachedOAuthResolver;
}

function isCredentialExpired(creds: { expires?: number } | undefined, nowMs: number): boolean {
  if (!creds) return false;
  if (typeof creds.expires !== "number") return false;
  return nowMs + TOKEN_REFRESH_SKEW_MS >= creds.expires;
}

export async function ensureFreshAuthForProviders(
  providerIds: OAuthProviderId[],
  config: EnsureFreshAuthConfig = {},
): Promise<FreshAuthResult> {
  const authFile = config.authFile ?? DEFAULT_AUTH_FILE;
  const auth = config.auth ?? readAuth(authFile);
  if (!auth) {
    return { auth: null, changed: false, refreshErrors: {} };
  }

  const nowMs = config.nowMs ?? Date.now();
  const uniqueProviders = Array.from(new Set(providerIds));
  const nextAuth: AuthData = { ...auth };
  const refreshErrors: Partial<Record<OAuthProviderId, string>> = {};

  let changed = false;

  for (const providerId of uniqueProviders) {
    const creds = (nextAuth as any)[providerId] as { access?: string; refresh?: string; expires?: number } | undefined;
    if (!creds?.refresh) continue;

    const needsRefresh = !creds.access || isCredentialExpired(creds, nowMs);
    if (!needsRefresh) continue;

    try {
      const resolver = config.oauthResolver ?? (await getDefaultOAuthResolver());
      const resolved = await resolver(providerId, nextAuth as any);
      if (!resolved?.newCredentials) {
        refreshErrors[providerId] = "missing OAuth credentials";
        continue;
      }

      (nextAuth as any)[providerId] = {
        ...(nextAuth as any)[providerId],
        ...resolved.newCredentials,
      };
      changed = true;
    } catch (error) {
      refreshErrors[providerId] = toErrorMessage(error);
    }
  }

  if (changed && config.persist !== false) {
    writeAuth(nextAuth, authFile);
  }

  return { auth: nextAuth, changed, refreshErrors };
}

export function readPercentCandidate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;

  if (value >= 0 && value <= 1) {
    if (Number.isInteger(value)) return value;
    return value * 100;
  }

  if (value >= 0 && value <= 100) return value;
  return null;
}

export function readLimitPercent(limit: any): number | null {
  const direct = [
    limit?.percentage,
    limit?.utilization,
    limit?.used_percent,
    limit?.usedPercent,
    limit?.usagePercent,
    limit?.usage_percent,
  ]
    .map(readPercentCandidate)
    .find((v) => v != null);

  if (direct != null) return direct;

  const current = typeof limit?.currentValue === "number" ? limit.currentValue : null;
  const remaining = typeof limit?.remaining === "number" ? limit.remaining : null;

  if (current != null && remaining != null && current + remaining > 0) {
    return (current / (current + remaining)) * 100;
  }

  return null;
}

export function extractUsageFromPayload(data: any): { session: number; weekly: number } | null {
  const limitArrays = [data?.data?.limits, data?.limits, data?.quota?.limits, data?.data?.quota?.limits];
  const limits = limitArrays.find((arr) => Array.isArray(arr)) as any[] | undefined;

  if (limits) {
    const byType = (types: string[]) =>
      limits.find((l) => {
        const t = String(l?.type || "").toUpperCase();
        return types.some((x) => t === x);
      });

    const sessionLimit = byType(["TIME_LIMIT", "SESSION_LIMIT", "REQUEST_LIMIT", "RPM_LIMIT", "RPD_LIMIT"]);
    const weeklyLimit = byType(["TOKENS_LIMIT", "TOKEN_LIMIT", "WEEK_LIMIT", "WEEKLY_LIMIT", "TPM_LIMIT", "DAILY_LIMIT"]);

    const s = readLimitPercent(sessionLimit);
    const w = readLimitPercent(weeklyLimit);
    if (s != null && w != null) return normalizeUsagePair(s, w);
  }

  const sessionCandidates = [
    data?.session,
    data?.sessionPercent,
    data?.session_percent,
    data?.five_hour?.utilization,
    data?.rate_limit?.primary_window?.used_percent,
    data?.limits?.session?.utilization,
    data?.usage?.session,
    data?.data?.session,
    data?.data?.sessionPercent,
    data?.data?.session_percent,
    data?.data?.usage?.session,
    data?.quota?.session?.percentage,
    data?.data?.quota?.session?.percentage,
  ];

  const weeklyCandidates = [
    data?.weekly,
    data?.weeklyPercent,
    data?.weekly_percent,
    data?.seven_day?.utilization,
    data?.rate_limit?.secondary_window?.used_percent,
    data?.limits?.weekly?.utilization,
    data?.usage?.weekly,
    data?.data?.weekly,
    data?.data?.weeklyPercent,
    data?.data?.weekly_percent,
    data?.data?.usage?.weekly,
    data?.quota?.weekly?.percentage,
    data?.data?.quota?.weekly?.percentage,
    data?.quota?.daily?.percentage,
    data?.data?.quota?.daily?.percentage,
  ];

  const session = sessionCandidates.map(readPercentCandidate).find((v) => v != null);
  const weekly = weeklyCandidates.map(readPercentCandidate).find((v) => v != null);

  if (session == null || weekly == null) return null;
  return normalizeUsagePair(session, weekly);
}

export function googleMetadata(projectId?: string) {
  return {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
    ...(projectId ? { duetProject: projectId } : {}),
  };
}

export function googleHeaders(token: string, projectId?: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "X-Goog-Api-Client": "gl-node/22.17.0",
    "Client-Metadata": JSON.stringify(googleMetadata(projectId)),
  };
}

export async function discoverGoogleProjectId(token: string, config: FetchConfig = {}): Promise<string | undefined> {
  const env = config.env ?? process.env;
  const envProjectId = env.GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT_ID;
  if (envProjectId) return envProjectId;

  const endpoints = config.endpoints ?? resolveUsageEndpoints();

  for (const endpoint of endpoints.googleLoadCodeAssistEndpoints) {
    const result = await requestJson(
      endpoint,
      {
        method: "POST",
        headers: googleHeaders(token),
        body: JSON.stringify({ metadata: googleMetadata() }),
      },
      config,
    );

    if (!result.ok) continue;

    const data = result.data;
    if (typeof data?.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
      return data.cloudaicompanionProject;
    }
    if (data?.cloudaicompanionProject && typeof data.cloudaicompanionProject === "object") {
      const id = data.cloudaicompanionProject.id;
      if (typeof id === "string" && id) return id;
    }
  }

  return undefined;
}

export function usedPercentFromRemainingFraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const remaining = Math.max(0, Math.min(1, value));
  return (1 - remaining) * 100;
}

export function pickMostUsedBucket(buckets: any[]): any | null {
  let best: any | null = null;
  let bestUsed = -1;
  for (const bucket of buckets) {
    const used = usedPercentFromRemainingFraction(bucket?.remainingFraction);
    if (used == null) continue;
    if (used > bestUsed) {
      bestUsed = used;
      best = bucket;
    }
  }
  return best;
}

export function parseGoogleQuotaBuckets(data: any, provider: "gemini" | "antigravity"): { session: number; weekly: number } | null {
  const allBuckets = Array.isArray(data?.buckets) ? data.buckets : [];
  if (!allBuckets.length) return null;

  const requestBuckets = allBuckets.filter((b: any) => String(b?.tokenType || "").toUpperCase() === "REQUESTS");
  const buckets = requestBuckets.length ? requestBuckets : allBuckets;

  const modelId = (b: any) => String(b?.modelId || "").toLowerCase();
  const claudeNonThinking = buckets.filter((b: any) => modelId(b).includes("claude") && !modelId(b).includes("thinking"));
  const geminiPro = buckets.filter((b: any) => modelId(b).includes("gemini") && modelId(b).includes("pro"));
  const geminiFlash = buckets.filter((b: any) => modelId(b).includes("gemini") && modelId(b).includes("flash"));

  const primaryBucket =
    provider === "antigravity"
      ? pickMostUsedBucket(claudeNonThinking) || pickMostUsedBucket(geminiPro) || pickMostUsedBucket(geminiFlash) || pickMostUsedBucket(buckets)
      : pickMostUsedBucket(geminiPro) || pickMostUsedBucket(geminiFlash) || pickMostUsedBucket(buckets);

  const secondaryBucket = pickMostUsedBucket(geminiFlash) || pickMostUsedBucket(geminiPro) || pickMostUsedBucket(buckets);

  const session = usedPercentFromRemainingFraction(primaryBucket?.remainingFraction);
  const weekly = usedPercentFromRemainingFraction(secondaryBucket?.remainingFraction);

  if (session == null || weekly == null) return null;
  return normalizeUsagePair(session, weekly);
}

export async function fetchCodexUsage(token: string, config: RequestConfig = {}): Promise<UsageData> {
  const result = await requestJson(
    "https://chatgpt.com/backend-api/wham/usage",
    { headers: { Authorization: `Bearer ${token}` } },
    config,
  );

  if (!result.ok) return { session: 0, weekly: 0, error: result.error };

  const primary = result.data?.rate_limit?.primary_window;
  const secondary = result.data?.rate_limit?.secondary_window;

  return {
    session: readPercentCandidate(primary?.used_percent) ?? 0,
    weekly: readPercentCandidate(secondary?.used_percent) ?? 0,
    sessionResetsIn: typeof primary?.reset_after_seconds === "number" ? formatDuration(primary.reset_after_seconds) : undefined,
    weeklyResetsIn: typeof secondary?.reset_after_seconds === "number" ? formatDuration(secondary.reset_after_seconds) : undefined,
  };
}

export async function fetchClaudeUsage(token: string, config: RequestConfig = {}): Promise<UsageData> {
  const result = await requestJson(
    "https://api.anthropic.com/api/oauth/usage",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
    config,
  );

  if (!result.ok) return { session: 0, weekly: 0, error: result.error };

  const data = result.data;
  const usage: UsageData = {
    session: readPercentCandidate(data?.five_hour?.utilization) ?? 0,
    weekly: readPercentCandidate(data?.seven_day?.utilization) ?? 0,
    sessionResetsIn: data?.five_hour?.resets_at ? formatResetsAt(data.five_hour.resets_at) : undefined,
    weeklyResetsIn: data?.seven_day?.resets_at ? formatResetsAt(data.seven_day.resets_at) : undefined,
  };

  if (data?.extra_usage?.is_enabled) {
    usage.extraSpend = typeof data.extra_usage.used_credits === "number" ? data.extra_usage.used_credits : undefined;
    usage.extraLimit = typeof data.extra_usage.monthly_limit === "number" ? data.extra_usage.monthly_limit : undefined;
  }

  return usage;
}

export async function fetchZaiUsage(token: string, config: FetchConfig = {}): Promise<UsageData> {
  const endpoint = (config.endpoints ?? resolveUsageEndpoints()).zai;
  if (!endpoint) return { session: 0, weekly: 0, error: "usage endpoint unavailable" };

  const result = await requestJson(
    endpoint,
    { headers: { Authorization: `Bearer ${token}` } },
    config,
  );

  if (!result.ok) return { session: 0, weekly: 0, error: result.error };

  const parsed = extractUsageFromPayload(result.data);
  if (!parsed) return { session: 0, weekly: 0, error: "unrecognized response shape" };
  return parsed;
}

export async function fetchGoogleUsage(
  token: string,
  endpoint: string,
  projectId: string | undefined,
  provider: "gemini" | "antigravity",
  config: FetchConfig = {},
): Promise<UsageData> {
  if (!endpoint) return { session: 0, weekly: 0, error: "configure endpoint" };

  const discoveredProjectId = projectId || (await discoverGoogleProjectId(token, config));
  if (!discoveredProjectId) {
    return { session: 0, weekly: 0, error: "missing projectId (try /login again)" };
  }

  const result = await requestJson(
    endpoint,
    {
      method: "POST",
      headers: googleHeaders(token, discoveredProjectId),
      body: JSON.stringify({ project: discoveredProjectId }),
    },
    config,
  );

  if (!result.ok) return { session: 0, weekly: 0, error: result.error };

  const quota = parseGoogleQuotaBuckets(result.data, provider);
  if (quota) return quota;

  const parsed = extractUsageFromPayload(result.data);
  if (!parsed) return { session: 0, weekly: 0, error: "unrecognized response shape" };
  return parsed;
}

export function detectProvider(
  model: { provider?: string; id?: string; name?: string; api?: string } | string | undefined | null,
): ProviderKey | null {
  if (!model) return null;
  if (typeof model === "string") return null;

  const provider = (model.provider || "").toLowerCase();

  if (provider === "openai-codex") return "codex";
  if (provider === "anthropic") return "claude";
  if (provider === "zai") return "zai";
  if (provider === "google-gemini-cli") return "gemini";
  if (provider === "google-antigravity") return "antigravity";

  return null;
}

export function providerToOAuthProviderId(active: ProviderKey | null): OAuthProviderId | null {
  if (active === "codex") return "openai-codex";
  if (active === "claude") return "anthropic";
  if (active === "gemini") return "google-gemini-cli";
  if (active === "antigravity") return "google-antigravity";
  return null;
}

export function canShowForProvider(active: ProviderKey | null, auth: AuthData | null, endpoints: UsageEndpoints): boolean {
  if (!active || !auth) return false;
  if (active === "codex") return !!(auth["openai-codex"]?.access || auth["openai-codex"]?.refresh);
  if (active === "claude") return !!(auth.anthropic?.access || auth.anthropic?.refresh);
  if (active === "zai") return !!(auth.zai?.access || auth.zai?.key) && !!endpoints.zai;
  if (active === "gemini") {
    return !!(auth["google-gemini-cli"]?.access || auth["google-gemini-cli"]?.refresh) && !!endpoints.gemini;
  }
  if (active === "antigravity") {
    return !!(auth["google-antigravity"]?.access || auth["google-antigravity"]?.refresh) && !!endpoints.antigravity;
  }
  return false;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function colorForPercent(value: number): "success" | "warning" | "error" {
  if (value >= 90) return "error";
  if (value >= 70) return "warning";
  return "success";
}

export async function fetchAllUsages(config: FetchAllUsagesConfig = {}): Promise<UsageByProvider> {
  const authFile = config.authFile ?? DEFAULT_AUTH_FILE;
  const auth = config.auth ?? readAuth(authFile);
  const endpoints = config.endpoints ?? resolveUsageEndpoints();

  const results: UsageByProvider = {
    codex: null,
    claude: null,
    zai: null,
    gemini: null,
    antigravity: null,
  };

  if (!auth) return results;

  const oauthProviders: OAuthProviderId[] = [
    "openai-codex",
    "anthropic",
    "google-gemini-cli",
    "google-antigravity",
  ];

  const refreshed = await ensureFreshAuthForProviders(oauthProviders, {
    ...config,
    auth,
    authFile,
  });

  const authData = refreshed.auth ?? auth;

  const refreshError = (providerId: OAuthProviderId): string | null => {
    const error = refreshed.refreshErrors[providerId];
    return error ? `auth refresh failed (${error})` : null;
  };

  const tasks: Promise<void>[] = [];
  const assign = (provider: ProviderKey, task: Promise<UsageData>) => {
    tasks.push(
      task
        .then((usage) => {
          results[provider] = usage;
        })
        .catch((error) => {
          results[provider] = { session: 0, weekly: 0, error: toErrorMessage(error) };
        }),
    );
  };

  if (authData["openai-codex"]?.access) {
    const err = refreshError("openai-codex");
    if (err) results.codex = { session: 0, weekly: 0, error: err };
    else assign("codex", fetchCodexUsage(authData["openai-codex"].access, config));
  }

  if (authData.anthropic?.access) {
    const err = refreshError("anthropic");
    if (err) results.claude = { session: 0, weekly: 0, error: err };
    else assign("claude", fetchClaudeUsage(authData.anthropic.access, config));
  }

  if (authData.zai?.access || authData.zai?.key) {
    assign("zai", fetchZaiUsage(authData.zai.access || authData.zai.key!, { ...config, endpoints }));
  }

  if (authData["google-gemini-cli"]?.access) {
    const err = refreshError("google-gemini-cli");
    if (err) {
      results.gemini = { session: 0, weekly: 0, error: err };
    } else {
      const creds = authData["google-gemini-cli"];
      assign(
        "gemini",
        fetchGoogleUsage(creds.access!, endpoints.gemini, creds.projectId, "gemini", { ...config, endpoints }),
      );
    }
  }

  if (authData["google-antigravity"]?.access) {
    const err = refreshError("google-antigravity");
    if (err) {
      results.antigravity = { session: 0, weekly: 0, error: err };
    } else {
      const creds = authData["google-antigravity"];
      assign(
        "antigravity",
        fetchGoogleUsage(creds.access!, endpoints.antigravity, creds.projectId, "antigravity", { ...config, endpoints }),
      );
    }
  }

  await Promise.all(tasks);
  return results;
}
