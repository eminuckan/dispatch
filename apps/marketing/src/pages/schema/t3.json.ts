import type { APIRoute } from "astro";

import { buildT3ProjectFileJsonSchema } from "@dispatch/shared/t3ProjectFile";

// Rendered at build time at /schema/t3.json. The t3.json filename is retained
// as a compatibility identifier so existing project files keep editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildT3ProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
