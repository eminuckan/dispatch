import type {
  OpenCodeClient,
  PermissionRuleset,
  SessionInfo,
  SessionMessageInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  V2Event,
  FormInfo,
  FormAnswer,
  SessionPromptInput,
  McpAddInput,
  ToolContent,
  ToolContent1,
} from "@opencode/client";
import type {
  Event,
  Session,
  Message,
  Part,
  ToolPart,
  PermissionRequest,
  QuestionRequest,
} from "@opencode-ai/sdk/v2";

type RequestOptions = Parameters<OpenCodeClient["server"]["info"]>[0];
const toolContent = (c: ToolContent1): ToolContent =>
  c.type === "text"
    ? c
    : { type: c.type, uri: c.uri, mime: c.mime, ...(c.name !== undefined ? { name: c.name } : {}) };

// Keep the adapter's tested message/part state machine independent of the wire
// protocol. These legacy SDK imports are types only; every request below uses v2.
const noTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
const errorInfo = (error: { type: string; message: string }) => ({
  name: "UnknownError" as const,
  data: { message: error.message },
});
const sessionInfo = (session: SessionInfo): Session => ({
  id: session.id,
  slug: session.id,
  projectID: session.projectID,
  directory: session.location.directory,
  title: session.title ?? "",
  version: "2",
  time: session.time,
  ...(session.parentID ? { parentID: session.parentID } : {}),
});

function toolPart(
  sessionID: string,
  messageID: string,
  tool: SessionMessageAssistantTool,
): ToolPart {
  const time = {
    start: tool.time.ran ?? tool.time.created,
    end: tool.time.completed ?? tool.time.created,
  };
  const state = tool.state;
  return {
    id: `${messageID}:tool:${tool.id}`,
    sessionID,
    messageID,
    type: "tool",
    callID: tool.id,
    tool: tool.name,
    state:
      state.status === "streaming"
        ? { status: "pending", input: {}, raw: state.input }
        : state.status === "running"
          ? { status: "running", input: state.input, time, metadata: state.metadata }
          : state.status === "error"
            ? {
                status: "error",
                input: state.input,
                error: state.error.message,
                time,
                ...(state.metadata ? { metadata: state.metadata } : {}),
              }
            : {
                status: "completed",
                input: state.input,
                output: state.content
                  .filter((c) => c.type === "text")
                  .map((c) => c.text)
                  .join("\n"),
                title: tool.name,
                metadata: state.metadata ?? {},
                time,
              },
  };
}

function messageInfo(
  sessionID: string,
  message: SessionMessageInfo,
  directory: string,
  parentID: string,
): { info: Message; parts: Part[] } | undefined {
  if (message.type === "user")
    return {
      info: {
        id: message.id,
        sessionID,
        role: "user",
        time: message.time,
        agent: "",
        model: { providerID: "", modelID: "" },
      },
      parts: [
        {
          id: `${message.id}:text:0`,
          sessionID,
          messageID: message.id,
          type: "text",
          text: message.text,
        },
      ],
    };
  if (message.type !== "assistant") return undefined;
  return {
    info: {
      id: message.id,
      sessionID,
      role: "assistant",
      time: message.time,
      parentID,
      agent: message.agent,
      mode: message.agent,
      modelID: message.model.id,
      providerID: message.model.providerID,
      path: { cwd: directory, root: directory },
      cost: message.cost ?? 0,
      tokens: message.tokens ?? noTokens(),
      ...(message.finish ? { finish: message.finish } : {}),
      ...(message.error ? { error: errorInfo(message.error) } : {}),
    },
    parts: message.content.map((content, ordinal): Part =>
      content.type === "tool"
        ? toolPart(sessionID, message.id, content)
        : {
            id: `${message.id}:${content.type}:${ordinal}`,
            sessionID,
            messageID: message.id,
            type: content.type,
            text: content.text,
            time: {
              start: message.time.created,
              ...(message.time.completed !== undefined ? { end: message.time.completed } : {}),
            },
          },
    ),
  };
}

/** Normalize native v2 requests and events for the provider lifecycle adapter. */
export function makeOpenCodeSessionClient(native: OpenCodeClient, directory: string) {
  const sessions = new Map<string, SessionInfo>();
  const parents = new Map<string, string>();
  const permissions = new Map<string, PermissionRequest>();
  const forms = new Map<string, FormInfo>();
  const messages = new Map<string, SessionMessageAssistant>();
  const tools = new Map<string, SessionMessageAssistantTool>();
  // v2 commands allocate their own inbox IDs. Preserve the adapter's admission
  // ID across the enqueue event, HTTP acknowledgement, and history recovery.
  const commandReceipts = new Map<string, { sessionID: string; nativeID: string }>();
  const aliases = new Map<string, string>();
  const commandTails = new Map<string, Promise<void>>();
  const commandAdmissions = new Map<string, Promise<void>>();
  const finishedSessions = new Set<string>();
  const retireReceipts = (sessionID: string) => {
    for (const [id, receipt] of commandReceipts) {
      if (receipt.sessionID !== sessionID) continue;
      aliases.delete(receipt.nativeID);
      commandReceipts.delete(id);
    }
    finishedSessions.delete(sessionID);
  };
  const waitForAdmission = async (pending: Promise<void>, signal?: AbortSignal) => {
    if (!signal) return pending;
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };
  const mapMessage = (sessionID: string, message: SessionMessageInfo, parentID: string) =>
    messageInfo(
      sessionID,
      message.type === "user" && aliases.has(message.id)
        ? { ...message, id: aliases.get(message.id)! }
        : message,
      directory,
      parentID,
    );
  const commandCandidates = async (sessionID: string, options?: RequestOptions) => {
    const [page, inbox] = await Promise.all([
      native.message.list({ sessionID, order: "desc", type: "user", limit: 100 }, options),
      native.session.inbox.list({ sessionID }, options),
    ]);
    return new Set([
      ...page.data.map((message) => message.id),
      ...inbox.filter((item) => item.type === "user").map((item) => item.id),
    ]);
  };
  const remember = (session: SessionInfo) => {
    sessions.set(session.id, session);
    return sessionInfo(session);
  };
  const permissionInfo = (
    p: Extract<V2Event, { type: "permission.asked" }>["data"],
  ): PermissionRequest => {
    const result = {
      id: p.id,
      sessionID: p.sessionID,
      permission: p.action,
      patterns: p.resources,
      metadata: p.metadata ?? {},
      always: p.save ?? [],
    };
    permissions.set(p.id, result);
    return result;
  };
  const questionInfo = (form: FormInfo): QuestionRequest => {
    forms.set(form.id, form);
    return {
      id: form.id,
      sessionID: form.sessionID,
      questions: form.fields
        .filter((f) => !("hidden" in f && f.hidden))
        .map((field) => ({
          header: field.key,
          question: field.description ?? field.title ?? field.key,
          options:
            field.type === "string" || field.type === "multiselect"
              ? (field.options ?? []).map((option) => ({
                  label: option.value,
                  description: option.description ?? option.label,
                }))
              : field.type === "boolean"
                ? [
                    { label: "true", description: "Yes" },
                    { label: "false", description: "No" },
                  ]
                : [],
          multiple: field.type === "multiselect",
          custom:
            field.type === "string"
              ? field.custom !== false
              : field.type !== "boolean" && field.type !== "multiselect",
        })),
    };
  };
  const get = async (sessionID: string, options?: RequestOptions) =>
    remember(await native.session.get({ sessionID }, options));
  const history = async (sessionID: string, options?: RequestOptions) => {
    const result: Array<{ info: Message; parts: Part[] }> = [];
    let cursor: string | undefined;
    let parentID = "";
    do {
      const page = await native.message.list(
        { sessionID, limit: 100, ...(cursor ? { cursor } : { order: "asc" }) },
        options,
      );
      for (const message of page.data) {
        if (message.type === "user") parentID = aliases.get(message.id) ?? message.id;
        const entry = mapMessage(sessionID, message, parentID);
        if (entry) result.push(entry);
      }
      cursor = page.cursor.next ?? undefined;
    } while (cursor);
    return result;
  };
  const select = async (
    input: {
      sessionID: string;
      model?: { providerID: string; modelID: string };
      agent?: string;
      variant?: string;
    },
    options?: RequestOptions,
  ) => {
    if (input.agent)
      await native.session.switchAgent({ sessionID: input.sessionID, agent: input.agent }, options);
    if (input.model)
      await native.session.switchModel(
        {
          sessionID: input.sessionID,
          model: {
            id: input.model.modelID,
            providerID: input.model.providerID,
            ...(input.variant ? { variant: input.variant } : {}),
          },
        },
        options,
      );
  };
  const normalize = async (event: V2Event, options?: RequestOptions): Promise<Event[]> => {
    if (event.type === "server.connected")
      return [{ id: event.id, type: "server.connected", properties: {} }];
    if (!("created" in event)) return [];
    const sessionID =
      "sessionID" in event.data && typeof event.data.sessionID === "string"
        ? event.data.sessionID
        : undefined;
    if (sessionID && !sessions.has(sessionID) && event.type !== "session.created") return [];
    const admission = sessionID ? commandAdmissions.get(sessionID) : undefined;
    if (admission) await waitForAdmission(admission, options?.signal);
    const partEvent = (part: Part): Event => ({
      id: event.id,
      type: "message.part.updated",
      properties: { sessionID: part.sessionID, part, time: event.created },
    });
    switch (event.type) {
      case "location.shutdown":
        if (event.location && event.location.directory !== directory) return [];
        throw new Error("OpenCode location reloaded; reconnect to recover the session.");
      case "session.created": {
        if (
          !sessions.has(event.data.sessionID) &&
          (!event.data.parentID || !sessions.has(event.data.parentID))
        )
          return [];
        const info = await get(event.data.sessionID, options);
        return [
          { id: event.id, type: "session.created", properties: { sessionID: info.id, info } },
        ];
      }
      case "session.renamed": {
        const info = await get(event.data.sessionID, options);
        return [
          { id: event.id, type: "session.updated", properties: { sessionID: info.id, info } },
        ];
      }
      case "session.deleted": {
        const known = sessions.get(event.data.sessionID);
        sessions.delete(event.data.sessionID);
        parents.delete(event.data.sessionID);
        retireReceipts(event.data.sessionID);
        return known
          ? [
              {
                id: event.id,
                type: "session.deleted",
                properties: { sessionID: known.id, info: sessionInfo(known) },
              },
            ]
          : [];
      }
      case "session.inbox.enqueued": {
        if (event.data.item.type !== "user") return [];
        const messageID = aliases.get(event.data.inboxID) ?? event.data.inboxID;
        parents.set(event.data.sessionID, messageID);
        return [
          {
            id: event.id,
            type: "message.updated",
            properties: {
              sessionID: event.data.sessionID,
              info: {
                id: messageID,
                sessionID: event.data.sessionID,
                role: "user",
                time: { created: event.created },
                agent: "",
                model: { providerID: "", modelID: "" },
              },
            },
          },
        ];
      }
      case "session.step.started": {
        const data = event.data;
        const message: SessionMessageAssistant = {
          id: data.assistantMessageID,
          type: "assistant",
          agent: data.agent,
          model: data.model,
          time: { created: data.started },
          content: [],
        };
        messages.set(message.id, message);
        const entry = messageInfo(
          data.sessionID,
          message,
          directory,
          parents.get(data.sessionID) ?? "",
        )!;
        return [
          {
            id: event.id,
            type: "message.updated",
            properties: { sessionID: data.sessionID, info: entry.info },
          },
        ];
      }
      case "session.text.started":
      case "session.reasoning.started":
      case "session.text.delta":
      case "session.reasoning.delta":
      case "session.text.ended":
      case "session.reasoning.ended": {
        const data = event.data;
        const type = event.type.startsWith("session.text.") ? "text" : "reasoning";
        const id = `${data.assistantMessageID}:${type}:${data.ordinal}`;
        if ("delta" in data)
          return [
            {
              id: event.id,
              type: "message.part.delta",
              properties: {
                sessionID: data.sessionID,
                messageID: data.assistantMessageID,
                partID: id,
                field: "text",
                delta: data.delta,
              },
            },
          ];
        const value = "text" in data ? data.text : "";
        const time = {
          start: messages.get(data.assistantMessageID)?.time.created ?? event.created,
          ...(event.type.endsWith(".ended") ? { end: event.created } : {}),
        };
        return [
          partEvent({
            id,
            messageID: data.assistantMessageID,
            sessionID: data.sessionID,
            type,
            text: value,
            time,
          }),
        ];
      }
      case "session.tool.input.started": {
        const d = event.data;
        const tool: SessionMessageAssistantTool = {
          type: "tool",
          id: d.id,
          name: d.name,
          state: { status: "streaming", input: "" },
          time: { created: event.created },
        };
        tools.set(`${d.assistantMessageID}:${d.id}`, tool);
        return [partEvent(toolPart(d.sessionID, d.assistantMessageID, tool))];
      }
      case "session.tool.called":
      case "session.tool.progress":
      case "session.tool.success":
      case "session.tool.failed": {
        const d = event.data;
        const key = `${d.assistantMessageID}:${d.id}`;
        const tool = tools.get(key);
        if (!tool) {
          const entry = await native.session.message.get(
            { sessionID: d.sessionID, messageID: d.assistantMessageID },
            options,
          );
          const mapped = messageInfo(d.sessionID, entry, directory, parents.get(d.sessionID) ?? "");
          return (
            mapped?.parts
              .filter((part) => part.type === "tool" && part.callID === d.id)
              .map(partEvent) ?? []
          );
        }
        if (event.type === "session.tool.called") {
          tool.state = { status: "running", input: event.data.input, metadata: {} };
          tool.time.ran = event.created;
        } else if (event.type === "session.tool.success") {
          tool.state = {
            status: "completed",
            input: tool.state.status === "streaming" ? {} : tool.state.input,
            content: [
              toolContent(event.data.content[0]),
              ...event.data.content.slice(1).map(toolContent),
            ],
            ...(event.data.metadata ? { metadata: event.data.metadata } : {}),
          };
          tool.time.completed = event.created;
        } else if (event.type === "session.tool.failed") {
          tool.state = {
            status: "error",
            input: tool.state.status === "streaming" ? {} : tool.state.input,
            error: event.data.error,
          };
          tool.time.completed = event.created;
        } else if (tool.state.status === "running") {
          tool.state = { ...tool.state, metadata: event.data.metadata };
        }
        return [partEvent(toolPart(d.sessionID, d.assistantMessageID, tool))];
      }
      case "session.step.ended": {
        const d = event.data;
        messages.delete(d.assistantMessageID);
        for (const key of tools.keys())
          if (key.startsWith(`${d.assistantMessageID}:`)) tools.delete(key);
        return [
          partEvent({
            id: `${d.assistantMessageID}:finish`,
            messageID: d.assistantMessageID,
            sessionID: d.sessionID,
            type: "step-finish",
            reason: d.finish,
            cost: d.cost,
            tokens: d.tokens,
          }),
        ];
      }
      case "session.status":
        return [{ id: event.id, type: "session.status", properties: event.data }];
      case "session.execution.started":
        finishedSessions.delete(event.data.sessionID);
        return [
          {
            id: event.id,
            type: "session.status",
            properties: { sessionID: event.data.sessionID, status: { type: "busy" } },
          },
        ];
      case "session.execution.succeeded":
      case "session.idle":
        finishedSessions.add(event.data.sessionID);
        return [
          {
            id: event.id,
            type: "session.status",
            properties: { sessionID: event.data.sessionID, status: { type: "idle" } },
          },
        ];
      case "session.execution.failed":
        finishedSessions.add(event.data.sessionID);
        return [
          {
            id: event.id,
            type: "session.error",
            properties: { sessionID: event.data.sessionID, error: errorInfo(event.data.error) },
          },
        ];
      case "session.execution.interrupted":
        if (event.data.reason === "superseded") return [];
        finishedSessions.add(event.data.sessionID);
        return [
          {
            id: event.id,
            type: "session.error",
            properties: {
              sessionID: event.data.sessionID,
              error: {
                name: "MessageAbortedError",
                data: { message: "OpenCode execution interrupted" },
              },
            },
          },
        ];
      case "session.compaction.ended":
        return [
          {
            id: event.id,
            type: "session.compacted",
            properties: { sessionID: event.data.sessionID },
          },
        ];
      case "permission.asked":
        return [{ id: event.id, type: "permission.asked", properties: permissionInfo(event.data) }];
      case "permission.replied":
        permissions.delete(event.data.requestID);
        return [{ id: event.id, type: "permission.replied", properties: event.data }];
      case "form.created":
        return [
          { id: event.id, type: "question.asked", properties: questionInfo(event.data.form) },
        ];
      case "form.replied": {
        const form = forms.get(event.data.id);
        const answers = (
          form?.fields.filter((field) => !("hidden" in field && field.hidden)) ?? []
        ).map((field) => {
          const value = event.data.answer[field.key];
          return Array.isArray(value) ? value : value === undefined ? [] : [String(value)];
        });
        forms.delete(event.data.id);
        return [
          {
            id: event.id,
            type: "question.replied",
            properties: { sessionID: event.data.sessionID, requestID: event.data.id, answers },
          },
        ];
      }
      case "form.cancelled":
        forms.delete(event.data.id);
        return [
          {
            id: event.id,
            type: "question.rejected",
            properties: { sessionID: event.data.sessionID, requestID: event.data.id },
          },
        ];
      default:
        return [];
    }
  };
  return {
    native,
    command: { list: async () => native.command.list({ location: { directory } }) },
    event: {
      subscribe: async (
        _input?: undefined,
        options?: { signal?: AbortSignal; onSseError?: (cause: unknown) => void },
      ) => ({
        stream: (async function* () {
          try {
            for await (const event of native.event.subscribe(
              options?.signal ? { signal: options.signal } : undefined,
            )) {
              for (const mapped of await normalize(
                event,
                options?.signal ? { signal: options.signal } : undefined,
              ))
                yield mapped;
            }
          } catch (cause) {
            options?.onSseError?.(cause);
            throw cause;
          }
        })(),
      }),
    },
    mcp: {
      add: async (
        input: { name: string; config: McpAddInput["config"] },
        options?: RequestOptions,
      ) =>
        native.mcp.add(
          { server: input.name, config: input.config, location: { directory } },
          options,
        ),
    },
    session: {
      create: async (
        input: { title?: string; permission: PermissionRuleset },
        options?: RequestOptions,
      ) => ({
        data: remember(
          await native.session.create(
            { title: input.title, permissions: input.permission, location: { directory } },
            options,
          ),
        ),
      }),
      get: async (input: { sessionID: string }, options?: RequestOptions) => ({
        data: await get(input.sessionID, options),
      }),
      update: async (
        input: { sessionID: string; permission?: PermissionRuleset; title?: string },
        options?: RequestOptions,
      ) => {
        await native.session.update(
          { sessionID: input.sessionID, permissions: input.permission, title: input.title },
          options,
        );
      },
      fork: async (
        input: { sessionID: string; messageID?: string; directory?: string },
        options?: RequestOptions,
      ) => {
        const session = await native.session.fork(
          {
            sessionID: input.sessionID,
            before: input.messageID
              ? (commandReceipts.get(input.messageID)?.nativeID ?? input.messageID)
              : undefined,
          },
          options,
        );
        if (input.directory && input.directory !== session.location.directory) {
          await native.session.move({ sessionID: session.id, directory: input.directory }, options);
          await native.session.wait({ sessionID: session.id }, options);
          return { data: await get(session.id, options) };
        }
        return { data: remember(session) };
      },
      children: async (input: { sessionID: string }, options?: RequestOptions) => {
        const children: Session[] = [];
        let cursor: string | undefined;
        do {
          const page = await native.session.list(
            { parentID: input.sessionID, limit: 100, ...(cursor ? { cursor } : {}) },
            options,
          );
          children.push(...page.data.map(remember));
          cursor = page.cursor.next ?? undefined;
        } while (cursor);
        return { data: children };
      },
      abort: async (input: { sessionID: string }, options?: RequestOptions) => {
        await native.session.interrupt(input, options);
        // The acknowledgement precedes the terminal execution event in v2.
        // Drain the execution before the adapter permits a follow-up or reconnect.
        await native.session.wait(input, options);
      },
      status: async (_input?: undefined, options?: RequestOptions) => {
        const active = await native.session.active(options);
        const data: Record<string, { type: "busy" | "idle" }> = {};
        await Promise.all(
          [...sessions.keys()].map(async (id) => {
            const queued = active[id]
              ? []
              : await native.session.inbox.list({ sessionID: id }, options);
            data[id] = { type: active[id] || queued.length > 0 ? "busy" : "idle" };
          }),
        );
        return { data };
      },
      message: async (
        input: { sessionID: string; messageID: string },
        options?: RequestOptions,
      ) => {
        const pending = commandAdmissions.get(input.sessionID);
        if (pending) await waitForAdmission(pending, options?.signal);
        const messageID = commandReceipts.get(input.messageID)?.nativeID ?? input.messageID;
        const receipt = commandReceipts.get(input.messageID);
        // An enqueued command may not have been delivered to history yet.
        if (receipt?.nativeID) {
          const inbox = await native.session.inbox.list({ sessionID: input.sessionID }, options);
          if (inbox.some((item) => item.id === messageID))
            return {
              data: mapMessage(
                input.sessionID,
                { id: messageID, type: "user", text: "", time: { created: 0 } },
                "",
              ),
            };
        }
        return {
          data: mapMessage(
            input.sessionID,
            await native.session.message.get({ ...input, messageID }, options),
            parents.get(input.sessionID) ?? "",
          ),
        };
      },
      messages: async (input: { sessionID: string }, options?: RequestOptions) => ({
        data: await history(input.sessionID, options),
      }),
      promptAsync: async (
        input: {
          sessionID: string;
          messageID: string;
          model: { providerID: string; modelID: string };
          agent?: string;
          variant?: string;
          system?: string;
          parts: ReadonlyArray<
            { type: "text"; text: string } | NonNullable<SessionPromptInput["files"]>[number]
          >;
        },
        options?: RequestOptions,
      ) => {
        if (finishedSessions.has(input.sessionID)) retireReceipts(input.sessionID);
        await select(input, options);
        if (input.system)
          await native.session.instructions.entry.put(
            { sessionID: input.sessionID, key: "dispatch", value: input.system },
            options,
          );
        parents.set(input.sessionID, input.messageID);
        return native.session.prompt(
          {
            sessionID: input.sessionID,
            id: input.messageID,
            text: input.parts
              .filter((p) => "type" in p)
              .map((p) => ("text" in p ? p.text : ""))
              .join("\n"),
            files: input.parts.filter(
              (p): p is NonNullable<SessionPromptInput["files"]>[number] => "uri" in p,
            ),
            delivery: "steer",
          },
          options,
        );
      },
      command: async (
        input: {
          sessionID: string;
          messageID: string;
          command: string;
          arguments: string;
          model: string;
          agent?: string;
          variant?: string;
          parts: SessionPromptInput["files"];
        },
        options?: RequestOptions,
      ) => {
        const predecessor = commandTails.get(input.sessionID) ?? Promise.resolve();
        const operation = predecessor
          .catch(() => undefined)
          .then(async () => {
            options?.signal?.throwIfAborted();
            if (finishedSessions.has(input.sessionID)) retireReceipts(input.sessionID);
            const separator = input.model.indexOf("/");
            await select(
              {
                ...input,
                model: {
                  providerID: input.model.slice(0, separator),
                  modelID: input.model.slice(separator + 1),
                },
              },
              options,
            );
            const admission = Promise.withResolvers<void>();
            commandAdmissions.set(input.sessionID, admission.promise);
            try {
              const prior = await commandCandidates(input.sessionID, options);
              await native.session.command(
                {
                  sessionID: input.sessionID,
                  name: input.command,
                  text: input.arguments,
                  files: input.parts,
                  delivery: "steer",
                },
                options,
              );
              const after = await commandCandidates(input.sessionID, options);
              const added = [...after].filter((id) => !prior.has(id));
              if (added.length !== 1)
                throw new Error(
                  "OpenCode command receipt is ambiguous; another client may have submitted work to this session.",
                );
              const nativeID = added[0]!;
              commandReceipts.set(input.messageID, { sessionID: input.sessionID, nativeID });
              aliases.set(nativeID, input.messageID);
              parents.set(input.sessionID, input.messageID);
            } finally {
              commandAdmissions.delete(input.sessionID);
              admission.resolve();
            }
          });
        commandTails.set(input.sessionID, operation);
        const release = () => {
          if (commandTails.get(input.sessionID) === operation) commandTails.delete(input.sessionID);
        };
        void operation.then(release, release);
        await waitForAdmission(operation, options?.signal);
      },
      summarize: async (
        input: { sessionID: string; providerID: string; modelID: string; auto: boolean },
        options?: RequestOptions,
      ) => {
        await select({ sessionID: input.sessionID, model: input }, options);
        await native.session.compact({ sessionID: input.sessionID }, options);
        await native.session.wait({ sessionID: input.sessionID }, options);
      },
    },
    permission: {
      list: async (_input?: undefined, options?: RequestOptions) => ({
        data: (await native.permission.request.list({ location: { directory } }, options)).data.map(
          permissionInfo,
        ),
      }),
      reply: async (
        input: { requestID: string; reply: "once" | "always" | "reject" },
        options?: RequestOptions,
      ) => {
        const request = permissions.get(input.requestID);
        if (!request) throw new Error(`Unknown OpenCode permission: ${input.requestID}`);
        await native.permission.reply(
          { sessionID: request.sessionID, requestID: request.id, decision: input.reply },
          options,
        );
        permissions.delete(request.id);
      },
    },
    question: {
      list: async (_input?: undefined, options?: RequestOptions) => ({
        data: (await native.form.list({ location: { directory } }, options)).data.map(questionInfo),
      }),
      reply: async (
        input: { requestID: string; answers: ReadonlyArray<ReadonlyArray<string>> },
        options?: RequestOptions,
      ) => {
        const form = forms.get(input.requestID);
        if (!form) throw new Error(`Unknown OpenCode form: ${input.requestID}`);
        const answer: FormAnswer = {};
        for (const [index, field] of form.fields
          .filter((f) => !("hidden" in f && f.hidden))
          .entries()) {
          const values = input.answers[index] ?? [];
          if (field.type === "multiselect") answer[field.key] = [...values];
          else if (field.type === "number" || field.type === "integer") {
            const value = Number(values[0]);
            if (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value)))
              throw new Error(`A valid ${field.type} is required for ${field.key}`);
            answer[field.key] = value;
          } else if (field.type === "boolean") {
            if (values[0] !== "true" && values[0] !== "false")
              throw new Error(`A boolean is required for ${field.key}`);
            answer[field.key] = values[0] === "true";
          } else answer[field.key] = values.join(", ");
        }
        await native.session.form.reply(
          { sessionID: form.sessionID, formID: form.id, answer },
          options,
        );
        forms.delete(form.id);
      },
    },
  };
}
export type OpenCodeSessionClient = ReturnType<typeof makeOpenCodeSessionClient>;
