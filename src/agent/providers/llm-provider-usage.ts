// Contrato genérico de telemetria de uso, desacoplado do SDK da OpenAI —
// nenhum tipo do pacote "openai" aparece aqui, só o que já é seguro expor
// para fora do provider (nunca prompt, chave ou resposta bruta).
export type LlmProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  responseId?: string;
  durationMs: number;
};
