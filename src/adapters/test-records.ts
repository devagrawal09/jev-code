import { InputError } from "../workflows/errors.ts";
import { MAX_TEST_RECORDS, type TestRecord } from "../workflows/evidence.ts";

/** Parse test records from JSON (`[{name,status,file?}]` or `{ tests: [...] }`) or JUnit XML. */
export function parseTestRecords(text: string): TestRecord[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new InputError("test results are not valid JSON");
    }
    const list = Array.isArray(value) ? value : (value as { tests?: unknown }).tests;
    if (!Array.isArray(list)) throw new InputError("test results JSON must be an array or { tests: [...] }");
    return list.slice(0, MAX_TEST_RECORDS).map((entry, index) => {
      const record = entry as Record<string, unknown>;
      const status = record.status;
      if (
        typeof record.name !== "string" ||
        (status !== "passed" && status !== "failed" && status !== "skipped")
      ) {
        throw new InputError(`test record ${index} needs a string name and status passed|failed|skipped`);
      }
      return {
        name: record.name.slice(0, 300),
        status,
        file: typeof record.file === "string" ? record.file : null,
      };
    });
  }
  if (trimmed.startsWith("<")) {
    const records: TestRecord[] = [];
    const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    for (const match of trimmed.matchAll(pattern)) {
      const attributes = match[1] ?? "";
      const body = match[2] ?? "";
      const attribute = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? null;
      const name = [attribute("classname"), attribute("name")].filter(Boolean).join(" ");
      if (!name) continue;
      const status = /<(?:failure|error)\b/.test(body)
        ? "failed"
        : /<skipped\b/.test(body)
          ? "skipped"
          : "passed";
      records.push({ name: name.slice(0, 300), status, file: attribute("file") });
      if (records.length >= MAX_TEST_RECORDS) break;
    }
    return records;
  }
  throw new InputError("test results must be JSON or JUnit XML");
}
