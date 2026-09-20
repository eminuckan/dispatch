import { describe, expect, it } from "vite-plus/test";

import {
  composerAttachmentFileReferenceKey,
  resolveOwnedComposerAttachmentFileUri,
} from "./composerAttachmentFiles";

const OLD_CONTAINER = "11111111-1111-4111-8111-111111111111";
const CURRENT_CONTAINER = "22222222-2222-4222-8222-222222222222";
const FILE_NAME = "33333333-3333-4333-8333-333333333333-report%20%252F%20%23.pdf";
const CANONICAL_DIRECTORY = "dispatch-composer-attachments";
const LEGACY_DIRECTORY = "t3-composer-attachments";

describe("owned attachment paths", () => {
  it.each([
    [CANONICAL_DIRECTORY, "file:///var/mobile/Containers/Data/Application/"],
    [LEGACY_DIRECTORY, "file:///var/mobile/Containers/Data/Application/"],
    [
      CANONICAL_DIRECTORY,
      "file:///Users/dev/Library/Developer/CoreSimulator/Devices/device/data/Containers/Data/Application/",
    ],
    [
      LEGACY_DIRECTORY,
      "file:///Users/dev/Library/Developer/CoreSimulator/Devices/device/data/Containers/Data/Application/",
    ],
  ])("resolves %s saved files after an iOS container move", (directory, prefix) => {
    const oldUri = `${prefix}${OLD_CONTAINER}/Documents/${directory}/${FILE_NAME}`;
    const documentUri = `${prefix}${CURRENT_CONTAINER}/Documents/`;
    const currentUri = `${documentUri}${directory}/${FILE_NAME}`;

    expect(resolveOwnedComposerAttachmentFileUri(oldUri, documentUri)).toBe(currentUri);
    expect(composerAttachmentFileReferenceKey(oldUri)).toBe(
      composerAttachmentFileReferenceKey(currentUri),
    );
  });

  it.each([CANONICAL_DIRECTORY, LEGACY_DIRECTORY])(
    "recognizes the private/var alias for %s without changing the stored filename",
    (directory) => {
      const oldUri = `file:///private/var/mobile/Containers/Data/Application/${OLD_CONTAINER}/Documents/${directory}/${FILE_NAME}`;
      const documentUri = `file:///var/mobile/Containers/Data/Application/${CURRENT_CONTAINER}/Documents/`;
      const currentUri = `${documentUri}${directory}/${FILE_NAME}`;

      expect(resolveOwnedComposerAttachmentFileUri(oldUri, documentUri)).toBe(currentUri);
      expect(composerAttachmentFileReferenceKey(oldUri)).toBe(
        composerAttachmentFileReferenceKey(currentUri),
      );
    },
  );

  it.each([
    `file:///private/var/mobile/Containers/Shared/FileProvider/other/Documents/${CANONICAL_DIRECTORY}/${FILE_NAME}`,
    `file:///var/mobile/Containers/Shared/AppGroup/other/t3-composer-attachments/${FILE_NAME}`,
    `file:///var/mobile/Containers/Data/Application/${OLD_CONTAINER}/Documents/report.pdf`,
    `file:///var/mobile/Containers/Data/Application/${OLD_CONTAINER}/Documents/${CANONICAL_DIRECTORY}/report.pdf`,
    `file:///downloads/${CANONICAL_DIRECTORY}/${FILE_NAME}`,
    `content://shared/${CANONICAL_DIRECTORY}/${FILE_NAME}`,
    `https://example.com/${CANONICAL_DIRECTORY}/${FILE_NAME}`,
    `file:///var/mobile/Containers/Data/Application/${OLD_CONTAINER}/Documents/${CANONICAL_DIRECTORY}/..%2F..%2Fsender.pdf`,
    `file:///var/mobile/Containers/Data/Application/${OLD_CONTAINER}/Documents/${LEGACY_DIRECTORY}/${FILE_NAME}%2Fnested.pdf`,
  ])("does not rebase an external or escaped path: %s", (uri) => {
    expect(
      resolveOwnedComposerAttachmentFileUri(
        uri,
        `file:///var/mobile/Containers/Data/Application/${CURRENT_CONTAINER}/Documents/`,
      ),
    ).toBeNull();
  });
});
