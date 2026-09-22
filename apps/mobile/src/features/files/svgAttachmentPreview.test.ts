import { describe, expect, it } from "vite-plus/test";

import { svgAttachmentPreviewSource } from "./svgAttachmentPreviewSource";

describe("svg attachment preview source", () => {
  it("renders a complete SVG document", () => {
    const xml = `<svg viewBox="0 0 16 16"><path d="M0 0h16v16H0z" /></svg>`;

    expect(svgAttachmentPreviewSource({ text: xml, truncated: false })).toEqual({
      status: "ready",
      xml,
    });
  });

  it.each([
    `<?xml version="1.0"?><svg/>`,
    `<svg><style>.accent { fill: red; }</style><path class="accent" d="M0 0h1v1H0z" /></svg>`,
  ])("accepts supported SVG source: %s", (xml) => {
    expect(svgAttachmentPreviewSource({ text: xml, truncated: false })).toEqual({
      status: "ready",
      xml,
    });
  });

  it("does not silently render a truncated SVG", () => {
    expect(svgAttachmentPreviewSource({ text: "<svg><path", truncated: true })).toMatchObject({
      status: "unavailable",
      title: "SVG too large to preview",
    });
  });

  it("reports non-SVG text instead of handing it to the renderer", () => {
    expect(svgAttachmentPreviewSource({ text: "not an svg", truncated: false })).toMatchObject({
      status: "unavailable",
      title: "Could not render SVG",
    });
  });
});
