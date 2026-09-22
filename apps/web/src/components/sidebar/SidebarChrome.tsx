import { ArrowLeftIcon, ChartNoAxesColumnIcon, SettingsIcon, WorkflowIcon } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { Link, useCanGoBack, useLocation, useNavigate, useParams } from "@tanstack/react-router";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useActiveEnvironmentId } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { DispatchMark } from "../DispatchMark";
import {
  resolveEnvironmentIdentificationPillLabel,
  SidebarGalaxyBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { SidebarConnectAccount } from "./SidebarConnectAccount";
import { resolveSidebarFlowEnvironment } from "./sidebarFlowEnvironment";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const showArtwork = environmentIdentificationMode === "artwork";
  const pillLabel =
    environmentIdentificationMode !== "none"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-3 py-0 md:gap-3 md:px-0",
        showArtwork && "mb-4",
        isElectron && "drag-region",
      )}
    >
      {showArtwork ? <SidebarGalaxyBackdrop /> : null}
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          showArtwork &&
            "focus-visible:ring-white/90 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white! [:hover,[data-pressed]]:bg-white/15",
        )}
      />
      <SidebarBrand onBackdrop={showArtwork} />
      {pillLabel ? (
        <Badge
          className={cn(
            "relative z-10 ml-auto h-5 shrink-0 px-1.5 text-[11px] font-semibold sm:h-5 sm:text-[11px] md:mr-3",
            showArtwork ? "bg-black/45 text-white" : "text-foreground",
          )}
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </SidebarHeader>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 flex h-9 min-w-0 items-center gap-2 rounded-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring md:ml-[var(--workspace-titlebar-content-left)]",
        onBackdrop ? "text-white focus-visible:ring-white/90" : "text-foreground",
      )}
      to="/"
    >
      <DispatchMark aria-hidden className="size-4 shrink-0" />
      <span className="truncate text-sm font-medium leading-5">Dispatch</span>
    </Link>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export function SidebarFlowMenu({ className }: { className?: string }) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useActiveEnvironmentId();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draftEnvironmentId = useComposerDraftStore((store) => {
    const draft = routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null;
    return draft?.promotedTo?.environmentId ?? draft?.environmentId ?? null;
  });
  const environment = resolveSidebarFlowEnvironment({
    environments,
    preferredEnvironmentId:
      (routeTarget?.kind === "server" ? routeTarget.threadRef.environmentId : draftEnvironmentId) ??
      activeEnvironmentId,
    primaryEnvironmentId,
  });
  const { isMobile, setOpenMobile } = useSidebar();
  if (!environment) return null;
  return (
    <SidebarMenu className={className}>
      <SidebarMenuItem>
        <SidebarMenuButton
          render={
            <Link to="/settings/orchestration" search={{ machine: environment.environmentId }} />
          }
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
          aria-label="Dispatch Flow"
          tooltip={`Configure Dispatch Flow on ${environment.label}`}
        >
          <WorkflowIcon />
          <span className="group-data-[collapsible=icon]:hidden">Dispatch Flow</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const currentFooterPage = useLocation({
    select: (location) =>
      /^\/settings(?:\/|$)/.test(location.pathname)
        ? "settings"
        : /^\/projects\/[^/]+\/?$/.test(location.pathname)
          ? "project-settings"
          : location.pathname === "/usage"
            ? "usage"
            : location.pathname === "/pull-requests"
              ? "pull-requests"
              : null,
  });
  const { environments } = useEnvironments();
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, closeMobileSidebar, navigate]);

  return (
    <>
      <SidebarConnectAccount />
      <SidebarMenu className="flex-row items-center">
        {currentFooterPage ? (
          <SidebarMenuItem className="min-w-0 flex-1">
            <SidebarMenuButton onClick={handleBackClick}>
              <ArrowLeftIcon />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : (
          <>
            <SidebarUtilityItem
              icon={<SettingsIcon />}
              label="Settings"
              onClick={handleSettingsClick}
            />
            {pullRequestsSupported ? (
              <SidebarUtilityItem
                icon={<PullRequestGlyph.pullRequest />}
                label="Pull Requests"
                onClick={handlePullRequestsClick}
              />
            ) : null}
            <SidebarUtilityItem
              icon={<ChartNoAxesColumnIcon />}
              label="Usage"
              onClick={handleUsageClick}
            />
          </>
        )}
        <SidebarUpdatePill />
      </SidebarMenu>
    </>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter className="px-[var(--sidebar-content-inset)] py-1">
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
