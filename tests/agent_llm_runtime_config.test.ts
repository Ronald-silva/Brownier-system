import assert from "node:assert/strict";
import test from "node:test";
import { LlmRuntimeConfigError, readLlmRuntimeConfig } from "../src/agent/llm-runtime-config.ts";

type Env = Record<string, string | undefined>;

function validFallbackEnv(overrides: Env = {}): Env {
  return {
    BF_LLM_MODE: "OPENAI_FALLBACK",
    OPENAI_API_KEY: "sk-abc123",
    OPENAI_MODEL: "gpt-test-model",
    ...overrides,
  };
}

function validNvidiaEnv(overrides: Env = {}): Env {
  return {
    BF_LLM_MODE: "NVIDIA_NEMOTRON",
    NVIDIA_API_KEY: "nvapi-abc123",
    ...overrides,
  };
}

function assertThrowsWithCode(env: Env, code: string) {
  assert.throws(
    () => readLlmRuntimeConfig(env),
    (error: unknown) => {
      assert.ok(error instanceof LlmRuntimeConfigError);
      assert.equal(error.name, "LlmRuntimeConfigError");
      assert.equal(error.code, code);
      return true;
    },
  );
}

test("1. env vazio retorna DISABLED", () => {
  assert.deepEqual(readLlmRuntimeConfig({}), { mode: "DISABLED" });
});

test("2. BF_LLM_MODE ausente retorna DISABLED", () => {
  const result = readLlmRuntimeConfig({ OPENAI_API_KEY: undefined, OPENAI_MODEL: undefined });
  assert.deepEqual(result, { mode: "DISABLED" });
});

test("3. BF_LLM_MODE vazio retorna DISABLED", () => {
  assert.deepEqual(readLlmRuntimeConfig({ BF_LLM_MODE: "" }), { mode: "DISABLED" });
});

test("4. BF_LLM_MODE com espaços retorna DISABLED", () => {
  assert.deepEqual(readLlmRuntimeConfig({ BF_LLM_MODE: "   " }), { mode: "DISABLED" });
});

test("5. DISABLED explícito retorna somente mode", () => {
  const result = readLlmRuntimeConfig({ BF_LLM_MODE: "DISABLED" });
  assert.deepEqual(result, { mode: "DISABLED" });
  assert.deepEqual(Object.keys(result), ["mode"]);
});

test("6. DISABLED não exige API key", () => {
  const result = readLlmRuntimeConfig({ BF_LLM_MODE: "DISABLED" });
  assert.deepEqual(result, { mode: "DISABLED" });
});

test("7. DISABLED não exige model", () => {
  const result = readLlmRuntimeConfig({ BF_LLM_MODE: "DISABLED" });
  assert.deepEqual(result, { mode: "DISABLED" });
});

test("8. DISABLED ignora API key vazia", () => {
  const result = readLlmRuntimeConfig({ BF_LLM_MODE: "DISABLED", OPENAI_API_KEY: "" });
  assert.deepEqual(result, { mode: "DISABLED" });
});

test("9. DISABLED ignora model vazio", () => {
  const result = readLlmRuntimeConfig({ BF_LLM_MODE: "DISABLED", OPENAI_MODEL: "" });
  assert.deepEqual(result, { mode: "DISABLED" });
});

test("10. OPENAI_FALLBACK válido retorna chave e modelo", () => {
  const result = readLlmRuntimeConfig(validFallbackEnv());
  assert.deepEqual(result, {
    mode: "OPENAI_FALLBACK",
    openaiApiKey: "sk-abc123",
    openaiModel: "gpt-test-model",
    maxRequestsPerMinute: 30,
    maxConcurrentRequests: 2,
  });
});

test("11. aplica trim ao modo", () => {
  const result = readLlmRuntimeConfig(validFallbackEnv({ BF_LLM_MODE: "  OPENAI_FALLBACK  " }));
  assert.equal(result.mode, "OPENAI_FALLBACK");
});

test("12. aplica trim à API key", () => {
  const result = readLlmRuntimeConfig(validFallbackEnv({ OPENAI_API_KEY: "  sk-abc123  " }));
  assert.equal(result.mode, "OPENAI_FALLBACK");
  assert.equal((result as { openaiApiKey: string }).openaiApiKey, "sk-abc123");
});

test("13. aplica trim ao model", () => {
  const result = readLlmRuntimeConfig(validFallbackEnv({ OPENAI_MODEL: "  gpt-test-model  " }));
  assert.equal(result.mode, "OPENAI_FALLBACK");
  assert.equal((result as { openaiModel: string }).openaiModel, "gpt-test-model");
});

test("14. OPENAI_FALLBACK sem chave é rejeitado", () => {
  assertThrowsWithCode(validFallbackEnv({ OPENAI_API_KEY: undefined }), "MISSING_OPENAI_API_KEY");
});

test("15. OPENAI_FALLBACK com chave vazia é rejeitado", () => {
  assertThrowsWithCode(validFallbackEnv({ OPENAI_API_KEY: "" }), "MISSING_OPENAI_API_KEY");
});

test("16. OPENAI_FALLBACK com chave apenas em espaços é rejeitado", () => {
  assertThrowsWithCode(validFallbackEnv({ OPENAI_API_KEY: "   " }), "MISSING_OPENAI_API_KEY");
});

test("17. OPENAI_FALLBACK sem model é rejeitado", () => {
  assertThrowsWithCode(validFallbackEnv({ OPENAI_MODEL: undefined }), "MISSING_OPENAI_MODEL");
});

test("18. OPENAI_FALLBACK com model vazio é rejeitado", () => {
  assertThrowsWithCode(validFallbackEnv({ OPENAI_MODEL: "" }), "MISSING_OPENAI_MODEL");
});

test("19. OPENAI_FALLBACK com model apenas em espaços é rejeitado", () => {
  assertThrowsWithCode(validFallbackEnv({ OPENAI_MODEL: "   " }), "MISSING_OPENAI_MODEL");
});

test("20. model acima do limite é rejeitado", () => {
  assertThrowsWithCode(validFallbackEnv({ OPENAI_MODEL: "x".repeat(201) }), "INVALID_OPENAI_MODEL");
});

test("21. modo desconhecido é rejeitado", () => {
  for (const invalid of ["OPENAI", "ENABLED", "FALLBACK", "TRUE", "1", "openai_fallback"]) {
    assertThrowsWithCode({ BF_LLM_MODE: invalid }, "INVALID_LLM_MODE");
  }
});

test("22. modo em lowercase é rejeitado", () => {
  assertThrowsWithCode({ BF_LLM_MODE: "disabled" }, "INVALID_LLM_MODE");
  assertThrowsWithCode(validFallbackEnv({ BF_LLM_MODE: "openai_fallback" }), "INVALID_LLM_MODE");
});

test("23. erro de chave não contém o valor da chave", () => {
  const secret = "sk-super-secret-value-should-not-leak";
  try {
    readLlmRuntimeConfig(validFallbackEnv({ OPENAI_API_KEY: undefined }));
    assert.fail("deveria ter lançado");
  } catch (error) {
    assert.ok(error instanceof LlmRuntimeConfigError);
    assert.ok(!error.message.includes(secret));
  }

  try {
    readLlmRuntimeConfig(validFallbackEnv({ OPENAI_API_KEY: "   " }));
    assert.fail("deveria ter lançado");
  } catch (error) {
    assert.ok(error instanceof LlmRuntimeConfigError);
    assert.ok(!error.message.includes(secret));
  }
});

test("24. erro não contém o objeto env serializado", () => {
  const env = validFallbackEnv({ OPENAI_MODEL: undefined, UNRELATED_SECRET: "unrelated-secret-value" });
  try {
    readLlmRuntimeConfig(env);
    assert.fail("deveria ter lançado");
  } catch (error) {
    assert.ok(error instanceof LlmRuntimeConfigError);
    assert.ok(!error.message.includes("unrelated-secret-value"));
    assert.ok(!error.message.includes(JSON.stringify(env)));
  }
});

test("25. função não muta env", () => {
  const env = validFallbackEnv();
  const snapshot = JSON.stringify(env);
  readLlmRuntimeConfig(env);
  assert.equal(JSON.stringify(env), snapshot);
});

test("26. objetos retornados são novos", () => {
  const env = validFallbackEnv();
  const result1 = readLlmRuntimeConfig(env);
  const result2 = readLlmRuntimeConfig(env);
  assert.notEqual(result1, result2);
  assert.deepEqual(result1, result2);
});

test("27. duas chamadas não compartilham estado", () => {
  const firstResult = readLlmRuntimeConfig(validFallbackEnv({ OPENAI_MODEL: "model-a" }));
  const secondResult = readLlmRuntimeConfig({ BF_LLM_MODE: "DISABLED" });
  assert.deepEqual(firstResult, {
    mode: "OPENAI_FALLBACK",
    openaiApiKey: "sk-abc123",
    openaiModel: "model-a",
    maxRequestsPerMinute: 30,
    maxConcurrentRequests: 2,
  });
  assert.deepEqual(secondResult, { mode: "DISABLED" });
});

test("28. API key com prefixo não convencional é aceita", () => {
  const result = readLlmRuntimeConfig(validFallbackEnv({ OPENAI_API_KEY: "not-a-standard-openai-prefix" }));
  assert.equal(result.mode, "OPENAI_FALLBACK");
  assert.equal((result as { openaiApiKey: string }).openaiApiKey, "not-a-standard-openai-prefix");
});

test("29. model não é validado contra lista fixa", () => {
  const result = readLlmRuntimeConfig(validFallbackEnv({ OPENAI_MODEL: "my-completely-custom-model-xyz" }));
  assert.equal(result.mode, "OPENAI_FALLBACK");
  assert.equal((result as { openaiModel: string }).openaiModel, "my-completely-custom-model-xyz");
});

test("30. propriedades adicionais no env não aparecem no retorno", () => {
  const result = readLlmRuntimeConfig(validFallbackEnv({ FOO_BAR: "baz", ANOTHER_VAR: "qux" }));
  assert.deepEqual(Object.keys(result).sort(), [
    "maxConcurrentRequests",
    "maxRequestsPerMinute",
    "mode",
    "openaiApiKey",
    "openaiModel",
  ]);
});

test("31. OPENAI_FALLBACK usa padrão 30 para requests/minuto quando ausente", () => {
  const result = readLlmRuntimeConfig(validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: undefined }));
  assert.equal((result as { maxRequestsPerMinute: number }).maxRequestsPerMinute, 30);
});

test("32. OPENAI_FALLBACK usa padrão 2 para concorrência quando ausente", () => {
  const result = readLlmRuntimeConfig(validFallbackEnv({ BF_LLM_MAX_CONCURRENT_REQUESTS: undefined }));
  assert.equal((result as { maxConcurrentRequests: number }).maxConcurrentRequests, 2);
});

test("33. valores vazios usam os padrões", () => {
  const result = readLlmRuntimeConfig(
    validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "", BF_LLM_MAX_CONCURRENT_REQUESTS: "" }),
  );
  assert.equal((result as { maxRequestsPerMinute: number }).maxRequestsPerMinute, 30);
  assert.equal((result as { maxConcurrentRequests: number }).maxConcurrentRequests, 2);
});

test("34. valores com espaços usam os padrões", () => {
  const result = readLlmRuntimeConfig(
    validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "   ", BF_LLM_MAX_CONCURRENT_REQUESTS: "   " }),
  );
  assert.equal((result as { maxRequestsPerMinute: number }).maxRequestsPerMinute, 30);
  assert.equal((result as { maxConcurrentRequests: number }).maxConcurrentRequests, 2);
});

test("35. valor válido de requests/minuto é convertido", () => {
  const result = readLlmRuntimeConfig(validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "120" }));
  assert.equal((result as { maxRequestsPerMinute: number }).maxRequestsPerMinute, 120);
});

test("36. valor válido de concorrência é convertido", () => {
  const result = readLlmRuntimeConfig(validFallbackEnv({ BF_LLM_MAX_CONCURRENT_REQUESTS: "5" }));
  assert.equal((result as { maxConcurrentRequests: number }).maxConcurrentRequests, 5);
});

test("37. trim é aplicado antes da conversão", () => {
  const result = readLlmRuntimeConfig(
    validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "  45  ", BF_LLM_MAX_CONCURRENT_REQUESTS: "  7  " }),
  );
  assert.equal((result as { maxRequestsPerMinute: number }).maxRequestsPerMinute, 45);
  assert.equal((result as { maxConcurrentRequests: number }).maxConcurrentRequests, 7);
});

test("38. requests/minuto zero é rejeitado", () => {
  assertThrowsWithCode(validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "0" }), "INVALID_LLM_MAX_REQUESTS_PER_MINUTE");
});

test("39. requests/minuto negativo é rejeitado", () => {
  assertThrowsWithCode(validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "-5" }), "INVALID_LLM_MAX_REQUESTS_PER_MINUTE");
});

test("40. requests/minuto decimal é rejeitado", () => {
  assertThrowsWithCode(validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "10.5" }), "INVALID_LLM_MAX_REQUESTS_PER_MINUTE");
});

test("41. requests/minuto acima de 600 é rejeitado", () => {
  assertThrowsWithCode(validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "601" }), "INVALID_LLM_MAX_REQUESTS_PER_MINUTE");
});

test("42. requests/minuto textual é rejeitado", () => {
  assertThrowsWithCode(validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "abc" }), "INVALID_LLM_MAX_REQUESTS_PER_MINUTE");
});

test("43. valor misto como 30abc é rejeitado", () => {
  assertThrowsWithCode(validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "30abc" }), "INVALID_LLM_MAX_REQUESTS_PER_MINUTE");
});

test("44. concorrência zero é rejeitada", () => {
  assertThrowsWithCode(validFallbackEnv({ BF_LLM_MAX_CONCURRENT_REQUESTS: "0" }), "INVALID_LLM_MAX_CONCURRENT_REQUESTS");
});

test("45. concorrência negativa é rejeitada", () => {
  assertThrowsWithCode(validFallbackEnv({ BF_LLM_MAX_CONCURRENT_REQUESTS: "-1" }), "INVALID_LLM_MAX_CONCURRENT_REQUESTS");
});

test("46. concorrência decimal é rejeitada", () => {
  assertThrowsWithCode(validFallbackEnv({ BF_LLM_MAX_CONCURRENT_REQUESTS: "1.5" }), "INVALID_LLM_MAX_CONCURRENT_REQUESTS");
});

test("47. concorrência acima de 20 é rejeitada", () => {
  assertThrowsWithCode(validFallbackEnv({ BF_LLM_MAX_CONCURRENT_REQUESTS: "21" }), "INVALID_LLM_MAX_CONCURRENT_REQUESTS");
});

test("48. concorrência textual é rejeitada", () => {
  assertThrowsWithCode(validFallbackEnv({ BF_LLM_MAX_CONCURRENT_REQUESTS: "abc" }), "INVALID_LLM_MAX_CONCURRENT_REQUESTS");
});

test("49. valor misto de concorrência como 2abc é rejeitado", () => {
  assertThrowsWithCode(validFallbackEnv({ BF_LLM_MAX_CONCURRENT_REQUESTS: "2abc" }), "INVALID_LLM_MAX_CONCURRENT_REQUESTS");
});

test("50. concorrência Infinity é rejeitada", () => {
  assertThrowsWithCode(validFallbackEnv({ BF_LLM_MAX_CONCURRENT_REQUESTS: "Infinity" }), "INVALID_LLM_MAX_CONCURRENT_REQUESTS");
});

test("51. requests/minuto NaN textual é rejeitado", () => {
  assertThrowsWithCode(validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "NaN" }), "INVALID_LLM_MAX_REQUESTS_PER_MINUTE");
});

test("52. erro não contém API key", () => {
  const secret = "sk-super-secret-value-should-not-leak";
  try {
    readLlmRuntimeConfig(validFallbackEnv({ OPENAI_API_KEY: secret, BF_LLM_MAX_REQUESTS_PER_MINUTE: "abc" }));
    assert.fail("deveria ter lançado");
  } catch (error) {
    assert.ok(error instanceof LlmRuntimeConfigError);
    assert.ok(!error.message.includes(secret));
  }
});

test("53. erro não contém o valor inválido", () => {
  try {
    readLlmRuntimeConfig(validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "999999" }));
    assert.fail("deveria ter lançado");
  } catch (error) {
    assert.ok(error instanceof LlmRuntimeConfigError);
    assert.ok(!error.message.includes("999999"));
  }

  try {
    readLlmRuntimeConfig(validFallbackEnv({ BF_LLM_MAX_CONCURRENT_REQUESTS: "999999" }));
    assert.fail("deveria ter lançado");
  } catch (error) {
    assert.ok(error instanceof LlmRuntimeConfigError);
    assert.ok(!error.message.includes("999999"));
  }
});

test("54. DISABLED ignora ambas as variáveis inválidas", () => {
  const result = readLlmRuntimeConfig({
    BF_LLM_MODE: "DISABLED",
    BF_LLM_MAX_REQUESTS_PER_MINUTE: "inválido",
    BF_LLM_MAX_CONCURRENT_REQUESTS: "-10",
  });
  assert.deepEqual(result, { mode: "DISABLED" });
});

test("55. DISABLED continua retornando somente mode", () => {
  const result = readLlmRuntimeConfig({
    BF_LLM_MODE: "DISABLED",
    BF_LLM_MAX_REQUESTS_PER_MINUTE: "50",
    BF_LLM_MAX_CONCURRENT_REQUESTS: "3",
  });
  assert.deepEqual(Object.keys(result), ["mode"]);
});

test("56. função não muta env com os novos campos", () => {
  const env = validFallbackEnv({ BF_LLM_MAX_REQUESTS_PER_MINUTE: "50", BF_LLM_MAX_CONCURRENT_REQUESTS: "3" });
  const snapshot = JSON.stringify(env);
  readLlmRuntimeConfig(env);
  assert.equal(JSON.stringify(env), snapshot);
});

test("57. NVIDIA_NEMOTRON é reconhecido", () => {
  const result = readLlmRuntimeConfig(validNvidiaEnv());
  assert.equal(result.mode, "NVIDIA_NEMOTRON");
});

test("58. API key NVIDIA válida é retornada", () => {
  const result = readLlmRuntimeConfig(validNvidiaEnv({ NVIDIA_API_KEY: "nvapi-abc123" }));
  assert.equal((result as { nvidiaApiKey: string }).nvidiaApiKey, "nvapi-abc123");
});

test("59. trim é aplicado à API key NVIDIA", () => {
  const result = readLlmRuntimeConfig(validNvidiaEnv({ NVIDIA_API_KEY: "  nvapi-abc123  " }));
  assert.equal((result as { nvidiaApiKey: string }).nvidiaApiKey, "nvapi-abc123");
});

test("60. API key NVIDIA ausente é rejeitada", () => {
  assertThrowsWithCode(validNvidiaEnv({ NVIDIA_API_KEY: undefined }), "MISSING_NVIDIA_API_KEY");
});

test("61. API key NVIDIA vazia é rejeitada", () => {
  assertThrowsWithCode(validNvidiaEnv({ NVIDIA_API_KEY: "" }), "MISSING_NVIDIA_API_KEY");
});

test("62. API key NVIDIA com somente espaços é rejeitada", () => {
  assertThrowsWithCode(validNvidiaEnv({ NVIDIA_API_KEY: "   " }), "MISSING_NVIDIA_API_KEY");
});

test("63. modelo NVIDIA padrão é usado quando ausente", () => {
  const result = readLlmRuntimeConfig(validNvidiaEnv({ NVIDIA_MODEL: undefined }));
  assert.equal((result as { nvidiaModel: string }).nvidiaModel, "nvidia/nemotron-3-ultra-550b-a55b");
});

test("64. modelo NVIDIA padrão é usado quando vazio", () => {
  const result = readLlmRuntimeConfig(validNvidiaEnv({ NVIDIA_MODEL: "" }));
  assert.equal((result as { nvidiaModel: string }).nvidiaModel, "nvidia/nemotron-3-ultra-550b-a55b");
});

test("65. modelo NVIDIA padrão é usado quando somente espaços", () => {
  const result = readLlmRuntimeConfig(validNvidiaEnv({ NVIDIA_MODEL: "   " }));
  assert.equal((result as { nvidiaModel: string }).nvidiaModel, "nvidia/nemotron-3-ultra-550b-a55b");
});

test("66. modelo NVIDIA customizado é aceito", () => {
  const result = readLlmRuntimeConfig(validNvidiaEnv({ NVIDIA_MODEL: "nvidia/custom-model" }));
  assert.equal((result as { nvidiaModel: string }).nvidiaModel, "nvidia/custom-model");
});

test("67. trim é aplicado ao modelo NVIDIA customizado", () => {
  const result = readLlmRuntimeConfig(validNvidiaEnv({ NVIDIA_MODEL: "  nvidia/custom-model  " }));
  assert.equal((result as { nvidiaModel: string }).nvidiaModel, "nvidia/custom-model");
});

test("68. base URL NVIDIA padrão é usada quando ausente", () => {
  const result = readLlmRuntimeConfig(validNvidiaEnv({ NVIDIA_BASE_URL: undefined }));
  assert.equal((result as { nvidiaBaseUrl: string }).nvidiaBaseUrl, "https://integrate.api.nvidia.com/v1");
});

test("69. base URL NVIDIA padrão é usada quando vazia", () => {
  const result = readLlmRuntimeConfig(validNvidiaEnv({ NVIDIA_BASE_URL: "" }));
  assert.equal((result as { nvidiaBaseUrl: string }).nvidiaBaseUrl, "https://integrate.api.nvidia.com/v1");
});

test("70. base URL NVIDIA padrão é usada quando somente espaços", () => {
  const result = readLlmRuntimeConfig(validNvidiaEnv({ NVIDIA_BASE_URL: "   " }));
  assert.equal((result as { nvidiaBaseUrl: string }).nvidiaBaseUrl, "https://integrate.api.nvidia.com/v1");
});

test("71. base URL NVIDIA customizada HTTPS é aceita", () => {
  const result = readLlmRuntimeConfig(validNvidiaEnv({ NVIDIA_BASE_URL: "https://custom.example.com/v2" }));
  assert.equal((result as { nvidiaBaseUrl: string }).nvidiaBaseUrl, "https://custom.example.com/v2");
});

test("72. trim é aplicado à base URL NVIDIA", () => {
  const result = readLlmRuntimeConfig(validNvidiaEnv({ NVIDIA_BASE_URL: "  https://custom.example.com/v2  " }));
  assert.equal((result as { nvidiaBaseUrl: string }).nvidiaBaseUrl, "https://custom.example.com/v2");
});

test("73. barra final da base URL NVIDIA é preservada", () => {
  const result = readLlmRuntimeConfig(validNvidiaEnv({ NVIDIA_BASE_URL: "https://custom.example.com/v2/" }));
  assert.equal((result as { nvidiaBaseUrl: string }).nvidiaBaseUrl, "https://custom.example.com/v2/");
});

test("74. base URL NVIDIA HTTP é rejeitada", () => {
  assertThrowsWithCode(validNvidiaEnv({ NVIDIA_BASE_URL: "http://custom.example.com/v2" }), "INVALID_NVIDIA_BASE_URL");
});

test("75. base URL NVIDIA inválida é rejeitada", () => {
  assertThrowsWithCode(validNvidiaEnv({ NVIDIA_BASE_URL: "not-a-url" }), "INVALID_NVIDIA_BASE_URL");
});

test("76. erro de chave NVIDIA usa MISSING_NVIDIA_API_KEY", () => {
  assertThrowsWithCode(validNvidiaEnv({ NVIDIA_API_KEY: undefined }), "MISSING_NVIDIA_API_KEY");
});

test("77. erro de modelo NVIDIA usa INVALID_NVIDIA_MODEL quando testável em runtime", () => {
  const env = validNvidiaEnv({ NVIDIA_MODEL: 123 as unknown as string });
  assertThrowsWithCode(env, "INVALID_NVIDIA_MODEL");
});

test("78. erro de URL NVIDIA usa INVALID_NVIDIA_BASE_URL", () => {
  assertThrowsWithCode(validNvidiaEnv({ NVIDIA_BASE_URL: "ftp://custom.example.com" }), "INVALID_NVIDIA_BASE_URL");
});

test("79. mensagem de erro NVIDIA não contém a API key", () => {
  const secret = "nvapi-super-secret-value-should-not-leak";
  try {
    readLlmRuntimeConfig(validNvidiaEnv({ NVIDIA_API_KEY: secret, NVIDIA_BASE_URL: "not-a-url" }));
    assert.fail("deveria ter lançado");
  } catch (error) {
    assert.ok(error instanceof LlmRuntimeConfigError);
    assert.ok(!error.message.includes(secret));
  }
});

test("80. mensagem de erro NVIDIA não contém a URL recebida", () => {
  const badUrl = "not-a-url-should-not-leak";
  try {
    readLlmRuntimeConfig(validNvidiaEnv({ NVIDIA_BASE_URL: badUrl }));
    assert.fail("deveria ter lançado");
  } catch (error) {
    assert.ok(error instanceof LlmRuntimeConfigError);
    assert.ok(!error.message.includes(badUrl));
  }
});

test("81. NVIDIA_NEMOTRON não exige variáveis OpenAI", () => {
  const result = readLlmRuntimeConfig({
    BF_LLM_MODE: "NVIDIA_NEMOTRON",
    NVIDIA_API_KEY: "nvapi-abc123",
    OPENAI_API_KEY: undefined,
    OPENAI_MODEL: undefined,
  });
  assert.equal(result.mode, "NVIDIA_NEMOTRON");
});

test("82. NVIDIA_NEMOTRON ignora limites OpenAI inválidos", () => {
  const result = readLlmRuntimeConfig(
    validNvidiaEnv({
      BF_LLM_MAX_REQUESTS_PER_MINUTE: "invalido",
      BF_LLM_MAX_CONCURRENT_REQUESTS: "-10",
    }),
  );
  assert.equal(result.mode, "NVIDIA_NEMOTRON");
  assert.deepEqual(Object.keys(result).sort(), ["mode", "nvidiaApiKey", "nvidiaBaseUrl", "nvidiaModel"]);
});

test("83. OPENAI_FALLBACK ignora variáveis NVIDIA inválidas", () => {
  const result = readLlmRuntimeConfig(
    validFallbackEnv({
      NVIDIA_API_KEY: "",
      NVIDIA_MODEL: 123 as unknown as string,
      NVIDIA_BASE_URL: "not-a-url",
    }),
  );
  assert.equal(result.mode, "OPENAI_FALLBACK");
});

test("84. OPENAI_FALLBACK mantém exatamente o formato atual mesmo com NVIDIA no env", () => {
  const result = readLlmRuntimeConfig(validFallbackEnv({ NVIDIA_API_KEY: "nvapi-abc123" }));
  assert.deepEqual(Object.keys(result).sort(), [
    "maxConcurrentRequests",
    "maxRequestsPerMinute",
    "mode",
    "openaiApiKey",
    "openaiModel",
  ]);
});

test("85. DISABLED ignora variáveis NVIDIA inválidas", () => {
  const result = readLlmRuntimeConfig({
    BF_LLM_MODE: "DISABLED",
    NVIDIA_API_KEY: "",
    NVIDIA_MODEL: 123 as unknown as string,
    NVIDIA_BASE_URL: "not-a-url",
  });
  assert.deepEqual(result, { mode: "DISABLED" });
});

test("86. DISABLED continua retornando somente mode mesmo com NVIDIA no env", () => {
  const result = readLlmRuntimeConfig({
    BF_LLM_MODE: "DISABLED",
    NVIDIA_API_KEY: "nvapi-abc123",
    NVIDIA_MODEL: "custom",
    NVIDIA_BASE_URL: "https://custom.example.com",
  });
  assert.deepEqual(Object.keys(result), ["mode"]);
});

test("87. env não é mutado para NVIDIA_NEMOTRON", () => {
  const env = validNvidiaEnv({ NVIDIA_MODEL: "custom", NVIDIA_BASE_URL: "https://custom.example.com" });
  const snapshot = JSON.stringify(env);
  readLlmRuntimeConfig(env);
  assert.equal(JSON.stringify(env), snapshot);
});

test("88. chamadas diferentes de NVIDIA_NEMOTRON retornam objetos independentes", () => {
  const env = validNvidiaEnv();
  const result1 = readLlmRuntimeConfig(env);
  const result2 = readLlmRuntimeConfig(env);
  assert.notEqual(result1, result2);
  assert.deepEqual(result1, result2);
});
