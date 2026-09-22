import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon, LogInIcon, LogOutIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";

import {
  DispatchConnectAccountAccess,
  type DispatchConnectAccountUserView,
  type DispatchConnectAccountView,
} from "../../connect/DispatchConnectAccountAccess";
import { DispatchConnectAuthDialog } from "../../connect/DispatchConnectAuthDialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function accountInitials(user: DispatchConnectAccountUserView): string {
  const source = user.name?.trim() || user.email?.trim() || "";
  const parts = source.split(/\s+/u).filter(Boolean);
  if (parts.length > 1) {
    return `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase() || "DC";
}

function AccountAvatar({ user }: { readonly user: DispatchConnectAccountUserView }) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const image = user.image && user.image !== failedImage ? user.image : null;
  return (
    <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-sidebar-row-selected text-[9px] font-semibold text-sidebar-foreground">
      {image ? (
        <img
          alt=""
          className="size-full object-cover"
          src={image}
          onError={() => setFailedImage(image)}
        />
      ) : (
        accountInitials(user)
      )}
    </span>
  );
}

function AccountErrorMenu({ account }: { readonly account: DispatchConnectAccountView }) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={<SidebarMenuButton aria-label="Dispatch Connect account unavailable" />}
              />
            }
          >
            <CircleAlertIcon />
            <span className="truncate group-data-[collapsible=icon]:hidden">
              Account unavailable
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">Account unavailable</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" side="top" className="w-64">
          <p className="px-2 py-1.5 text-xs text-destructive" role="alert">
            {account.error}
          </p>
          <MenuItem onClick={account.refresh}>
            <RefreshCwIcon />
            Retry
          </MenuItem>
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}

function SignedInAccount({ account }: { readonly account: DispatchConnectAccountView }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const user = account.user;
  if (!user) return null;
  const displayName = user.name?.trim() || user.email?.trim() || "Dispatch Connect";
  const secondary =
    user.email?.trim() && user.email.trim() !== displayName ? user.email.trim() : null;
  const openAccountSettings = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/settings/connections" });
  };

  return (
    <SidebarMenuItem className="shrink-0">
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger render={<SidebarMenuButton aria-label={"Account: " + displayName} />} />
            }
          >
            <AccountAvatar user={user} />
            <span className="truncate group-data-[collapsible=icon]:hidden">{displayName}</span>
          </TooltipTrigger>
          <TooltipPopup side="top">{displayName}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" side="top" className="w-64">
          <div className="min-w-0 px-2 py-1.5">
            <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
            {secondary ? (
              <p className="truncate text-xs text-muted-foreground">{secondary}</p>
            ) : null}
          </div>
          {account.error ? (
            <>
              <p className="px-2 py-1 text-xs text-destructive" role="alert">
                {account.error}
              </p>
              <MenuItem onClick={account.refresh}>
                <RefreshCwIcon />
                Retry account status
              </MenuItem>
            </>
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={openAccountSettings}>
            <SettingsIcon />
            Account settings
          </MenuItem>
          <MenuItem disabled={account.signOutPending} onClick={() => void account.signOut()}>
            {account.signOutPending ? <Spinner className="size-4" /> : <LogOutIcon />}
            {account.signOutPending ? "Signing out…" : "Sign out"}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}

function SignedOutAccount({ account }: { readonly account: DispatchConnectAccountView }) {
  return (
    <DispatchConnectAuthDialog onAuthenticated={account.refresh}>
      {({ openSignIn }) => (
        <SidebarMenuItem className="shrink-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuButton aria-label="Sign in to Dispatch Connect" onClick={openSignIn}>
                  <LogInIcon />
                  <span className="group-data-[collapsible=icon]:hidden">Sign in</span>
                </SidebarMenuButton>
              }
            />
            <TooltipPopup side="top">Sign in</TooltipPopup>
          </Tooltip>
        </SidebarMenuItem>
      )}
    </DispatchConnectAuthDialog>
  );
}

export function SidebarConnectAccount() {
  return (
    <DispatchConnectAccountAccess>
      {(account) => {
        if (!account.configured) return null;
        return (
          <SidebarMenu>
            {account.pending ? (
              <SidebarMenuItem className="shrink-0">
                <SidebarMenuButton aria-label="Checking Dispatch Connect account" disabled>
                  <Spinner className="size-4" />
                  <span className="group-data-[collapsible=icon]:hidden">Checking account…</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : account.signedIn && account.user ? (
              <SignedInAccount account={account} />
            ) : account.error ? (
              <AccountErrorMenu account={account} />
            ) : (
              <SignedOutAccount account={account} />
            )}
          </SidebarMenu>
        );
      }}
    </DispatchConnectAccountAccess>
  );
}
