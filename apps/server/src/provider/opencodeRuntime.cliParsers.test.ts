import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { toOpenCodeFileParts } from "./opencodeRuntime.ts";

describe("toOpenCodeFileParts", () => {
  const attachment = (mimeType: string, sizeBytes = 12) => ({
    type: "file" as const,
    id: "thread-1-00000000-0000-4000-8000-000000000001-bin",
    name: "attachment",
    mimeType,
    sizeBytes,
  });

  it("sends supported images, text, and PDFs as v2 file URIs", () => {
    const parts = toOpenCodeFileParts({
      attachments: [
        attachment("application/pdf"),
        attachment("text/markdown"),
        attachment("image/png"),
        attachment("application/zip"),
        attachment("application/octet-stream"),
        attachment("image/bmp"),
        attachment("image/svg+xml"),
        attachment("application/pdf", 21 * 1024 * 1024),
      ],
      resolveAttachmentPath: () => "/tmp/attachment",
    });

    NodeAssert.deepEqual(parts, [
      { uri: "file:///tmp/attachment", name: "attachment" },
      { uri: "file:///tmp/attachment", name: "attachment" },
      { uri: "file:///tmp/attachment", name: "attachment" },
    ]);
  });

  it("keeps folded clipboard text on the lazy path fallback", () => {
    const parts = toOpenCodeFileParts({
      attachments: [
        {
          ...attachment("text/plain"),
          source: { _tag: "pasted-text" as const },
        },
      ],
      resolveAttachmentPath: () => "/tmp/pasted-text.txt",
    });

    NodeAssert.deepEqual(parts, []);
  });
});
