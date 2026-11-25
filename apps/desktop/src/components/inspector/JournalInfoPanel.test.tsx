import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JournalInfo } from "@/lib/journal";
import { JournalInfoPanel } from "./JournalInfoPanel";

const lookup = vi.hoisted(() => vi.fn<(query: string) => Promise<JournalInfo>>());
vi.mock("@/lib/journal", async (original) => ({ ...(await original<typeof import("@/lib/journal")>()), journalLookup: lookup }));
const info: JournalInfo = {
  publicationName: "Example Journal", doi: "10.1234/example", issns: ["1234-567X"],
  impactFactor: { value: 0, year: null }, impactFactor5Year: null,
  jcrQuartile: { value: "Q1", year: 2023 }, casPartition: { value: "Zone 2", year: null },
  source: "easyScholar", fetchedAt: 1_700_000_000,
};
beforeEach(() => { lookup.mockReset().mockResolvedValue(info); });

describe("JournalInfoPanel", () => {
  it("does not request on mount, prefill or edit, and queries only on click", async () => {
    render(<JournalInfoPanel initialQuery="10.1234/example" />);
    expect(screen.getByLabelText("DOI or journal name")).toHaveValue("10.1234/example");
    expect(lookup).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Look up" }));
    expect(lookup).toHaveBeenCalledWith("10.1234/example");
    expect(await screen.findByText("Example Journal")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("DOI or journal name"), "extra");
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("shows zero, missing metrics, source, retrieval time and actual metric years", async () => {
    render(<JournalInfoPanel initialQuery="Example Journal" />);
    await userEvent.click(screen.getByRole("button", { name: "Look up" }));
    expect(await screen.findByText("0")).toBeInTheDocument();
    expect(screen.getByText("Not provided")).toBeInTheDocument();
    expect(screen.getAllByText("Year not provided")).toHaveLength(2);
    expect(screen.getByText("Year 2023")).toBeInTheDocument();
    expect(screen.getByText("Metrics source: easyScholar")).toBeInTheDocument();
    expect(screen.getByText(/^Retrieved:/)).toBeInTheDocument();
    expect(screen.getByText("ISSN: 1234-567X")).toBeInTheDocument();
  });

  it("allows a manual journal query and shows a safe typed error", async () => {
    lookup.mockRejectedValue({ code: "not_configured", message: "secretKey=private" });
    render(<JournalInfoPanel />);
    expect(screen.getByRole("button", { name: "Look up" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("DOI or journal name"), "Manual Journal");
    expect(lookup).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Look up" }));
    expect(lookup).toHaveBeenCalledWith("Manual Journal");
    expect(await screen.findByRole("alert")).toHaveTextContent(/desktop settings/);
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
  });

  it("discards an old response when the inspector switches to another query", async () => {
    let resolve: (value: JournalInfo) => void = () => {};
    lookup.mockReturnValue(new Promise<JournalInfo>((done) => { resolve = done; }));
    const { rerender } = render(<JournalInfoPanel initialQuery="Old Journal" />);
    await userEvent.click(screen.getByRole("button", { name: "Look up" }));
    rerender(<JournalInfoPanel initialQuery="New Journal" />);
    resolve(info);
    await waitFor(() => expect(screen.getByLabelText("DOI or journal name")).toHaveValue("New Journal"));
    expect(screen.queryByText("Example Journal")).not.toBeInTheDocument();
    expect(lookup).toHaveBeenCalledOnce();
  });
});
