import {
  ChevronDownIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  HistoryIcon,
} from "lucide-react";
import { memo } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { Button } from "./ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

interface BranchToolbarEnvModeSelectorProps {
  forceNewWorktree?: boolean;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel?: string | null;
  onUsePreviousWorktree?: () => void;
  onSetPrefix?: (() => void) | undefined;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forceNewWorktree = false,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  onUsePreviousWorktree,
  onSetPrefix,
}: BranchToolbarEnvModeSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const showPreviousWorktree = Boolean(previousWorktreeLabel && onUsePreviousWorktree);
  const locked = envLocked || forceNewWorktree;
  const workspaceLabel = forceNewWorktree
    ? resolveEnvModeLabel("worktree")
    : envLocked
      ? resolveLockedWorkspaceLabel(activeWorktreePath)
      : effectiveEnvMode === "worktree"
        ? resolveEnvModeLabel("worktree")
        : resolveCurrentWorkspaceLabel(activeWorktreePath);

  return (
    <Menu modal={false}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<Button variant="ghost" size="xs" />}
              className="min-w-0 shrink font-normal text-xs!"
              aria-label="Workspace"
              data-composer-shortcut={locked ? undefined : "composer.workspace"}
              data-composer-context-control
            />
          }
        >
          {effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon className="size-3" />
          ) : activeWorktreePath ? (
            <FolderGitIcon className="size-3" />
          ) : (
            <FolderIcon className="size-3" />
          )}
          <span
            data-composer-label
            className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          >
            <span
              data-composer-label-motion
              className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
            >
              {workspaceLabel}
            </span>
          </span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
        </TooltipTrigger>
        <TooltipPopup>{workspaceLabel}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="top" {...composerFloatingLayerProps}>
        <MenuGroup>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          <MenuRadioGroup
            value={effectiveEnvMode}
            onValueChange={(value) => {
              if (locked) return;
              if (value === PREVIOUS_WORKTREE_SELECT_VALUE) onUsePreviousWorktree?.();
              else onEnvModeChange(value as EnvMode);
            }}
          >
            <MenuRadioItem disabled={locked} value="local">
              <span className="inline-flex items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                {resolveCurrentWorkspaceLabel(activeWorktreePath)}
              </span>
            </MenuRadioItem>
            <MenuRadioItem disabled={locked} value="worktree">
              <span className="inline-flex items-center gap-1.5">
                <FolderGit2Icon className="size-3" />
                {resolveEnvModeLabel("worktree")}
              </span>
            </MenuRadioItem>
            {showPreviousWorktree && previousWorktreeLabel ? (
              <MenuRadioItem disabled={locked} value={PREVIOUS_WORKTREE_SELECT_VALUE}>
                <span className="inline-flex items-center gap-1.5">
                  <HistoryIcon className="size-3" />
                  {previousWorktreeLabel}
                </span>
              </MenuRadioItem>
            ) : null}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem disabled={!onSetPrefix} onClick={onSetPrefix}>
          Set prefix
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});
