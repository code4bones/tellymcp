import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import type { SendPartnerNoteOutput } from "../src/services/features/telegram-mcp/src/entities/collaboration/model/types";
import type { SessionContext } from "../src/services/features/telegram-mcp/src/entities/session/model/types";
import type { SessionStore } from "../src/services/features/telegram-mcp/src/shared/api/storage/contract";
import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";
import type { ProjectIdentityResolver } from "../src/services/features/telegram-mcp/src/shared/lib/project-identity/projectIdentity";
import { SendPartnerFileService } from "../src/services/features/telegram-mcp/src/features/collaboration/model/sendPartnerFileService";
import type { CollaborationService } from "../src/services/features/telegram-mcp/src/features/collaboration/model/collaborationService";

const tempDirs: string[] = [];

function createOutput(): SendPartnerNoteOutput {
  return {
    session_id: "left-session",
    partner_session_id: "right-session",
    kind: "handoff",
    share_id: "share-1",
    delivery_status: "queued",
    note_path: "gateway://shares/share-1.md",
    xchange_record_id: "share-1",
    copied_artifacts: ["sample.txt"],
    inbox_message_id: "inbox-1",
    requires_reply: false,
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("SendPartnerFileService", () => {
  it("attaches an actual local workspace file as artifacts and artifact_refs", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "telegram-mcp-file-"));
    tempDirs.push(workspaceDir);
    await writeFile(path.join(workspaceDir, "sample.txt"), "hello sample", "utf8");

    const sendPartnerNote = vi
      .fn<CollaborationService["sendPartnerNote"]>()
      .mockResolvedValue(createOutput());
    const service = new SendPartnerFileService(
      { tmux: {} } as AppConfig,
      {
        getSession: vi.fn<SessionStore["getSession"]>().mockResolvedValue({
          sessionId: "left-session",
          cwd: workspaceDir,
          updatedAt: new Date().toISOString(),
        } satisfies SessionContext),
      } as SessionStore,
      {
        info: vi.fn(),
      } as unknown as Logger,
      {
        resolveSessionDefaults: vi.fn<
          ProjectIdentityResolver["resolveSessionDefaults"]
        >().mockReturnValue({
          sessionId: "left-session",
          sessionLabel: "leftDev",
          cwd: workspaceDir,
          sessionIdDerived: false,
          sessionLabelDerived: false,
        }),
      } as unknown as ProjectIdentityResolver,
      {
        sendPartnerNote,
      } as unknown as CollaborationService,
    );

    const output = await service.send({
      session_id: "left-session",
      target_session_id: "right-session",
      file_path: "sample.txt",
      message: "Передаю sample.txt",
    });

    expect(output).toEqual(createOutput());
    expect(sendPartnerNote).toHaveBeenCalledTimes(1);
    expect(sendPartnerNote).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "left-session",
        target_session_id: "right-session",
        kind: "handoff",
        artifacts: ["sample.txt"],
        message: "Передаю sample.txt",
        artifact_refs: [
          expect.objectContaining({
            file_path: "sample.txt",
            original_name: "sample.txt",
            mime_type: "text/plain",
            size_bytes: 12,
            content_base64: Buffer.from("hello sample", "utf8").toString("base64"),
          }),
        ],
      }),
    );
  });

  it("rejects file paths outside the workspace", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "telegram-mcp-file-"));
    tempDirs.push(workspaceDir);

    const service = new SendPartnerFileService(
      { tmux: {} } as AppConfig,
      {
        getSession: vi.fn<SessionStore["getSession"]>().mockResolvedValue({
          sessionId: "left-session",
          cwd: workspaceDir,
          updatedAt: new Date().toISOString(),
        } satisfies SessionContext),
      } as SessionStore,
      {
        info: vi.fn(),
      } as unknown as Logger,
      {
        resolveSessionDefaults: vi.fn<
          ProjectIdentityResolver["resolveSessionDefaults"]
        >().mockReturnValue({
          sessionId: "left-session",
          sessionLabel: "leftDev",
          cwd: workspaceDir,
          sessionIdDerived: false,
          sessionLabelDerived: false,
        }),
      } as unknown as ProjectIdentityResolver,
      {
        sendPartnerNote: vi.fn(),
      } as unknown as CollaborationService,
    );

    await expect(
      service.send({
        session_id: "left-session",
        target_session_id: "right-session",
        file_path: "../outside.txt",
      }),
    ).rejects.toThrow("File path is outside the workspace directory.");
  });
});
