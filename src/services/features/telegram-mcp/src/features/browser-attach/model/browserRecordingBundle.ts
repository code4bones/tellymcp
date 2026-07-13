import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../../../app/config/env";
import type { BrowserRecordingRecord } from "../../../entities/browser/model/types";
import type { SessionContext } from "../../../entities/session/model/types";
import type { Logger } from "../../../shared/lib/logger/logger";
import {
  ensureXchangeDir,
  writeXchangeRelativeFile,
} from "../../../shared/integrations/terminal/client";

type BrowserRecordingEvent =
  | {
      kind: "session_started" | "session_stopped";
      at?: string | undefined;
      status?: string | undefined;
    }
  | {
      kind: "console_event";
      at?: string | undefined;
      level?: string | undefined;
      args?: unknown[] | undefined;
      text?: string | undefined;
      url?: string | undefined;
      title?: string | undefined;
    }
  | {
      kind: "page_snapshot";
      at?: string | undefined;
      reason?: string | undefined;
      html?: string | undefined;
      url?: string | undefined;
      title?: string | undefined;
      ready_state?: string | undefined;
    }
  | {
      kind: "navigation";
      at?: string | undefined;
      url?: string | undefined;
      title?: string | undefined;
      status?: string | undefined;
      frame_id?: number | undefined;
    }
  | {
      kind:
        | "network_request"
        | "network_request_headers"
        | "network_response_headers"
        | "network_response_complete"
        | "network_response_body"
        | "network_error"
        | "cookies_snapshot";
      at?: string | undefined;
      request_id?: string | undefined;
      url?: string | undefined;
      method?: string | undefined;
      resource_type?: string | undefined;
      status_code?: number | undefined;
      headers?: Array<{ name: string; value: string }> | undefined;
      body_text?: string | undefined;
      body_base64?: string | undefined;
      body_file_rel_path?: string | undefined;
      body_mime_type?: string | undefined;
      body_encoding?: "utf8" | "base64" | undefined;
      body_truncated?: boolean | undefined;
      cookies?: unknown[] | undefined;
      error?: string | undefined;
      tab_title?: string | undefined;
    };

type TimelineEntry = {
  at: string;
  kind: BrowserRecordingEvent["kind"];
  page_id?: string | undefined;
  rel_path?: string | undefined;
  request_id?: string | undefined;
  url?: string | undefined;
  title?: string | undefined;
  summary?: string | undefined;
};

export type ActiveBrowserRecordingState = {
  record: BrowserRecordingRecord;
  session: SessionContext;
  currentPageId?: string | undefined;
  currentPageUrl?: string | undefined;
  pageCounter: number;
  snapshotCounter: number;
  requestCounter: number;
  requestArtifacts: Map<string, BrowserRecordingRequestArtifact>;
};

type BrowserRecordingNetworkEvent = Extract<
  BrowserRecordingEvent,
  {
    kind:
      | "network_request"
      | "network_request_headers"
      | "network_response_headers"
      | "network_response_complete"
      | "network_response_body"
      | "network_error"
      | "cookies_snapshot";
  }
>;

type BrowserRecordingRequestArtifact = {
  seq: number;
  requestId: string;
  requestDirRelPath: string;
  metaFileRelPath: string;
  requestFileRelPath: string;
  responseFileRelPath: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
};

function sanitizeSegment(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  return normalized || "recording";
}

function padNumber(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function formatLocalTimestamp(date: Date): string {
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}T${padNumber(
    date.getHours(),
  )}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}.${padNumber(
    date.getMilliseconds(),
    3,
  )}`;
}

function formatTimestampForDir(date: Date): string {
  return formatLocalTimestamp(date).replace(/[:.]/gu, "-");
}

function normalizeRecordedTimestamp(rawValue?: string | undefined): string {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return formatLocalTimestamp(new Date());
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return formatLocalTimestamp(new Date());
  }

  return formatLocalTimestamp(parsed);
}

function formatJsonLine(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function sanitizeRequestId(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "") || "request";
}

function detectMimeTypeFromHeaders(
  headers?: Array<{ name: string; value: string }> | undefined,
): string | undefined {
  const match = headers?.find(
    (header) => header.name.trim().toLowerCase() === "content-type",
  );
  const value = match?.value?.trim();
  return value || undefined;
}

async function allocateBundleDirName(
  config: AppConfig,
  session: SessionContext,
  tabTitle: string,
): Promise<string> {
  const exchangeRoot = await ensureXchangeDir(
    config.terminal,
    session.cwd || "",
    config.exchange.dir,
  );
  const webRoot = path.resolve(exchangeRoot, "web");
  await mkdir(webRoot, { recursive: true });

  const baseName = `${sanitizeSegment(tabTitle)}-${formatTimestampForDir(new Date())}`;
  let attempt = 1;
  while (attempt < 1000) {
    const candidate = attempt === 1 ? baseName : `${baseName}-${attempt}`;
    const candidatePath = path.resolve(webRoot, candidate);
    try {
      await mkdir(candidatePath);
      return candidate;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "EEXIST"
      ) {
        attempt += 1;
        continue;
      }
      throw error;
    }
  }

  throw new Error("Could not allocate a unique browser recording bundle directory.");
}

export class BrowserRecordingBundleWriter {
  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  public async create(input: {
    session: SessionContext;
    sessionId: string;
    instanceId: string;
    tabId: number;
    tabTitle: string;
    tabUrl?: string | undefined;
    recordingId: string;
  }): Promise<ActiveBrowserRecordingState> {
    if (!input.session.cwd?.trim()) {
      throw new Error("Workspace cwd is not registered for this console.");
    }

    const bundleDirName = await allocateBundleDirName(
      this.config,
      input.session,
      input.tabTitle,
    );
    const bundleRelativePath = `web/${bundleDirName}`;
    const exchangeRoot = await ensureXchangeDir(
      this.config.terminal,
      input.session.cwd,
      this.config.exchange.dir,
    );
    const bundlePath = path.resolve(exchangeRoot, bundleRelativePath);

    for (const segment of [
      bundleRelativePath,
      `${bundleRelativePath}/pages`,
      `${bundleRelativePath}/network`,
      `${bundleRelativePath}/network/requests`,
      `${bundleRelativePath}/console`,
    ]) {
      await writeXchangeRelativeFile(
        this.config.terminal,
        input.session.cwd,
        this.config.exchange.dir,
        `${segment}/.keep`,
        Buffer.from("", "utf8"),
      );
    }

    const startedAt = formatLocalTimestamp(new Date());
    const record: BrowserRecordingRecord = {
      sessionId: input.sessionId,
      backend: "firefox-attached",
      recordingId: input.recordingId,
      instanceId: input.instanceId,
      tabId: input.tabId,
      ...(input.tabTitle ? { tabTitle: input.tabTitle } : {}),
      ...(input.tabUrl ? { tabUrl: input.tabUrl } : {}),
      bundleDirName,
      bundleRelativePath,
      bundlePath,
      startedAt,
      status: "recording",
      eventCount: 0,
    };

    const sessionJson = {
      recording_id: record.recordingId,
      backend: record.backend,
      session_id: record.sessionId,
      session_label: input.session.label || input.session.sessionId,
      instance_id: record.instanceId,
      tab_id: record.tabId,
      ...(record.tabTitle ? { tab_title: record.tabTitle } : {}),
      ...(record.tabUrl ? { tab_url: record.tabUrl } : {}),
      started_at: record.startedAt,
      status: record.status,
      bundle_dir_name: record.bundleDirName,
      bundle_relative_path: record.bundleRelativePath,
      bundle_path: record.bundlePath,
      workspace_dir: input.session.cwd,
      exchange_dir: path.resolve(input.session.cwd, this.config.exchange.dir),
      files: {
        timeline: "timeline.ndjson",
        session: "session.json",
        pages: "pages",
        network: "network",
        network_index: "network/index.ndjson",
        network_requests: "network/requests",
        console: "console",
      },
    };

    await writeXchangeRelativeFile(
      this.config.terminal,
      input.session.cwd,
      this.config.exchange.dir,
      `${bundleRelativePath}/session.json`,
      Buffer.from(`${JSON.stringify(sessionJson, null, 2)}\n`, "utf8"),
    );

    const state: ActiveBrowserRecordingState = {
      record,
      session: input.session,
      pageCounter: 0,
      snapshotCounter: 0,
      requestCounter: 0,
      requestArtifacts: new Map(),
    };

    await this.appendEvent(state, {
      kind: "session_started",
      status: "recording",
    });

    this.logger.info("Browser recording bundle created", {
      sessionId: input.sessionId,
      recordingId: input.recordingId,
      bundlePath,
      tabId: input.tabId,
      tabTitle: input.tabTitle,
    });

    return state;
  }

  public async appendEvent(
    state: ActiveBrowserRecordingState,
    event: BrowserRecordingEvent,
  ): Promise<ActiveBrowserRecordingState> {
    const at = normalizeRecordedTimestamp(event.at);
    state.record.eventCount += 1;
    state.record.lastEventAt = at;

    let relPath: string | undefined;
    let pageId = state.currentPageId;

    if (event.kind === "page_snapshot") {
      const targetUrl = event.url?.trim() || state.currentPageUrl || "";
      if (!pageId || (targetUrl && targetUrl !== state.currentPageUrl)) {
        state.pageCounter += 1;
        pageId = `page-${String(state.pageCounter).padStart(3, "0")}`;
        state.currentPageId = pageId;
        state.currentPageUrl = targetUrl || state.currentPageUrl;
      }
      state.snapshotCounter += 1;
      relPath = `${state.record.bundleRelativePath}/pages/${pageId}/snapshot-${String(
        state.snapshotCounter,
      ).padStart(4, "0")}.html`;
      await writeXchangeRelativeFile(
        this.config.terminal,
        state.session.cwd || "",
        this.config.exchange.dir,
        relPath,
        Buffer.from(String(event.html || ""), "utf8"),
      );
      await this.appendJsonLine(
        state,
        `${state.record.bundleRelativePath}/pages/events.ndjson`,
        {
          at,
          page_id: pageId,
          reason: event.reason || "snapshot",
          url: event.url || state.currentPageUrl || "",
          title: event.title || state.record.tabTitle || "",
          ready_state: event.ready_state || "",
          html_rel_path: relPath.replace(`${state.record.bundleRelativePath}/`, ""),
        },
      );
    } else if (event.kind === "console_event") {
      await this.appendJsonLine(
        state,
        `${state.record.bundleRelativePath}/console/events.ndjson`,
        {
          at,
          level: event.level || "log",
          text: event.text || "",
          args: event.args || [],
          url: event.url || state.currentPageUrl || "",
          title: event.title || state.record.tabTitle || "",
          page_id: state.currentPageId,
        },
      );
    } else if (
      event.kind.startsWith("network_") ||
      event.kind === "cookies_snapshot"
    ) {
      const networkEvent = await this.materializeNetworkBodyArtifact(
        state,
        event as BrowserRecordingNetworkEvent,
      );
      const requestArtifact = await this.upsertNetworkRequestArtifact(
        state,
        networkEvent,
      );
      await this.appendJsonLine(
        state,
        `${state.record.bundleRelativePath}/network/index.ndjson`,
        {
          at,
          page_id: state.currentPageId,
          request_id: networkEvent.request_id,
          kind: networkEvent.kind,
          method: networkEvent.method,
          url: networkEvent.url,
          resource_type: networkEvent.resource_type,
          status_code: networkEvent.status_code,
          summary: this.buildSummary(networkEvent as BrowserRecordingEvent),
        ...(requestArtifact
            ? {
                seq: requestArtifact.seq,
                request_bundle_rel_path: requestArtifact.requestDirRelPath.replace(
                  `${state.record.bundleRelativePath}/`,
                  "",
                ),
                meta_rel_path: requestArtifact.metaFileRelPath.replace(
                  `${state.record.bundleRelativePath}/`,
                  "",
                ),
                request_rel_path: requestArtifact.requestFileRelPath.replace(
                  `${state.record.bundleRelativePath}/`,
                  "",
                ),
                response_rel_path: requestArtifact.responseFileRelPath.replace(
                  `${state.record.bundleRelativePath}/`,
                  "",
                ),
                ...(this.extractBodyRelPath(requestArtifact)
                  ? {
                      body_rel_path: this.extractBodyRelPath(requestArtifact),
                    }
                  : {}),
              }
            : {}),
        },
      );
    }

    if (event.kind === "navigation") {
      const nextUrl = event.url?.trim() || "";
      if (nextUrl && nextUrl !== state.currentPageUrl) {
        state.currentPageUrl = nextUrl;
      }
    }

    if (event.kind === "session_stopped") {
      state.record.status = "stopped";
      state.record.stoppedAt = at;
    }

    const eventRecord = event as Record<string, unknown>;
    const requestId = typeof eventRecord.request_id === "string" ? eventRecord.request_id : "";
    const eventUrl = typeof eventRecord.url === "string" ? eventRecord.url : "";
    const eventTitle = typeof eventRecord.title === "string" ? eventRecord.title : "";
    const timelineEntry: TimelineEntry = {
      at,
      kind: event.kind,
      ...(state.currentPageId ? { page_id: state.currentPageId } : {}),
      ...(relPath
        ? {
            rel_path: relPath.replace(`${state.record.bundleRelativePath}/`, ""),
          }
        : {}),
      ...(requestId.trim()
        ? { request_id: requestId.trim() }
        : {}),
      ...(eventUrl.trim()
        ? { url: eventUrl.trim() }
        : {}),
      ...(eventTitle.trim()
        ? { title: eventTitle.trim() }
        : {}),
      summary: this.buildSummary(event),
    };

    await this.appendJsonLine(
      state,
      `${state.record.bundleRelativePath}/timeline.ndjson`,
      timelineEntry,
    );
    await this.writeSessionJson(state);

    return state;
  }

  public async finalizeExisting(
    input: {
      session: SessionContext;
      record: BrowserRecordingRecord;
    },
  ): Promise<BrowserRecordingRecord> {
    const state: ActiveBrowserRecordingState = {
      record: { ...input.record },
      session: input.session,
      currentPageId: undefined,
      currentPageUrl: input.record.tabUrl,
      pageCounter: 0,
      snapshotCounter: 0,
      requestCounter: 0,
      requestArtifacts: new Map(),
    };

    await this.appendEvent(state, {
      kind: "session_stopped",
      status: "stopped",
    });

    return state.record;
  }

  private async appendJsonLine(
    state: ActiveBrowserRecordingState,
    relativePath: string,
    value: unknown,
  ): Promise<void> {
    await writeXchangeRelativeFile(
      this.config.terminal,
      state.session.cwd || "",
      this.config.exchange.dir,
      relativePath,
      formatJsonLine(value),
      { append: true },
    );
  }

  private async materializeNetworkBodyArtifact(
    state: ActiveBrowserRecordingState,
    event: BrowserRecordingNetworkEvent,
  ): Promise<Record<string, unknown>> {
    const mimeType = detectMimeTypeFromHeaders(event.headers);

    return {
      ...event,
      ...(mimeType ? { body_mime_type: mimeType } : {}),
      ...(typeof event.body_text === "string" ? { body_encoding: "utf8" } : {}),
    };
  }

  private async upsertNetworkRequestArtifact(
    state: ActiveBrowserRecordingState,
    event: Record<string, unknown>,
  ): Promise<BrowserRecordingRequestArtifact | null> {
    const requestId =
      typeof event.request_id === "string" && event.request_id.trim()
        ? event.request_id.trim()
        : "";
    if (!requestId) {
      return null;
    }

    let artifact = state.requestArtifacts.get(requestId);
    if (!artifact) {
      state.requestCounter += 1;
      const requestDirRelPath = `${state.record.bundleRelativePath}/network/requests/${String(
        state.requestCounter,
      ).padStart(6, "0")}-${sanitizeRequestId(requestId)}`;
      artifact = {
        seq: state.requestCounter,
        requestId,
        requestDirRelPath,
        metaFileRelPath: `${requestDirRelPath}/meta.json`,
        requestFileRelPath: `${requestDirRelPath}/request.json`,
        responseFileRelPath: `${requestDirRelPath}/response.json`,
        request: {
          request_id: requestId,
        },
        response: {
          request_id: requestId,
        },
      };
      state.requestArtifacts.set(requestId, artifact);
      await writeXchangeRelativeFile(
        this.config.terminal,
        state.session.cwd || "",
        this.config.exchange.dir,
        `${requestDirRelPath}/.keep`,
        Buffer.from("", "utf8"),
      );
    }

    const kind = typeof event.kind === "string" ? event.kind : "";
    const artifactEvent = { ...event };
    delete artifactEvent.body_base64;
    delete artifactEvent.body_text;
    delete artifactEvent.body_file_rel_path;
    delete artifactEvent.body_mime_type;
    delete artifactEvent.body_encoding;
    if (kind === "network_request" || kind === "network_request_headers") {
      artifact.request = {
        ...artifact.request,
        ...artifactEvent,
        seq: artifact.seq,
      };
    } else {
      artifact.response = {
        ...artifact.response,
        ...artifactEvent,
        seq: artifact.seq,
      };
    }

    await writeXchangeRelativeFile(
      this.config.terminal,
      state.session.cwd || "",
      this.config.exchange.dir,
      artifact.requestFileRelPath,
      Buffer.from(`${JSON.stringify(artifact.request, null, 2)}\n`, "utf8"),
    );
    await writeXchangeRelativeFile(
      this.config.terminal,
      state.session.cwd || "",
      this.config.exchange.dir,
      artifact.responseFileRelPath,
      Buffer.from(`${JSON.stringify(artifact.response, null, 2)}\n`, "utf8"),
    );
    await this.writeRequestArtifactMeta(state, artifact);

    await this.materializeRequestBodyArtifact(state, artifact, event, kind);

    return artifact;
  }

  private async materializeRequestBodyArtifact(
    state: ActiveBrowserRecordingState,
    artifact: BrowserRecordingRequestArtifact,
    event: Record<string, unknown>,
    kind: string,
  ): Promise<void> {
    const bodyBase64 =
      typeof event.body_base64 === "string" && event.body_base64.trim()
        ? event.body_base64.trim()
        : "";
    const bodyText = typeof event.body_text === "string" ? event.body_text : "";
    const bodyMimeType =
      typeof event.body_mime_type === "string" && event.body_mime_type.trim()
        ? event.body_mime_type.trim()
        : undefined;

    let bodyFileRelPath: string | undefined;
    let bodyEncoding: "utf8" | "base64" | undefined;

    if (bodyBase64) {
      bodyFileRelPath = `${artifact.requestDirRelPath}/${kind}-body.bin`;
      bodyEncoding = "base64";
      await writeXchangeRelativeFile(
        this.config.terminal,
        state.session.cwd || "",
        this.config.exchange.dir,
        bodyFileRelPath,
        Buffer.from(bodyBase64, "base64"),
      );
    } else if (bodyText.length > 16384) {
      bodyFileRelPath = `${artifact.requestDirRelPath}/${kind}-body.txt`;
      bodyEncoding = "utf8";
      await writeXchangeRelativeFile(
        this.config.terminal,
        state.session.cwd || "",
        this.config.exchange.dir,
        bodyFileRelPath,
        Buffer.from(bodyText, "utf8"),
      );
    }

    if (kind === "network_request" || kind === "network_request_headers") {
      artifact.request = {
        ...artifact.request,
        ...(bodyMimeType ? { body_mime_type: bodyMimeType } : {}),
        ...(bodyEncoding ? { body_encoding: bodyEncoding } : {}),
        ...(bodyFileRelPath
          ? {
              body_file_rel_path: bodyFileRelPath.replace(
                `${state.record.bundleRelativePath}/`,
                "",
              ),
            }
          : {}),
        ...(!bodyFileRelPath && bodyText ? { body_text: bodyText } : {}),
        ...(bodyFileRelPath && bodyText
          ? {
              body_text_preview: bodyText.slice(0, 4096),
            }
          : {}),
      };
    } else {
      artifact.response = {
        ...artifact.response,
        ...(bodyMimeType ? { body_mime_type: bodyMimeType } : {}),
        ...(bodyEncoding ? { body_encoding: bodyEncoding } : {}),
        ...(bodyFileRelPath
          ? {
              body_file_rel_path: bodyFileRelPath.replace(
                `${state.record.bundleRelativePath}/`,
                "",
              ),
            }
          : {}),
        ...(!bodyFileRelPath && bodyText ? { body_text: bodyText } : {}),
        ...(bodyFileRelPath && bodyText
          ? {
              body_text_preview: bodyText.slice(0, 4096),
            }
          : {}),
      };
    }

    await writeXchangeRelativeFile(
      this.config.terminal,
      state.session.cwd || "",
      this.config.exchange.dir,
      artifact.requestFileRelPath,
      Buffer.from(`${JSON.stringify(artifact.request, null, 2)}\n`, "utf8"),
    );
    await writeXchangeRelativeFile(
      this.config.terminal,
      state.session.cwd || "",
      this.config.exchange.dir,
      artifact.responseFileRelPath,
      Buffer.from(`${JSON.stringify(artifact.response, null, 2)}\n`, "utf8"),
    );
    await this.writeRequestArtifactMeta(state, artifact);
  }

  private extractBodyRelPath(
    artifact: BrowserRecordingRequestArtifact,
  ): string | undefined {
    const responseBody =
      typeof artifact.response.body_file_rel_path === "string"
        ? artifact.response.body_file_rel_path
        : "";
    if (responseBody.trim()) {
      return responseBody.trim();
    }
    const requestBody =
      typeof artifact.request.body_file_rel_path === "string"
        ? artifact.request.body_file_rel_path
        : "";
    return requestBody.trim() || undefined;
  }

  private async writeRequestArtifactMeta(
    state: ActiveBrowserRecordingState,
    artifact: BrowserRecordingRequestArtifact,
  ): Promise<void> {
    const requestAt =
      typeof artifact.request.at === "string" && artifact.request.at.trim()
        ? artifact.request.at.trim()
        : undefined;
    const responseAt =
      typeof artifact.response.at === "string" && artifact.response.at.trim()
        ? artifact.response.at.trim()
        : undefined;
    const method =
      typeof artifact.request.method === "string" && artifact.request.method.trim()
        ? artifact.request.method.trim()
        : undefined;
    const url =
      typeof artifact.request.url === "string" && artifact.request.url.trim()
        ? artifact.request.url.trim()
        : typeof artifact.response.url === "string" && artifact.response.url.trim()
          ? artifact.response.url.trim()
          : undefined;
    const resourceType =
      typeof artifact.request.resource_type === "string" &&
      artifact.request.resource_type.trim()
        ? artifact.request.resource_type.trim()
        : typeof artifact.response.resource_type === "string" &&
            artifact.response.resource_type.trim()
          ? artifact.response.resource_type.trim()
          : undefined;
    const statusCode =
      typeof artifact.response.status_code === "number"
        ? artifact.response.status_code
        : undefined;
    const requestBodyRelPath =
      typeof artifact.request.body_file_rel_path === "string" &&
      artifact.request.body_file_rel_path.trim()
        ? artifact.request.body_file_rel_path.trim()
        : undefined;
    const responseBodyRelPath =
      typeof artifact.response.body_file_rel_path === "string" &&
      artifact.response.body_file_rel_path.trim()
        ? artifact.response.body_file_rel_path.trim()
        : undefined;

    const meta = {
      seq: artifact.seq,
      request_id: artifact.requestId,
      ...(requestAt ? { request_at: requestAt } : {}),
      ...(responseAt ? { response_at: responseAt } : {}),
      ...(method ? { method } : {}),
      ...(url ? { url } : {}),
      ...(resourceType ? { resource_type: resourceType } : {}),
      ...(typeof statusCode === "number" ? { status_code: statusCode } : {}),
      request_rel_path: artifact.requestFileRelPath.replace(
        `${state.record.bundleRelativePath}/`,
        "",
      ),
      response_rel_path: artifact.responseFileRelPath.replace(
        `${state.record.bundleRelativePath}/`,
        "",
      ),
      ...(requestBodyRelPath ? { request_body_rel_path: requestBodyRelPath } : {}),
      ...(responseBodyRelPath ? { response_body_rel_path: responseBodyRelPath } : {}),
    };

    await writeXchangeRelativeFile(
      this.config.terminal,
      state.session.cwd || "",
      this.config.exchange.dir,
      artifact.metaFileRelPath,
      Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, "utf8"),
    );
  }

  private async writeSessionJson(
    state: ActiveBrowserRecordingState,
  ): Promise<void> {
    await writeXchangeRelativeFile(
      this.config.terminal,
      state.session.cwd || "",
      this.config.exchange.dir,
      `${state.record.bundleRelativePath}/session.json`,
      Buffer.from(
        `${JSON.stringify(
          {
            recording_id: state.record.recordingId,
            backend: state.record.backend,
            session_id: state.record.sessionId,
            session_label: state.session.label || state.session.sessionId,
            instance_id: state.record.instanceId,
            tab_id: state.record.tabId,
            ...(state.record.tabTitle ? { tab_title: state.record.tabTitle } : {}),
            ...(state.record.tabUrl ? { tab_url: state.record.tabUrl } : {}),
            started_at: state.record.startedAt,
            ...(state.record.stoppedAt
              ? { stopped_at: state.record.stoppedAt }
              : {}),
            status: state.record.status,
            event_count: state.record.eventCount,
            ...(state.record.lastEventAt
              ? { last_event_at: state.record.lastEventAt }
              : {}),
            bundle_dir_name: state.record.bundleDirName,
            bundle_relative_path: state.record.bundleRelativePath,
            bundle_path: state.record.bundlePath,
            current_page_id: state.currentPageId,
            current_page_url: state.currentPageUrl,
            files: {
              timeline: "timeline.ndjson",
              session: "session.json",
              pages: "pages",
              network: "network",
              network_index: "network/index.ndjson",
              network_requests: "network/requests",
              console: "console",
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      ),
    );
  }

  private buildSummary(event: BrowserRecordingEvent): string {
    switch (event.kind) {
      case "console_event":
        return `${event.level || "log"} ${event.text || ""}`.trim();
      case "page_snapshot":
        return `${event.reason || "snapshot"} ${event.title || event.url || ""}`.trim();
      case "network_request":
        return `${event.method || "GET"} ${event.url || ""}`.trim();
      case "network_response_complete":
        return `${event.status_code || 0} ${event.url || ""}`.trim();
      case "network_error":
        return `${event.error || "error"} ${event.url || ""}`.trim();
      case "navigation":
        return `${event.status || "navigation"} ${event.url || ""}`.trim();
      case "session_started":
      case "session_stopped":
        return event.kind;
      default:
        return event.kind;
    }
  }
}
