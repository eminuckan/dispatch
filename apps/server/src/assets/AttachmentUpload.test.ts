// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlEncode, signPayload } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import {
  parseThreadSegmentFromAttachmentId,
  pendingAttachmentLeaseHasOwner,
  releasePendingAttachmentLease,
} from "../attachmentStore.ts";
import {
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  deletePendingAttachment,
  issueAttachmentUploadUrl,
  materializePendingAttachmentsForThread,
  releasePendingAttachmentsForOwner,
  retainPendingAttachmentsForOwner,
  storeAttachmentUpload,
  validateAttachmentUploadToken,
} from "./AttachmentUpload.ts";

const testLayer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-upload-" })),
  Layer.provideMerge(NodeServices.layer),
);

const uploadInput = {
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 6,
} as const;

const LegacyAttachmentUploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("attachment-upload"),
  attachmentId: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
const encodeLegacyAttachmentUploadClaims = Schema.encodeEffect(
  Schema.fromJsonString(LegacyAttachmentUploadClaims),
);

describe("AttachmentUpload", () => {
  it.effect("leases pending uploads and materializes isolated copies for managed threads", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const attachmentId = "pending-00000000-0000-4000-8000-0000000000aa";
      const pendingPath = NodePath.join(config.attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("original"));
      const attachment = {
        type: "image" as const,
        id: attachmentId,
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: Buffer.byteLength("original"),
      };

      expect(
        yield* retainPendingAttachmentsForOwner({
          ownerId: "team-run",
          attachments: [attachment],
        }),
      ).toBe(true);
      const lead = yield* materializePendingAttachmentsForThread({
        ownerId: "team-run",
        threadId: "team-lead",
        attachments: [attachment],
      });
      const worker = yield* materializePendingAttachmentsForThread({
        ownerId: "team-run",
        threadId: "team-worker",
        attachments: [attachment],
      });
      expect(lead?.[0]?.id).not.toBe(worker?.[0]?.id);
      expect(parseThreadSegmentFromAttachmentId(lead?.[0]?.id ?? "")).toBe("team-lead");
      expect(parseThreadSegmentFromAttachmentId(worker?.[0]?.id ?? "")).toBe("team-worker");
      expect(NodeFS.readFileSync(pendingPath, "utf8")).toBe("original");

      yield* releasePendingAttachmentsForOwner({
        ownerId: "team-run",
        attachments: [attachment],
      });
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not roll back a pre-existing lease when a later refresh is incomplete", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const first = {
        type: "image" as const,
        id: "pending-00000000-0000-4000-8000-0000000000ab",
        name: "first.png",
        mimeType: "image/png",
        sizeBytes: 5,
      };
      const second = {
        ...first,
        id: "pending-00000000-0000-4000-8000-0000000000ac",
        name: "second.png",
      };
      for (const attachment of [first, second]) {
        NodeFS.writeFileSync(
          NodePath.join(config.attachmentsDir, `${attachment.id}.png`),
          Buffer.from("bytes"),
        );
      }
      expect(
        yield* retainPendingAttachmentsForOwner({
          ownerId: "team-run",
          attachments: [first, second],
        }),
      ).toBe(true);

      NodeFS.rmSync(NodePath.join(config.attachmentsDir, `${second.id}.png`));
      expect(
        yield* retainPendingAttachmentsForOwner({
          ownerId: "team-run",
          attachments: [first, second],
        }),
      ).toBe(false);
      expect(
        pendingAttachmentLeaseHasOwner({
          attachmentsDir: config.attachmentsDir,
          attachmentId: first.id,
          ownerId: "team-run",
        }),
      ).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "protects a leased pending upload from explicit deletion until its owner releases",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const attachment = {
          type: "image" as const,
          id: "pending-00000000-0000-4000-8000-0000000000ad",
          name: "leased.png",
          mimeType: "image/png",
          sizeBytes: 6,
        };
        const pendingPath = NodePath.join(config.attachmentsDir, `${attachment.id}.png`);
        NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));
        expect(
          yield* retainPendingAttachmentsForOwner({
            ownerId: "team-run",
            attachments: [attachment],
          }),
        ).toBe(true);

        yield* deletePendingAttachment(attachment.id);
        expect(NodeFS.existsSync(pendingPath)).toBe(true);

        expect(
          releasePendingAttachmentLease({
            attachmentsDir: config.attachmentsDir,
            attachmentId: attachment.id,
            ownerId: "team-run",
            deleteSourceWhenUnowned: false,
          }),
        ).toEqual({ released: true, deleted: false });
        expect(NodeFS.existsSync(pendingPath)).toBe(true);

        yield* deletePendingAttachment(attachment.id);
        expect(NodeFS.existsSync(pendingPath)).toBe(false);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("signs the attachment metadata and validates the upload token", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      expect(parseThreadSegmentFromAttachmentId(issued.attachmentId)).toBe("pending");

      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      expect(yield* validateAttachmentUploadToken(token)).toMatchObject({
        kind: "attachment-upload",
        attachmentId: issued.attachmentId,
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 6,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects tampered and malformed upload tokens", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const [payload, signature] = token.split(".");

      expect(yield* validateAttachmentUploadToken(`${payload}x.${signature}`)).toBeNull();
      expect(yield* validateAttachmentUploadToken(`${token}.extra`)).toBeNull();
      expect(yield* validateAttachmentUploadToken("garbage")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("accepts unexpired image upload tokens issued before file support", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const secret = yield* secretStore.getOrCreateRandom("asset-access-signing-key", 32);
      const encodedPayload = base64UrlEncode(
        yield* encodeLegacyAttachmentUploadClaims({
          version: 1,
          kind: "attachment-upload",
          attachmentId: issued.attachmentId,
          name: uploadInput.name,
          mimeType: uploadInput.mimeType,
          sizeBytes: uploadInput.sizeBytes,
          expiresAt: issued.expiresAt,
        }),
      );
      const legacyToken = `${encodedPayload}.${signPayload(encodedPayload, secret)}`;

      expect(yield* validateAttachmentUploadToken(legacyToken)).toMatchObject({
        type: "image",
        attachmentId: issued.attachmentId,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects expired upload tokens", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);

      yield* TestClock.adjust("11 minutes");
      expect(yield* validateAttachmentUploadToken(token)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes expired pending uploads while issuing a new upload URL", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const staleId = "pending-00000000-0000-4000-8000-0000000000cc";
      const stalePath = NodePath.join(config.attachmentsDir, `${staleId}.png`);
      NodeFS.writeFileSync(stalePath, Buffer.from("pixels"));
      NodeFS.utimesSync(stalePath, 0, 0);

      yield* TestClock.adjust("25 hours");
      yield* issueAttachmentUploadUrl(uploadInput);

      expect(NodeFS.existsSync(stalePath)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("stores the expected bytes without leaving temporary files", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      expect(yield* storeAttachmentUpload(claims, new Uint8Array([1, 2, 3]))).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(yield* storeAttachmentUpload(claims, new Uint8Array(6))).toEqual({ ok: true });
      expect(
        NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${issued.attachmentId}.png`)),
      ).toBe(true);
      expect(
        NodeFS.readdirSync(config.attachmentsDir).filter((entry) => entry.endsWith(".part")),
      ).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("streams generic files to a path with their original extension", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl({
        type: "file",
        name: "report.PDF",
        mimeType: "application/pdf",
        sizeBytes: 6,
      });
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      expect(
        yield* storeAttachmentUpload(
          claims,
          Stream.make(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
        ),
      ).toEqual({ ok: true });
      expect(issued.attachmentId).toMatch(/-pdf$/);
      expect(
        NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${issued.attachmentId}.pdf`)),
      ).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));

      yield* deletePendingAttachment(issued.attachmentId);
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes partial streamed uploads that exceed their signed size", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      expect(yield* storeAttachmentUpload(claims, Stream.make(new Uint8Array(7)))).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes partial streamed uploads when the upload is interrupted", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      const nextChunkRequested = yield* Deferred.make<void>();
      const body = Stream.make(new Uint8Array([1, 2, 3])).pipe(
        Stream.concat(
          Stream.fromEffect(
            Deferred.succeed(nextChunkRequested, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      );
      const upload = yield* storeAttachmentUpload(claims, body).pipe(Effect.forkScoped);

      yield* Deferred.await(nextChunkRequested);
      expect(
        NodeFS.readdirSync(config.attachmentsDir).filter((entry) => entry.endsWith(".part")),
      ).toHaveLength(1);

      yield* Fiber.interrupt(upload);
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("deletes pending uploads without deleting thread-owned copies", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const uuid = "00000000-0000-4000-8000-0000000000dd";
      const pendingPath = NodePath.join(config.attachmentsDir, `pending-${uuid}.png`);
      const claimedPath = NodePath.join(config.attachmentsDir, `thread-1-${uuid}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));
      NodeFS.writeFileSync(claimedPath, Buffer.from("pixels"));

      yield* deletePendingAttachment(`pending-${uuid}`);
      yield* deletePendingAttachment(`pending-${uuid}`);
      yield* deletePendingAttachment(`thread-1-${uuid}`);

      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(claimedPath)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});
