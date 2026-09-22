import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@dispatch/contracts";
import { ArrowRightIcon, WorkflowIcon, XIcon } from "lucide-react";

import { FEATURE_DISCOVERIES, useFeatureDiscoveryDismissal } from "../../featureDiscovery";
import { Button } from "../ui/button";

type Announcement = (typeof FEATURE_DISCOVERIES)[keyof typeof FEATURE_DISCOVERIES];

function FeatureAnnouncement({
  announcement,
  environmentId,
}: {
  announcement: Announcement;
  environmentId: EnvironmentId;
}) {
  const { dismissed, dismiss } = useFeatureDiscoveryDismissal(announcement.id);
  if (dismissed) return null;

  return (
    <aside
      aria-label={announcement.title}
      className="relative mt-7 flex items-center gap-4 rounded-xl bg-foreground/[0.035] p-4 text-sm sm:p-5"
    >
      <div
        aria-hidden
        className="relative flex size-11 shrink-0 items-center justify-center rounded-xl bg-background text-foreground shadow-xs"
      >
        <WorkflowIcon className="size-6" strokeWidth={1.5} />
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-3 pr-5">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h2 className="font-semibold text-foreground">{announcement.title}</h2>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <span aria-hidden className="size-1 rounded-full bg-orange-500" />
              New
            </span>
          </div>
          <p className="mt-1 text-pretty text-[13px] leading-relaxed text-muted-foreground">
            {announcement.description}
          </p>
        </div>
        <Link
          to={announcement.to}
          {...(announcement.to === "/settings/orchestration"
            ? { search: { machine: environmentId } }
            : {})}
          className="inline-flex min-h-8 shrink-0 items-center gap-2 rounded-lg bg-background px-3 text-[13px] font-medium text-foreground shadow-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {announcement.actionLabel}
          <ArrowRightIcon aria-hidden className="size-3.5" />
        </Link>
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Dismiss ${announcement.title}`}
        onClick={dismiss}
        className="absolute top-1 right-1 text-muted-foreground"
      >
        <XIcon className="size-4" />
      </Button>
    </aside>
  );
}

/** Product announcements live on the new-chat landing surface, outside the input. */
export function NewChatAnnouncements({
  teamRouting,
  environmentId,
}: {
  teamRouting: boolean;
  environmentId: EnvironmentId;
}) {
  const capabilities = { teamRouting };
  return Object.values(FEATURE_DISCOVERIES)
    .filter((announcement) => capabilities[announcement.capability])
    .map((announcement) => (
      <FeatureAnnouncement
        key={announcement.id}
        announcement={announcement}
        environmentId={environmentId}
      />
    ));
}
