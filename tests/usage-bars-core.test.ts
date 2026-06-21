import { describe, expect, it, spyOn, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let homedirSpy: any;
beforeAll(() => {
  homedirSpy = spyOn(os, "homedir").mockReturnValue("/nonexistent-home-for-tests");
});

afterAll(() => {
  homedirSpy?.mockRestore();
});
import {
  canShowForProvider,
  codexLabelFromKey,
  detectProvider,
  discoverGoogleProjectId,
  ensureFreshAuthForProviders,
  extractUsageFromPayload,
  extractZaiUsageFromPayload,
  fetchAllUsages,
  fetchClaudeUsage,
  fetchClaudeUsageWithFallback,
  fetchCodexUsage,
  fetchGoogleUsage,
  fetchZaiUsage,
  fetchOpencodeGoUsage,
  fetchKiroUsage,
  resolveOpencodeGoConfig,
  formatDuration,
  formatResetsAt,
  parseGoogleQuotaBuckets,
  parseRetryAfterMs,
  pickMostUsedBucket,
  readLimitPercent,
  readPercentCandidate,
  resolveUsageEndpoints,
  usedPercentFromRemainingFraction,
  type AuthData,
  type FetchLike,
  type FetchResponseLike,
  type UsageEndpoints,
} from "../extensions/usage-bars/core";

function responseHeaders(values: Record<string, string> = {}) {
  const normalized = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    get(name: string) {
      return normalized.get(name.toLowerCase()) ?? null;
    },
  };
}

function jsonResponse(status: number, body: any, headers: Record<string, string> = {}): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeaders(headers),
    json: async () => body,
  };
}

function invalidJsonResponse(status = 200): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeaders(),
    json: async () => {
      throw new Error("bad json");
    },
  };
}

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-bars-"));
  return path.join(dir, name);
}

describe("usage-bars-core formatting", () => {
  it("formats durations across units", () => {
    expect(formatDuration(0)).toBe("now");
    expect(formatDuration(30)).toBe("<1m");
    expect(formatDuration(61)).toBe("1m");
    expect(formatDuration(3660)).toBe("1h 1m");
    expect(formatDuration(90000)).toBe("1d 1h");
  });

  it("formats reset date relative to fixed now and handles invalid dates", () => {
    const now = Date.parse("2026-02-18T12:00:00.000Z");
    expect(formatResetsAt("2026-02-18T13:30:00.000Z", now)).toBe("1h 30m");
    expect(formatResetsAt("not-a-date", now)).toBe("");
    expect(formatResetsAt("2026-02-18T11:00:00.000Z", now)).toBe("now");
  });

  it("parses retry-after seconds and dates", () => {
    const now = Date.parse("2026-02-18T12:00:00.000Z");
    expect(parseRetryAfterMs("120", now)).toBe(120000);
    expect(parseRetryAfterMs("2026-02-18T12:05:00.000Z", now)).toBe(300000);
    expect(parseRetryAfterMs("bad-value", now)).toBeNull();
  });
});

describe("usage-bars-core percent parsing", () => {
  it("parses percent candidates from fractions and percentages", () => {
    expect(readPercentCandidate(0.37)).toBe(37);
    expect(readPercentCandidate(1)).toBe(1);
    expect(readPercentCandidate(99)).toBe(99);
    expect(readPercentCandidate(101)).toBeNull();
    expect(readPercentCandidate("50")).toBeNull();
  });

  it("reads limit percent directly or from current/remaining", () => {
    expect(readLimitPercent({ utilization: 44 })).toBe(44);
    expect(readLimitPercent({ currentValue: 30, remaining: 70 })).toBe(30);
    expect(readLimitPercent({ currentValue: 0, remaining: 0 })).toBeNull();
  });
});

describe("usage-bars-core payload extraction", () => {
  it("extracts usage from typed limits arrays", () => {
    const payload = {
      data: {
        limits: [
          { type: "TIME_LIMIT", usage_percent: 25 },
          { type: "TOKENS_LIMIT", currentValue: 20, remaining: 80 },
        ],
      },
    };

    expect(extractUsageFromPayload(payload)).toEqual({ session: 25, weekly: 20 });
  });

  it("extracts usage from fallback fields", () => {
    const payload = {
      rate_limit: {
        primary_window: { used_percent: 35 },
        secondary_window: { used_percent: 45 },
      },
    };

    expect(extractUsageFromPayload(payload)).toEqual({ session: 35, weekly: 45 });
  });

  it("returns null for unknown payload shape", () => {
    expect(extractUsageFromPayload({ nope: true })).toBeNull();
  });
});

describe("usage-bars-core google buckets", () => {
  it("converts remaining fraction to used percent", () => {
    expect(usedPercentFromRemainingFraction(0.25)).toBe(75);
    expect(usedPercentFromRemainingFraction(-1)).toBe(100);
    expect(usedPercentFromRemainingFraction(5)).toBe(0);
    expect(usedPercentFromRemainingFraction("x")).toBeNull();
  });

  it("picks the most used bucket", () => {
    const selected = pickMostUsedBucket([
      { remainingFraction: 0.6, id: "a" },
      { remainingFraction: 0.1, id: "b" },
      { remainingFraction: 0.4, id: "c" },
    ]);
    expect(selected?.id).toBe("b");
  });

  it("parses gemini buckets with provider-specific preferences", () => {
    const parsed = parseGoogleQuotaBuckets(
      {
        buckets: [
          { tokenType: "REQUESTS", modelId: "gemini-2.5-pro", remainingFraction: 0.4 },
          { tokenType: "REQUESTS", modelId: "gemini-2.5-flash", remainingFraction: 0.2 },
        ],
      },
      "gemini",
    );

    expect(parsed).toEqual({ session: 60, weekly: 80 });
  });

  it("parses antigravity buckets preferring non-thinking claude for session", () => {
    const parsed = parseGoogleQuotaBuckets(
      {
        buckets: [
          { tokenType: "REQUESTS", modelId: "claude-3.7-sonnet", remainingFraction: 0.7 },
          { tokenType: "REQUESTS", modelId: "gemini-2.5-pro", remainingFraction: 0.1 },
          { tokenType: "REQUESTS", modelId: "gemini-2.5-flash", remainingFraction: 0.5 },
        ],
      },
      "antigravity",
    );

    expect(parsed).toEqual({ session: 30, weekly: 50 });
  });
});

describe("usage-bars-core provider detection and visibility", () => {
  it("detects known providers only", () => {
    expect(detectProvider({ provider: "openai-codex" })).toBe("codex");
    expect(detectProvider({ provider: "google-gemini-cli" })).toBe("gemini");
    expect(detectProvider("gpt-4.1")).toBeNull();
    expect(detectProvider({ provider: "openai" })).toBeNull();
  });

  it("checks whether provider usage can be shown", () => {
    const auth: AuthData = {
      "openai-codex": { access: "a" },
      anthropic: { access: "b" },
      zai: { key: "c" },
      "google-gemini-cli": { access: "d" },
    };
    const endpoints: UsageEndpoints = {
      zai: "https://z.ai",
      gemini: "https://gemini",
      antigravity: "",
      googleLoadCodeAssistEndpoints: [],
    };

    expect(canShowForProvider("codex", auth, endpoints)).toBe(true);
    expect(canShowForProvider("antigravity", auth, endpoints)).toBe(false);
    expect(canShowForProvider("zai", auth, { ...endpoints, zai: "" })).toBe(false);
    expect(canShowForProvider("opencode-go", auth, endpoints)).toBe(false);
    expect(canShowForProvider("opencode-go", { ...auth, "opencode-go": { key: "e" } }, endpoints)).toBe(true);
  });
});

describe("usage-bars-core network fetchers", () => {
  it("discovers google project id from env before network", async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls += 1;
      return jsonResponse(200, {});
    };

    const id = await discoverGoogleProjectId("token", {
      fetchFn,
      env: { GOOGLE_CLOUD_PROJECT: "proj-from-env" } as any,
      endpoints: resolveUsageEndpoints({} as any),
    });

    expect(id).toBe("proj-from-env");
    expect(calls).toBe(0);
  });

  it("discovers google project id from loadCodeAssist fallback endpoints", async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      calls.push(url);
      if (url.startsWith("https://cloudcode-pa.googleapis.com/")) {
        return jsonResponse(500, { error: true });
      }
      return jsonResponse(200, { cloudaicompanionProject: { id: "project-2" } });
    };

    const id = await discoverGoogleProjectId("token", {
      fetchFn,
      env: {} as any,
      endpoints: {
        zai: "",
        gemini: "",
        antigravity: "",
        googleLoadCodeAssistEndpoints: [
          "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
          "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
        ],
      },
    });

    expect(id).toBe("project-2");
    expect(calls.length).toBe(2);
  });

  it("fetches codex usage and handles http/json failures", async () => {
    const ok = await fetchCodexUsage("token", {
      fetchFn: async () =>
        jsonResponse(200, {
          rate_limit: {
            primary_window: { used_percent: 42, reset_after_seconds: 120 },
            secondary_window: { used_percent: 73, reset_after_seconds: 240 },
          },
        }),
    });

    expect(ok).toMatchObject({ session: 42, weekly: 73, sessionResetsIn: "2m", weeklyResetsIn: "4m" });

    const badHttp = await fetchCodexUsage("token", { fetchFn: async () => jsonResponse(401, {}) });
    expect(badHttp.error).toBe("HTTP 401");

    const badJson = await fetchCodexUsage("token", { fetchFn: async () => invalidJsonResponse() });
    expect(badJson.error).toBe("invalid JSON response");
  });

  it("fetches codex usage with accountId and sends it in headers", async () => {
    let headersSeen: any = null;
    const ok = await fetchCodexUsage("token", "account-123", {
      fetchFn: async (_url, init) => {
        headersSeen = init?.headers;
        return jsonResponse(200, {
          rate_limit: {
            primary_window: { used_percent: 42, reset_after_seconds: 120 },
            secondary_window: { used_percent: 73, reset_after_seconds: 240 },
          },
        });
      },
    });

    expect(ok).toMatchObject({ session: 42, weekly: 73 });
    expect(headersSeen).toBeDefined();
    expect(headersSeen["Authorization"]).toBe("Bearer token");
    expect(headersSeen["ChatGPT-Account-Id"]).toBe("account-123");
  });

  it("fetches claude usage with extra spend", async () => {
    const usage = await fetchClaudeUsage("token", {
      fetchFn: async () =>
        jsonResponse(200, {
          five_hour: { utilization: 55, resets_at: "2026-02-18T13:00:00.000Z" },
          seven_day: { utilization: 22, resets_at: "2026-02-19T13:00:00.000Z" },
          extra_usage: { is_enabled: true, used_credits: 7.5, monthly_limit: 20 },
        }),
    });

    expect(usage.session).toBe(55);
    expect(usage.weekly).toBe(22);
    expect(usage.extraSpend).toBe(7.5);
    expect(usage.extraLimit).toBe(20);
    expect(usage.sessionResetsAt).toBe("2026-02-18T13:00:00.000Z");
  });

  it("refreshes claude oauth token after a 429 and retries once", async () => {
    const auth: AuthData = {
      anthropic: {
        access: "stale-token",
        refresh: "refresh-token",
        expires: 9999999999999,
      },
    };

    const cacheFile = tempFile("usage-cache.json");
    const authFile = tempFile("auth.json");
    const tokensSeen: string[] = [];

    const result = await fetchClaudeUsageWithFallback({
      auth,
      authFile,
      cacheFile,
      persist: false,
      nowMs: Date.parse("2026-02-18T12:00:00.000Z"),
      oauthResolver: async () => ({
        apiKey: "ignored",
        newCredentials: {
          access: "fresh-token",
          refresh: "refresh-token-2",
          expires: 9999999999999,
        },
      }),
      fetchFn: async (_url, init) => {
        const token = String((init?.headers as any)?.Authorization || "").replace("Bearer ", "");
        tokensSeen.push(token);

        if (token === "stale-token") {
          return jsonResponse(429, { error: true }, { "retry-after": "0" });
        }

        return jsonResponse(200, {
          five_hour: { utilization: 61, resets_at: "2026-02-18T14:00:00.000Z" },
          seven_day: { utilization: 19, resets_at: "2026-02-20T12:00:00.000Z" },
        });
      },
    });

    expect(tokensSeen).toEqual(["stale-token", "fresh-token"]);
    expect(result.auth?.anthropic?.access).toBe("fresh-token");
    expect(result.usage).toMatchObject({ session: 61, weekly: 19 });
    expect(result.usage.error).toBeUndefined();
  });

  it("returns stale cached claude usage during 429 cooldown", async () => {
    const auth: AuthData = {
      anthropic: {
        access: "claude-token",
        refresh: "refresh-token",
        expires: 9999999999999,
      },
    };

    const cacheFile = tempFile("usage-cache.json");
    const authFile = tempFile("auth.json");

    const first = await fetchClaudeUsageWithFallback({
      auth,
      authFile,
      cacheFile,
      persist: false,
      nowMs: Date.parse("2026-02-18T12:00:00.000Z"),
      fetchFn: async () =>
        jsonResponse(200, {
          five_hour: { utilization: 45, resets_at: "2026-02-18T13:00:00.000Z" },
          seven_day: { utilization: 12, resets_at: "2026-02-20T12:00:00.000Z" },
        }),
    });

    expect(first.usage).toMatchObject({ session: 45, weekly: 12 });

    const second = await fetchClaudeUsageWithFallback({
      auth,
      authFile,
      cacheFile,
      persist: false,
      nowMs: Date.parse("2026-02-18T12:10:00.000Z"),
      oauthResolver: async () => ({
        apiKey: "ignored",
        newCredentials: {
          access: "refreshed-token",
          refresh: "refresh-token-2",
          expires: 9999999999999,
        },
      }),
      fetchFn: async () => jsonResponse(429, { error: true }, { "retry-after": "0" }),
    });

    expect(second.usage.session).toBe(45);
    expect(second.usage.weekly).toBe(12);
    expect(second.usage.stale).toBe(true);
    expect(second.usage.warning).toContain("retry in");
    expect(second.usage.error).toBeUndefined();
  });

  it("reuses recent claude cache across concurrent callers", async () => {
    const auth: AuthData = {
      anthropic: {
        access: "claude-token",
        refresh: "refresh-token",
        expires: 9999999999999,
      },
    };

    const cacheFile = tempFile("usage-cache.json");
    const authFile = tempFile("auth.json");
    let calls = 0;

    const fetchFn: FetchLike = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 75));
      return jsonResponse(200, {
        five_hour: { utilization: 52, resets_at: "2026-02-18T13:00:00.000Z" },
        seven_day: { utilization: 28, resets_at: "2026-02-20T12:00:00.000Z" },
      });
    };

    const [one, two] = await Promise.all([
      fetchClaudeUsageWithFallback({
        auth,
        authFile,
        cacheFile,
        persist: false,
        nowMs: Date.parse("2026-02-18T12:00:00.000Z"),
        fetchFn,
      }),
      fetchClaudeUsageWithFallback({
        auth,
        authFile,
        cacheFile,
        persist: false,
        nowMs: Date.parse("2026-02-18T12:00:00.000Z"),
        fetchFn,
      }),
    ]);

    expect(calls).toBe(1);
    expect(one.usage).toMatchObject({ session: 52, weekly: 28 });
    expect(two.usage).toMatchObject({ session: 52, weekly: 28 });
  });

  it("parses z.ai payload with TOKENS_LIMIT differentiated by unit field", () => {
    const now = Date.now();
    const payload = {
      code: 200,
      data: {
        limits: [
          {
            type: "TOKENS_LIMIT",
            unit: 3,
            number: 5,
            percentage: 29,
            nextResetTime: now + 5 * 60 * 60 * 1000,
          },
          {
            type: "TOKENS_LIMIT",
            unit: 6,
            number: 1,
            percentage: 5,
            nextResetTime: now + 7 * 24 * 60 * 60 * 1000,
          },
          {
            type: "TIME_LIMIT",
            unit: 5,
            number: 1,
            percentage: 0,
          },
        ],
      },
    };

    const parsed = extractZaiUsageFromPayload(payload, now);
    expect(parsed).not.toBeNull();
    expect(parsed!.session).toBe(29);
    expect(parsed!.weekly).toBe(5);
    expect(parsed!.sessionResetsIn).toBeDefined();
    expect(parsed!.weeklyResetsIn).toBeDefined();
  });

  it("extractZaiUsageFromPayload returns null when no unit 3 or 6 TOKENS_LIMIT", () => {
    const payload = {
      data: {
        limits: [
          { type: "TIME_LIMIT", unit: 5, percentage: 50 },
        ],
      },
    };
    expect(extractZaiUsageFromPayload(payload)).toBeNull();
  });

  it("fetches zai usage with z.ai-specific TOKENS_LIMIT by unit", async () => {
    const endpoints: UsageEndpoints = {
      zai: "https://z.ai/usage",
      gemini: "",
      antigravity: "",
      googleLoadCodeAssistEndpoints: [],
    };

    const usage = await fetchZaiUsage("token", {
      endpoints,
      fetchFn: async () =>
        jsonResponse(200, {
          data: {
            limits: [
              { type: "TOKENS_LIMIT", unit: 3, percentage: 29 },
              { type: "TOKENS_LIMIT", unit: 6, percentage: 5 },
              { type: "TIME_LIMIT", unit: 5, percentage: 0 },
            ],
          },
        }),
    });

    expect(usage.session).toBe(29);
    expect(usage.weekly).toBe(5);
    expect(usage.error).toBeUndefined();
  });

  it("fetches zai usage falls back to generic parser when no unit-based limits", async () => {
    const endpoints: UsageEndpoints = {
      zai: "https://z.ai/usage",
      gemini: "",
      antigravity: "",
      googleLoadCodeAssistEndpoints: [],
    };

    const usage = await fetchZaiUsage("token", {
      endpoints,
      fetchFn: async () =>
        jsonResponse(200, {
          data: {
            limits: [
              { type: "TIME_LIMIT", percentage: 20 },
              { type: "TOKENS_LIMIT", percentage: 40 },
            ],
          },
        }),
    });

    expect(usage.session).toBe(20);
    expect(usage.weekly).toBe(40);
  });

  it("fetches zai usage returns error for unrecognized shapes", async () => {
    const endpoints: UsageEndpoints = {
      zai: "https://z.ai/usage",
      gemini: "",
      antigravity: "",
      googleLoadCodeAssistEndpoints: [],
    };

    const unknown = await fetchZaiUsage("token", {
      endpoints,
      fetchFn: async () => jsonResponse(200, { nope: true }),
    });
    expect(unknown.error).toBe("unrecognized response shape");
  });

  it("fetches google usage and falls back to generic parser", async () => {
    const usage = await fetchGoogleUsage(
      "token",
      "https://google-endpoint",
      "project-123",
      "gemini",
      {
        fetchFn: async (_url) =>
          jsonResponse(200, {
            data: { usage: { session: 61, weekly: 72 } },
          }),
      },
    );

    expect(usage).toEqual({ session: 61, weekly: 72 });
  });

  it("returns explicit error when google project id cannot be discovered", async () => {
    const usage = await fetchGoogleUsage("token", "https://google-endpoint", undefined, "gemini", {
      fetchFn: async () => jsonResponse(500, {}),
      env: {} as any,
      endpoints: {
        zai: "",
        gemini: "https://google-endpoint",
        antigravity: "",
        googleLoadCodeAssistEndpoints: ["https://discover"],
      },
    });

    expect(usage.error).toBe("missing projectId (try /login again)");
  });

  it("refreshes expired oauth credentials before usage requests", async () => {
    const auth: AuthData = {
      "google-gemini-cli": {
        access: "expired-token",
        refresh: "refresh-token",
        projectId: "proj-a",
        expires: 1,
      },
    };

    const refreshed = await ensureFreshAuthForProviders(["google-gemini-cli"], {
      auth,
      nowMs: 10_000,
      persist: false,
      oauthResolver: async (providerId) => {
        expect(providerId).toBe("google-gemini-cli");
        return {
          apiKey: "ignored",
          newCredentials: {
            access: "fresh-token",
            refresh: "refresh-token",
            projectId: "proj-a",
            expires: 999_999,
          },
        };
      },
    });

    expect(refreshed.changed).toBe(true);
    expect(refreshed.refreshErrors["google-gemini-cli"]).toBeUndefined();
    expect(refreshed.auth?.["google-gemini-cli"]?.access).toBe("fresh-token");
  });

  it("uses refreshed oauth token in fetchAllUsages", async () => {
    const auth: AuthData = {
      "google-gemini-cli": {
        access: "expired-token",
        refresh: "refresh-token",
        projectId: "proj-a",
        expires: 1,
      },
    };

    const all = await fetchAllUsages({
      auth,
      env: {} as any,
      persist: false,
      oauthResolver: async () => ({
        apiKey: "ignored",
        newCredentials: {
          access: "fresh-token",
          refresh: "refresh-token",
          projectId: "proj-a",
          expires: 999_999,
        },
      }),
      endpoints: {
        zai: "",
        gemini: "https://google/quota/gemini",
        antigravity: "",
        googleLoadCodeAssistEndpoints: [],
      },
      fetchFn: async (_url, init) => {
        const authHeader = String((init?.headers as any)?.Authorization || "");
        expect(authHeader).toContain("fresh-token");
        return jsonResponse(200, {
          buckets: [{ tokenType: "REQUESTS", modelId: "gemini-pro", remainingFraction: 0.2 }],
        });
      },
    });

    expect(all.gemini).toEqual({ session: 80, weekly: 80 });
  });

  it("surfaces oauth refresh failures with explicit error", async () => {
    const auth: AuthData = {
      "google-antigravity": {
        access: "expired-token",
        refresh: "refresh-token",
        projectId: "proj-b",
        expires: 1,
      },
    };

    const all = await fetchAllUsages({
      auth,
      env: {} as any,
      persist: false,
      oauthResolver: async () => {
        throw new Error("refresh boom");
      },
      endpoints: {
        zai: "",
        gemini: "",
        antigravity: "https://google/quota/antigravity",
        googleLoadCodeAssistEndpoints: [],
      },
      fetchFn: async () => jsonResponse(200, {}),
    });

    expect(all.antigravity?.error).toContain("auth refresh failed");
  });

  it("fetches all available providers in parallel-friendly orchestration", async () => {
    const auth: AuthData = {
      "openai-codex": { access: "codex-token" },
      anthropic: { access: "claude-token" },
      zai: { key: "zai-key" },
      "google-gemini-cli": { access: "gemini-token", projectId: "proj-a" },
      "google-antigravity": { access: "ag-token", projectId: "proj-b" },
    };

    const endpoints: UsageEndpoints = {
      zai: "https://z.ai/usage",
      gemini: "https://google/quota/gemini",
      antigravity: "https://google/quota/antigravity",
      googleLoadCodeAssistEndpoints: [],
    };

    const fetchFn: FetchLike = async (url) => {
      if (url.includes("chatgpt.com")) {
        return jsonResponse(200, {
          rate_limit: {
            primary_window: { used_percent: 11 },
            secondary_window: { used_percent: 22 },
          },
        });
      }

      if (url.includes("anthropic")) {
        return jsonResponse(200, {
          five_hour: { utilization: 33 },
          seven_day: { utilization: 44 },
        });
      }

      if (url.includes("z.ai")) {
        return jsonResponse(200, { usage: { session: 55, weekly: 66 } });
      }

      if (url.includes("gemini")) {
        return jsonResponse(200, {
          buckets: [{ tokenType: "REQUESTS", modelId: "gemini-pro", remainingFraction: 0.2 }],
        });
      }

      return jsonResponse(200, {
        buckets: [{ tokenType: "REQUESTS", modelId: "claude-3.7-sonnet", remainingFraction: 0.4 }],
      });
    };

    const all = await fetchAllUsages({ auth, endpoints, fetchFn, env: {} as any, cacheFile: tempFile("all-usage-cache.json") });

    expect(all.codex).toEqual({ session: 11, weekly: 22, sessionResetsIn: undefined, weeklyResetsIn: undefined });
    expect(all.claude).toMatchObject({ session: 33, weekly: 44, sessionResetsIn: undefined, weeklyResetsIn: undefined });
    expect(all.zai).toEqual({ session: 55, weekly: 66 });
    expect(all.gemini).toEqual({ session: 80, weekly: 80 });
    expect(all.antigravity).toEqual({ session: 60, weekly: 60 });

    // Single codex key should produce one subscription
    expect(all.codexSubscriptions).toHaveLength(1);
    expect(all.codexSubscriptions[0]!.authKey).toBe("openai-codex");
    expect(all.codexSubscriptions[0]!.label).toBe("Codex");
    expect(all.codexSubscriptions[0]!.usage).toEqual({ session: 11, weekly: 22, sessionResetsIn: undefined, weeklyResetsIn: undefined });
  });

  it("fetches opencode-go and reports missing config error if not configured but in auth", async () => {
    const auth: AuthData = {
      "opencode-go": { key: "some-key" },
    };
    const endpoints: UsageEndpoints = {
      zai: "",
      gemini: "",
      antigravity: "",
      googleLoadCodeAssistEndpoints: [],
    };
    const all = await fetchAllUsages({
      auth,
      endpoints,
      env: {} as any,
      persist: false,
    });
    expect(all["opencode-go"]).toEqual({
      session: 0,
      weekly: 0,
      error: "missing workspaceId or authCookie (set OPENCODE_GO_WORKSPACE_ID/AUTH_COOKIE or config file)",
    });
  });

  it("detects opencode-go provider", () => {
    expect(detectProvider({ provider: "opencode-go" })).toBe("opencode-go");
  });

  it("codexLabelFromKey returns correct labels", () => {
    expect(codexLabelFromKey("openai-codex")).toBe("Codex");
    expect(codexLabelFromKey("openai-codex-2")).toBe("Codex 2");
    expect(codexLabelFromKey("openai-codex-n")).toBe("Codex N");
    expect(codexLabelFromKey("openai-codex-pro")).toBe("Codex Pro");
  });

  it("fetchAllUsages returns all codex subscriptions individually", async () => {
    const auth: AuthData = {
      "openai-codex": { access: "token-1" },
      "openai-codex-2": { access: "token-2" },
      "openai-codex-n": { access: "token-n" },
    };

    const endpoints: UsageEndpoints = {
      zai: "",
      gemini: "",
      antigravity: "",
      googleLoadCodeAssistEndpoints: [],
    };

    const tokenToUsage: Record<string, { primary: number; secondary: number }> = {
      "token-1": { primary: 10, secondary: 20 },
      "token-2": { primary: 30, secondary: 40 },
      "token-n": { primary: 50, secondary: 60 },
    };

    const fetchFn: FetchLike = async (_url, init) => {
      const authHeader = String((init?.headers as any)?.Authorization || "");
      const token = authHeader.replace("Bearer ", "");
      const data = tokenToUsage[token];
      if (!data) return jsonResponse(401, {});
      return jsonResponse(200, {
        rate_limit: {
          primary_window: { used_percent: data.primary },
          secondary_window: { used_percent: data.secondary },
        },
      });
    };

    const all = await fetchAllUsages({ auth, endpoints, fetchFn, env: {} as any, persist: false });

    // Should have 3 subscriptions
    expect(all.codexSubscriptions).toHaveLength(3);

    const sub1 = all.codexSubscriptions.find(s => s.authKey === "openai-codex")!;
    expect(sub1.label).toBe("Codex");
    expect(sub1.usage).toMatchObject({ session: 10, weekly: 20 });

    const sub2 = all.codexSubscriptions.find(s => s.authKey === "openai-codex-2")!;
    expect(sub2.label).toBe("Codex 2");
    expect(sub2.usage).toMatchObject({ session: 30, weekly: 40 });

    const subN = all.codexSubscriptions.find(s => s.authKey === "openai-codex-n")!;
    expect(subN.label).toBe("Codex N");
    expect(subN.usage).toMatchObject({ session: 50, weekly: 60 });

    // Backward compat: codex slot has first subscription
    expect(all.codex).toMatchObject({ session: 10, weekly: 20 });
  });

  describe("opencode-go config resolver", () => {
    it("resolves config from environment variables", () => {
      const config = resolveOpencodeGoConfig({
        OPENCODE_GO_WORKSPACE_ID: "env-workspace",
        OPENCODE_GO_AUTH_COOKIE: "env-cookie",
      } as any);
      expect(config).toEqual({
        workspaceId: "env-workspace",
        authCookie: "env-cookie",
      });
    });

    it("returns null when workspaceId or authCookie is missing from env", () => {
      const config = resolveOpencodeGoConfig({
        OPENCODE_GO_WORKSPACE_ID: "env-workspace",
      } as any);
      expect(config).toBeNull();
    });
  });

  describe("opencode-go usage fetcher", () => {
    it("parses opencode-go quota successfully from HTML", async () => {
      const mockHtml = `
        some prefix data
        rollingUsage:$R[1]={usagePercent:45.5,resetInSec:18000}
        weeklyUsage:$R[2]={usagePercent:20,resetInSec:360000}
        monthlyUsage:$R[3]={usagePercent:10,resetInSec:720000}
        some suffix data
      `;

      const fetchFn: FetchLike = async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => mockHtml,
        };
      };

      const usage = await fetchOpencodeGoUsage({
        fetchFn,
        env: {
          OPENCODE_GO_WORKSPACE_ID: "test-workspace",
          OPENCODE_GO_AUTH_COOKIE: "test-cookie",
        } as any,
      });

      expect(usage.session).toBe(45.5);
      expect(usage.weekly).toBe(20);
      expect(usage.monthly).toBe(10);
      expect(usage.sessionResetsIn).toBe("5h");
      expect(usage.weeklyResetsIn).toBe("4d 4h");
      expect(usage.monthlyResetsIn).toBe("8d 8h");
      expect(usage.extraSpend).toBe(6); // 10% of 60
      expect(usage.extraLimit).toBe(60);
      expect(usage.error).toBeUndefined();
    });

    it("handles alternative ordering in SolidJS hydration output", async () => {
      const mockHtml = `
        rollingUsage:$R[1]={resetInSec:7200,usagePercent:15}
        weeklyUsage:$R[2]={resetInSec:14400,usagePercent:30}
        monthlyUsage:$R[3]={resetInSec:28800,usagePercent:45}
      `;

      const fetchFn: FetchLike = async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => mockHtml,
        };
      };

      const usage = await fetchOpencodeGoUsage({
        fetchFn,
        env: {
          OPENCODE_GO_WORKSPACE_ID: "test-workspace",
          OPENCODE_GO_AUTH_COOKIE: "test-cookie",
        } as any,
      });

      expect(usage.session).toBe(15);
      expect(usage.weekly).toBe(30);
      expect(usage.monthly).toBe(45);
      expect(usage.sessionResetsIn).toBe("2h");
      expect(usage.weeklyResetsIn).toBe("4h");
      expect(usage.monthlyResetsIn).toBe("8h");
      expect(usage.extraSpend).toBe(27); // 45% of 60
    });

    it("returns error when unable to parse usage", async () => {
      const fetchFn: FetchLike = async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "no data here",
        };
      };

      const usage = await fetchOpencodeGoUsage({
        fetchFn,
        env: {
          OPENCODE_GO_WORKSPACE_ID: "test-workspace",
          OPENCODE_GO_AUTH_COOKIE: "test-cookie",
        } as any,
      });

      expect(usage.error).toBe("Could not parse any known OpenCode Go dashboard usage windows");
    });

    it("returns error on HTTP failure", async () => {
      const fetchFn: FetchLike = async () => {
        return {
          ok: false,
          status: 500,
          json: async () => ({}),
          text: async () => "Internal Server Error",
        };
      };

      const usage = await fetchOpencodeGoUsage({
        fetchFn,
        env: {
          OPENCODE_GO_WORKSPACE_ID: "test-workspace",
          OPENCODE_GO_AUTH_COOKIE: "test-cookie",
        } as any,
      });

      expect(usage.error).toBe("HTTP 500");
    });
  });

  describe("usage-bars-core kiro usage fetcher", () => {
    // Regression: Kiro IDE users log in via the AWS SSO cache JSON
    // (no OIDC clientId/secret) and get authMethod: "desktop" with
    // refresh packed as `RT|||desktop`. fetchKiroUsage previously threw
    // "missing clientId/clientSecret" on refresh and sent a GET with
    // `Content-Type: application/json` (no `X-Amz-Target`) which AWS
    // returned 403 for. These tests cover both fixes.

    function makeAuthFile(auth: AuthData): string {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-bars-kiro-"));
      const file = path.join(tmpDir, "auth.json");
      fs.writeFileSync(file, JSON.stringify(auth));
      return file;
    }

    it("refreshes via the desktop endpoint when authMethod is desktop", async () => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetchFn: FetchLike = async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (String(url).includes("auth.desktop.kiro.dev")) {
          return jsonResponse(200, {
            accessToken: "AT2",
            refreshToken: "RT2",
            expiresIn: 3600,
          });
        }
        // getUsageLimits response
        return jsonResponse(200, {
          usageBreakdownList: [
            { currentUsage: 30, usageLimit: 100, nextDateReset: "2026-07-01T00:00:00Z" },
          ],
          subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
        });
      };

      const auth: AuthData = {
        kiro: {
          type: "oauth",
          access: "stale-AT",
          refresh: "RT|||desktop",
          expires: 0, // force refresh
          clientId: "",
          clientSecret: "",
          region: "eu-central-1",
          authMethod: "desktop",
        },
      };
      const authFile = makeAuthFile(auth);

      const usage = await fetchKiroUsage({ authFile, fetchFn });

      // Refresh hit the desktop endpoint, NOT the OIDC one.
      const refreshCall = calls.find((c) =>
        c.url.includes("auth.desktop.kiro.dev/refreshToken"),
      );
      expect(refreshCall).toBeDefined();
      expect(refreshCall!.init.method).toBe("POST");
      expect(JSON.parse(refreshCall!.init.body as string)).toEqual({
        refreshToken: "RT",
      });
      const oidcCall = calls.find((c) => c.url.includes("oidc."));
      expect(oidcCall).toBeUndefined();

      // Usage was parsed correctly.
      expect(usage.session).toBe(30);
      expect(usage.error).toBeUndefined();
    });

    it("refreshes via the OIDC endpoint when clientId/clientSecret are present", async () => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetchFn: FetchLike = async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (String(url).includes("oidc.") && String(url).includes("/token")) {
          return jsonResponse(200, {
            accessToken: "AT2",
            refreshToken: "RT2",
            expiresIn: 3600,
          });
        }
        return jsonResponse(200, {
          usageBreakdownList: [{ currentUsage: 50, usageLimit: 100 }],
        });
      };

      const auth: AuthData = {
        kiro: {
          type: "oauth",
          access: "stale-AT",
          refresh: "old-RT|CID|CSEC|idc",
          expires: 0,
          clientId: "CID",
          clientSecret: "CSEC",
          region: "us-east-1",
          authMethod: "idc",
        },
      };
      const authFile = makeAuthFile(auth);

      await fetchKiroUsage({ authFile, fetchFn });

      const refreshCall = calls.find((c) => c.url.includes("oidc.us-east-1.amazonaws.com/token"));
      expect(refreshCall).toBeDefined();
      expect(JSON.parse(refreshCall!.init.body as string)).toEqual({
        clientId: "CID",
        clientSecret: "CSEC",
        refreshToken: "old-RT",
        grantType: "refresh_token",
      });
    });

    it("falls back to the desktop endpoint when clientId/clientSecret are missing even if authMethod is idc", async () => {
      // Defensive: the packed refresh string can disagree with the
      // struct authMethod. If the struct says "idc" but the pack has
      // no clientId/secret (or the struct fields are empty), route
      // through the desktop endpoint instead of throwing.
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetchFn: FetchLike = async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (String(url).includes("auth.desktop.kiro.dev")) {
          return jsonResponse(200, {
            accessToken: "AT2",
            refreshToken: "RT2",
            expiresIn: 3600,
          });
        }
        return jsonResponse(200, {
          usageBreakdownList: [{ currentUsage: 10, usageLimit: 100 }],
        });
      };

      const auth: AuthData = {
        kiro: {
          type: "oauth",
          access: "stale-AT",
          refresh: "RT|||desktop", // pack says desktop
          expires: 0,
          clientId: "",
          clientSecret: "",
          region: "eu-central-1",
          authMethod: "idc", // struct says idc (mismatch)
        },
      };
      const authFile = makeAuthFile(auth);

      const usage = await fetchKiroUsage({ authFile, fetchFn });

      const refreshCall = calls.find((c) =>
        c.url.includes("auth.desktop.kiro.dev/refreshToken"),
      );
      expect(refreshCall).toBeDefined();
      const oidcCall = calls.find((c) => c.url.includes("oidc.") && c.url.includes("/token"));
      expect(oidcCall).toBeUndefined();
      expect(usage.session).toBe(10);
    });

    it("sends the AWS service routing headers on getUsageLimits (Content-Type + X-Amz-Target)", async () => {
      // Regression: the old GET-with-query-params call used
      // `Content-Type: application/json` and no `X-Amz-Target`, which
      // AWS returns 403 for. The new POST shape uses
      // `application/x-amz-json-1.0` + `AmazonCodeWhispererService.GetUsageLimits`.
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetchFn: FetchLike = async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse(200, {
          usageBreakdownList: [{ currentUsage: 5, usageLimit: 100 }],
        });
      };

      const auth: AuthData = {
        kiro: {
          type: "oauth",
          access: "AT",
          refresh: "RT|||desktop",
          expires: Date.now() + 3600 * 1000, // not expired
          clientId: "",
          clientSecret: "",
          region: "eu-central-1",
          authMethod: "desktop",
        },
      };
      const authFile = makeAuthFile(auth);

      await fetchKiroUsage({ authFile, fetchFn });

      // The profile-resolve call also POSTs to the same root URL, so
      // pick the one whose X-Amz-Target is GetUsageLimits specifically.
      const usageCall = calls.find(
        (c) =>
          c.url === "https://q.eu-central-1.amazonaws.com/" &&
          c.init.method === "POST" &&
          (c.init.headers as Record<string, string>)["X-Amz-Target"] ===
            "AmazonCodeWhispererService.GetUsageLimits",
      );
      expect(usageCall).toBeDefined();
      const headers = usageCall!.init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/x-amz-json-1.0");
      expect(headers["X-Amz-Target"]).toBe("AmazonCodeWhispererService.GetUsageLimits");
      expect(headers["x-amzn-codewhisperer-optout"]).toBe("true");
      expect(headers["amz-sdk-invocation-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(headers["amz-sdk-request"]).toBe("attempt=1; max=1");
      expect(headers["x-amzn-kiro-agent-mode"]).toBe("vibe");
      expect(headers["Authorization"]).toBe("Bearer AT");

      // The body should carry the params as JSON, not as query string.
      const body = JSON.parse(usageCall!.init.body as string);
      expect(body.isEmailRequired).toBe(true);
      expect(body.origin).toBe("AI_EDITOR");
    });

    it("returns a useful error when both refresh and usage fail", async () => {
      const fetchFn: FetchLike = async (url) => {
        if (String(url).includes("auth.desktop.kiro.dev")) {
          return jsonResponse(401, {});
        }
        return jsonResponse(403, {});
      };

      const auth: AuthData = {
        kiro: {
          type: "oauth",
          access: "stale-AT",
          refresh: "RT|||desktop",
          expires: 0,
          clientId: "",
          clientSecret: "",
          region: "eu-central-1",
          authMethod: "desktop",
        },
      };
      const authFile = makeAuthFile(auth);

      const usage = await fetchKiroUsage({ authFile, fetchFn });
      expect(usage.error).toMatch(/auth refresh failed/);
    });
  });
});
