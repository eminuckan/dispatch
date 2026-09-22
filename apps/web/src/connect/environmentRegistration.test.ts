import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  fetchIdentity: vi.fn(),
  configureEnvironment: vi.fn(),
  listEnvironments: vi.fn(),
  createEnvironment: vi.fn(),
  rotateCredential: vi.fn(),
}));

vi.mock("../environments/primary", () => ({
  fetchDispatchConnectEnvironmentIdentity: mocks.fetchIdentity,
  configureDispatchConnectEnvironment: mocks.configureEnvironment,
}));

vi.mock("./dispatchConnect", () => ({
  listDispatchConnectEnvironments: mocks.listEnvironments,
  createDispatchConnectEnvironment: mocks.createEnvironment,
  rotateDispatchConnectEnvironmentCredential: mocks.rotateCredential,
}));

import { ensurePrimaryDispatchConnectEnvironmentLinked } from "./environmentRegistration";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchIdentity.mockResolvedValue({ publicKey: "pk-local", label: "My Mac" });
  mocks.configureEnvironment.mockResolvedValue(undefined);
});

describe("Flow Connect environment linking", () => {
  it("registers a new environment without publishing remote endpoints", async () => {
    mocks.listEnvironments.mockResolvedValue([]);
    mocks.createEnvironment.mockResolvedValue({
      environment: { id: "env-connect", publicKey: "pk-local", label: "My Mac", endpoints: [] },
      credential: "credential-new",
    });

    await ensurePrimaryDispatchConnectEnvironmentLinked("https://connect.dispatch.test");

    expect(mocks.createEnvironment).toHaveBeenCalledWith({
      baseUrl: "https://connect.dispatch.test",
      label: "My Mac",
      publicKey: "pk-local",
      endpoints: [],
    });
    expect(mocks.rotateCredential).not.toHaveBeenCalled();
    expect(mocks.configureEnvironment).toHaveBeenCalledWith({
      baseUrl: "https://connect.dispatch.test",
      environmentId: "env-connect",
      credential: "credential-new",
    });
  });

  it("reuses the existing Connect identity by rotating only its credential", async () => {
    mocks.listEnvironments.mockResolvedValue([
      { id: "env-existing", publicKey: "pk-local", label: "My Mac", endpoints: [] },
    ]);
    mocks.rotateCredential.mockResolvedValue("credential-rotated");

    await ensurePrimaryDispatchConnectEnvironmentLinked("https://connect.dispatch.test");

    expect(mocks.createEnvironment).not.toHaveBeenCalled();
    expect(mocks.rotateCredential).toHaveBeenCalledWith({
      baseUrl: "https://connect.dispatch.test",
      environmentId: "env-existing",
    });
    expect(mocks.configureEnvironment).toHaveBeenCalledWith({
      baseUrl: "https://connect.dispatch.test",
      environmentId: "env-existing",
      credential: "credential-rotated",
    });
  });
});
