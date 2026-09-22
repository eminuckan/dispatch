import type { PreviewAnnotationPayload } from "@dispatch/contracts";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { previewAnnotationContextId } from "../../lib/composerContextRecords";

interface RetainedPreviewAnnotation {
  annotation: PreviewAnnotationPayload;
  image: ComposerImageAttachment | undefined;
}

export interface RetainedAttachmentContextPayloads {
  files: Map<string, ComposerFileAttachment>;
  previewAnnotations: Map<string, RetainedPreviewAnnotation>;
}

export function reconcileAttachmentContextReferences(input: {
  referencedContextIds: ReadonlySet<string>;
  files: ReadonlyArray<ComposerFileAttachment>;
  images: ReadonlyArray<ComposerImageAttachment>;
  previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  retained: RetainedAttachmentContextPayloads;
}): {
  filesToRemove: string[];
  filesToRestore: ComposerFileAttachment[];
  annotationIdsToRemove: string[];
  annotationsToRestore: RetainedPreviewAnnotation[];
} {
  // Files are owned by the attachment tray. Inline references are optional pointers to an
  // attached file, so deleting or undoing a reference must not remove or restore its payload.
  // Keep these compatibility fields until the composer call site drops the old reconciliation
  // branches.
  const filesToRemove: string[] = [];
  const filesToRestore: ComposerFileAttachment[] = [];

  const imagesById = new Map(input.images.map((image) => [image.id, image]));
  const liveAnnotationContextIds = new Set<string>(
    input.previewAnnotations.map((annotation) => previewAnnotationContextId(annotation.id)),
  );
  const annotationIdsToRemove: string[] = [];
  for (const annotation of input.previewAnnotations) {
    const contextId = previewAnnotationContextId(annotation.id);
    if (input.referencedContextIds.has(contextId)) continue;
    input.retained.previewAnnotations.set(contextId, {
      annotation,
      image: imagesById.get(annotation.id),
    });
    annotationIdsToRemove.push(annotation.id);
  }
  const annotationsToRestore = [...input.referencedContextIds].flatMap((contextId) => {
    if (liveAnnotationContextIds.has(contextId)) return [];
    const retained = input.retained.previewAnnotations.get(contextId);
    return retained ? [retained] : [];
  });

  return { filesToRemove, filesToRestore, annotationIdsToRemove, annotationsToRestore };
}
