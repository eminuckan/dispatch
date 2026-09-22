import type { DesktopWhatsNew } from "@dispatch/contracts";
import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { getDesktopUpdateReleaseUrl } from "./desktopUpdate.logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { stackedThreadToast, toastManager } from "./ui/toast";

export function resolveWhatsNewExternalUrl(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

async function openExternal(url: string): Promise<void> {
  const bridge = window.desktopBridge;
  if (!bridge) return;
  try {
    if (await bridge.openExternal(url)) return;
  } catch {
    // Surface the same fallback below for rejected IPC calls.
  }
  toastManager.add(stackedThreadToast({ type: "error", title: "Could not open release notes" }));
}

export function DesktopWhatsNew() {
  const [release, setRelease] = useState<DesktopWhatsNew | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.getWhatsNew !== "function") return;
    let active = true;
    void bridge
      .getWhatsNew()
      .then((nextRelease) => {
        if (active) setRelease(nextRelease);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const dismiss = useCallback(() => {
    const bridge = window.desktopBridge;
    setRelease(null);
    if (!bridge || typeof bridge.dismissWhatsNew !== "function") return;
    void bridge
      .dismissWhatsNew()
      .then((persisted) => {
        if (persisted) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not remember What's New dismissal",
            description: "The release notes may appear again after restarting Dispatch.",
          }),
        );
      })
      .catch(() => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not remember What's New dismissal",
            description: "The release notes may appear again after restarting Dispatch.",
          }),
        );
      });
  }, []);

  if (!release) return null;
  const releaseUrl = getDesktopUpdateReleaseUrl(release.version);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>What's New in Dispatch {release.version}</DialogTitle>
          <DialogDescription>Changes from the release you just installed.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {release.markdown ? (
            <div className="space-y-3 text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_h1]:font-semibold [&_h1]:text-lg [&_h2]:font-semibold [&_h2]:text-base [&_h3]:font-medium [&_li]:ml-5 [&_ol]:list-decimal [&_p]:my-2 [&_ul]:list-disc">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                components={{
                  a: ({ href, children }) => {
                    const safeUrl = resolveWhatsNewExternalUrl(href);
                    if (!safeUrl) return <span>{children}</span>;
                    return (
                      <a
                        href={safeUrl}
                        onClick={(event) => {
                          event.preventDefault();
                          void openExternal(safeUrl);
                        }}
                      >
                        {children}
                      </a>
                    );
                  },
                  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
                }}
              >
                {release.markdown}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Release notes are not available inside this build.
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          {releaseUrl ? (
            <Button variant="outline" onClick={() => void openExternal(releaseUrl)}>
              View release
            </Button>
          ) : null}
          <Button onClick={dismiss}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
