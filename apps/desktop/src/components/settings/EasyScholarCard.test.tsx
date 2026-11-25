import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EasyScholarCard } from "./EasyScholarCard";

const api = vi.hoisted(() => ({ web: false, status: vi.fn(), save: vi.fn(), remove: vi.fn(), lookup: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ isTauri: true }));
vi.mock("@/lib/webMode", () => ({ get isGatewayWeb() { return api.web; } }));
vi.mock("@/lib/journal", async (original) => ({
  ...(await original<typeof import("@/lib/journal")>()),
  journalStatus: api.status, setJournalKey: api.save, deleteJournalKey: api.remove, journalLookup: api.lookup,
}));

beforeEach(() => {
  api.web = false;
  api.status.mockReset().mockResolvedValue({ configured: false });
  api.save.mockReset().mockResolvedValue({ configured: true });
  api.remove.mockReset().mockResolvedValue({ configured: false });
  api.lookup.mockReset().mockResolvedValue({});
});

describe("EasyScholarCard", () => {
  it("keeps the key masked, clears it after save, and only reads status on mount", async () => {
    render(<EasyScholarCard />);
    expect(await screen.findByText(/No easyScholar key is configured/)).toBeInTheDocument();
    expect(api.lookup).not.toHaveBeenCalled();
    const input = screen.getByLabelText("easyScholar secret key");
    expect(input).toHaveAttribute("type", "password");
    await userEvent.type(input, "test-only-secret");
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(api.save).toHaveBeenCalledWith("test-only-secret");
    expect(await screen.findByText("Key saved.")).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(api.lookup).not.toHaveBeenCalled();
  });

  it("requires an explicit journal name to test the saved key", async () => {
    api.status.mockResolvedValue({ configured: true });
    render(<EasyScholarCard />);
    await screen.findByText(/An easyScholar key is saved/);
    const button = screen.getByRole("button", { name: "Test saved key" });
    expect(button).toBeDisabled();
    const input = screen.getByLabelText("Journal name for the test");
    await userEvent.type(input, "10.1234/article");
    expect(button).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "Example Journal");
    expect(api.lookup).not.toHaveBeenCalled();
    await userEvent.click(button);
    expect(api.lookup).toHaveBeenCalledWith("Example Journal");
    expect(await screen.findByText(/Journal lookup succeeded/)).toBeInTheDocument();
  });

  it("removes the credential and updates configuration status", async () => {
    api.status.mockResolvedValue({ configured: true });
    render(<EasyScholarCard />);
    await screen.findByText(/An easyScholar key is saved/);
    await userEvent.click(screen.getByRole("button", { name: "Remove key" }));
    expect(api.remove).toHaveBeenCalledOnce();
    expect(await screen.findByText(/No easyScholar key is configured/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test saved key" })).toBeDisabled();
  });

  it("reports credential store failure and never shows a raw error", async () => {
    api.save.mockRejectedValue({ code: "credential_store_unavailable", detail: "secretKey=private" });
    render(<EasyScholarCard />);
    await screen.findByText(/No easyScholar key is configured/);
    await userEvent.type(screen.getByLabelText("easyScholar secret key"), "test-only-secret");
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/credential store is unavailable/);
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("easyScholar secret key")).toHaveValue("");
  });

  it("hides all secret controls in gateway web mode", async () => {
    api.web = true;
    const { container } = render(<EasyScholarCard />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(api.status).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
  });
});
