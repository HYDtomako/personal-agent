/**
 * 定时任务触发器：每天 HH:MM（或一次性 at）触发一个 pi 提示词任务，输出发到指定目标。
 *
 * 优先级：定时任务以 priority:"scheduled" 进入执行队列——交互任务（用户消息）永远优先，
 * 只有没有交互任务排队时定时任务才会启动（见 runner 的双通道 pump）。
 * 错过正点 10 分钟内会补发（例如重启晚点），超过则跳过当日。
 *
 * 定时任务与交互消息使用同一套工具（本地读写/命令 + 联网、记忆等全部可用）。
 */
export interface ScheduledTask {
  name: string;
  /** 每日/每周触发时刻 HH:MM（与 at 二选一） */
  time?: string;
  /** 一次性触发时刻 "YYYY-MM-DD HH:MM"（触发后自动移除） */
  at?: string;
  days?: number[]; // 1-7（周一=1）；配合 time 使用，缺省=每天
  enabled?: boolean;
  prompt: string;
}

export interface TaskClient {
  runSchedule(prompt: string, task: ScheduledTask): Promise<{ ok: boolean; text: string }>;
  /** 结果的去向：本地 GUI 的对话记录 */
  sendTo(text: string): Promise<void>;
  /** 一次性任务触发后，从配置中移除（由主程序实现） */
  removeTask?(name: string): Promise<void> | void;
}

const FIRE_GRACE_MIN = 10; // 错过正点后的补发窗口
const TICK_MS = 20_000;

/** 解析 "YYYY-MM-DD HH:MM" 为本地时间戳；失败返回 NaN。 */
function parseAt(at: string): number {
  const m = at.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[\sT](\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0).getTime();
}

export class TaskScheduler {
  private readonly tasks: ScheduledTask[];
  private readonly client: TaskClient;
  private readonly log: (...a: unknown[]) => void;
  private lastFired = new Map<string, string>(); // task.name -> 已触发的日期
  private timer: NodeJS.Timeout | null = null;

  constructor(tasks: ScheduledTask[], client: TaskClient, log: (...a: unknown[]) => void) {
    this.tasks = tasks;
    this.client = client;
    this.log = log;
  }

  start(): void {
    const enabled = this.tasks.filter((t) => t.enabled !== false);
    if (this.timer) clearInterval(this.timer);
    if (enabled.length === 0) {
      this.log("[tasks] 无启用的定时任务");
      this.timer = null;
      return;
    }
    this.log("[tasks] 已注册定时任务:", enabled.map((t) => `${t.name}@${t.time ?? t.at}`).join(", "));
    this.timer = setInterval(() => this.tick().catch(() => {}), TICK_MS);
    this.timer.unref();
  }

  /** 热更新任务列表（task_manage 工具写入配置后由主程序调用），无需重启。 */
  setTasks(tasks: ScheduledTask[]): void {
    this.tasks = tasks;
    this.start();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const todayMon1 = ((now.getDay() - 1 + 7) % 7) + 1; // 周一=1
    const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const nowMs = now.getTime();

    for (const task of this.tasks) {
      if (task.enabled === false) continue;

      // ① 一次性任务：at 指定具体时刻，触发后自动移除
      if (task.at) {
        const atMs = parseAt(task.at);
        if (isNaN(atMs)) continue;
        const lateMin = (nowMs - atMs) / 60000;
        if (lateMin < 0 || lateMin >= FIRE_GRACE_MIN) continue;
        if (this.lastFired.get(task.name) === `at:${task.at}`) continue;
        this.lastFired.set(task.name, `at:${task.at}`);
        this.log(`[tasks] 触发一次性任务: ${task.name}（${task.at}）`);
        await this.fire(task);
        await this.client.removeTask?.(task.name);
        continue;
      }

      // ② 每日/每周任务：time + 可选 days
      if (!task.time) continue;
      if (this.lastFired.get(task.name) === ymd) continue;
      if (task.days && !task.days.includes(todayMon1)) continue;
      const [hh, mm] = task.time.split(":").map(Number);
      const taskMin = (hh || 0) * 60 + (mm || 0);
      const late = nowMin - taskMin;
      if (late < 0 || late >= FIRE_GRACE_MIN) continue;
      this.lastFired.set(task.name, ymd);
      this.log(`[tasks] 触发定时任务: ${task.name}`);
      await this.fire(task);
    }
  }

  /** 执行任务并把结果写进对话记录。 */
  private async fire(task: ScheduledTask): Promise<void> {
    try {
      const result = await this.client.runSchedule(task.prompt, task);
      if (result.ok) await this.client.sendTo(result.text);
      else await this.client.sendTo(`定时任务「${task.name}」执行失败：${result.text.slice(0, 200)}`);
    } catch (err) {
      this.log(`[tasks] ${task.name} 执行异常:`, err instanceof Error ? err.message : err);
    }
  }
}
