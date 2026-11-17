import { delay } from "../core/clock.ts";
import { RunwrightError } from "../core/errors.ts";
import { sha256Hex } from "../core/json.ts";
import type { SecretsReader } from "../engine/types.ts";
import { createAnthropicProvider } from "./anthropic.ts";
import { createOpenAiProvider } from "./openai.ts";
import type { RetryPolicyOptions } from "./retry.ts";
import { createScriptedProvider } from "./scripted.ts";
import type { ModelCredential, ModelProvider, ModelRef, ModelRegistry } from "./types.ts";
import { apiKeySecretName } from "./util.ts";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
/** The most provider objects one registry keeps; the oldest is dropped (and made again when it is needed). */
export const MAX_CACHED_PROVIDERS = 64;

export interface ModelRegistryDeps {
  secrets: SecretsReader;
  retry: RetryPolicyOptions;
  fetch?: typeof fetch;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The provider object the registry hands out: the provider, plus the credential it sends (none without a key). */
function withCredential(provider: ModelProvider, secretName: string, apiKey: string | null): ModelProvider {
  const credentials: readonly ModelCredential[] = apiKey === null || apiKey === ""
    ? Object.freeze([])
    : Object.freeze([Object.freeze({ name: secretName, value: apiKey })]);
  return Object.freeze({ generate: provider.generate.bind(provider), credentials });
}

function normalizeBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new RunwrightError("validation_failed", `model baseUrl is not an http(s) URL: ${url}`);
  }
  return url.replace(/\/+$/, "");
}

/**
 * Resolves a ModelRef to a provider. Providers make exactly one request per call; the registry only carries the
 * retry policy (`retry`), which the engine applies attempt by attempt. Keys come from the secrets reader at resolve
 * time. A custom OpenAI-compatible base URL only gets a key when the ref names its secret explicitly, so the
 * default OpenAI key is never sent to some other server. A provider that sends a key carries it in `credentials`
 * under the name of the secret it was read from; providers are cached per secret name and key digest, so a rotated
 * key gives a new provider object with the new credential.
 */
export function createModelRegistry(deps: ModelRegistryDeps): ModelRegistry {
  const sleep = deps.sleep ?? delay;
  const random = deps.random ?? Math.random;
  const cache = new Map<string, ModelProvider>();

  const cached = (key: string, make: () => ModelProvider): ModelProvider => {
    let provider = cache.get(key);
    if (provider === undefined) {
      provider = make();
      if (cache.size >= MAX_CACHED_PROVIDERS) {
        const oldest = cache.keys().next();
        if (oldest.done !== true) cache.delete(oldest.value);
      }
      cache.set(key, provider);
    }
    return provider;
  };

  const revealKey = async (secretName: string, required: boolean): Promise<string | null> => {
    const revealed = await deps.secrets.reveal([secretName]);
    const value = Object.hasOwn(revealed, secretName) ? revealed[secretName] : undefined;
    if (value === undefined || value === "") {
      if (required) {
        throw new RunwrightError("secret_missing", `the model API key secret ${secretName} is not set`, { details: { secret: secretName } });
      }
      return null;
    }
    return value;
  };

  return {
    retry: { policy: { ...deps.retry }, random, sleep },
    async resolve(ref: ModelRef): Promise<ModelProvider> {
      switch (ref.provider) {
        case "scripted":
          return cached("scripted", () => createScriptedProvider({ sleep }));
        case "anthropic": {
          const secretName = apiKeySecretName(ref) ?? "ANTHROPIC_API_KEY";
          const apiKey = (await revealKey(secretName, true)) ?? "";
          const baseUrl = ref.baseUrl === undefined ? undefined : normalizeBaseUrl(ref.baseUrl);
          const key = `anthropic\u0000${baseUrl ?? ""}\u0000${secretName}\u0000${sha256Hex(apiKey)}`;
          return cached(key, () => withCredential(
            createAnthropicProvider({ apiKey, ...(baseUrl === undefined ? {} : { baseUrl }), ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) }),
            secretName, apiKey,
          ));
        }
        case "openai-compatible": {
          const baseUrl = normalizeBaseUrl(ref.baseUrl ?? DEFAULT_OPENAI_BASE_URL);
          const isDefault = baseUrl === DEFAULT_OPENAI_BASE_URL;
          const secretName = isDefault ? apiKeySecretName(ref) ?? "OPENAI_API_KEY" : ref.apiKeySecret ?? null;
          const apiKey = secretName === null ? null : await revealKey(secretName, true);
          const key = `openai-compatible\u0000${baseUrl}\u0000${secretName ?? ""}\u0000${apiKey === null ? "" : sha256Hex(apiKey)}`;
          return cached(key, () => withCredential(
            createOpenAiProvider({ apiKey, baseUrl, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) }),
            secretName ?? "", apiKey,
          ));
        }
        default: {
          const provider: string = (ref as { provider: string }).provider;
          throw new RunwrightError("model_unknown", `unknown model provider "${provider}"`, { details: { provider } });
        }
      }
    },
  };
}
