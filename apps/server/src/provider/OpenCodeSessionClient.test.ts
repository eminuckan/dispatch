import { OpenCode, type SessionInfo, type SessionMessageAssistant } from "@opencode/client";
import { describe, expect, it } from "vite-plus/test";
import { makeOpenCodeSessionClient } from "./OpenCodeSessionClient.ts";

const directory = "/workspace/project";
const session: SessionInfo = {
  id: "ses_one",
  projectID: "prj_one",
  location: { directory },
  title: "Example",
  time: { created: 1, updated: 1 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
};
const assistant: SessionMessageAssistant = {
  id: "msg_assistant",
  type: "assistant",
  agent: "build",
  model: { id: "deepseek-v4-flash", providerID: "opencode-go" },
  time: { created: 2, completed: 3 },
  content: [{ type: "text", text: "Hello" }],
  finish: "stop",
  cost: 0,
  tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
};
const user = { id: "msg_user", type: "user", text: "Hi", time: { created: 1 } };

type Handler = (request: Request) => Response | undefined | Promise<Response | undefined>;
function harness(handler: Handler = () => undefined) {
  const requests: Array<{ method: string; url: URL; body: unknown }> = [];
  let events: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  let sequence = 0;
  const emit = (type: string, data: unknown = {}) => {
    events!.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ id: `evt_${++sequence}`, created: 2, type, data, durable: { aggregateID: session.id, seq: 1, version: 1 } })}\n\n`,
      ),
    );
  };
  const native = OpenCode.make({
    baseUrl: "http://opencode.test",
    fetch: Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        requests.push({
          method: request.method,
          url,
          body: request.body === null ? undefined : await request.clone().json(),
        });
        if (url.pathname === "/api/event")
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                events = controller;
                request.signal.addEventListener("abort", () => controller.close(), { once: true });
                emit("server.connected");
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        const custom = await handler(request);
        if (custom) return custom;
        if (url.pathname === "/api/session" || url.pathname === `/api/session/${session.id}`)
          return Response.json({ data: session });
        if (url.pathname.endsWith("/prompt") || url.pathname.endsWith("/interrupt"))
          return Response.json({});
        if (url.pathname.endsWith("/inbox")) return Response.json({ data: [] });
        if (url.pathname.endsWith("/message")) return Response.json({ data: [], cursor: {} });
        return new Response(null, { status: 204 });
      },
      { preconnect: () => undefined },
    ),
  });
  const client = makeOpenCodeSessionClient(native, directory);
  const ready = async () => {
    await client.session.create({ permission: [{ action: "*", resource: "*", effect: "ask" }] });
    const abort = new AbortController();
    const { stream } = await client.event.subscribe(undefined, { signal: abort.signal });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("server.connected");
    return { iterator, abort };
  };
  return { client, requests, emit, ready };
}

describe("OpenCode v2 session transport", () => {
  it("uses native model, agent, instruction and prompt routes with cwd and file URIs", async () => {
    const { client, requests } = harness();
    await client.session.create({
      permission: [{ action: "shell", resource: "*", effect: "ask" }],
    });
    await client.session.promptAsync({
      sessionID: session.id,
      messageID: "msg_dispatch",
      model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
      agent: "build",
      variant: "high",
      system: "Instructions",
      parts: [
        { type: "text", text: "Hi" },
        { uri: "file:///tmp/image.png", name: "image.png" },
      ],
    });
    expect(requests[0]?.body).toEqual({
      location: { directory },
      permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    });
    expect(requests.map((r) => r.url.pathname)).toEqual([
      "/api/session",
      `/api/session/${session.id}/agent`,
      `/api/session/${session.id}/model`,
      `/api/experimental/session/${session.id}/instructions/entries/dispatch`,
      `/api/session/${session.id}/prompt`,
    ]);
    expect(requests[2]?.body).toEqual({
      model: { id: "deepseek-v4-flash", providerID: "opencode-go", variant: "high" },
    });
    expect(requests.at(-1)?.body).toEqual({
      id: "msg_dispatch",
      text: "Hi",
      files: [{ uri: "file:///tmp/image.png", name: "image.png" }],
      delivery: "steer",
    });
  });

  it("continues message pages without combining cursor and order and retains ownership", async () => {
    const { client, requests } = harness((request) => {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/message")) return;
      return url.searchParams.has("cursor")
        ? Response.json({ data: [assistant], cursor: {} })
        : Response.json({ data: [user], cursor: { next: "page_two" } });
    });
    const history = await client.session.messages({ sessionID: session.id });
    expect(history.data.map((entry) => entry.info.role)).toEqual(["user", "assistant"]);
    expect(history.data[1]?.info).toMatchObject({ parentID: user.id, tokens: assistant.tokens });
    expect(requests[0]?.url.searchParams.get("order")).toBe("asc");
    expect(requests[1]?.url.searchParams.get("cursor")).toBe("page_two");
    expect(requests[1]?.url.searchParams.has("order")).toBe(false);
  });

  it("streams text deltas, tool output and usage from native events without unrelated sessions", async () => {
    const { emit, ready } = harness();
    const { iterator, abort } = await ready();
    try {
      emit("session.step.started", {
        sessionID: "ses_other",
        assistantMessageID: "other",
        agent: "build",
        model: assistant.model,
        started: 1,
      });
      emit("session.inbox.enqueued", {
        sessionID: session.id,
        inboxID: user.id,
        item: { type: "user", payload: { text: "Hi" }, delivery: "steer" },
      });
      expect((await iterator.next()).value).toMatchObject({
        type: "message.updated",
        properties: { info: { id: user.id, role: "user" } },
      });
      emit("session.step.started", {
        sessionID: session.id,
        assistantMessageID: assistant.id,
        agent: "build",
        model: assistant.model,
        started: 1,
      });
      expect((await iterator.next()).value).toMatchObject({
        properties: { info: { parentID: user.id } },
      });
      emit("session.text.started", {
        sessionID: session.id,
        assistantMessageID: assistant.id,
        ordinal: 0,
      });
      expect((await iterator.next()).value).toMatchObject({
        type: "message.part.updated",
        properties: { part: { text: "" } },
      });
      emit("session.text.delta", {
        sessionID: session.id,
        assistantMessageID: assistant.id,
        ordinal: 0,
        delta: "Hello",
      });
      expect((await iterator.next()).value).toMatchObject({
        type: "message.part.delta",
        properties: { delta: "Hello", partID: `${assistant.id}:text:0` },
      });
      emit("session.text.ended", {
        sessionID: session.id,
        assistantMessageID: assistant.id,
        ordinal: 0,
        text: "Hello",
      });
      expect((await iterator.next()).value).toMatchObject({
        properties: { part: { text: "Hello" } },
      });
      const tool = {
        sessionID: session.id,
        assistantMessageID: assistant.id,
        id: "call_one",
        name: "shell",
      };
      emit("session.tool.input.started", tool);
      expect((await iterator.next()).value).toMatchObject({
        properties: { part: { callID: "call_one", state: { status: "pending" } } },
      });
      emit("session.tool.called", { ...tool, input: { command: "pwd" } });
      expect((await iterator.next()).value).toMatchObject({
        properties: { part: { state: { status: "running", input: { command: "pwd" } } } },
      });
      emit("session.tool.success", { ...tool, content: [{ type: "text", text: directory }] });
      expect((await iterator.next()).value).toMatchObject({
        properties: { part: { state: { status: "completed", output: directory } } },
      });
      emit("session.step.ended", {
        sessionID: session.id,
        assistantMessageID: assistant.id,
        finish: "stop",
        cost: 0,
        tokens: assistant.tokens,
      });
      expect((await iterator.next()).value).toMatchObject({
        properties: { part: { type: "step-finish", tokens: assistant.tokens } },
      });
      emit("session.execution.succeeded", { sessionID: session.id });
      expect((await iterator.next()).value).toMatchObject({
        type: "session.status",
        properties: { status: { type: "idle" } },
      });
    } finally {
      abort.abort();
      await iterator.return();
    }
  });

  it("recovers a command receipt with server allocated IDs when the enqueue event was missed", async () => {
    let submitted = false;
    const { client, requests } = harness((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/command")) {
        submitted = true;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message"))
        return Response.json({ data: submitted ? [user] : [], cursor: {} });
      if (path.endsWith(`/message/${user.id}`)) return Response.json({ data: user });
    });
    await client.session.command({
      sessionID: session.id,
      messageID: "msg_dispatch",
      command: "review",
      arguments: "changes",
      model: "opencode-go/deepseek-v4-flash",
      parts: [],
    });
    const receipt = await client.session.message({
      sessionID: session.id,
      messageID: "msg_dispatch",
    });
    expect(receipt.data?.info).toMatchObject({ id: "msg_dispatch", role: "user" });
    expect(requests.find((r) => r.url.pathname.endsWith("/command"))?.body).toEqual({
      name: "review",
      text: "changes",
      files: [],
      delivery: "steer",
    });
    expect(requests.at(-1)?.url.pathname).toBe(`/api/session/${session.id}/message/${user.id}`);
  });

  it("translates permission and typed form answers to their owning session", async () => {
    const { client, requests, emit, ready } = harness();
    const { iterator, abort } = await ready();
    try {
      emit("permission.asked", {
        id: "perm_one",
        sessionID: session.id,
        action: "shell",
        resources: ["pwd"],
        save: ["pwd *"],
      });
      expect((await iterator.next()).value).toMatchObject({
        type: "permission.asked",
        properties: { permission: "shell", patterns: ["pwd"] },
      });
      await client.permission.reply({ requestID: "perm_one", reply: "once" });
      expect(requests.at(-1)).toMatchObject({ body: { decision: "once" } });
      expect(requests.at(-1)?.url.pathname).toBe(
        `/api/session/${session.id}/permission/perm_one/reply`,
      );
      emit("form.created", {
        form: {
          id: "form_one",
          sessionID: session.id,
          fields: [
            { key: "count", type: "integer", title: "Count" },
            { key: "enabled", type: "boolean", title: "Enabled" },
            { key: "names", type: "multiselect", options: [{ value: "a", label: "A" }] },
          ],
        },
      });
      expect((await iterator.next()).value).toMatchObject({
        type: "question.asked",
        properties: {
          questions: [
            { header: "count" },
            { header: "enabled" },
            { header: "names", multiple: true },
          ],
        },
      });
      await client.question.reply({ requestID: "form_one", answers: [["2"], ["false"], ["a"]] });
      expect(requests.at(-1)?.body).toEqual({ answer: { count: 2, enabled: false, names: ["a"] } });
      expect(requests.at(-1)?.url.pathname).toBe(`/api/session/${session.id}/form/form_one/reply`);
    } finally {
      abort.abort();
      await iterator.return();
    }
  });

  it("does not report idle while an inbox item is queued before execution starts", async () => {
    const { client } = harness((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/active")) return Response.json({ data: {} });
      if (path.endsWith("/inbox"))
        return Response.json({ data: [{ id: "inbox_one", type: "user" }] });
    });
    await client.session.get({ sessionID: session.id });
    expect((await client.session.status()).data[session.id]).toEqual({ type: "busy" });
  });

  it("passes cancellation to native interrupt and aborts an open event stream", async () => {
    const { client, requests, ready } = harness();
    const { iterator, abort } = await ready();
    await client.session.abort({ sessionID: session.id });
    expect(requests.slice(-2).map((request) => request.url.pathname)).toEqual([
      `/api/session/${session.id}/interrupt`,
      `/api/experimental/session/${session.id}/wait`,
    ]);
    const ended = iterator.next();
    abort.abort();
    expect(await ended).toEqual({ done: true, value: undefined });
  });
  it("waits for execution termination before acknowledging interruption", async () => {
    const waiting = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<Response>();
    let settled = false;
    const { client } = harness((request) => {
      if (new URL(request.url).pathname.endsWith("/wait")) {
        waiting.resolve();
        return stopped.promise;
      }
    });
    const interruption = client.session.abort({ sessionID: session.id }).then(() => {
      settled = true;
    });
    await waiting.promise;
    expect(settled).toBe(false);
    stopped.resolve(new Response(null, { status: 204 }));
    await interruption;
    expect(settled).toBe(true);
  });

  it("does not fail a turn when v2 supersedes an execution while steering", async () => {
    const { ready, emit } = harness();
    const { iterator, abort } = await ready();
    try {
      emit("session.execution.interrupted", { sessionID: session.id, reason: "superseded" });
      emit("session.execution.started", { sessionID: session.id });
      expect((await iterator.next()).value).toMatchObject({
        type: "session.status",
        properties: { status: { type: "busy" } },
      });
      emit("session.execution.failed", {
        sessionID: session.id,
        error: { type: "provider", message: "Model unavailable" },
      });
      expect((await iterator.next()).value).toMatchObject({
        type: "session.error",
        properties: { error: { data: { message: "Model unavailable" } } },
      });
    } finally {
      abort.abort();
      await iterator.return();
    }
  });
  it("rejects ambiguous command admissions without assigning a competing user's ID", async () => {
    let submitted = false;
    const { client, emit, ready } = harness((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/command")) {
        submitted = true;
        for (const id of ["msg_other", "msg_command"])
          emit("session.inbox.enqueued", {
            sessionID: session.id,
            inboxID: id,
            item: { type: "user", payload: { text: "Hi" }, delivery: "steer" },
          });
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message"))
        return Response.json({
          data: submitted ? [user, { ...user, id: "msg_other" }] : [],
          cursor: {},
        });
    });
    const { iterator, abort } = await ready();
    try {
      const received = iterator.next();
      await expect(
        client.session.command({
          sessionID: session.id,
          messageID: "msg_dispatch",
          command: "review",
          arguments: "",
          model: "opencode-go/deepseek-v4-flash",
          parts: [],
        }),
      ).rejects.toThrow("ambiguous");
      expect((await received).value).toMatchObject({ properties: { info: { id: "msg_other" } } });
      expect((await iterator.next()).value).toMatchObject({
        properties: { info: { id: "msg_command" } },
      });
    } finally {
      abort.abort();
      await iterator.return();
    }
  });

  it("serializes two concurrent native commands and preserves their distinct receipts", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstRelease = Promise.withResolvers<Response>();
    const history: Array<typeof user> = [];
    let commands = 0;
    const { client } = harness(async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/command")) {
        commands += 1;
        history.unshift({ ...user, id: `msg_native_${commands}` });
        if (commands === 1) {
          firstStarted.resolve();
          return firstRelease.promise;
        }
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message")) return Response.json({ data: history, cursor: {} });
      const message = history.find((entry) => path.endsWith(`/message/${entry.id}`));
      if (message) return Response.json({ data: message });
    });
    const input = {
      sessionID: session.id,
      command: "review",
      arguments: "",
      model: "opencode-go/deepseek-v4-flash",
      parts: [],
    };
    const first = client.session.command({ ...input, messageID: "msg_dispatch_1" });
    const second = client.session.command({ ...input, messageID: "msg_dispatch_2" });
    await firstStarted.promise;
    expect(commands).toBe(1);
    firstRelease.resolve(new Response(null, { status: 204 }));
    await Promise.all([first, second]);
    expect(commands).toBe(2);
    expect(
      (await client.session.message({ sessionID: session.id, messageID: "msg_dispatch_1" })).data
        ?.info.id,
    ).toBe("msg_dispatch_1");
    expect(
      (await client.session.message({ sessionID: session.id, messageID: "msg_dispatch_2" })).data
        ?.info.id,
    ).toBe("msg_dispatch_2");
  });
});
