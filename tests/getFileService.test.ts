import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import type { GetFileOutput } from "../src/services/features/telegram-mcp/src/entities/request/model/types";
import type { SessionContext } from "../src/services/features/telegram-mcp/src/entities/session/model/types";
import { GetFileService } from "../src/services/features/telegram-mcp/src/features/file-content/model/getFileService";
import type {
  MaintenanceStore,
  SessionStore,
  TelegramXchangeFileMetaStore,
} from "../src/services/features/telegram-mcp/src/shared/api/storage/contract";
import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";
import type { ProjectIdentityResolver } from "../src/services/features/telegram-mcp/src/shared/lib/project-identity/projectIdentity";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function createService(input: {
  workspaceDir: string;
  mode: "client" | "gateway";
  sessionId?: string;
  remoteInvoke?: (
    sessionId: string,
    actionName: string,
    params: Record<string, unknown>,
  ) => Promise<GetFileOutput>;
  fileMetas?: Awaited<
    ReturnType<TelegramXchangeFileMetaStore["listXchangeFileMetas"]>
  >;
}): GetFileService {
  const sessionId = input.sessionId ?? "local-session";
  return new GetFileService(
    {
      terminal: {},
      distributed: { mode: input.mode },
    } as AppConfig,
    {
      getSession: vi.fn<SessionStore["getSession"]>(async (requestedId) =>
        requestedId === sessionId
          ? ({
              sessionId,
              cwd: input.workspaceDir,
              updatedAt: new Date().toISOString(),
            } satisfies SessionContext)
          : null,
      ),
    } as SessionStore,
    {
      getGatewayClientUuid: vi
        .fn<MaintenanceStore["getGatewayClientUuid"]>()
        .mockResolvedValue("local-client"),
    } as unknown as MaintenanceStore,
    {
      listXchangeFileMetas: vi
        .fn<TelegramXchangeFileMetaStore["listXchangeFileMetas"]>()
        .mockResolvedValue(input.fileMetas ?? []),
    } as unknown as TelegramXchangeFileMetaStore,
    {
      info: vi.fn(),
    } as unknown as Logger,
    {
      resolveSessionDefaults: vi
        .fn<ProjectIdentityResolver["resolveSessionDefaults"]>()
        .mockReturnValue({
          sessionId,
          sessionLabel: "workspace",
          cwd: input.workspaceDir,
          sessionIdDerived: false,
          sessionLabelDerived: false,
        }),
    } as unknown as ProjectIdentityResolver,
    input.remoteInvoke
      ? { invokeForRelaySession: input.remoteInvoke }
      : undefined,
  );
}

describe("GetFileService", () => {
  it("returns file metadata and base64 content from the selected workspace", async () => {
    const workspaceDir = await mkdtemp(
      path.join(os.tmpdir(), "telly-get-file-"),
    );
    tempDirs.push(workspaceDir);
    await writeFile(
      path.join(workspaceDir, "sample.txt"),
      "hello file",
      "utf8",
    );
    const service = createService({ workspaceDir, mode: "client" });

    await expect(
      service.get({
        session_id: "local-session",
        file_path: "sample.txt",
        type: "base64",
      }),
    ).resolves.toEqual({
      type: "base64",
      data: Buffer.from("hello file", "utf8").toString("base64"),
      mimetype: "text/plain",
      filename: "sample.txt",
      size_bytes: 10,
    });
  });

  it("returns UTF-8 source files as native text with a source MIME type", async () => {
    const workspaceDir = await mkdtemp(
      path.join(os.tmpdir(), "telly-get-file-"),
    );
    tempDirs.push(workspaceDir);
    await mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, "src", "test.ts"),
      "export const answer = 42;\n",
      "utf8",
    );
    const service = createService({ workspaceDir, mode: "client" });

    await expect(
      service.get({
        session_id: "local-session",
        file_path: "src/test.ts",
        type: "text",
      }),
    ).resolves.toEqual({
      type: "text",
      data: "export const answer = 42;\n",
      mimetype: "text/typescript",
      filename: "test.ts",
      size_bytes: 26,
    });
  });

  it("blocks sensitive files inside the selected workspace", async () => {
    const workspaceDir = await mkdtemp(
      path.join(os.tmpdir(), "telly-get-file-"),
    );
    tempDirs.push(workspaceDir);
    await writeFile(path.join(workspaceDir, ".env"), "TOKEN=secret\n", "utf8");
    const service = createService({ workspaceDir, mode: "client" });

    await expect(
      service.get({
        session_id: "local-session",
        file_path: ".env",
        type: "text",
      }),
    ).rejects.toThrow("Access to sensitive workspace files is blocked.");
  });

  it("blocks symlink aliases to sensitive files inside the workspace", async () => {
    const workspaceDir = await mkdtemp(
      path.join(os.tmpdir(), "telly-get-file-"),
    );
    tempDirs.push(workspaceDir);
    const envPath = path.join(workspaceDir, ".env");
    await writeFile(envPath, "TOKEN=secret\n", "utf8");
    await symlink(envPath, path.join(workspaceDir, "safe-name.txt"));
    const service = createService({ workspaceDir, mode: "client" });

    await expect(
      service.get({
        session_id: "local-session",
        file_path: "safe-name.txt",
        type: "text",
      }),
    ).rejects.toThrow("Access to sensitive workspace files is blocked.");
  });

  it("allows documented environment templates", async () => {
    const workspaceDir = await mkdtemp(
      path.join(os.tmpdir(), "telly-get-file-"),
    );
    tempDirs.push(workspaceDir);
    await writeFile(
      path.join(workspaceDir, ".env.example"),
      "TOKEN=replace-me\n",
      "utf8",
    );
    const service = createService({ workspaceDir, mode: "client" });

    await expect(
      service.get({
        session_id: "local-session",
        file_path: ".env.example",
        type: "text",
      }),
    ).resolves.toMatchObject({
      type: "text",
      data: "TOKEN=replace-me\n",
      filename: ".env.example",
    });
  });

  it("routes a canonical gateway session to its live client", async () => {
    const workspaceDir = await mkdtemp(
      path.join(os.tmpdir(), "telly-get-file-"),
    );
    tempDirs.push(workspaceDir);
    const output: GetFileOutput = {
      type: "base64",
      data: "aW1hZ2U=",
      mimetype: "image/png",
      filename: "screen.png",
      size_bytes: 5,
    };
    const remoteInvoke = vi.fn().mockResolvedValue(output);
    const service = createService({
      workspaceDir,
      mode: "gateway",
      sessionId: "remote-client:remote-session",
      remoteInvoke,
    });

    await expect(
      service.get({
        session_id: "remote-client:remote-session",
        file_path: ".mcp-xchange/screenshots/screen.png",
        type: "base64",
      }),
    ).resolves.toEqual(output);
    expect(remoteInvoke).toHaveBeenCalledWith(
      "remote-client:remote-session",
      "telegramMcp.fileContent.getFileRemote",
      {
        session_id: "remote-client:remote-session",
        file_path: ".mcp-xchange/screenshots/screen.png",
        type: "base64",
      },
    );
  });

  it("resolves the latest browser screenshot when no path is known", async () => {
    const workspaceDir = await mkdtemp(
      path.join(os.tmpdir(), "telly-get-file-"),
    );
    tempDirs.push(workspaceDir);
    const olderPath = path.join(workspaceDir, ".mcp-xchange", "older.png");
    const latestPath = path.join(workspaceDir, ".mcp-xchange", "latest.png");
    await mkdir(path.dirname(olderPath), { recursive: true });
    await writeFile(olderPath, "older");
    await writeFile(latestPath, "latest");
    const service = createService({
      workspaceDir,
      mode: "client",
      fileMetas: [
        {
          sessionId: "local-session",
          filePath: olderPath,
          source: "browser-screenshot",
          uploadedAt: "2026-07-14T10:00:00+03:00",
        },
        {
          sessionId: "local-session",
          filePath: latestPath,
          source: "browser-screenshot",
          uploadedAt: "2026-07-14T11:00:00+03:00",
        },
      ],
    });

    await expect(
      service.get({
        session_id: "local-session",
        selector: "latest_screenshot",
        type: "base64",
      }),
    ).resolves.toEqual({
      type: "base64",
      data: Buffer.from("latest").toString("base64"),
      mimetype: "image/png",
      filename: "latest.png",
      size_bytes: 6,
    });
  });

  it("rejects lexical paths outside the selected workspace", async () => {
    const workspaceDir = await mkdtemp(
      path.join(os.tmpdir(), "telly-get-file-"),
    );
    tempDirs.push(workspaceDir);
    const service = createService({ workspaceDir, mode: "client" });

    await expect(
      service.get({
        session_id: "local-session",
        file_path: "../secret.txt",
        type: "base64",
      }),
    ).rejects.toThrow("File path is outside the workspace directory.");
  });

  it("rejects symlinks that escape the selected workspace", async () => {
    const workspaceDir = await mkdtemp(
      path.join(os.tmpdir(), "telly-get-file-"),
    );
    const outsideDir = await mkdtemp(
      path.join(os.tmpdir(), "telly-get-file-outside-"),
    );
    tempDirs.push(workspaceDir, outsideDir);
    const outsideFile = path.join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "secret", "utf8");
    await symlink(outsideFile, path.join(workspaceDir, "linked-secret.txt"));
    const service = createService({ workspaceDir, mode: "client" });

    await expect(
      service.get({
        session_id: "local-session",
        file_path: "linked-secret.txt",
        type: "base64",
      }),
    ).rejects.toThrow("File path is outside the workspace directory.");
  });
});
