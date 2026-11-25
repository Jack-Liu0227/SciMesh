import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ tauri: false, web: false, invoke: vi.fn(), fetch: vi.fn() }));

vi.mock("./tauri", () => ({ get isTauri() { return transport.tauri; } }));
vi.mock("./webMode", () => ({
  get isGatewayWeb() { return transport.web; },
  gatewayOrigin: () => "http://gateway",
  gatewayToken: () => "test-token",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: transport.invoke }));

import { readStructureFile, saveStructureFile, StructureFileError } from "./structureFile";

const hash = "a".repeat(64);
const request = {
  path: "crystals/Si.cif",
  directory: "D:/workspaces/viewed session",
  content: "data_Si",
  expectedHash: hash,
  operationId: "ab-12",
};

describe("structure file transports", () => {
  beforeEach(() => {
    transport.tauri = false;
    transport.web = false;
    transport.invoke.mockReset();
    transport.fetch.mockReset();
    vi.stubGlobal("fetch", transport.fetch);
  });

  it("passes the explicit viewed directory to both desktop commands", async () => {
    transport.tauri = true;
    transport.invoke.mockResolvedValueOnce({ content: "data_Si", hash, path: request.path });
    const readRequest = { path: request.path, directory: request.directory };
    expect(await readStructureFile(readRequest)).toEqual({ content: "data_Si", hash, path: request.path });
    expect(transport.invoke).toHaveBeenLastCalledWith("structure_read", { request: readRequest });
    transport.invoke.mockResolvedValueOnce({ hash, version: 2 });
    expect(await saveStructureFile(request)).toEqual({ hash, version: 2 });
    expect(transport.invoke).toHaveBeenLastCalledWith("structure_save", { request });
  });

  it("reads through the authenticated gateway with path, root and dir identity", async () => {
    transport.web = true;
    transport.fetch.mockResolvedValue(new Response(JSON.stringify({ content: "data_Si", hash, path: request.path })));
    await readStructureFile({ path: request.path, root: "base", directory: request.directory });
    const url = new URL(transport.fetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/v1/structures/read");
    expect([...url.searchParams.entries()]).toEqual([
      ["path", request.path], ["root", "base"], ["dir", request.directory],
    ]);
    expect(transport.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer test-token");
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it("saves camelCase request fields without changing a retry's operation ID", async () => {
    transport.web = true;
    transport.fetch.mockImplementation(async () => new Response(JSON.stringify({ hash, version: 1 })));
    expect(await saveStructureFile(request)).toEqual({ hash, version: 1 });
    expect(await saveStructureFile(request)).toEqual({ hash, version: 1 });
    for (const [url, init] of transport.fetch.mock.calls) {
      expect(url).toBe("http://gateway/v1/structures/save");
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ Authorization: "Bearer test-token", "Content-Type": "application/json" });
      expect(JSON.parse(init.body)).toEqual(request);
    }
  });

  it("retains a gateway conflict code and status and does not retry", async () => {
    transport.web = true;
    transport.fetch.mockResolvedValue(new Response(JSON.stringify({ error: "File changed" }), { status: 409 }));
    await expect(saveStructureFile(request)).rejects.toMatchObject({ code: "conflict", status: 409, message: "File changed" });
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });

  it("retains structured desktop recovery errors", async () => {
    transport.tauri = true;
    transport.invoke.mockRejectedValue({ code: "recovery_required", message: "Retry the same operationId" });
    await expect(saveStructureFile(request)).rejects.toMatchObject({ code: "recovery_required", message: "Retry the same operationId" });
  });

  it("validates unknown backend results and refuses unavailable browser mode", async () => {
    await expect(readStructureFile({ path: request.path })).rejects.toMatchObject({ code: "unavailable" });
    transport.tauri = true;
    transport.invoke.mockResolvedValueOnce({ content: "data_Si", hash: "bad", path: request.path });
    await expect(readStructureFile({ path: request.path })).rejects.toBeInstanceOf(StructureFileError);
    transport.invoke.mockResolvedValueOnce({ hash, version: 0 });
    await expect(saveStructureFile(request)).rejects.toMatchObject({ code: "invalid_response" });
  });
});
