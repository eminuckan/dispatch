// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  attachmentFileExtension,
  copyLeasedPendingAttachmentsForThread,
  createAttachmentId,
  createPendingAttachmentId,
  parseAttachmentIdFromRelativePath,
  parseAttachmentUuid,
  parseAttachmentFileExtension,
  planAttachmentClaim,
  parseThreadSegmentFromAttachmentId,
  releasePendingAttachmentLease,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  retainPendingAttachmentLease,
  sweepStalePendingAttachments,
} from "./attachmentStore.ts";

describe("attachmentStore", () => {
  it("sanitizes thread ids when creating attachment ids", () => {
    const attachmentId = createAttachmentId("thread.folder/unsafe space");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }

    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    expect(threadSegment).toBeTruthy();
    expect(threadSegment).toMatch(/^[a-z0-9_-]+$/i);
    expect(threadSegment).not.toContain(".");
    expect(threadSegment).not.toContain("%");
    expect(threadSegment).not.toContain("/");
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("normalizes created thread segments to lowercase", () => {
    const attachmentId = createAttachmentId("Thread.Foo");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }
    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("thread-foo");
  });

  it("reserves the pending attachment segment", () => {
    const pendingId = createPendingAttachmentId();
    expect(parseThreadSegmentFromAttachmentId(pendingId)).toBe("pending");
    expect(parseAttachmentUuid(pendingId)).toMatch(/^[a-f0-9-]{36}$/);
    expect(parseThreadSegmentFromAttachmentId(createAttachmentId("pending")!)).toBe("_pending");
    expect(parseThreadSegmentFromAttachmentId(createAttachmentId("pending_thread")!)).toBe(
      "pending_thread",
    );
  });

  it("preserves safe file extensions in attachment ids and paths", () => {
    const attachmentId = createPendingAttachmentId(".PDF");

    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("pending");
    expect(parseAttachmentUuid(attachmentId)).toMatch(/^[a-f0-9-]{36}$/);
    expect(parseAttachmentFileExtension(attachmentId)).toBe("pdf");
    expect(attachmentFileExtension("report.PDF")).toBe(".pdf");
    expect(attachmentFileExtension("report")).toBe(".bin");
    expect(attachmentFileExtension("report.extensiontoolong")).toBe(".bin");
    // ".part" is the in-flight upload suffix; storing it would make the file
    // look like a stale partial to the sweep.
    expect(attachmentFileExtension("archive.part")).toBe(".bin");
    expect(createAttachmentId("x".repeat(80), ".abcdefghij")?.length).toBeLessThanOrEqual(128);
  });

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachmentId = "thread-1-attachment";
      const pngPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });
      expect(resolved).toBe(pngPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("returns null when no attachment file exists for the id", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: "thread-1-missing",
      });
      expect(resolved).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("resolves generic attachments without scanning the attachment directory", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-file-attachment-"),
    );
    try {
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001-zip";
      const archivePath = NodePath.join(attachmentsDir, `${attachmentId}.zip`);
      NodeFS.writeFileSync(archivePath, Buffer.from("archive"));

      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId })).toBe(archivePath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("plans pending attachment claims with direct filename lookups", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-claim-"),
    );
    try {
      const uuid = "00000000-0000-4000-8000-000000000001";
      const pendingPath = NodePath.join(attachmentsDir, `pending-${uuid}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));

      const claim = planAttachmentClaim({
        attachmentsDir,
        threadId: "thread-1",
        attachmentId: `pending-${uuid}`,
      });
      expect(claim).toMatchObject({
        ok: true,
        currentPath: pendingPath,
      });
      if (!claim.ok) {
        return;
      }
      expect(parseThreadSegmentFromAttachmentId(claim.finalId)).toBe("thread-1");
      expect(parseAttachmentUuid(claim.finalId)).not.toBe(uuid);
      expect(claim.finalPath).toBe(NodePath.join(attachmentsDir, `${claim.finalId}.png`));
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects thread-owned attachments even when thread segments collide", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-ownership-"),
    );
    try {
      const attachmentId = "a-b-00000000-0000-4000-8000-000000000003";
      NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachmentId}.png`), "pixels");

      expect(planAttachmentClaim({ attachmentsDir, threadId: "a b", attachmentId })).toEqual({
        ok: false,
        reason: "attachment must be a pending upload",
      });
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("removes expired pending and partial files without touching thread attachments", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-sweep-"),
    );
    try {
      const now = 1_800_000_000_000;
      const oldTimeSeconds = (now - 2 * 24 * 60 * 60 * 1000) / 1000;
      const uuid = "00000000-0000-4000-8000-000000000002";
      const pendingPath = NodePath.join(attachmentsDir, `pending-${uuid}.png`);
      const pendingFilePath = NodePath.join(attachmentsDir, `pending-${uuid}-pdf.pdf`);
      const threadPath = NodePath.join(attachmentsDir, `thread-1-${uuid}.png`);
      const partialPath = NodePath.join(attachmentsDir, `${uuid}.part`);
      for (const filePath of [pendingPath, pendingFilePath, threadPath, partialPath]) {
        NodeFS.writeFileSync(filePath, Buffer.from("pixels"));
        NodeFS.utimesSync(filePath, oldTimeSeconds, oldTimeSeconds);
      }

      expect(sweepStalePendingAttachments({ attachmentsDir, nowMs: now })).toEqual({ deleted: 3 });
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(pendingFilePath)).toBe(false);
      expect(NodeFS.existsSync(partialPath)).toBe(false);
      expect(NodeFS.existsSync(threadPath)).toBe(true);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("keeps an expired pending source while a durable team lease exists", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "dispatch-attachment-team-lease-"),
    );
    try {
      const now = 1_800_000_000_000;
      const oldTimeSeconds = (now - 2 * 24 * 60 * 60 * 1000) / 1000;
      const attachmentId = "pending-00000000-0000-4000-8000-000000000010";
      const pendingPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));

      expect(
        retainPendingAttachmentLease({
          attachmentsDir,
          attachmentId,
          ownerId: "team-run",
          nowMs: now,
        }),
      ).toBe(true);
      NodeFS.utimesSync(pendingPath, oldTimeSeconds, oldTimeSeconds);

      const marker = NodeFS.readdirSync(attachmentsDir).find((entry) =>
        entry.includes(".team-lease.json"),
      );
      expect(marker).toBeTruthy();
      expect(marker ? parseAttachmentIdFromRelativePath(marker) : null).toBeNull();
      expect(NodeFS.readdirSync(attachmentsDir).some((entry) => entry.endsWith(".part"))).toBe(
        false,
      );
      expect(sweepStalePendingAttachments({ attachmentsDir, nowMs: now })).toEqual({ deleted: 0 });
      expect(NodeFS.existsSync(pendingPath)).toBe(true);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["corrupt", "{not-json"],
    ["empty-owner", JSON.stringify({ version: 1, owners: [] })],
  ])("does not let a %s lease marker shield an expired pending source", (_kind, markerBody) => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "dispatch-attachment-invalid-lease-"),
    );
    try {
      const now = 1_800_000_000_000;
      const oldTimeSeconds = (now - 2 * 24 * 60 * 60 * 1000) / 1000;
      const attachmentId = "pending-00000000-0000-4000-8000-000000000013";
      const pendingPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      const leasePath = NodePath.join(attachmentsDir, `${attachmentId}.team-lease.json`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));
      NodeFS.utimesSync(pendingPath, oldTimeSeconds, oldTimeSeconds);
      NodeFS.writeFileSync(leasePath, markerBody);

      expect(sweepStalePendingAttachments({ attachmentsDir, nowMs: now })).toEqual({ deleted: 1 });
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(leasePath)).toBe(false);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("deletes a leased pending source only when its final proven owner releases it", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "dispatch-attachment-team-owners-"),
    );
    try {
      const attachmentId = "pending-00000000-0000-4000-8000-000000000011";
      const pendingPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));
      expect(
        retainPendingAttachmentLease({
          attachmentsDir,
          attachmentId,
          ownerId: "team-a",
          nowMs: 1_800_000_000_000,
        }),
      ).toBe(true);
      expect(
        retainPendingAttachmentLease({
          attachmentsDir,
          attachmentId,
          ownerId: "team-b",
          nowMs: 1_800_000_000_000,
        }),
      ).toBe(true);

      expect(
        releasePendingAttachmentLease({ attachmentsDir, attachmentId, ownerId: "unknown" }),
      ).toEqual({ released: false, deleted: false });
      expect(NodeFS.existsSync(pendingPath)).toBe(true);
      expect(
        releasePendingAttachmentLease({ attachmentsDir, attachmentId, ownerId: "team-a" }),
      ).toEqual({ released: true, deleted: false });
      expect(NodeFS.existsSync(pendingPath)).toBe(true);
      expect(
        releasePendingAttachmentLease({ attachmentsDir, attachmentId, ownerId: "team-b" }),
      ).toEqual({ released: true, deleted: true });
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(
        releasePendingAttachmentLease({ attachmentsDir, attachmentId, ownerId: "team-b" }),
      ).toEqual({ released: false, deleted: false });
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("materializes isolated thread copies from the immutable leased source", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "dispatch-attachment-team-copy-"),
    );
    try {
      const attachmentId = "pending-00000000-0000-4000-8000-000000000012";
      const pendingPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("original"));
      expect(
        retainPendingAttachmentLease({
          attachmentsDir,
          attachmentId,
          ownerId: "team-run",
          nowMs: 1_800_000_000_000,
        }),
      ).toBe(true);
      const source = {
        type: "image" as const,
        id: attachmentId,
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: Buffer.byteLength("original"),
      };

      const lead = copyLeasedPendingAttachmentsForThread({
        attachmentsDir,
        attachments: [source],
        ownerId: "team-run",
        threadId: "team-lead",
      });
      expect(lead).not.toBeNull();
      const leadAttachment = lead?.[0];
      expect(leadAttachment?.id).not.toBe(attachmentId);
      expect(leadAttachment ? parseThreadSegmentFromAttachmentId(leadAttachment.id) : null).toBe(
        "team-lead",
      );
      const leadPath = leadAttachment
        ? resolveAttachmentPath({ attachmentsDir, attachment: leadAttachment })
        : null;
      if (!leadPath) throw new Error("Expected lead attachment path");
      NodeFS.writeFileSync(leadPath, Buffer.from("lead changed this"));

      const worker = copyLeasedPendingAttachmentsForThread({
        attachmentsDir,
        attachments: [source],
        ownerId: "team-run",
        threadId: "team-worker",
      });
      const workerAttachment = worker?.[0];
      expect(workerAttachment?.id).not.toBe(leadAttachment?.id);
      expect(
        workerAttachment ? parseThreadSegmentFromAttachmentId(workerAttachment.id) : null,
      ).toBe("team-worker");
      const workerPath = workerAttachment
        ? resolveAttachmentPath({ attachmentsDir, attachment: workerAttachment })
        : null;
      if (!workerPath) throw new Error("Expected worker attachment path");
      expect(NodeFS.readFileSync(workerPath, "utf8")).toBe("original");
      expect(NodeFS.readFileSync(pendingPath, "utf8")).toBe("original");

      expect(
        copyLeasedPendingAttachmentsForThread({
          attachmentsDir,
          attachments: [source],
          ownerId: "not-an-owner",
          threadId: "team-other",
        }),
      ).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
