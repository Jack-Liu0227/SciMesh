import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteJournalKey, journalLookup, journalStatus, parseJournalInfo, setJournalKey } from "./journal";
import en from "@/i18n/locales/en/settings.json";
import de from "@/i18n/locales/de/settings.json";
import es from "@/i18n/locales/es/settings.json";
import fr from "@/i18n/locales/fr/settings.json";
import ja from "@/i18n/locales/ja/settings.json";
import ko from "@/i18n/locales/ko/settings.json";
import zh from "@/i18n/locales/zh-Hans/settings.json";

const transport = vi.hoisted(() => ({ web: false, invoke: vi.fn(), fetch: vi.fn() }));
vi.mock("./tauri", () => ({ isTauri: true }));
vi.mock("./webMode", () => ({ get isGatewayWeb() { return transport.web; }, gatewayOrigin: () => "https://host.test", gatewayToken: () => "gateway-token" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: transport.invoke }));

const info = {
  publicationName: "Example Journal", doi: null, issns: [],
  impactFactor: { value: 0, year: null }, impactFactor5Year: { value: 2.1, year: 2023 },
  jcrQuartile: { value: "Q2", year: null }, casPartition: null,
  source: "easyScholar", fetchedAt: 1_700_000_000,
};

beforeEach(() => {
  transport.web = false;
  transport.invoke.mockReset();
  transport.fetch.mockReset();
  vi.stubGlobal("fetch", transport.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("journal bridge", () => {
  it("reads configuration state without returning extra credential fields", async () => {
    transport.invoke.mockResolvedValue({ configured: true, key: "must-not-return" });
    expect(await journalStatus()).toEqual({ configured: true });
    expect(transport.invoke).toHaveBeenCalledWith("journal_status", undefined);
  });

  it("sends desktop keys only through the dedicated commands", async () => {
    const store = vi.spyOn(Storage.prototype, "setItem");
    transport.invoke.mockResolvedValue({ configured: true });
    await expect(setJournalKey("test-only-secret")).resolves.toEqual({ configured: true });
    expect(transport.invoke).toHaveBeenCalledWith("set_journal_key", { key: "test-only-secret" });
    transport.invoke.mockResolvedValue({ configured: false });
    await expect(deleteJournalKey()).resolves.toEqual({ configured: false });
    expect(transport.invoke).toHaveBeenCalledWith("delete_journal_key", undefined);
    expect(store).not.toHaveBeenCalled();
    expect(transport.fetch).not.toHaveBeenCalled();
    store.mockRestore();
  });

  it("uses the gateway status and POST lookup contracts without a secret", async () => {
    transport.web = true;
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ configured: true })));
    expect(await journalStatus()).toEqual({ configured: true });
    expect(transport.fetch).toHaveBeenLastCalledWith("https://host.test/v1/journal/status", expect.objectContaining({ method: "GET" }));
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify(info)));
    expect(await journalLookup(" Example Journal ")).toEqual(info);
    expect(transport.fetch).toHaveBeenLastCalledWith("https://host.test/v1/journal/lookup", expect.objectContaining({
      method: "POST", body: JSON.stringify({ query: "Example Journal" }),
      headers: { Authorization: "Bearer gateway-token", "Content-Type": "application/json" },
    }));
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it("refuses web credential mutations before any request", async () => {
    transport.web = true;
    await expect(setJournalKey("test-only-secret")).rejects.toMatchObject({ code: "desktop_only" });
    await expect(deleteJournalKey()).rejects.toMatchObject({ code: "desktop_only" });
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it("preserves typed service errors while discarding raw transport text", async () => {
    transport.invoke.mockRejectedValueOnce({ code: "invalid_key", detail: "secretKey=private" });
    await expect(journalLookup("Example Journal")).rejects.toMatchObject({ code: "invalid_key", message: "invalid_key" });
    transport.invoke.mockRejectedValueOnce(new Error("https://host/?secretKey=private"));
    await expect(journalLookup("Example Journal")).rejects.toMatchObject({ code: "unavailable", message: "unavailable" });
    transport.web = true;
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429 }));
    await expect(journalLookup("Example Journal")).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("rejects empty queries before invoking a transport", async () => {
    await expect(journalLookup("  ")).rejects.toMatchObject({ code: "invalid_query" });
    expect(transport.invoke).not.toHaveBeenCalled();
  });
});

describe("journal response boundary", () => {
  it("keeps zero, missing metrics and unknown years distinct", () => {
    const parsed = parseJournalInfo(info);
    expect(parsed.impactFactor).toEqual({ value: 0, year: null });
    expect(parsed.impactFactor5Year).toEqual({ value: 2.1, year: 2023 });
    expect(parsed.casPartition).toBeNull();
  });

  it.each([
    { impactFactor: { value: Infinity, year: null } },
    { impactFactor5Year: { value: -1, year: null } },
    { jcrQuartile: { value: "<script>secret</script>", year: null } },
    { source: "unknown" }, { fetchedAt: "2024" }, { issns: ["not-an-issn"] },
    { impactFactor: { value: 1, year: 0 } },
  ])("rejects untrusted data: %j", (change) => {
    expect(() => parseJournalInfo({ ...info, ...change })).toThrow("invalid_response");
  });

  it("keeps the journal translation keys and placeholders in parity across seven locales", () => {
    const flatten = (value: unknown, prefix = ""): Record<string, string> => {
      if (typeof value === "string") return { [prefix]: value };
      if (typeof value !== "object" || value === null) return {};
      return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => Object.entries(flatten(child, `${prefix}.${key}`))));
    };
    const expected = flatten(en.journal);
    for (const locale of [de, es, fr, ja, ko, zh]) {
      const actual = flatten(locale.journal);
      expect(Object.keys(actual)).toEqual(Object.keys(expected));
      for (const key of Object.keys(expected)) expect(actual[key].match(/{{\w+}}/g)).toEqual(expected[key].match(/{{\w+}}/g));
    }
  });
});
