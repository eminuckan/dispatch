export type SvgAttachmentPreviewSource =
  | { readonly status: "ready"; readonly xml: string }
  | { readonly status: "unavailable"; readonly title: string; readonly detail: string };

/** A rendered SVG must be complete; source mode may still show the bounded prefix. */
export function svgAttachmentPreviewSource(content: {
  readonly text: string;
  readonly truncated: boolean;
}): SvgAttachmentPreviewSource {
  if (content.truncated) {
    return {
      status: "unavailable",
      title: "SVG too large to preview",
      detail:
        "The SVG is larger than the 1 MB preview limit. View its partial source here, or save and share the original file.",
    };
  }
  if (!/<svg(?:\s|\/?>)/i.test(content.text)) {
    return {
      status: "unavailable",
      title: "Could not render SVG",
      detail:
        "The file does not contain a supported SVG document. View its source or share it instead.",
    };
  }
  return { status: "ready", xml: content.text };
}
