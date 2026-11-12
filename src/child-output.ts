import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface CapturedChildOutput {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: Error;
}

export interface CaptureChildOptions {
  /** stdout 超过该字符数时回调一次。调用方通常会杀掉子进程。 */
  maxStdout?: number;
  /** 只保留 stderr 末尾这么多个字符。未设置则全部保留。 */
  maxStderr?: number;
  onStdoutLimit?: () => void;
}

/**
 * 按流重组子进程 UTF-8。与执行器读 pi stdout 相同：StringDecoder 跨块拼接，
 * close（stdio 结束）之后才返回，并先把 decoder.end() 的尾字节收进来。
 * exit 可能早于最后一块数据，不能在那里收尾。
 */
export function captureChildOutput(child: ChildProcess, options: CaptureChildOptions = {}): Promise<CapturedChildOutput> {
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stdout = "";
  let stderr = "";
  let error: Error | undefined;
  let stdoutLimited = false;
  const noteLimit = (): void => {
    if (stdoutLimited || options.maxStdout === undefined || stdout.length <= options.maxStdout) return;
    stdoutLimited = true;
    options.onStdoutLimit?.();
  };
  const keepStderr = (): void => {
    if (options.maxStderr !== undefined && stderr.length > options.maxStderr) stderr = stderr.slice(-options.maxStderr);
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += stdoutDecoder.write(chunk);
    noteLimit();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += stderrDecoder.write(chunk);
    keepStderr();
  });
  child.on("error", (err: Error) => {
    error ??= err;
  });
  return new Promise((resolve) => {
    child.once("close", (code) => {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      keepStderr();
      noteLimit();
      resolve({ stdout, stderr, code, error });
    });
  });
}
