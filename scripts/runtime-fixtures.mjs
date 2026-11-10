import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PiRunner } from "../src/runner.ts";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function temporary(t) {
  const parent = path.resolve(tmpdir());
  const root = mkdtempSync(path.join(parent, "pa-runtime-selftest-"));
  const runners = [];
  t.after(async () => {
    for (const runner of runners) runner.abortAll();
    const deadline = Date.now() + 4000;
    while (runners.some((runner) => runner.busy) && Date.now() < deadline) await delay(10);
    assert(runners.every((runner) => !runner.busy), "own workers must exit before cleanup");
    assert.equal(path.dirname(root), parent);
    assert(path.basename(root).startsWith("pa-runtime-selftest-"));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, runners };
}

export function runnerFixture(t, options = {}) {
  const { root, runners } = temporary(t);
  const fake = path.join(root, "fake-pi.mjs");
  writeFileSync(fake, `
const mode = process.argv.at(-1);
const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const reply = (text) => ({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text}]}]});
const tools = (id, result = 'denied', isError = true) => {
  send({type:'tool_execution_start',toolCallId:String(id),toolName:'read',args:{path:'fixture'}});
  send({type:'tool_execution_end',toolCallId:String(id),toolName:'read',isError,result});
};
if (mode === 'unicode') {
  const raw = Buffer.from(JSON.stringify(reply('你好🔑')));
  const cut = raw.indexOf(Buffer.from('你'))+1;
  process.stdout.write(raw.subarray(0,cut));
  setTimeout(() => process.stdout.write(raw.subarray(cut)), 20);
} else if (mode === 'multi') {
  for (let i=1;i<=2;i++) send({type:'message_end',message:{id:String(i),role:'assistant',content:[{type:'text',text:String(i)}],usage:{totalTokens:i*100,cost:{total:i/10}}}});
  send(reply('done'));
} else if (mode === 'loop') {
  for (let i=0;i<8;i++) tools(i);
  setInterval(() => {},1000);
} else if (mode === 'progress') {
  for (let i=0;i<8;i++) tools(i,'result-'+i);
  send(reply('progress completed'));
} else if (mode === 'limit') {
  for (let i=0;i<8;i++) tools(i,'ok',false);
  setInterval(() => {},1000);
} else if (mode === 'oversize') {
  process.stdout.write('x'.repeat(2000001)); setInterval(() => {},1000);
} else if (mode === 'timeout' || mode === 'cancel') {
  send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'started'}});
  setInterval(() => {},1000);
} else if (mode === 'slow') setTimeout(() => send(reply('slow')),100);
else if (mode === 'failure') { console.error('fixture failure'); process.exitCode=2; }
else { process.stdout.write('not JSON\\nnull\\n'); send(reply('normal')); }
`);
  const runner = new PiRunner({ command: process.execPath, args: [fake], thinking: "", cwd: root, maxConcurrent: 1, timeoutMs: 4000, ...options });
  runners.push(runner);
  return runner;
}
