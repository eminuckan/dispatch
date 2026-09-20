// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ChatAttachment } from "@dispatch/contracts";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { inferImageExtension, SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";

const ATTACHMENT_FILENAME_EXTENSIONS = [...SAFE_IMAGE_FILE_EXTENSIONS, ".bin"];
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_ID_FILE_EXTENSION_PATTERN = "[a-z0-9]{1,10}";
const PENDING_ATTACHMENT_LEASE_SUFFIX = ".team-lease.json";
const PENDING_ATTACHMENT_LEASE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})(?:-(${ATTACHMENT_ID_FILE_EXTENSION_PATTERN}))?$`,
  "i",
);

export const PENDING_ATTACHMENT_THREAD_SEGMENT = "pending";
const PENDING_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PARTIAL_UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  return segment === PENDING_ATTACHMENT_THREAD_SEGMENT ? "_pending" : segment;
}

export function attachmentFileExtension(fileName: string): string {
  const extension = NodePath.extname(fileName).toLowerCase();
  // ".part" is reserved for in-flight uploads; a stored "archive.part" would
  // look stale to sweepStalePendingAttachments and get deleted.
  if (extension === ".part" || !/^\.[a-z0-9]{1,10}$/.test(extension)) {
    return ".bin";
  }
  return extension;
}

function attachmentIdExtensionSuffix(extension: string | undefined): string {
  if (!extension) {
    return "";
  }
  const normalized = extension.replace(/^\./, "").toLowerCase();
  return new RegExp(`^${ATTACHMENT_ID_FILE_EXTENSION_PATTERN}$`).test(normalized)
    ? `-${normalized}`
    : "-bin";
}

export function createPendingAttachmentId(extension?: string): string {
  return `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${NodeCrypto.randomUUID()}${attachmentIdExtensionSuffix(extension)}`;
}

export function parseAttachmentUuid(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  return normalizedId.match(ATTACHMENT_ID_PATTERN)?.[2]?.toLowerCase() ?? null;
}

export function parseAttachmentFileExtension(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  return normalizedId.match(ATTACHMENT_ID_PATTERN)?.[3]?.toLowerCase() ?? null;
}

export function createAttachmentId(threadId: string, extension?: string): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${NodeCrypto.randomUUID()}${attachmentIdExtensionSuffix(extension)}`;
}

export function parseThreadSegmentFromAttachmentId(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const match = normalizedId.match(ATTACHMENT_ID_PATTERN);
  if (!match) {
    return null;
  }
  return match[1]?.toLowerCase() ?? null;
}

/** Null for attachment types this build does not know; callers skip those. */
export function attachmentRelativePath(attachment: ChatAttachment): string | null {
  switch (attachment.type) {
    case "image": {
      const extension = inferImageExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
    case "file":
      return `${attachment.id}${attachmentFileExtension(attachment.name)}`;
    default:
      return null;
  }
}

export function resolveAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
}): string | null {
  const relativePath = attachmentRelativePath(input.attachment);
  if (!relativePath) {
    return null;
  }
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath,
  });
}

export function resolveAttachmentPathById(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
}): string | null {
  const normalizedId = normalizeAttachmentRelativePath(input.attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const fileExtension = parseAttachmentFileExtension(normalizedId);
  if (fileExtension) {
    const filePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}.${fileExtension.toLowerCase()}`,
    });
    return filePath && NodeFS.existsSync(filePath) ? filePath : null;
  }
  for (const extension of ATTACHMENT_FILENAME_EXTENSIONS) {
    const maybePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}${extension}`,
    });
    if (maybePath && NodeFS.existsSync(maybePath)) {
      return maybePath;
    }
  }
  return null;
}

type PendingAttachmentLease = {
  readonly version: 1;
  readonly owners: ReadonlyArray<string>;
};

type PendingAttachmentLeaseRead =
  | { readonly state: "missing" }
  | { readonly state: "invalid" }
  | { readonly state: "valid"; readonly owners: Set<string> };

function pendingAttachmentLeasePath(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
}): string | null {
  if (
    parseThreadSegmentFromAttachmentId(input.attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT
  ) {
    return null;
  }
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: `${input.attachmentId}${PENDING_ATTACHMENT_LEASE_SUFFIX}`,
  });
}

function readPendingAttachmentLease(leasePath: string): PendingAttachmentLeaseRead {
  if (!NodeFS.existsSync(leasePath)) {
    return { state: "missing" };
  }
  try {
    const value = JSON.parse(
      NodeFS.readFileSync(leasePath, "utf8"),
    ) as Partial<PendingAttachmentLease>;
    if (
      value.version !== 1 ||
      !Array.isArray(value.owners) ||
      value.owners.length === 0 ||
      value.owners.some((owner) => typeof owner !== "string" || owner.trim().length === 0)
    ) {
      return { state: "invalid" };
    }
    return { state: "valid", owners: new Set(value.owners) };
  } catch {
    return { state: "invalid" };
  }
}

export function pendingAttachmentLeaseHasOwner(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
  readonly ownerId: string;
}): boolean {
  const leasePath = pendingAttachmentLeasePath(input);
  if (!leasePath) return false;
  const lease = readPendingAttachmentLease(leasePath);
  return lease.state === "valid" && lease.owners.has(input.ownerId);
}

function writePendingAttachmentLease(leasePath: string, owners: ReadonlySet<string>): boolean {
  const temporaryPath = `${leasePath}.${NodeCrypto.randomUUID()}.part`;
  try {
    NodeFS.writeFileSync(
      temporaryPath,
      JSON.stringify({ version: 1, owners: [...owners].sort() } satisfies PendingAttachmentLease),
      { flag: "wx" },
    );
    NodeFS.renameSync(temporaryPath, leasePath);
    return true;
  } catch {
    return false;
  } finally {
    try {
      NodeFS.rmSync(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup. Stale partials are also covered by the normal sweep.
    }
  }
}

export function retainPendingAttachmentLease(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
  readonly ownerId: string;
  readonly nowMs: number;
}): boolean {
  const ownerId = input.ownerId.trim();
  if (!ownerId) return false;
  const attachmentPath = resolveAttachmentPathById(input);
  const leasePath = pendingAttachmentLeasePath(input);
  if (!attachmentPath || !leasePath) return false;

  const lease = readPendingAttachmentLease(leasePath);
  if (lease.state === "invalid") return false;
  const owners = lease.state === "valid" ? lease.owners : new Set<string>();
  owners.add(ownerId);
  if (!writePendingAttachmentLease(leasePath, owners)) return false;

  try {
    const stat = NodeFS.statSync(attachmentPath);
    if (input.nowMs - stat.mtimeMs >= PENDING_ATTACHMENT_LEASE_REFRESH_INTERVAL_MS) {
      const nowSeconds = input.nowMs / 1000;
      NodeFS.utimesSync(attachmentPath, nowSeconds, nowSeconds);
    }
  } catch {
    releasePendingAttachmentLease({
      attachmentsDir: input.attachmentsDir,
      attachmentId: input.attachmentId,
      ownerId,
      deleteSourceWhenUnowned: false,
    });
    return false;
  }
  return true;
}

export function releasePendingAttachmentLease(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
  readonly ownerId: string;
  readonly deleteSourceWhenUnowned?: boolean;
}): { readonly released: boolean; readonly deleted: boolean } {
  const leasePath = pendingAttachmentLeasePath(input);
  if (!leasePath) return { released: false, deleted: false };
  const lease = readPendingAttachmentLease(leasePath);
  if (lease.state !== "valid" || !lease.owners.has(input.ownerId)) {
    return { released: false, deleted: false };
  }

  lease.owners.delete(input.ownerId);
  if (lease.owners.size > 0) {
    return writePendingAttachmentLease(leasePath, lease.owners)
      ? { released: true, deleted: false }
      : { released: false, deleted: false };
  }

  try {
    NodeFS.rmSync(leasePath, { force: true });
  } catch {
    return { released: false, deleted: false };
  }
  if (input.deleteSourceWhenUnowned === false) {
    return { released: true, deleted: false };
  }

  const attachmentPath = resolveAttachmentPathById(input);
  if (!attachmentPath) return { released: true, deleted: false };
  try {
    NodeFS.rmSync(attachmentPath, { force: true });
    return { released: true, deleted: true };
  } catch {
    return { released: true, deleted: false };
  }
}

export function copyLeasedPendingAttachmentsForThread(input: {
  readonly attachmentsDir: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly ownerId: string;
  readonly threadId: string;
}): ReadonlyArray<ChatAttachment> | null {
  const copied: ChatAttachment[] = [];
  const cleanup = () => {
    for (const attachment of copied) {
      const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
      if (!path) continue;
      try {
        NodeFS.rmSync(path, { force: true });
      } catch {
        // Thread-owned copies are best effort cleanup on a failed materialization.
      }
    }
  };

  for (const attachment of input.attachments) {
    const leasePath = pendingAttachmentLeasePath({
      attachmentsDir: input.attachmentsDir,
      attachmentId: attachment.id,
    });
    if (!leasePath) {
      cleanup();
      return null;
    }
    const lease = readPendingAttachmentLease(leasePath);
    if (lease.state !== "valid" || !lease.owners.has(input.ownerId)) {
      cleanup();
      return null;
    }
    const claim = planAttachmentClaim({
      attachmentsDir: input.attachmentsDir,
      threadId: input.threadId,
      attachmentId: attachment.id,
    });
    if (!claim.ok) {
      cleanup();
      return null;
    }
    const materialized = { ...attachment, id: claim.finalId };
    if (
      resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment: materialized }) !==
      claim.finalPath
    ) {
      cleanup();
      return null;
    }
    try {
      NodeFS.copyFileSync(claim.currentPath, claim.finalPath, NodeFS.constants.COPYFILE_EXCL);
    } catch {
      cleanup();
      return null;
    }
    copied.push(materialized);
  }
  return copied;
}

export function deleteThreadAttachmentCopies(input: {
  readonly attachmentsDir: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): void {
  for (const attachment of input.attachments) {
    if (parseThreadSegmentFromAttachmentId(attachment.id) === PENDING_ATTACHMENT_THREAD_SEGMENT) {
      continue;
    }
    const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
    if (!path) continue;
    try {
      NodeFS.rmSync(path, { force: true });
    } catch {
      // Best-effort rollback for a command reservation that did not persist.
    }
  }
}

export function hasPendingAttachmentLease(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
}): boolean {
  const leasePath = pendingAttachmentLeasePath(input);
  if (!leasePath) return false;
  const lease = readPendingAttachmentLease(leasePath);
  if (lease.state === "valid" && lease.owners.size > 0) return true;
  if (lease.state === "invalid") {
    try {
      NodeFS.rmSync(leasePath, { force: true });
    } catch {
      // Invalid markers do not protect pending uploads even when cleanup fails.
    }
  }
  return false;
}

export type AttachmentClaimPlan =
  | {
      readonly ok: true;
      readonly finalId: string;
      readonly currentPath: string;
      readonly finalPath: string;
    }
  | { readonly ok: false; readonly reason: string };

export function planAttachmentClaim(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly attachmentId: string;
}): AttachmentClaimPlan {
  const uuid = parseAttachmentUuid(input.attachmentId);
  const requestedSegment = parseThreadSegmentFromAttachmentId(input.attachmentId);
  if (!uuid || !requestedSegment) {
    return { ok: false, reason: "invalid attachment id" };
  }

  if (!toSafeThreadAttachmentSegment(input.threadId)) {
    return { ok: false, reason: "invalid thread id" };
  }
  if (requestedSegment !== PENDING_ATTACHMENT_THREAD_SEGMENT) {
    return { ok: false, reason: "attachment must be a pending upload" };
  }

  const currentPath = resolveAttachmentPathById({
    attachmentsDir: input.attachmentsDir,
    attachmentId: input.attachmentId,
  });
  if (!currentPath) {
    return { ok: false, reason: "attachment not found (removed or expired)" };
  }
  const fileExtension = parseAttachmentFileExtension(input.attachmentId) ?? undefined;
  const finalId = createAttachmentId(input.threadId, fileExtension);
  if (!finalId) {
    return { ok: false, reason: "failed to create attachment id" };
  }

  const expectedFinalPath = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: `${finalId}${NodePath.extname(currentPath)}`,
  });
  if (!expectedFinalPath) {
    return { ok: false, reason: "failed to resolve attachment path" };
  }
  return {
    ok: true,
    finalId,
    currentPath,
    finalPath: expectedFinalPath,
  };
}

export function sweepStalePendingAttachments(input: {
  readonly attachmentsDir: string;
  readonly nowMs: number;
}): { readonly deleted: number } {
  let entries: string[];
  try {
    entries = NodeFS.readdirSync(input.attachmentsDir);
  } catch {
    return { deleted: 0 };
  }

  let deleted = 0;
  for (const entry of entries) {
    const isPartial = entry.endsWith(".part");
    if (!isPartial) {
      const attachmentId = parseAttachmentIdFromRelativePath(entry);
      if (
        !attachmentId ||
        parseThreadSegmentFromAttachmentId(attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT
      ) {
        continue;
      }
      if (hasPendingAttachmentLease({ attachmentsDir: input.attachmentsDir, attachmentId })) {
        continue;
      }
    }

    const resolved = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: entry,
    });
    if (!resolved) {
      continue;
    }
    try {
      const maxAgeMs = isPartial ? PARTIAL_UPLOAD_MAX_AGE_MS : PENDING_ATTACHMENT_MAX_AGE_MS;
      if (input.nowMs - NodeFS.statSync(resolved).mtimeMs > maxAgeMs) {
        NodeFS.unlinkSync(resolved);
        deleted += 1;
      }
    } catch {
      continue;
    }
  }

  return { deleted };
}

export function parseAttachmentIdFromRelativePath(relativePath: string): string | null {
  const normalized = normalizeAttachmentRelativePath(relativePath);
  if (!normalized || normalized.includes("/")) {
    return null;
  }
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return null;
  }
  const id = normalized.slice(0, extensionIndex);
  return id.length > 0 && !id.includes(".") ? id : null;
}
