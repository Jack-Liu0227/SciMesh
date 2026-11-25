import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Specialist } from "@/lib/specialists";
import { useRuntimeStore } from "@/lib/runtime";
import { listSpecialists } from "@/lib/tauri";
import i18n from "@/i18n";
import { SkillsPage } from "./SkillsPage";

const mode = vi.hoisted(() => ({ desktop: true, gateway: false }));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/tauri")>(),
  get isTauri() { return mode.desktop; },
  listSpecialists: vi.fn(async (): Promise<Specialist[]> => []),
}));
vi.mock("@/lib/webMode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/webMode")>(),
  get isGatewayWeb() { return mode.gateway; },
}));

const defaults = useRuntimeStore.getState();
const managed: Specialist = {
  id: "stats-reviewer", description: "Checks statistics", instructions: "Check the evidence.",
  model: "", skills: null, blockedConnectors: [], color: null, icon: null,
};

beforeEach(async () => {
  mode.desktop = true;
  mode.gateway = false;
  vi.mocked(listSpecialists).mockResolvedValue([]);
  await i18n.changeLanguage("en");
  useRuntimeStore.setState({
    status: "ready", switching: false, skills: [], tools: [], workspace: "C:\\work\\project",
    agents: [
      { name: "build", description: "Primary agent", mode: "primary" },
      { name: "literature-researcher", description: "Finds cited literature", mode: "subagent" },
      { name: "materials-data", description: "Retrieves source structures", mode: "subagent" },
    ],
    loadCatalog: async () => {}, detectTools: async () => {},
  });
});
afterEach(async () => {
  useRuntimeStore.setState(defaults, true);
  await i18n.changeLanguage("en");
});

function open() {
  return render(<MemoryRouter><SkillsPage /></MemoryRouter>);
}

describe("skill source filters", () => {
  beforeEach(() => {
    useRuntimeStore.setState({
      skills: [
        { name: "bundled", description: "Research evidence", location: "/app/runtime/agent/skills/bundled/SKILL.md" },
        { name: "project-root", description: "Project notes", location: "C:\\work\\project\\skills\\project-root\\SKILL.md" },
        { name: "project-profile", description: "Project analysis", location: "C:\\work\\project\\.agents\\skills\\project-profile\\SKILL.md" },
        { name: "global", description: "Research citations", location: "C:\\Users\\user\\.agents\\skills\\global\\SKILL.md" },
        { name: "installed", description: "Custom tools", location: "/app/runtime/agent/skills/user/installed/SKILL.md" },
      ],
    });
  });

  it("filters skills by source, counts both project roots and keeps agents visible", async () => {
    const user = userEvent.setup();
    open();
    const filters = within(screen.getByRole("group", { name: "Filter skills by source" }));
    expect(filters.getByRole("button", { name: "All 5", pressed: true })).toBeInTheDocument();
    await user.click(filters.getByRole("button", { name: "built-in 1" }));
    expect(screen.getByText("Research evidence")).toBeInTheDocument();
    expect(screen.queryByText("Research citations")).not.toBeInTheDocument();
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("literature-researcher")).toBeInTheDocument();
    await user.click(filters.getByRole("button", { name: "project 2" }));
    expect(screen.getByText("Project notes")).toBeInTheDocument();
    expect(screen.getByText("Project analysis")).toBeInTheDocument();
    expect(screen.queryByText("Research evidence")).not.toBeInTheDocument();
    await user.click(filters.getByRole("button", { name: "user 2" }));
    expect(screen.getByText("Research citations")).toBeInTheDocument();
    expect(screen.getByText("Custom tools")).toBeInTheDocument();
    expect(screen.queryByText("Project notes")).not.toBeInTheDocument();
  });

  it("combines search with source filters and lets empty results be cleared", async () => {
    const user = userEvent.setup();
    open();
    const search = screen.getByRole("textbox", { name: "Search skills and agents" });
    await user.type(search, "research");
    const filters = within(screen.getByRole("group", { name: "Filter skills by source" }));
    expect(filters.getByRole("button", { name: "All 2" })).toBeInTheDocument();
    await user.click(filters.getByRole("button", { name: "user 1" }));
    expect(screen.getByText("Research citations")).toBeInTheDocument();
    expect(screen.queryByText("Research evidence")).not.toBeInTheDocument();
    await user.click(filters.getByRole("button", { name: "project 0" }));
    expect(screen.getByRole("status")).toHaveTextContent("No skills match these filters.");
    await user.clear(search);
    await user.type(search, "unmatched-query");
    expect(filters.getByRole("button", { name: "All 0" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(search).toHaveValue("");
    expect(filters.getByRole("button", { name: "All 5", pressed: true })).toBeInTheDocument();
    expect(screen.getByText("Research evidence")).toBeInTheDocument();
    expect(screen.getByText("Research citations")).toBeInTheDocument();
  });

  it("expands only the selected source and folds again when changing source", async () => {
    const user = userEvent.setup();
    useRuntimeStore.setState({
      skills: ["builtin", "user"].flatMap((source) => Array.from({ length: 10 }, (_, index) => ({
        name: `${source}-${index}`, description: `${source} guide ${index}`,
        location: `/app/runtime/agent/skills/${source === "user" ? "user/" : ""}${source}-${index}/SKILL.md`,
      }))),
    });
    open();
    const filters = within(screen.getByRole("group", { name: "Filter skills by source" }));
    await user.click(filters.getByRole("button", { name: "built-in 10" }));
    expect(screen.queryByText("builtin guide 9")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all 10" }));
    expect(screen.getByText("builtin guide 9")).toBeInTheDocument();
    expect(screen.queryByText("user guide 0")).not.toBeInTheDocument();
    await user.click(filters.getByRole("button", { name: "user 10" }));
    expect(screen.queryByText("builtin guide 9")).not.toBeInTheDocument();
    expect(screen.getByText("user guide 0")).toBeInTheDocument();
    expect(screen.queryByText("user guide 9")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all 10" }));
    expect(screen.getByText("user guide 9")).toBeInTheDocument();
  });

  it("supports the same source filters in the Chinese gateway client", async () => {
    const user = userEvent.setup();
    mode.desktop = false;
    mode.gateway = true;
    await i18n.changeLanguage("zh-Hans");
    open();
    const filters = within(screen.getByRole("group", { name: "按来源筛选技能" }));
    expect(filters.getByRole("button", { name: "全部 5", pressed: true })).toBeInTheDocument();
    await user.click(filters.getByRole("button", { name: "内置 1" }));
    expect(screen.getByText("Research evidence")).toBeInTheDocument();
    expect(screen.queryByText("Research citations")).not.toBeInTheDocument();
  });
});

describe("the specialist catalog", () => {
  it("shows bundled subagents as specialists even when no user-created specialists exist", async () => {
    open();
    const section = screen.getByRole("heading", { name: "Specialists 2" }).closest("section");
    expect(section).toContainElement(screen.getByText("literature-researcher"));
    expect(section).toContainElement(screen.getByText("materials-data"));
    expect(section).not.toContainElement(screen.getByText("build"));
    expect(screen.queryByText("No specialists yet")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New specialist" })).toBeInTheDocument();
    await waitFor(() => expect(listSpecialists).toHaveBeenCalled());
  });

  it("lists a managed specialist once alongside bundled and workspace subagents", async () => {
    const user = userEvent.setup();
    vi.mocked(listSpecialists).mockResolvedValue([managed]);
    useRuntimeStore.setState({
      agents: [
        ...useRuntimeStore.getState().agents,
        { name: managed.id, description: managed.description, mode: "subagent" },
        { name: "project-auditor", description: "Reviews project evidence", mode: "subagent" },
      ],
    });
    open();
    const heading = await screen.findByRole("heading", { name: "Specialists 4" });
    await waitFor(() => expect(listSpecialists).toHaveBeenCalled());
    expect(screen.getAllByText(managed.id)).toHaveLength(1);
    expect(heading.closest("section")).toContainElement(screen.getByText("project-auditor"));
    expect(heading.closest("section")).toContainElement(screen.getByText("materials-data"));
    await user.click(screen.getByRole("button", { name: /stats-reviewer/ }));
    expect(screen.getByRole("dialog", { name: "Edit stats-reviewer" })).toBeInTheDocument();
  });

  it("shows the same runtime specialists in gateway mode without desktop editing controls", () => {
    mode.desktop = false;
    mode.gateway = true;
    open();
    const section = screen.getByRole("heading", { name: "Specialists 2" }).closest("section");
    expect(section).toContainElement(screen.getByText("literature-researcher"));
    expect(section).toContainElement(screen.getByText("materials-data"));
    expect(screen.queryByRole("button", { name: "New specialist" })).not.toBeInTheDocument();
  });

  it("keeps search results in the specialist section and opens the runtime role description", async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByRole("textbox", { name: "Search skills and agents" }), "literature");
    expect(screen.queryByText("materials-data")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Specialists 2" }).closest("section"))
      .toContainElement(screen.getByText("literature-researcher"));
    await user.click(screen.getByRole("button", { name: /literature-researcher/ }));
    expect(screen.getByRole("dialog", { name: "literature-researcher" })).toHaveTextContent("Finds cited literature");
  });

  it("allows the first specialist to be created when the runtime catalog is empty", async () => {
    useRuntimeStore.setState({ agents: [] });
    open();
    expect(screen.getByRole("button", { name: "New specialist" })).toBeInTheDocument();
    expect(screen.getByText("No specialists yet")).toBeInTheDocument();
    await waitFor(() => expect(listSpecialists).toHaveBeenCalled());
  });
});
