import type { JsonValue } from "./types.ts";

export type Entry = string | JsonValue[] | { [key: string]: JsonValue } | null;
export type ChoiceCriteria = Record<string, Entry>;
export type ScoreCriteria = readonly [Entry, Entry, ...Entry[]];

export interface NoulQuestion {
  type: "noul";
  instructions?: Entry;
  criteria?: { true?: Entry; false?: Entry } | null;
}

export interface ChoiceQuestion<T extends ChoiceCriteria = ChoiceCriteria> {
  type: "choice";
  instructions?: Entry;
  criteria: T;
}

export interface ScoreQuestion<T extends ScoreCriteria = ScoreCriteria> {
  type: "score";
  instructions?: Entry;
  criteria: T;
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export function noul(instructions?: Entry, criteria?: NoulQuestion["criteria"]): NoulQuestion {
  return {
    type: "noul",
    ...(instructions === undefined ? {} : { instructions }),
    ...(criteria === undefined ? {} : { criteria }),
  };
}

export function choice<T extends ChoiceCriteria>(instructions: Entry, criteria: T): ChoiceQuestion<T> {
  return { type: "choice", instructions, criteria };
}

export function score<T extends ScoreCriteria>(instructions: Entry, criteria: T): ScoreQuestion<T> {
  return { type: "score", instructions, criteria };
}
