import { catalogLabel } from "../catalogPresentation.js";
import type { ReadyShader } from "./shaders";
import { READY_SHADERS as INTERNAL_READY_SHADERS } from "./shaders";

export const READY_SHADERS: readonly ReadyShader[] = INTERNAL_READY_SHADERS.map((shader) => ({
  ...shader,
  label: catalogLabel(shader),
}));

export const VISIBLE_READY_SHADERS = READY_SHADERS.filter((shader) => !shader.variantOf);

export const READY_SHADER_COLLECTION_COUNT = VISIBLE_READY_SHADERS.reduce(
  (total, shader) => total + (shader.variants?.length || 1),
  0,
);

export function getReadyShader(id: string): ReadyShader {
  return READY_SHADERS.find((shader) => shader.id === id) ?? READY_SHADERS[0];
}
