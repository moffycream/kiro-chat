/**
 * What the v3 engine says can be configured about a session.
 *
 * `session/new`, `session/load`, `session/fork` and every
 * `session/set_config_option` answer with `configOptions`, and a
 * `config_option_update` notification repeats it whenever anything moves. It
 * is the one source for the model list, the credit rates and effort: there is
 * no `models` block any more, and `session/set_model` is refused.
 *
 * Measured against kiro-cli 3.1.0; `test/fixtures/kiro-config-options.json` is
 * the captured payload. Free of `vscode` so `test/configOptions.test.js` can
 * drive it.
 */

import { creditRateOf, describeContextWindow, numberFrom } from "./usage";

export interface ConfigModel {
  modelId: string;
  name: string;
  description?: string;
  creditRate?: string;
  contextWindow?: string;
  contextWindowTokens?: number;
  /** Only on a model that takes an effort level. */
  effortLevels?: string[];
  defaultEffort?: string;
}

export interface EffortState {
  /** The id to write back. `effortLevel` today, found through its category. */
  configId: string;
  current: string;
  levels: Array<{ value: string; name: string }>;
  /** What the current model uses when nobody has chosen. */
  defaultLevel?: string;
}

export interface SessionConfig {
  modelConfigId: string;
  models: ConfigModel[];
  currentModelId: string;
  /**
   * Absent when the current model has no effort levels. Kiro drops the option
   * outright for `auto` and for older models, so "no option" is the signal.
   */
  effort?: EffortState;
}

/**
 * The context window, out of Kiro's own sentence about the model.
 *
 * The option carries a rate but no window, so "with 1M context window" in the
 * description is all there is. Only a figure beside the words "context window"
 * is read, in the spirit of `findCreditRate`: a number nobody said is never
 * shown.
 */
export function contextWindowFrom(description: unknown): number | undefined {
  const match = String(description ?? "").match(/(\d+(?:\.\d+)?)\s*([km])\b[^.]*context window/i);
  if (!match) return undefined;
  return Number(match[1]) * (match[2].toLowerCase() === "m" ? 1_000_000 : 1_000);
}

function readModel(option: any): ConfigModel | undefined {
  const modelId = String(option?.value ?? "").trim();
  if (!modelId) return undefined;
  const kiro = option?._meta?.kiro ?? {};
  const description = option?.description ? String(option.description) : undefined;
  const tokens = contextWindowFrom(description);
  const model: ConfigModel = {
    modelId,
    name: String(option?.name ?? modelId),
    description,
    creditRate: numberFrom(kiro.rateMultiplier) !== undefined ? creditRateOf(kiro) : undefined,
    contextWindow: describeContextWindow(tokens),
    contextWindowTokens: tokens,
  };
  if (kiro.hasEffort === true && Array.isArray(kiro.effortLevels)) {
    model.effortLevels = kiro.effortLevels.map((level: unknown) => String(level));
    if (kiro.defaultEffortLevel) model.defaultEffort = String(kiro.defaultEffortLevel);
  }
  return model;
}

/**
 * The option is found by its category, which is ACP's word for it, with Kiro's
 * id as the fallback. Anything that is not a select with choices is ignored.
 */
function readEffort(options: any[], model: ConfigModel | undefined): EffortState | undefined {
  const option = options.find(
    (candidate) => candidate?.category === "thought_level" || candidate?.id === "effortLevel"
  );
  if (!option || !Array.isArray(option.options) || option.options.length === 0) return undefined;
  const levels = option.options
    .map((level: any) => ({
      value: String(level?.value ?? ""),
      name: String(level?.name ?? level?.value ?? ""),
    }))
    .filter((level: { value: string }) => level.value);
  if (levels.length === 0) return undefined;
  return {
    configId: String(option.id),
    current: String(option.currentValue ?? ""),
    levels,
    defaultLevel: model?.defaultEffort,
  };
}

/** Everything the panel draws from `configOptions`, or undefined if it has no models. */
export function readSessionConfig(options: unknown): SessionConfig | undefined {
  if (!Array.isArray(options)) return undefined;
  const modelOption = options.find(
    (option) => option?.category === "model" || option?.id === "model"
  );
  if (!modelOption || !Array.isArray(modelOption.options)) return undefined;
  const models = modelOption.options
    .map(readModel)
    .filter((model: ConfigModel | undefined): model is ConfigModel => model !== undefined);
  const currentModelId = String(modelOption.currentValue ?? models[0]?.modelId ?? "");
  return {
    modelConfigId: String(modelOption.id ?? "model"),
    models,
    currentModelId,
    effort: readEffort(
      options,
      models.find((model: ConfigModel) => model.modelId === currentModelId)
    ),
  };
}
