import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { DEPLOYMENT_MODELS, withDeploymentModels } from "./model-catalog.js";

describe("deployment model catalog", () => {
  it("resolves the model the live fleet runs on", () => {
    // Without this the runtime answers every run with "Unknown model xai/grok-4.6"
    // and still records the run as completed.
    const model = withDeploymentModels(builtinModels()).getModel("xai", "grok-4.6");

    expect(model).toBeDefined();
    expect(model?.name).toBe("Grok 4.6");
    expect(model?.contextWindow).toBe(500_000);
  });

  it("keeps the provider's own models", () => {
    const before = builtinModels().getProvider("xai")?.getModels() ?? [];
    const after = withDeploymentModels(builtinModels()).getProvider("xai")?.getModels() ?? [];

    for (const model of before) {
      expect(after.some((entry) => entry.id === model.id)).toBe(true);
    }
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  });

  it("lets an upstream release win once it ships the model itself", () => {
    const models = builtinModels();
    const provider = models.getProvider("xai");
    if (!provider) throw new Error("xai provider missing");
    const upstream = { ...DEPLOYMENT_MODELS[0], name: "Grok 4.6 (upstream)" } as never;
    models.setProvider({
      ...provider,
      getModels: () => [...provider.getModels(), upstream],
    } as never);

    const model = withDeploymentModels(models).getModel("xai", "grok-4.6");

    expect(model?.name).toBe("Grok 4.6 (upstream)");
  });

  it("ignores an entry for a provider the release does not have", () => {
    const extra = [{ ...DEPLOYMENT_MODELS[0], provider: "not-a-provider" }] as never;

    expect(() => withDeploymentModels(builtinModels(), extra)).not.toThrow();
  });
});
