/**
 * Optional live smoke test against Jev through the Vercel AI Gateway. Requires
 * AI_GATEWAY_API_KEY in the environment (JEV_PROVIDER=vercel is implied) and
 * performs one minimal real evaluation. Skips cleanly without credentials, so
 * it never becomes required for normal CI.
 */
import { createVercelAdapter, GATEWAY_MODEL } from "../src/adapters/vercel-jev.ts";
import { checkEnvironment } from "./smoke-env.ts";

const env = process.env;
const verdict = checkEnvironment(env, { provider: "vercel" });
if (verdict.skip) {
  console.log(`smoke:vercel skipped: ${verdict.skip}`);
  process.exit(0);
}

const adapter = createVercelAdapter(env);
const started = Date.now();
const response = (await adapter.ask(
  {
    state: { change: "renamed variable base to amount in price()" },
    questions: {
      renamed: { type: "noul", instructions: "Does the change rename a variable?" },
      severity: {
        type: "choice",
        instructions: "How severe is this change?",
        criteria: { cosmetic: "rename only", behavioral: "changes behavior" },
      },
    },
    model: GATEWAY_MODEL,
  },
  { timeoutMs: 30_000 },
)) as {
  model: string;
  answers: Record<string, Record<string, unknown>>;
  usage: { input_tokens: number; output_tokens: number };
};

const answers = response.answers;
if (!answers.renamed || !answers.severity) throw new Error("smoke:vercel: missing answers");
console.log(
  `smoke:vercel ok: model=${response.model} renamed=${(answers.renamed as { noul: number }).noul} ` +
    `severity=${(answers.severity as { choice: string }).choice} ` +
    `confidence=${(answers.severity as { confidence: number }).confidence} ` +
    `tokens=${response.usage.input_tokens}/${response.usage.output_tokens} ` +
    `latencyMs=${Date.now() - started}`,
);
