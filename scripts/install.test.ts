// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer through a PTY and a gated HTTP fixture.
import { HostProcessArchitecture, HostProcessPlatform } from "@dispatch/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// util-linux's script gives the real installer a terminal without a browser or extra packages.
describe.skipIf(HostProcessPlatform.defaultValue() !== "linux")("installer terminal", () => {
  it.each([false, true])(
    "preserves download and install behavior, including release URL env compatibility (HTTP failure: %s)",
    async (fail) => {
      const root = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "dispatch-install-progress-"),
      );
      const version = "1.2.3";
      const stem = `t3-${version}-linux-${HostProcessArchitecture.defaultValue()}`;
      const archiveName = `${stem}.tar.gz`;
      let resumeDownload: (() => void) | undefined;
      let sawPartialProgress = false;
      let output = "";
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      await NodeFSP.writeFile(
        NodePath.join(root, stem, "payload"),
        NodeCrypto.randomBytes(64 * 1024),
      );
      NodeChildProcess.execFileSync("tar", [
        "-czf",
        NodePath.join(root, archiveName),
        "-C",
        root,
        stem,
      ]);
      const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
      const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const server = NodeHttp.createServer((request, response) => {
        if (request.url?.endsWith("/SHA256SUMS")) {
          response.end(`${checksum}  ${archiveName}\n`);
        } else if (fail) {
          response.writeHead(500).end();
        } else {
          response.writeHead(200, { "Content-Length": archive.length });
          resumeDownload = () => response.end(archive.subarray(Math.floor(archive.length / 2)));
          response.write(archive.subarray(0, Math.floor(archive.length / 2)));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const installer = NodePath.resolve(import.meta.dirname, "install.sh").replaceAll(
        "'",
        "'\\''",
      );
      const child = NodeChildProcess.spawn("script", ["-qec", `sh '${installer}'`, "/dev/null"], {
        env: {
          ...process.env,
          TERM: "xterm",
          NO_COLOR: "1",
          DISPATCH_VERSION: version,
          T3CODE_VERSION: "9.9.9",
          DISPATCH_HOME: NodePath.join(root, "home"),
          T3CODE_HOME: NodePath.join(root, "legacy-home"),
          DISPATCH_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
          T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "legacy-bin"),
          ...(fail
            ? { T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}` }
            : {
                DISPATCH_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
                T3CODE_RELEASE_BASE_URL: "http://127.0.0.1:1",
              }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sawPartialProgress && /\b[1-9]\d?%/.test(output)) {
          sawPartialProgress = true;
          resumeDownload?.();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
        const versions = NodePath.join(root, "home/runtime/versions");
        if (fail) {
          expect(code).not.toBe(0);
          expect(output).toContain("500");
          expect(output).not.toContain("100%");
          expect(output).not.toContain("Installed Dispatch");
          expect(await NodeFSP.readdir(versions)).toEqual([]);
        } else {
          expect(code).toBe(0);
          expect(sawPartialProgress).toBe(true);
          expect(output).toContain("100%");
          expect(output).toContain("0.1 / 0.1 MB");
          expect(output).toContain("Installed Dispatch 1.2.3");
          expect(
            await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
          ).toBe("1.2.3\n");
          expect(
            NodeChildProcess.execFileSync(NodePath.join(root, "bin/t3"), ["--version"], {
              encoding: "utf8",
            }).trim(),
          ).toBe("t3 v1.2.3");
          expect(
            NodeChildProcess.execFileSync(NodePath.join(root, "bin/dispatch"), ["--version"], {
              encoding: "utf8",
            }).trim(),
          ).toBe("t3 v1.2.3");
          expect(await NodeFSP.readdir(versions)).toEqual([version]);
        }
      } finally {
        if (child.exitCode === null) child.kill();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(!["darwin", "linux"].includes(HostProcessPlatform.defaultValue()))(
  "installer home adoption",
  () => {
    it("reuses an existing legacy home before creating the Dispatch home", async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dispatch-install-home-"));
      const home = NodePath.join(root, "home");
      const legacyHome = NodePath.join(home, ".t3");
      const binDir = NodePath.join(root, "bin");
      const version = "2.3.4";
      const platform = HostProcessPlatform.defaultValue() === "darwin" ? "darwin" : "linux";
      const stem = `t3-${version}-${platform}-${HostProcessArchitecture.defaultValue()}`;
      const archiveName = `${stem}.tar.gz`;
      const sentinel = NodePath.join(legacyHome, "legacy-state-sentinel");
      await NodeFSP.mkdir(NodePath.join(root, stem), { recursive: true });
      await NodeFSP.mkdir(legacyHome, { recursive: true });
      await NodeFSP.writeFile(sentinel, "keep-existing-state\n");
      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v2.3.4'\n", {
        mode: 0o755,
      });
      NodeChildProcess.execFileSync("tar", [
        "-czf",
        NodePath.join(root, archiveName),
        "-C",
        root,
        stem,
      ]);
      const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
      const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const server = NodeHttp.createServer((request, response) => {
        if (request.url?.endsWith("/SHA256SUMS")) {
          response.end(`${checksum}  ${archiveName}\n`);
          return;
        }
        if (request.url?.endsWith(`/${archiveName}`)) {
          response.writeHead(200, { "Content-Length": archive.length });
          response.end(archive);
          return;
        }
        response.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const installer = NodePath.resolve(import.meta.dirname, "install.sh");
      const child = NodeChildProcess.spawn("sh", [installer], {
        env: {
          ...process.env,
          HOME: home,
          DISPATCH_VERSION: version,
          DISPATCH_HOME: "   ",
          T3CODE_HOME: "   ",
          DISPATCH_INSTALL_BIN_DIR: binDir,
          DISPATCH_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });

      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });

        expect(code, output).toBe(0);
        expect(await NodeFSP.readFile(sentinel, "utf8")).toBe("keep-existing-state\n");
        expect(
          await NodeFSP.readFile(
            NodePath.join(legacyHome, "runtime/versions", version, ".install-complete"),
            "utf8",
          ),
        ).toBe(`${version}\n`);
        await expect(NodeFSP.stat(NodePath.join(home, ".dispatch"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(
          NodeChildProcess.execFileSync(NodePath.join(binDir, "dispatch"), ["--version"], {
            encoding: "utf8",
          }).trim(),
        ).toBe("t3 v2.3.4");
      } finally {
        if (child.exitCode === null) child.kill();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });
  },
);
