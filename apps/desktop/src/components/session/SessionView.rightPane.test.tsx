import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderAt } from "@/test/render";
import { makeLeaf, useLayoutStore } from "@/lib/layout";
import { useRuntimeStore } from "@/lib/runtime";
import { useUiStore } from "@/lib/store";

const LAYOUT = useLayoutStore.getState();
const PANES = useRuntimeStore.getState().panes;

afterEach(() => {
  useLayoutStore.setState(LAYOUT, true);
  useRuntimeStore.setState({ panes: PANES });
  useUiStore.setState({ inspectorMaximized: null });
});

describe("the session right-panel toggle", () => {
  beforeEach(() => {
    const pane = makeLeaf("ses_right_pane");
    useLayoutStore.setState({
      groups: [{ id: "screen-a", name: "", tree: pane, focusedLeafId: pane.id, zoomedLeafId: null }],
      activeGroupId: "screen-a",
      tree: pane,
      focusedLeafId: pane.id,
      zoomedLeafId: null,
      ephemeralGroupId: null,
    });
    useRuntimeStore.setState({ panes: {} });
  });

  it("opens Files when no panel is selected", async () => {
    renderAt("/live");

    const toggle = await screen.findByRole("button", { name: "Show right panel" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);

    expect(await screen.findByRole("button", { name: "Close files" })).toBeInTheDocument();
    expect(toggle).toHaveAccessibleName("Hide right panel");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(useRuntimeStore.getState().panes.ses_right_pane?.showFiles).toBe(true);
  });

  it("hides and restores the selected panel without clearing it", async () => {
    renderAt("/live");

    await userEvent.click(await screen.findByRole("button", { name: "Trajectory" }));
    expect(await screen.findByRole("button", { name: "Close trajectory" })).toBeInTheDocument();

    const hide = screen.getByRole("button", { name: "Hide right panel" });
    await userEvent.click(hide);

    expect(screen.queryByRole("button", { name: "Close trajectory" })).toBeNull();
    expect(hide).toHaveAccessibleName("Show right panel");
    expect(hide).toHaveAttribute("aria-pressed", "false");
    expect(useRuntimeStore.getState().panes.ses_right_pane?.showTrajectory).toBe(true);

    await userEvent.click(hide);

    expect(await screen.findByRole("button", { name: "Close trajectory" })).toBeInTheDocument();
    expect(hide).toHaveAccessibleName("Hide right panel");
    expect(hide).toHaveAttribute("aria-pressed", "true");
  });
});
