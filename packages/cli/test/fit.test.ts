import { describe, expect, test } from "bun:test";
import { budgetOf, cacheMb, fitOf, largestContext, OVERHEAD_MB, PROVEN_ARCHITECTURES } from "../src/fit.ts";
import type { ModelShape } from "../src/gguf.ts";
import type { Machine } from "../src/machine.ts";

const GB = 1024 * 1024 * 1024;
/** A model of eight billion parameters in the usual kind: 32 layers, 8 heads kept, heads of 128: a token costs 128 KB of cache. */
const shape: ModelShape = { architecture: "llama", layers: 32, kvHeads: Array(32).fill(8), keyLength: 128, valueLength: 128, contextLength: 131072 };
const weights = 4.7 * GB;
const computer = (o: Partial<Machine> & { gpus?: Machine["gpus"] }): Machine => ({ os: "linux", arch: "x64", gpus: [], ramMb: 16384, freeRamMb: 12000, ...o });
/** The fit of a model of a proven kind (the others have their own test). */
const fit = (...a: Parameters<typeof fitOf>) => fitOf(...a)!;
const card = (freeMb: number, memoryMb = freeMb): Machine["gpus"] => [{ name: "card", vendor: "nvidia", kind: "discrete", memoryMb, freeMb }];

describe("the cache of keys and values", () => {
  test("is two bytes for each head kept, each layer, each token: 128 KB a token for this model, so 4 GB for 32768 tokens", () => {
    expect(cacheMb(shape, 1)).toBeCloseTo(0.125, 5);
    expect(cacheMb(shape, 32768)).toBeCloseTo(4096, 3);
  });

  test("a model that keeps a different number of heads in each layer costs what its layers keep", () => {
    expect(cacheMb({ ...shape, layers: 2, kvHeads: [1, 3] }, 1024)).toBeCloseTo((1 + 3) * 256 * 1024 * 2 / 1048576, 5);
  });
});

describe("what a computer can give", () => {
  test("a tenth is left alone: the free memory of a card, plus the unified memory's share, and the RAM without what the system keeps", () => {
    expect(budgetOf(computer({ gpus: card(10000) }))).toEqual({ gpuMb: 9000, ramMb: 9878 });
    expect(budgetOf(computer({ gpus: [{ name: "m", vendor: "apple", kind: "unified", memoryMb: 16384 }], ramMb: 16384, freeRamMb: 8000 }))).toEqual({ gpuMb: Math.floor(Math.floor(16384 * 0.66) * 0.9), ramMb: 6278 });
  });

  test("a card that shares the computer's memory gives none of its own; memory that could not be read is not counted for the card, and the RAM is half of it", () => {
    expect(budgetOf(computer({ gpus: [{ name: "i", vendor: "intel", kind: "integrated" }, { name: "u", vendor: "amd", kind: "unknown" }] })).gpuMb).toBe(0);
    expect(budgetOf(computer({ freeRamMb: undefined, ramMb: 16384 })).ramMb).toBe(Math.floor((8192 - 1024) * 0.9));
  });
});

describe("where a model runs", () => {
  test("all in a big card", () => {
    expect(fit(weights, shape, 32768, computer({ gpus: card(23000, 24564) }))).toMatchObject({ fit: "gpu", gpuLayers: 32 });
  });

  test("a small card takes as many layers as there are room for and the computer's memory the rest", () => {
    const r = fit(weights, shape, 32768, computer({ gpus: card(7000) }));
    expect(r.fit).toBe("ram");
    expect(r.gpuLayers).toBe(19);
    expect(r.needMb).toBeGreaterThan(9000);
  });

  test("no card: the RAM, with no layer on a card", () => {
    expect(fit(weights, shape, 32768, computer({}))).toMatchObject({ fit: "ram", gpuLayers: 0 });
  });

  test("a card and the RAM together can hold what neither holds alone", () => {
    expect(fit(14 * GB, shape, 8192, computer({ gpus: card(6000), freeRamMb: 15000 })).fit).toBe("ram");
    expect(fit(14 * GB, shape, 8192, computer({ freeRamMb: 14000 })).fit).toBe("none");
  });

  test("too big for the memory there is", () => {
    expect(fit(weights, shape, 32768, computer({ freeRamMb: 8000 }))).toMatchObject({ fit: "none", gpuLayers: 0 });
  });

  test("Apple silicon: its one memory, two thirds of it, with a tenth left alone", () => {
    expect(fit(weights, shape, 32768, computer({ ramMb: 16384, gpus: [{ name: "m", vendor: "apple", kind: "unified", memoryMb: 16384 }] })).fit).toBe("gpu");
    expect(fit(weights, shape, 32768, computer({ ramMb: 8192, freeRamMb: 5000, gpus: [{ name: "m", vendor: "apple", kind: "unified", memoryMb: 8192 }] })).fit).toBe("none");
  });

  test("a larger context needs more: the same model fits at 8k and not at 128k", () => {
    const m = computer({ gpus: card(10000) });
    expect(fit(weights, shape, 8192, m).fit).toBe("gpu");
    expect(fit(weights, shape, 131072, m).fit).not.toBe("gpu");
  });

  test("the buffers are counted even when the weights alone fit", () => {
    const m = computer({ gpus: card(Math.ceil((4.7 * 1024 + 1) / 0.9)) });
    expect(fit(weights, { ...shape, kvHeads: Array(32).fill(0) }, 1024, m).fit).not.toBe("gpu");
    expect(OVERHEAD_MB).toBeGreaterThan(0);
  });
});

describe("the largest context that fits", () => {
  test("is a usual size, the largest that runs anywhere and no more than the model supports", () => {
    expect(largestContext(weights, shape, 131072, computer({}))).toBe(32768);
    expect(largestContext(weights, shape, 8192, computer({}))).toBe(8192);
    expect(largestContext(weights, shape, 131072, computer({ gpus: card(49000), freeRamMb: 60000, ramMb: 65536 }))).toBe(131072);
  });

  test("none when not even the smallest fits", () => {
    expect(largestContext(20 * GB, shape, 131072, computer({}))).toBeUndefined();
  });
});

describe("a kind of model the formula is not proven for", () => {
  test("nothing is said of where it runs, and no context is claimed for it", () => {
    for (const architecture of ["mamba", "jamba", "qwen3next", "something-new"]) {
      expect(fitOf(weights, { ...shape, architecture }, 8192, computer({ gpus: card(23000) }))).toBeUndefined();
      expect(largestContext(weights, { ...shape, architecture }, 131072, computer({ gpus: card(23000) }))).toBeUndefined();
    }
  });

  test("every kind on the list is one that keeps keys and values in every layer", () => {
    expect(PROVEN_ARCHITECTURES).toEqual(["llama", "qwen2", "qwen3", "qwen3moe", "gemma2", "gemma3", "phi3"]);
    for (const architecture of PROVEN_ARCHITECTURES) expect(fitOf(weights, { ...shape, architecture }, 8192, computer({ gpus: card(23000) }))?.fit).toBe("gpu");
  });
});
