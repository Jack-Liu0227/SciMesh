import type { FileRoot } from "@ai4s/shared";
import { isTauri } from "./tauri";
import { gatewayOrigin, gatewayToken, isGatewayWeb } from "./webMode";

export type StructureFileRoot = Extract<FileRoot, "workspace" | "base">;

/** The directory is the viewed owner workspace, on both transports. The host
 * must authorize it before resolving this root-relative path. */
export interface StructureFileRequest {
  path: string;
  root?: StructureFileRoot;
  directory?: string;
}

export interface StructureFile {
  content: string;
  hash: string;
  path: string;
}

export interface SaveStructureFileRequest extends StructureFileRequest {
  content: string;
  expectedHash: string;
  /** Reuse this ID only when retrying the exact same edit. */
  operationId: string;
}

export interface StructureFileSaveResult {
  hash: string;
  version: number;
}

export type StructureFileErrorCode =
  | "invalid_path" | "unsupported_format" | "invalid_content" | "invalid_request"
  | "too_large" | "not_found" | "conflict" | "recovery_required" | "io"
  | "unavailable" | "invalid_response" | "transport_error";

export class StructureFileError extends Error {
  constructor(
    public readonly code: StructureFileErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "StructureFileError";
  }
}

function errorCode(value: unknown, status?: number): StructureFileErrorCode {
  switch (value) {
    case "invalid_path": case "unsupported_format": case "invalid_content":
    case "invalid_request": case "too_large": case "not_found": case "conflict":
    case "recovery_required": case "io":
      return value;
    default:
      switch (status) {
        case 409: return "conflict";
        case 413: return "too_large";
        case 404: return "not_found";
        case 422: return "invalid_content";
        case 503: return "recovery_required";
        default: return "transport_error";
      }
  }
}

function transportError(value: unknown, status?: number): StructureFileError {
  if (value instanceof StructureFileError) return value;
  if (typeof value === "object" && value !== null) {
    const code = "code" in value ? value.code : undefined;
    const message = "message" in value && typeof value.message === "string"
      ? value.message
      : "error" in value && typeof value.error === "string" ? value.error : undefined;
    if (message) return new StructureFileError(errorCode(code, status), message, status);
  }
  return new StructureFileError(
    errorCode(undefined, status),
    typeof value === "string" ? value : status ? `HTTP ${status}` : "Structure file request failed",
    status,
  );
}

const SHA256 = /^[0-9a-f]{64}$/;

function parseRead(value: unknown): StructureFile {
  if (typeof value === "object" && value !== null
    && "content" in value && typeof value.content === "string"
    && "hash" in value && typeof value.hash === "string" && SHA256.test(value.hash)
    && "path" in value && typeof value.path === "string" && value.path.length > 0) {
    return { content: value.content, hash: value.hash, path: value.path };
  }
  throw new StructureFileError("invalid_response", "Invalid structure read response");
}

function parseSave(value: unknown): StructureFileSaveResult {
  if (typeof value === "object" && value !== null
    && "hash" in value && typeof value.hash === "string" && SHA256.test(value.hash)
    && "version" in value && typeof value.version === "number"
    && Number.isSafeInteger(value.version) && value.version > 0) {
    return { hash: value.hash, version: value.version };
  }
  throw new StructureFileError("invalid_response", "Invalid structure save response");
}

function validateScope(request: StructureFileRequest): void {
  if (request.root !== undefined && request.root !== "workspace" && request.root !== "base") {
    throw new StructureFileError("invalid_path", "Structure files require a workspace or base root");
  }
}

async function gatewayRequest(path: string, request?: SaveStructureFileRequest): Promise<unknown> {
  const token = gatewayToken();
  const response = await fetch(`${gatewayOrigin()}${path}`, {
    method: request ? "POST" : "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(request ? { "Content-Type": "application/json" } : {}),
    },
    ...(request ? { body: JSON.stringify(request) } : {}),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw transportError(body, response.status);
  return body;
}

/** Read an existing structure, keeping its hash for the next save. */
export async function readStructureFile(request: StructureFileRequest): Promise<StructureFile> {
  validateScope(request);
  try {
    if (isGatewayWeb) {
      const query = new URLSearchParams({ path: request.path, root: request.root ?? "workspace" });
      if (request.directory !== undefined) query.set("dir", request.directory);
      return parseRead(await gatewayRequest(`/v1/structures/read?${query}`));
    }
    if (!isTauri) throw new StructureFileError("unavailable", "Structure files require the desktop app or gateway");
    const { invoke } = await import("@tauri-apps/api/core");
    return parseRead(await invoke<unknown>("structure_read", { request }));
  } catch (e) {
    throw transportError(e);
  }
}

/** A conflict or pending-recovery error is surfaced to the editor. It must not
 * silently retry with a new hash or a new operation ID. */
export async function saveStructureFile(request: SaveStructureFileRequest): Promise<StructureFileSaveResult> {
  validateScope(request);
  try {
    if (isGatewayWeb) return parseSave(await gatewayRequest("/v1/structures/save", request));
    if (!isTauri) throw new StructureFileError("unavailable", "Structure files require the desktop app or gateway");
    const { invoke } = await import("@tauri-apps/api/core");
    return parseSave(await invoke<unknown>("structure_save", { request }));
  } catch (e) {
    throw transportError(e);
  }
}
