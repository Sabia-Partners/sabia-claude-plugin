export async function readResponseJson(response, action) {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    const redirect = location ? safeUrl(location, response.url) : null;
    if (redirect?.hostname === "vercel.com" && redirect.pathname === "/sso-api") {
      throw new Error(
        "the configured Sabia URL is protected by Vercel; update the plugin or set SABIA_APP_URL to Sabia's public production URL",
      );
    }
    throw new Error(`could not ${action} (HTTP ${response.status} redirect)`);
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      body?.error?.message || `could not ${action} (HTTP ${response.status})`,
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(
      `Sabia returned an invalid response while trying to ${action}; verify SABIA_APP_URL points to the public Sabia app`,
    );
  }
  return body;
}

export function connectHandoff(value) {
  if (
    typeof value.sessionId !== "string" ||
    typeof value.verificationUri !== "string" ||
    !isHttpUrl(value.verificationUri) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    (value.intervalSeconds !== undefined &&
      (!Number.isFinite(value.intervalSeconds) || value.intervalSeconds <= 0))
  ) {
    throw new Error(
      "Sabia returned an invalid browser connection response; verify SABIA_APP_URL points to the public Sabia app",
    );
  }
  return value;
}

export function approvedHandoff(value) {
  // `otlpMetricsEndpoint` rather than `otlpLogsEndpoint`: Claude Code exports
  // metrics, and its exporter takes a full signal URL rather than a base one.
  // Sabia serves both signals from the same authenticated endpoint, so the two
  // fields currently hold the same value — reading the wrong one would work
  // today and break silently the moment they diverge.
  if (
    value.status !== "approved" ||
    typeof value.organizationId !== "string" ||
    typeof value.organizationName !== "string" ||
    typeof value.ingestionKeyId !== "string" ||
    typeof value.ingestionKey !== "string" ||
    typeof value.otlpMetricsEndpoint !== "string" ||
    !isHttpUrl(value.otlpMetricsEndpoint)
  ) {
    throw new Error(
      "Sabia returned an invalid approval response; restart the browser connection",
    );
  }
  return value;
}

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function safeUrl(value, base) {
  try {
    return base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }
}
