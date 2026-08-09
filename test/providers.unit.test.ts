import { describe, expect, test } from "bun:test";

import { configuredSearchProviders, providerDisplayName } from "../frontend/src/lib/providers";

describe("provider rail contract", () => {
  /*
   * Plate 1a's rail is coverage, not health. It used to be filtered by a live
   * readiness observation and Click and Book Plus never survived the filter on
   * the idle screen — it cannot reach `ready` until a real search has answered
   * — so the desk claimed to search one provider. Both are always listed; a
   * provider that fails a search is said in one line above the results.
   */
  test("lists both providers, always, with their canonical name and icon", () => {
    const providers = configuredSearchProviders();

    expect(providers.map((provider) => provider.id)).toEqual(["agil-local", "costamar"]);
    expect(providers.map((provider) => provider.label)).toEqual(["Agilsmart", "Click and Book Plus"]);
    providers.forEach((provider) => {
      expect(provider.icon).toMatch(/^\/assets\/provider-icons\/.+\.png$/);
    });
  });

  test("hands back a fresh copy, so a caller cannot edit the catalogue", () => {
    const first = configuredSearchProviders();
    first[0].label = "mutated";

    expect(configuredSearchProviders()[0].label).toBe("Agilsmart");
  });

  test("resolves the display name from every id the providers answer to", () => {
    expect(providerDisplayName("agil-local")).toBe("Agilsmart");
    expect(providerDisplayName("agil")).toBe("Agilsmart");
    expect(providerDisplayName("costamar")).toBe("Click and Book Plus");
    expect(providerDisplayName("cbplus")).toBe("Click and Book Plus");
    expect(providerDisplayName("click-and-book-plus")).toBe("Click and Book Plus");
    expect(providerDisplayName("")).toBe("Proveedor");
    expect(providerDisplayName(null)).toBe("Proveedor");
  });
});
