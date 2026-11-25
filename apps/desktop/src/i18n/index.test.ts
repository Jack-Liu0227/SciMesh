import { describe, expect, it } from "vitest";
import i18n, { NAMESPACES } from "./index";
import { shippedLocales } from "./config";

describe("i18n instance", () => {
  it("initializes with English and the full namespace set", () => {
    expect(i18n.language).toBe("en");
    expect(NAMESPACES).toContain("common");
    expect(NAMESPACES.length).toBe(8);
  });

  it("resolves a seeded key", () => {
    expect(i18n.t("common:actions.save")).toBe("Save");
  });

  it.each(shippedLocales().map((locale) => locale.code))(
    "%s interpolates the product name without hiding caller variables",
    (lng) => {
      const subtitle = i18n.t("nav:projects.importSubtitle", { lng, name: "Test project" });
      expect(subtitle).toContain("SciMesh");
      expect(subtitle).toContain("Test project");
      expect(subtitle).not.toContain("{{");
      expect(i18n.t("settings:computer.accessibilityHint", { lng })).toContain("SciMesh Computer Use");
    },
  );

  it("falls back to English for a not-yet-shipped language", async () => {
    await i18n.changeLanguage("pt-BR");
    // pt-BR is registered but not shipped → no bundled resources → falls back to en.
    expect(i18n.t("common:actions.save")).toBe("Save");
    await i18n.changeLanguage("en");
  });
});
