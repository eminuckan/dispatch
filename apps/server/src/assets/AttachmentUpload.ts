import * as NodeCrypto from "node:crypto";

import {
  ATTACHMENT_UPLOAD_URL_TTL_MS,
  type AttachmentCreateUploadUrlInput,
  AttachmentUploadSigningKeyError,
  type ChatAttachment,
} from "@dispatch/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import {
  attachmentFileExtension,
  copyLeasedPendingAttachmentsForThread,
  createPendingAttachmentId,
  deleteThreadAttachmentCopies,
  hasPendingAttachmentLease,
  parseThreadSegmentFromAttachmentId,
  pendingAttachmentLeaseHasOwner,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  releasePendingAttachmentLease,
  resolveAttachmentPathById,
  retainPendingAttachmentLease,
  sweepStalePendingAttachments,
} from "../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { inferImageExtension } from "../imageMime.ts";

export const ATTACHMENT_UPLOAD_ROUTE_PREFIX = "/api/attachments/upload";

// Asset download tokens share this key, but their signed claim kind is different.
const SIGNING_SECRET_NAME = "asset-access-signing-key";
const PENDING_ATTACHMENT_SWEEP_INTERVAL_MS = 15 * 60_000;
const lastPendingSweepByDirectory = new Map<string, number>();

export const retainPendingAttachmentsForOwner = Effect.fn("AttachmentUpload.retainPendingForOwner")(
  function* (input: {
    readonly ownerId: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) {
    if (input.attachments.length === 0) return true;
    const config = yield* ServerConfig.ServerConfig;
    const nowMs = yield* Clock.currentTimeMillis;
    const retained: string[] = [];
    for (const attachment of input.attachments) {
      const alreadyOwned = pendingAttachmentLeaseHasOwner({
        attachmentsDir: config.attachmentsDir,
        attachmentId: attachment.id,
        ownerId: input.ownerId,
      });
      if (
        parseThreadSegmentFromAttachmentId(attachment.id) !== PENDING_ATTACHMENT_THREAD_SEGMENT ||
        !retainPendingAttachmentLease({
          attachmentsDir: config.attachmentsDir,
          attachmentId: attachment.id,
          ownerId: input.ownerId,
          nowMs,
        })
      ) {
        for (const attachmentId of retained) {
          releasePendingAttachmentLease({
            attachmentsDir: config.attachmentsDir,
            attachmentId,
            ownerId: input.ownerId,
            deleteSourceWhenUnowned: false,
          });
        }
        return false;
      }
      if (!alreadyOwned) retained.push(attachment.id);
    }
    return true;
  },
);

export const releasePendingAttachmentsForOwner = Effect.fn(
  "AttachmentUpload.releasePendingForOwner",
)(function* (input: {
  readonly ownerId: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}) {
  if (input.attachments.length === 0) return;
  const config = yield* ServerConfig.ServerConfig;
  for (const attachment of input.attachments) {
    releasePendingAttachmentLease({
      attachmentsDir: config.attachmentsDir,
      attachmentId: attachment.id,
      ownerId: input.ownerId,
    });
  }
});

export const materializePendingAttachmentsForThread = Effect.fn(
  "AttachmentUpload.materializePendingForThread",
)(function* (input: {
  readonly ownerId: string;
  readonly threadId: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}) {
  if (input.attachments.length === 0) return [] as ReadonlyArray<ChatAttachment>;
  const config = yield* ServerConfig.ServerConfig;
  return copyLeasedPendingAttachmentsForThread({
    attachmentsDir: config.attachmentsDir,
    attachments: input.attachments,
    ownerId: input.ownerId,
    threadId: input.threadId,
  });
});

export const deleteMaterializedThreadAttachments = Effect.fn(
  "AttachmentUpload.deleteMaterializedThreadAttachments",
)(function* (attachments: ReadonlyArray<ChatAttachment>) {
  if (attachments.length === 0) return;
  const config = yield* ServerConfig.ServerConfig;
  deleteThreadAttachmentCopies({ attachmentsDir: config.attachmentsDir, attachments });
});

const AttachmentUploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("attachment-upload"),
  type: Schema.Literals(["image", "file"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("image" as const)),
  ),
  attachmentId: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
export type AttachmentUploadClaims = typeof AttachmentUploadClaims.Type;

const attachmentUploadClaimsJson = Schema.fromJsonString(AttachmentUploadClaims);
const decodeAttachmentUploadClaims = Schema.decodeUnknownOption(attachmentUploadClaimsJson);
const encodeAttachmentUploadClaims = Schema.encodeSync(attachmentUploadClaimsJson);

function decodeClaims(encodedPayload: string): AttachmentUploadClaims | null {
  try {
    return Option.getOrNull(decodeAttachmentUploadClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

const loadSigningSecret = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  return yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

export const issueAttachmentUploadUrl = Effect.fn("AttachmentUpload.issueUrl")(function* (
  input: AttachmentCreateUploadUrlInput,
) {
  const secret = yield* loadSigningSecret.pipe(
    Effect.mapError((cause) => new AttachmentUploadSigningKeyError({ cause })),
  );
  const config = yield* ServerConfig.ServerConfig;
  const nowMs = yield* Clock.currentTimeMillis;
  const previousSweep = lastPendingSweepByDirectory.get(config.attachmentsDir);
  if (
    previousSweep === undefined ||
    nowMs - previousSweep >= PENDING_ATTACHMENT_SWEEP_INTERVAL_MS
  ) {
    lastPendingSweepByDirectory.set(config.attachmentsDir, nowMs);
    const swept = sweepStalePendingAttachments({
      attachmentsDir: config.attachmentsDir,
      nowMs,
    });
    if (swept.deleted > 0) {
      yield* Effect.logInfo("Removed expired attachment uploads.", { deleted: swept.deleted });
    }
  }

  const attachmentType = input.type ?? "image";
  const attachmentId = createPendingAttachmentId(
    attachmentType === "file" ? attachmentFileExtension(input.name) : undefined,
  );
  const expiresAt = nowMs + ATTACHMENT_UPLOAD_URL_TTL_MS;
  const encodedPayload = base64UrlEncode(
    encodeAttachmentUploadClaims({
      version: 1,
      kind: "attachment-upload",
      type: attachmentType,
      attachmentId,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      expiresAt,
    }),
  );

  return {
    attachmentId,
    relativeUrl: `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/${encodedPayload}.${signPayload(encodedPayload, secret)}`,
    expiresAt,
  };
});

export const validateAttachmentUploadToken = Effect.fn("AttachmentUpload.validateToken")(function* (
  token: string,
) {
  const [encodedPayload, signature, unexpectedSegment] = token.split(".");
  if (!encodedPayload || !signature || unexpectedSegment) {
    return null;
  }

  const secret = yield* loadSigningSecret.pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to load the attachment upload signing key.", { cause }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (!secret || !timingSafeEqualBase64Url(signature, signPayload(encodedPayload, secret))) {
    return null;
  }

  const claims = decodeClaims(encodedPayload);
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) {
    return null;
  }
  return claims;
});

export type StoreAttachmentUploadResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly detail: string };

export const storeAttachmentUpload = Effect.fn("AttachmentUpload.store")(function* (
  claims: AttachmentUploadClaims,
  body: Uint8Array | HttpServerRequest.HttpServerRequest["stream"],
) {
  if (body instanceof Uint8Array && body.byteLength !== claims.sizeBytes) {
    return {
      ok: false,
      status: 400,
      detail: `Body was ${body.byteLength} bytes, expected ${claims.sizeBytes}.`,
    } satisfies StoreAttachmentUploadResult;
  }

  const config = yield* ServerConfig.ServerConfig;
  const extension =
    claims.type === "file"
      ? attachmentFileExtension(claims.name)
      : inferImageExtension({ mimeType: claims.mimeType, fileName: claims.name });
  const relativePath = `${claims.attachmentId}${extension}`;
  const finalPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath,
  });
  const partPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${relativePath}.${NodeCrypto.randomUUID()}.part`,
  });
  if (!finalPath || !partPath) {
    return { ok: false, status: 500, detail: "Failed to resolve attachment path." };
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let receivedBytes = 0;
  const bodyStream = body instanceof Uint8Array ? Stream.make(body) : body;
  return yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(path.dirname(finalPath), { recursive: true });
    yield* Stream.run(
      bodyStream.pipe(
        Stream.takeWhile((chunk) => {
          receivedBytes += chunk.byteLength;
          return receivedBytes <= claims.sizeBytes;
        }),
      ),
      fileSystem.sink(partPath),
    );
    if (receivedBytes !== claims.sizeBytes) {
      return {
        ok: false,
        status: 400,
        detail: `Body was ${receivedBytes} bytes, expected ${claims.sizeBytes}.`,
      } satisfies StoreAttachmentUploadResult;
    }
    yield* fileSystem.rename(partPath, finalPath);
    return { ok: true } satisfies StoreAttachmentUploadResult;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("Failed to persist attachment upload.", {
        attachmentId: claims.attachmentId,
        cause,
      }).pipe(
        Effect.as({
          ok: false,
          status: 500,
          detail: "Failed to persist upload.",
        } satisfies StoreAttachmentUploadResult),
      ),
    ),
    Effect.ensuring(
      fileSystem.remove(partPath, { force: true }).pipe(Effect.orElseSucceed(() => undefined)),
    ),
  );
});

export const deletePendingAttachment = Effect.fn("AttachmentUpload.deletePending")(function* (
  attachmentId: string,
) {
  if (parseThreadSegmentFromAttachmentId(attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT) {
    return;
  }

  const config = yield* ServerConfig.ServerConfig;
  if (
    hasPendingAttachmentLease({
      attachmentsDir: config.attachmentsDir,
      attachmentId,
    })
  ) {
    return;
  }
  const attachmentPath = resolveAttachmentPathById({
    attachmentsDir: config.attachmentsDir,
    attachmentId,
  });
  if (!attachmentPath) {
    return;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.remove(attachmentPath, { force: true }).pipe(Effect.orElseSucceed(() => {}));
});
