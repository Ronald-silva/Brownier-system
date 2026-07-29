import "dotenv/config";
import OpenAI from "openai";

const BASE_URL = "https://integrate.api.nvidia.com/v1";
const PRIMARY_MODEL = "nvidia/nemotron-3-super-120b-a12b";

if (process.env.BF_LLM_LIVE_SMOKE !== "true") {
  console.log("Smoke test NVIDIA desativado. Defina BF_LLM_LIVE_SMOKE=true para executar uma chamada externa.");
} else if (!process.env.NVIDIA_API_KEY) {
  console.error("NVIDIA_API_KEY não foi encontrada. Adicione-a ao arquivo .env e tente novamente.");
  process.exitCode = 1;
} else {
  const model = process.env.NVIDIA_NIM_MODEL || PRIMARY_MODEL;
  const client = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: BASE_URL,
  });

  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content: "Você é um assistente de programação. Responda apenas com código TypeScript válido.",
        },
        {
          role: "user",
          content: "Crie uma função pura chamada add que recebe dois numbers e retorna a soma, com export.",
        },
      ],
    });

    const answer = completion.choices[0]?.message?.content?.trim();
    if (!answer) throw new Error("A API respondeu sem conteúdo gerado.");

    console.log(`Conexão NVIDIA NIM validada com o modelo: ${model}`);
    console.log("\nCódigo gerado:\n");
    console.log(answer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Falha ao chamar NVIDIA NIM (${model}): ${message}`);
    process.exitCode = 1;
  }
}
