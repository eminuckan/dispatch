import {
  FlowError,
  FlowJob,
  FlowModelSelection,
  FlowSendInput,
  FlowSpawnInput,
  FlowThreadView,
  FlowWaitInput,
  FlowWorker,
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
    }),
  ),
  failure: FlowError,
  dependencies,
})
  .annotate(Tool.Title, "List Flow models")
  .annotate(Tool.Readonly, true);

const Spawn = Tool.make("flow_spawn", {
  description:
    "Start one persistent Dispatch worker thread for a concrete assignment. Choose its model explicitly with flow_models. The worker gets an isolated Git worktree and only the assignment you supply; it does not inherit this conversation. Reuse id on retry. The lead owns review and integration.",
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
    "Send a follow-up assignment to an idle worker, preserving that worker's thread and model. Reuse id on retry. Open the worker thread for its full history.",
  parameters: FlowSendInput,
  success: FlowJob,
  failure: FlowError,
  dependencies,
})
  .annotate(Tool.Title, "Message Flow worker")
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.Readonly, false);

const Wait = Tool.make("flow_wait", {
  description:
    "Read worker progress and results. Optionally wait up to 30 seconds for a worker to finish. Results are concise; the worker thread holds its full conversation. The lead must verify the result before answering the user.",
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
    "Stop a worker owned by this Flow. Its thread and worktree remain available for inspection. The worker cannot receive new assignments after stopping.",
  parameters: Schema.Struct({ workerThreadId: ThreadId }),
  success: FlowWorker,
  failure: FlowError,
  dependencies,
})
  .annotate(Tool.Title, "Stop Flow worker")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true);

export const FlowToolkit = Toolkit.make(Models, Spawn, Send, Wait, List, Stop);
