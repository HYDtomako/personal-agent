import path from "node:path";
import { readRuntimeTraces, summarizeRuntimeTraces } from "../src/runtime-trace.ts";

const file = path.resolve(import.meta.dirname, "../data/runtime-traces.jsonl");
const rows = [...readRuntimeTraces(`${file}.1`), ...readRuntimeTraces(file)];
console.log(JSON.stringify(summarizeRuntimeTraces(rows), null, 2));
