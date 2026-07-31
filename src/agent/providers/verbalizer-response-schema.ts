// JSON Schema da saída aceita do LLM Verbalizer, usado como guided_json na
// chamada NVIDIA #2. Schema deliberadamente pequeno: só texto e os IDs de
// fato usados — nenhum campo estrutural de ação, preço ou produto (isso
// nunca é produzido pela verbalização, só citado via usedFactIds e
// checado por response-text-validator.ts).
const RESPONSE_TEXT_MAX_LENGTH = 700;
const MAX_USED_FACT_IDS = 20;
const FACT_ID_MAX_LENGTH = 120;

export const VERBALIZER_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["responseText", "usedFactIds"],
  properties: {
    responseText: { type: "string", minLength: 1, maxLength: RESPONSE_TEXT_MAX_LENGTH },
    usedFactIds: {
      type: "array",
      maxItems: MAX_USED_FACT_IDS,
      items: { type: "string", minLength: 1, maxLength: FACT_ID_MAX_LENGTH },
    },
  },
} as const;

export const VERBALIZER_RESPONSE_TEXT_MAX_LENGTH = RESPONSE_TEXT_MAX_LENGTH;
