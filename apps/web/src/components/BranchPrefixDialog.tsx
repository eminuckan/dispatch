import type { EnvironmentId, ProjectId } from "@dispatch/contracts";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useEnvironment } from "../state/environments";
import { BranchPrefixSetting } from "./settings/BranchPrefixSetting";
import { SettingsScopeProvider, useSettingsScope } from "./settings/SettingsScopeContext";
import { useSettingsProjectGroups } from "./settings/useSettingsProjectGroups";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

export function BranchPrefixDialog({
  environmentId,
  projectId,
  onClose,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onClose: () => void;
}) {
  const environment = useEnvironment(environmentId);
  const navigate = useNavigate();
  const groups = useSettingsProjectGroups();
  const group = groups.find((candidate) =>
    candidate.memberProjects.some(
      (member) => member.environmentId === environmentId && member.id === projectId,
    ),
  );
  const member = group?.memberProjects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  const [scope, setScope] = useState("project");
  const search =
    scope === "environment"
      ? { machine: environmentId }
      : {
          machine: environmentId,
          // A removed checkout must stay unavailable instead of broadening a write.
          project: group?.projectKey ?? projectId,
          checkout: member?.physicalProjectKey ?? projectId,
        };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Branch prefix</DialogTitle>
          <DialogDescription>
            Applies to future branch names. Existing branches keep their names.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Select
            value={scope}
            onValueChange={(value) => {
              if (value) setScope(value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Branch prefix scope" className="w-full">
              <SelectValue>
                {scope === "environment"
                  ? `Environment default · ${environment?.label ?? "Unavailable"}`
                  : `This project · ${group?.displayName ?? "Unavailable"} / ${environment?.label ?? "Unavailable"}`}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="project">
                This project · {group?.displayName ?? "Unavailable"} /{" "}
                {environment?.label ?? "Unavailable"}
              </SelectItem>
              <SelectItem value="environment">
                Environment default · {environment?.label ?? "Unavailable"}
              </SelectItem>
            </SelectPopup>
          </Select>
          <SettingsScopeProvider
            search={search}
            onChange={(next) => {
              void navigate({ to: "/settings/source-control", search: next });
              onClose();
            }}
          >
            <PrefixScopeDetails />
            <BranchPrefixSetting />
          </SettingsScopeProvider>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function PrefixScopeDetails() {
  const { scope } = useSettingsScope();
  return (
    <p className="mt-2 text-muted-foreground text-xs">
      {scope.kind === "unavailable" ? scope.message : scope.label}
      {scope.kind === "checkout"
        ? ". Reset the override to inherit the environment default."
        : null}
    </p>
  );
}
