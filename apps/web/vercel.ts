import { matchers, routes, type Transform, type VercelConfig } from "@vercel/config/v1";

const HOSTED_WEB_CHANNEL_COOKIE = "dispatch_web_channel";
const CLEAN_CHANNEL_QUERY_TRANSFORMS = [
  {
    type: "request.query",
    op: "delete",
    target: { key: "channel" },
  },
] satisfies Transform[];

function channelCookie(channel: "latest" | "nightly"): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

function hostFromUrl(value: string | undefined): string | null {
  const configured = value?.trim();
  if (!configured) return null;

  try {
    return new URL(configured).host;
  } catch {
    return null;
  }
}

function originFromDomain(value: string | undefined): string | null {
  const domain = value?.trim();
  if (!domain) return null;
  return `https://${domain}`;
}

const routerHost = hostFromUrl(process.env.DISPATCH_WEB_ROUTER_URL);
const latestOrigin = originFromDomain(process.env.DISPATCH_WEB_LATEST_DOMAIN);
const nightlyOrigin = originFromDomain(process.env.DISPATCH_WEB_NIGHTLY_DOMAIN);

const hostedChannelRoutes =
  routerHost && latestOrigin && nightlyOrigin
    ? [
        ...["/__dispatch/channel", "/__t3code/channel"].flatMap((src) => [
          {
            src,
            has: [matchers.query("channel", "nightly")],
            transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
            headers: {
              Location: "/",
              "Set-Cookie": channelCookie("nightly"),
            },
            status: 302,
          },
          {
            src,
            transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
            headers: {
              Location: "/",
              "Set-Cookie": channelCookie("latest"),
            },
            status: 302,
          },
        ]),
        {
          src: "/(.*)",
          has: [matchers.host(routerHost), matchers.cookie(HOSTED_WEB_CHANNEL_COOKIE, "nightly")],
          dest: `${nightlyOrigin}/$1`,
        },
        {
          src: "/(.*)",
          has: [matchers.host(routerHost)],
          dest: `${latestOrigin}/$1`,
        },
      ]
    : [];

export const config: VercelConfig = {
  buildCommand:
    'vp run --filter @dispatch/web build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@dispatch/scripts...' --filter '@dispatch/web...'",
  routes: [...hostedChannelRoutes],
  rewrites: [routes.rewrite("/(.*)", "/index.html")],
};
