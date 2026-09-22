import { useCallback, useId, useState, type ComponentProps, type CSSProperties } from "react";
import {
  ChevronDownIcon,
  FileIcon,
  PaperclipIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { svgMimeType } from "@dispatch/shared/image";

import {
  composerFileNeedsReattach,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import {
  formatAttachmentUploadProgress,
  type AttachmentUploadState,
} from "../../lib/attachmentUploadState";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { ComposerImageThumbnail } from "./ComposerImageThumbnail";
import { PierreEntryIcon } from "./PierreEntryIcon";

type Attachment = ComposerImageAttachment | ComposerFileAttachment;

function SvgThumbnail({ file, name }: { file: File; name: string }) {
  const attach = useCallback(
    (element: HTMLImageElement | null) => {
      if (!element) return;
      const url = URL.createObjectURL(file);
      element.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [file],
  );
  return <img ref={attach} alt={name} className="size-full object-contain" />;
}

/** Keep attachment presentation separate from the text sent alongside it. */
export function ComposerAttachmentTray({
  attachments,
  uploads,
  nonPersistedImageIds,
  theme,
  onPreview,
  onRemove,
  onRetry,
}: {
  attachments: readonly Attachment[];
  uploads: Readonly<Record<string, AttachmentUploadState>>;
  nonPersistedImageIds: ReadonlySet<string>;
  theme: ComponentProps<typeof PierreEntryIcon>["theme"];
  onPreview: (attachment: Attachment) => void;
  onRemove: (attachment: Attachment) => void;
  onRetry: (attachment: Attachment) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (attachments.length === 0) return null;
  const needsAttention = attachments.some(
    (attachment) =>
      uploads[attachment.id]?.status === "failed" ||
      (attachment.type === "file" && composerFileNeedsReattach(attachment)),
  );
  return (
    <div className="@container/attachment-tray mb-3" data-chat-composer-attachment-tray="true">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded(!expanded)}
        className="hidden items-center gap-2 rounded-sm py-1 text-sm text-secondary-label hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring @max-[440px]/attachment-tray:flex"
      >
        <PaperclipIcon className="size-4" />
        {attachments.length} {attachments.length === 1 ? "attachment" : "attachments"}
        {needsAttention ? (
          <TriangleAlertIcon
            aria-label="Attachments need attention"
            className="size-3.5 text-amber-600"
          />
        ) : null}
        <ChevronDownIcon className={cn("size-3.5", expanded && "rotate-180")} />
      </button>
      <ul
        id={listId}
        aria-label="Attachments"
        className={cn(
          "m-0 flex list-none flex-wrap gap-2 p-0 @max-[440px]/attachment-tray:max-h-44 @max-[440px]/attachment-tray:overflow-y-auto @max-[440px]/attachment-tray:px-1 @max-[440px]/attachment-tray:py-2",
          !expanded && "@max-[440px]/attachment-tray:hidden",
        )}
        style={{ "--attachment-count": attachments.length } as CSSProperties}
      >
        {attachments.map((attachment) => {
          const upload = uploads[attachment.id];
          const needsReattach = attachment.type === "file" && composerFileNeedsReattach(attachment);
          const warning = needsReattach
            ? "Attach again before sending"
            : nonPersistedImageIds.has(attachment.id)
              ? "Draft attachment may not persist"
              : upload?.status === "failed"
                ? upload.reason
                : null;
          const hideName =
            attachments.length > 4 ||
            attachment.type === "image" ||
            svgMimeType(attachment) !== null;
          return (
            <li
              key={attachment.id}
              className="@container/attachment group/attachment relative min-w-0 [width:clamp(6rem,calc((100cqw-(var(--attachment-count)-1)*0.5rem)/var(--attachment-count)),10rem)] @max-[440px]/attachment-tray:w-full"
            >
              <button
                type="button"
                aria-label={`Preview ${attachment.name}`}
                disabled={needsReattach}
                onClick={() => onPreview(attachment)}
                className="relative flex aspect-[4/3] w-full flex-col overflow-hidden rounded-lg bg-transparent text-left hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-70 @max-[440px]/attachment-tray:aspect-auto @max-[440px]/attachment-tray:flex-row"
              >
                <span className="absolute inset-0 flex size-full items-center justify-center overflow-hidden text-secondary-label @max-[440px]/attachment-tray:hidden">
                  {attachment.type === "image" ? (
                    <ComposerImageThumbnail
                      file={attachment.file}
                      alt={attachment.name}
                      className="size-full object-cover"
                      fallback={<FileIcon className="size-7" />}
                    />
                  ) : attachment.file && svgMimeType(attachment) ? (
                    <SvgThumbnail file={attachment.file} name={attachment.name} />
                  ) : (
                    <span className="relative flex size-full items-center justify-center">
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 160 120"
                        preserveAspectRatio="none"
                        className="absolute inset-0 size-full"
                      >
                        <path
                          d="M24 0H150Q160 0 160 10V110Q160 120 150 120H10Q0 120 0 110V24Q0 20 3 17L17 3Q20 0 24 0Z"
                          className="fill-muted/60"
                        />
                        <path
                          d="M0 24Q0 20 3 17L17 3Q20 0 24 0V16Q24 24 16 24Z"
                          className="fill-foreground/15"
                        />
                      </svg>
                      <PierreEntryIcon
                        pathValue={attachment.name}
                        kind="file"
                        theme={theme}
                        className="relative size-9"
                      />
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "absolute inset-x-0 bottom-0 flex h-9 min-w-0 items-center gap-1.5 px-2 text-xs @max-[440px]/attachment-tray:static @max-[440px]/attachment-tray:flex @max-[440px]/attachment-tray:h-11 @max-[440px]/attachment-tray:w-full",
                    "@max-[127px]/attachment:hidden",
                    (attachment.type === "image" || svgMimeType(attachment)) &&
                      "bg-black/55 text-white @max-[440px]/attachment-tray:bg-transparent @max-[440px]/attachment-tray:text-foreground",
                  )}
                >
                  <PierreEntryIcon pathValue={attachment.name} kind="file" theme={theme} />
                  <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
                  {upload?.status === "uploading" ? (
                    <span>{formatAttachmentUploadProgress(upload.progress)}</span>
                  ) : null}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => onRemove(attachment)}
                className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full border border-border bg-background text-secondary-label hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                <XIcon className="size-3" />
              </button>
              {hideName && upload?.status === "uploading" ? (
                <span className="pointer-events-none absolute bottom-1 left-1 rounded-sm bg-background/90 px-1 text-xs @max-[440px]/attachment-tray:hidden">
                  {formatAttachmentUploadProgress(upload.progress)}
                </span>
              ) : null}
              {upload?.status === "failed" && !needsReattach ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={`Retry upload for ${attachment.name}`}
                        onClick={() => onRetry(attachment)}
                        className="absolute bottom-1 right-1 flex size-7 items-center justify-center rounded-sm bg-background text-destructive-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <RefreshCwIcon className="size-3.5" />
                      </button>
                    }
                  />
                  <TooltipPopup>{upload.reason}</TooltipPopup>
                </Tooltip>
              ) : warning ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        role="img"
                        aria-label={warning}
                        className="absolute bottom-2.5 right-2 text-amber-600"
                      >
                        <TriangleAlertIcon className="size-4" />
                      </span>
                    }
                  />
                  <TooltipPopup>{warning}</TooltipPopup>
                </Tooltip>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
