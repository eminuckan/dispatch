import {
  FlowError,
  FlowJob,
  FlowModelSelection,
  FlowSendInput,
  FlowReportInput,
  FlowSpawnInput,
  FlowThreadView,
  FlowWaitInput,
  FlowWorker,
  FlowUpdate,
  FlowWorkerProfile,
  ProviderOptionDescriptor,
  ThreadId,
} from "@dispatch/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { McpInvocationContext } from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext];
const NoArguments = Schema.Record(Schema.String, Schema.Unknown);

const Models = Tool.make("flow_models", {
  description:
    "List available Dispatch provider models for explicit Flow worker selection. The current thread's composer model stays the lead model.",
  parameters: NoArguments,
  success: Schema.Array(
    Schema.Struct({
      selection: FlowModelSelection,
      providerName: Schema.String,
      modelName: Schema.String,
      optionDescriptors: Schema.Array(ProviderOptionDescriptor),
    }),
  ),
  failure: FlowError,
  dependencies,
})
  .annotate(Tool.Title, "List Flow models")
  .annotate(Tool.Readonly, true);

const Profiles = Tool.make("flow_profiles", {
  description:
    "List the user's configured worker pool for this project. Each profile includes provider, model, effort, and the user's description of when to use it. Deep workers suit difficult reasoning; routine workers suit frequent bounded tasks and may need closer checking. Review every worker's result. Pick a profile deliberately for each assignment; there is no automatic routing.",
  parameters: NoArguments,
  success: Schema.Array(
    Schema.Struct({
      profile: FlowWorkerProfile,
      providerName: Schema.String,
      modelName: Schema.String,
      available: Schema.Boolean,
    }),
  ),
  failure: FlowError,
  dependencies,
})
  .annotate(Tool.Title, "List Flow worker pool")
  .annotate(Tool.Readonly, true);

const Spawn = Tool.make("flow_spawn", {
  description:
    "Start one persistent Dispatch worker thread for a concrete assignment. Prefer a configured profile from flow_profiles so its task guidance, provider, model, and effort inform your choice; use an explicit selection from flow_models when no profile fits. In a Git project, the worker automatically gets an isolated worktree. In a project whose root is not Git, the worker shares the live project directory by default; specify repositoryPath relative to the project root to give it an isolated worktree in a child Git repository. Inspect the project and choose the child path yourself when isolation helps; the user need not configure it. The worker receives only the assignment you supply and does not inherit this conversation. Reuse id on retry. The lead owns review and integration.",
  parameters: FlowSpawnInput,
  success: FlowWorker,
  failure: FlowError,
  dependencies,
})
  .annotate(Tool.Title, "Start Flow worker")
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.Readonly, false);

const Send = Tool.make("flow_send", {
  description:
    "Message an idle or working worker, preserving its thread and model. A working provider session receives the message during its current turn when that provider supports steering. Reuse id on retry. Open the worker thread for its full history.",
  parameters: FlowSendInput,
  success: FlowJob,
  failure: FlowError,
  dependencies,
})
  .annotate(Tool.Title, "Message Flow worker")
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.Readonly, false);

const Report = Tool.make("flow_report", {
  description:
    "For Flow workers: send a concise progress update, question, or blocker to the lead while working. The lead sees it through flow_wait or flow_list. Reuse id on retry.",
  parameters: FlowReportInput,
  success: FlowUpdate,
  failure: FlowError,
  dependencies,
})
  .annotate(Tool.Title, "Report Flow progress")
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.Readonly, false);

const Wait = Tool.make("flow_wait", {
  description:
    "Read recent worker progress, including live flow_report updates, and results. Optionally wait up to 30 seconds for a change; pass the last update sequence as afterUpdateSequence to wake on a newer report. The worker thread holds its full conversation. The lead must verify the result before answering the user.",
  parameters: FlowWaitInput,
  success: FlowThreadView,
  failure: FlowError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for Flow workers")
  .annotate(Tool.Readonly, true);

const List = Tool.make("flow_list", {
  description: "List this thread's persistent Flow workers, current jobs, and results.",
  parameters: NoArguments,
  success: FlowThreadView,
  failure: FlowError,
  dependencies,
})
  .annotate(Tool.Title, "List Flow workers")
  .annotate(Tool.Readonly, true);

const Stop = Tool.make("flow_stop", {
  description:
    "Stop a worker owned by this Flow. Its thread and any worktree remain available for inspection. The worker cannot receive new assignments after stopping.",
  parameters: Schema.Struct({ workerThreadId: ThreadId }),
  success: FlowWorker,
  failure: FlowError,
  dependencies,
})
  .annotate(Tool.Title, "Stop Flow worker")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true);

export const FlowToolkit = Toolkit.make(Models, Profiles, Spawn, Send, Report, Wait, List, Stop);
