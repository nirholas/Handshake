import type { ReadyShader } from "./data/shaders";

export const THREEUI_METRICS_STORAGE_KEY = "threeui-metrics-v1";

export type ShaderMetrics = {
  views: number;
  copies: number;
};

type ShaderMetricStore = Partial<Record<ReadyShader["id"], ShaderMetrics>>;

function normalizeCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function readStore(): ShaderMetricStore {
  try {
    const stored = localStorage.getItem(THREEUI_METRICS_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(parsed).map(([id, metrics]) => {
      const entry = metrics && typeof metrics === "object" ? metrics as Record<string, unknown> : {};
      return [id, { views: normalizeCount(entry.views), copies: normalizeCount(entry.copies) }];
    })) as ShaderMetricStore;
  } catch {
    return {};
  }
}

export function readShaderMetrics(id: ReadyShader["id"]): ShaderMetrics {
  const metrics = readStore()[id];
  return metrics ? { ...metrics } : { views: 0, copies: 0 };
}

function incrementShaderMetric(id: ReadyShader["id"], metric: keyof ShaderMetrics) {
  const store = readStore();
  const current = readShaderMetrics(id);
  const next = { ...current, [metric]: current[metric] + 1 };
  store[id] = next;
  try {
    localStorage.setItem(THREEUI_METRICS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // The current page still shows the increment when persistence is unavailable.
  }
  return next;
}

export function recordShaderView(id: ReadyShader["id"]) {
  return incrementShaderMetric(id, "views");
}

export function recordShaderCopy(id: ReadyShader["id"]) {
  return incrementShaderMetric(id, "copies");
}
