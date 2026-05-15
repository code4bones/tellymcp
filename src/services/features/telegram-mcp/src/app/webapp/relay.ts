function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function normalizeBasePath(value: string): string {
  const trimmed = trimTrailingSlashes(value.trim());
  if (!trimmed) {
    return "/";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export const LIVE_RELAY_SESSION_PREFIX = "relay~";

export function buildLiveRelaySessionId(
  clientUuid: string,
  localSessionId: string,
): string {
  return `${LIVE_RELAY_SESSION_PREFIX}${clientUuid}~${encodeURIComponent(localSessionId)}`;
}

export function parseLiveRelaySessionId(
  value: string | null | undefined,
): { clientUuid: string; localSessionId: string } | null {
  if (!value || !value.startsWith(LIVE_RELAY_SESSION_PREFIX)) {
    return null;
  }

  const payload = value.slice(LIVE_RELAY_SESSION_PREFIX.length);
  const separatorIndex = payload.indexOf("~");
  if (separatorIndex <= 0) {
    return null;
  }

  const clientUuid = payload.slice(0, separatorIndex).trim();
  const encodedSessionId = payload.slice(separatorIndex + 1).trim();
  if (!clientUuid || !encodedSessionId) {
    return null;
  }

  try {
    const localSessionId = decodeURIComponent(encodedSessionId);
    return localSessionId ? { clientUuid, localSessionId } : null;
  } catch {
    return null;
  }
}

export function resolveGatewayWebAppBaseUrl(
  gatewayPublicUrl: string,
  webAppBasePath: string,
): string {
  const rootPrefix = normalizeBasePath(process.env.ROOT_PREFIX || "/api");
  const normalizedWebAppBasePath = normalizeBasePath(webAppBasePath || "/webapp");
  const expectedPath =
    rootPrefix === "/"
      ? normalizedWebAppBasePath
      : `${rootPrefix}${normalizedWebAppBasePath}`;

  const url = new URL(gatewayPublicUrl);
  url.pathname = trimTrailingSlashes(url.pathname);

  if (url.pathname.endsWith("/gateway")) {
    url.pathname = url.pathname.slice(0, -"/gateway".length) || "/";
  }

  const currentPath = normalizeBasePath(url.pathname || "/");
  if (currentPath === "/" || currentPath === rootPrefix) {
    url.pathname = expectedPath;
  } else {
    url.pathname = `${trimTrailingSlashes(currentPath)}${normalizedWebAppBasePath}`.replace(
      /\/{2,}/gu,
      "/",
    );
  }

  return trimTrailingSlashes(url.toString());
}
