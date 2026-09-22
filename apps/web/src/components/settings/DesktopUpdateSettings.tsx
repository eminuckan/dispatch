import type { DesktopUpdateChannel } from "@dispatch/contracts";
import { useCallback, useState } from "react";

import { APP_VERSION } from "../../branding";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";

export type DesktopProductUpdateChannel = "latest" | "preview";

export function resolveDesktopProductUpdateChannel(
  channel: DesktopUpdateChannel | null | undefined,
): DesktopProductUpdateChannel {
  return channel === "latest" ? "latest" : "preview";
}

function VersionTitle({ version }: { version: string }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{version}</code>
    </span>
  );
}

export function DesktopUpdateSettings() {
  const updateState = useDesktopUpdateState();
  const [isChangingChannel, setIsChangingChannel] = useState(false);
  const [isUpdateActionPending, setIsUpdateActionPending] = useState(false);
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const selectedChannel = resolveDesktopProductUpdateChannel(updateState?.channel);

  const handleChannelChange = useCallback(
    (channel: DesktopProductUpdateChannel) => {
      const desktopBridge = window.desktopBridge;
      if (!desktopBridge || typeof desktopBridge.setUpdateChannel !== "function") return;
      if (channel === updateState?.channel) return;

      setIsChangingChannel(true);
      void desktopBridge
        .setUpdateChannel(channel)
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not change update track",
              description: error instanceof Error ? error.message : "Update track change failed.",
            }),
          );
        })
        .finally(() => setIsChangingChannel(false));
    },
    [updateState?.channel],
  );

  const handleUpdateAction = useCallback(async () => {
    const desktopBridge = window.desktopBridge;
    if (!desktopBridge) return;
    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void desktopBridge.downloadUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not download update",
            description: error instanceof Error ? error.message : "Download failed.",
          }),
        );
      });
      return;
    }

    if (action === "install") {
      if (isUpdateActionPending) return;
      setIsUpdateActionPending(true);
      try {
        const confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(
            updateState ?? { availableVersion: null, downloadedVersion: null },
          ),
        );
        if (!confirmed) return;
        await desktopBridge.installUpdate();
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "Install failed.",
          }),
        );
      } finally {
        setIsUpdateActionPending(false);
      }
      return;
    }

    if (typeof desktopBridge.checkForUpdate !== "function") return;
    void desktopBridge
      .checkForUpdate()
      .then((result) => {
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      });
  }, [isUpdateActionPending, updateState]);

  if (!bridge) return null;

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);
  const buttonLabel =
    action === "download"
      ? "Download"
      : action === "install"
        ? "Install"
        : updateState?.status === "checking"
          ? "Checking…"
          : updateState?.status === "downloading"
            ? "Downloading…"
            : updateState?.status === "up-to-date"
              ? "Up to Date"
              : "Check for Updates";

  return (
    <>
      <SettingsRow
        title={<VersionTitle version={updateState?.currentVersion ?? APP_VERSION} />}
        description={
          action === "download" || action === "install"
            ? "Update available."
            : "Current version of the application."
        }
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={buttonDisabled || isUpdateActionPending}
                  onClick={() => void handleUpdateAction()}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      <SettingsRow
        title="Update track"
        description="Stable receives regular releases. Preview receives opt-in prereleases earlier."
        control={
          <Select
            value={selectedChannel}
            onValueChange={(value) => handleChannelChange(value as DesktopProductUpdateChannel)}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-40"
              aria-label="Update track"
              disabled={isChangingChannel}
            >
              <SelectValue>{selectedChannel === "preview" ? "Preview" : "Stable"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="latest">
                Stable
              </SelectItem>
              <SelectItem hideIndicator value="preview">
                Preview
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}
