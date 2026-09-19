/**
 * Optional live smoke test against Jev through Cloudflare Workers AI. Requires
 * JEV_SMOKE=1, CLOUDFLARE_ACCOUNT_ID, and a Cloudflare API token
 * (CLOUDFLARE_API_TOKEN or JEV_CLOUDFLARE_API_TOKEN) in the environment and
 * performs one minimal real evaluation. Skips cleanly without credentials, so
 * it never becomes required for normal CI.
 */
import { CLOUDFLARE_MODEL, createCloudflareAdapter } from "../src/adapters/cloudflare-jev.ts";
import { checkEnvironment } from "./smoke-env.ts";

const env = process.env;
const verdict = checkEnvironment(env, { provider: "cloudflare" });
if (verdict.skip) {
  console.log(`smoke:cloudflare skipped: ${verdict.skip}`);
  process.exit(0);
}

const adapter = createCloudflareAdapter(env);
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
    model: CLOUDFLARE_MODEL,
  },
  { timeoutMs: 30_000 },
)) as {
  model: string;
  answers: Record<string, Record<string, unknown>>;
  usage: { input_tokens: number; output_tokens: number };
};

const answers = response.answers;
if (!answers.renamed || !answers.severity) throw new Error("smoke:cloudflare: missing answers");
console.log(
  `smoke:cloudflare ok: model=${response.model} renamed=${(answers.renamed as { noul: number }).noul} ` +
    `severity=${(answers.severity as { choice: string }).choice} ` +
    `confidence=${(answers.severity as { confidence: number }).confidence} ` +
    `tokens=${response.usage.input_tokens}/${response.usage.output_tokens} ` +
    `latencyMs=${Date.now() - started}`,
);
