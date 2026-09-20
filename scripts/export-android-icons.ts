#!/usr/bin/env node

// Renders Android launcher, splash, monochrome, and notification artwork from the
// canonical Dispatch SVGs. Android applies its own launcher and splash masks, so the
// foreground is a centered mark on a transparent full-size canvas while the background
// bleeds to every edge.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

// 108dp at xxxhdpi. Expo derives the remaining launcher density buckets from this.
const ADAPTIVE_CANVAS = 432;
// 288dp at xxxhdpi. Android 12+ applies its splash icon mask inside this full canvas.
const SPLASH_CANVAS = 1152;
// 24dp at xxxhdpi, matching Android's status-bar notification icon target.
const NOTIFICATION_CANVAS = 96;
const MARK_FRACTION = 0.52;
const NOTIFICATION_MARK_FRACTION = 0.66;
const SVG_DENSITY = 300;
const OUTPUT_DIRECTORY = "apps/mobile/assets";

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

const readArtwork = Effect.fn("androidIcons.readArtwork")(function* (
  repositoryRoot: string,
  relativePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(path.join(repositoryRoot, relativePath));
});

const rasterize = (layer: string, svg: string, width: number, height = width) =>
  Effect.tryPromise({
    try: () =>
      sharp(Buffer.from(svg), { density: SVG_DENSITY })
        .resize({
          width,
          height,
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const canvas = (layer: string, size: number, background: string) =>
  Effect.tryPromise({
    try: () =>
      sharp({ create: { width: size, height: size, channels: 4, background } })
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const composite = (layer: string, base: Buffer, overlay: Buffer, offset: number) =>
  Effect.tryPromise({
    try: () =>
      sharp(base)
        .composite([{ input: overlay, left: offset, top: offset }])
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const extractDispatchBackgroundColor = Effect.fn("androidIcons.extractDispatchBackgroundColor")(
  function* (repositoryRoot: string) {
    const icon = yield* readArtwork(repositoryRoot, BRAND_ASSET_PATHS.dispatchIconSvg);
    return yield* Effect.try({
      try: () => {
        const color = icon.match(/<rect\b[^>]*\bfill="([^"]+)"/)?.[1];
        if (!color) throw new Error("Dispatch icon SVG does not define a background fill");
        return color;
      },
      catch: (cause) => new AndroidIconRenderError({ layer: "dispatch-background", cause }),
    });
  },
);

const renderMarkCanvas = Effect.fn("androidIcons.renderMarkCanvas")(function* (
  repositoryRoot: string,
  size: number,
  fraction = MARK_FRACTION,
  monochrome = false,
) {
  const source = yield* readArtwork(repositoryRoot, BRAND_ASSET_PATHS.dispatchMarkSvg);
  const svg = monochrome ? source.replace(/fill="[^"]+"/g, 'fill="#ffffff"') : source;
  const markSize = Math.round(size * fraction);
  const mark = yield* rasterize(
    monochrome ? "dispatch-mark-monochrome" : "dispatch-mark",
    svg,
    markSize,
  );
  const transparent = yield* canvas("transparent-canvas", size, "rgba(0,0,0,0)");
  const offset = Math.round((size - markSize) / 2);
  return yield* composite("dispatch-mark-canvas", transparent, mark, offset);
});

const renderBackground = Effect.fn("androidIcons.renderBackground")(function* (
  repositoryRoot: string,
  size: number,
) {
  const backgroundColor = yield* extractDispatchBackgroundColor(repositoryRoot);
  return yield* canvas("dispatch-background", size, backgroundColor);
});

const renderSplashIcon = Effect.fn("androidIcons.renderSplashIcon")(function* (
  repositoryRoot: string,
) {
  const background = yield* renderBackground(repositoryRoot, SPLASH_CANVAS);
  const foreground = yield* renderMarkCanvas(repositoryRoot, SPLASH_CANVAS);
  return yield* composite("dispatch-splash", background, foreground, 0);
});

const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");

  const foreground = yield* renderMarkCanvas(repositoryRoot, ADAPTIVE_CANVAS);
  const background = yield* renderBackground(repositoryRoot, ADAPTIVE_CANVAS);
  const splash = yield* renderSplashIcon(repositoryRoot);
  const monochrome = yield* renderMarkCanvas(repositoryRoot, ADAPTIVE_CANVAS, MARK_FRACTION, true);
  const notification = yield* renderMarkCanvas(
    repositoryRoot,
    NOTIFICATION_CANVAS,
    NOTIFICATION_MARK_FRACTION,
    true,
  );

  const outputs = [
    ["android-icon-foreground.png", foreground],
    ["android-icon-background-dev.png", background],
    ["android-icon-background-nightly.png", background],
    ["android-splash-icon-dev.png", splash],
    ["android-splash-icon-nightly.png", splash],
    ["android-splash-icon-prod.png", splash],
    ["android-icon-mark.png", monochrome],
    ["android-notification-icon.png", notification],
  ] as const;

  for (const [name, contents] of outputs) {
    yield* fs.writeFile(path.join(repositoryRoot, OUTPUT_DIRECTORY, name), contents);
    yield* Console.log(`wrote ${OUTPUT_DIRECTORY}/${name}`);
  }
});

if (import.meta.main) {
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
