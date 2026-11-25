import { isTauri } from "./tauri";
import { gatewayOrigin, gatewayToken, isGatewayWeb } from "./webMode";

export type JournalErrorCode =
  | "not_configured"
  | "invalid_key"
  | "rate_limited"
  | "unavailable"
  | "not_found"
  | "invalid_query"
  | "invalid_response"
  | "credential_store_unavailable"
  | "desktop_only";

export interface JournalStatus { configured: boolean }
export interface JournalMetric<T> { value: T; year: number | null }
export interface JournalInfo {
  publicationName: string;
  doi: string | null;
  issns: string[];
  impactFactor: JournalMetric<number> | null;
  impactFactor5Year: JournalMetric<number> | null;
  jcrQuartile: JournalMetric<string> | null;
  casPartition: JournalMetric<string> | null;
  source: "easyScholar";
  /** Unix seconds, independent of each metric's publication year. */
  fetchedAt: number;
}

export class JournalServiceError extends Error {
  constructor(readonly code: JournalErrorCode) {
    super(code);
    this.name = "JournalServiceError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(value: unknown): JournalErrorCode | null {
  switch (value) {
    case "not_configured": case "invalid_key": case "rate_limited":
    case "unavailable": case "not_found": case "invalid_query":
    case "invalid_response": case "credential_store_unavailable": case "desktop_only":
      return value;
    default: return null;
  }
}

/** Only a typed code crosses the error boundary. Never display transport text. */
export function journalErrorCode(error: unknown): JournalErrorCode {
  if (error instanceof JournalServiceError) return error.code;
  if (record(error)) {
    return errorCode(error.code) ?? (record(error.error) ? errorCode(error.error.code) : null) ?? "unavailable";
  }
  if (typeof error === "string" && error.length < 1024) {
    try {
      const parsed: unknown = JSON.parse(error);
      if (record(parsed)) return errorCode(parsed.code) ?? "unavailable";
    } catch { /* Opaque transport failures are deliberately discarded. */ }
  }
  return "unavailable";
}

function invalid(): never { throw new JournalServiceError("invalid_response"); }
function hasControl(value: string): boolean {
  return [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

function status(value: unknown): JournalStatus {
  if (!record(value) || typeof value.configured !== "boolean") return invalid();
  return { configured: value.configured };
}

function metric<T>(value: unknown, parseValue: (v: unknown) => T): JournalMetric<T> | null {
  if (value === null) return null;
  if (!record(value)) return invalid();
  const year = value.year;
  if (year !== null && (typeof year !== "number" || !Number.isInteger(year) || year < 1900 || year > 2200)) return invalid();
  return { value: parseValue(value.value), year };
}

function numeric(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return invalid();
  return value;
}
function quartile(value: unknown): string {
  if (value !== "Q1" && value !== "Q2" && value !== "Q3" && value !== "Q4") return invalid();
  return value;
}
function partition(value: unknown): string {
  if (value !== "Zone 1" && value !== "Zone 2" && value !== "Zone 3" && value !== "Zone 4") return invalid();
  return value;
}

export function parseJournalInfo(value: unknown): JournalInfo {
  if (!record(value) || typeof value.publicationName !== "string" || !value.publicationName.trim()
    || value.publicationName.length > 512 || hasControl(value.publicationName)
    || (value.doi !== null && (typeof value.doi !== "string" || !/^10\.\d{4,9}\/\S+$/.test(value.doi)))
    || !Array.isArray(value.issns) || value.issns.length > 16 || value.source !== "easyScholar"
    || typeof value.fetchedAt !== "number" || !Number.isSafeInteger(value.fetchedAt) || value.fetchedAt <= 0
    || !Number.isFinite(new Date(value.fetchedAt * 1000).getTime())) return invalid();
  const issns: string[] = value.issns.map((issn: unknown) => {
    if (typeof issn !== "string" || !/^\d{4}-\d{3}[\dX]$/.test(issn)) return invalid();
    return issn;
  });
  return {
    publicationName: value.publicationName, doi: value.doi, issns,
    impactFactor: metric(value.impactFactor, numeric),
    impactFactor5Year: metric(value.impactFactor5Year, numeric),
    jcrQuartile: metric(value.jcrQuartile, quartile),
    casPartition: metric(value.casPartition, partition),
    source: value.source, fetchedAt: value.fetchedAt,
  };
}

async function call(command: string, path: string, args?: { query: string }): Promise<unknown> {
  try {
    if (isGatewayWeb) {
      const token = gatewayToken();
      const response = await fetch(`${gatewayOrigin()}${path}`, {
        method: args ? "POST" : "GET",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(args ? { "Content-Type": "application/json" } : {}) },
        ...(args ? { body: JSON.stringify(args) } : {}),
        signal: AbortSignal.timeout(25_000),
      });
      const value: unknown = await response.json();
      if (!response.ok) throw new JournalServiceError(response.status === 429 ? "rate_limited" : journalErrorCode(value));
      return value;
    }
    if (!isTauri) throw new JournalServiceError("unavailable");
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<unknown>(command, args);
  } catch (error) { throw new JournalServiceError(journalErrorCode(error)); }
}

export async function journalStatus(): Promise<JournalStatus> {
  return status(await call("journal_status", "/v1/journal/status"));
}

export async function journalLookup(query: string): Promise<JournalInfo> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > 512 || hasControl(trimmed)) throw new JournalServiceError("invalid_query");
  return parseJournalInfo(await call("journal_lookup", "/v1/journal/lookup", { query: trimmed }));
}

async function manage(command: string, args?: { key: string }): Promise<JournalStatus> {
  if (!isTauri || isGatewayWeb) throw new JournalServiceError("desktop_only");
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return status(await invoke<unknown>(command, args));
  } catch (error) { throw new JournalServiceError(journalErrorCode(error)); }
}

export function setJournalKey(key: string): Promise<JournalStatus> { return manage("set_journal_key", { key }); }
export function deleteJournalKey(): Promise<JournalStatus> { return manage("delete_journal_key"); }
