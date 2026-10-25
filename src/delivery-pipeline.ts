import type { ProjectDelivery, DeliveryRecord, ReviewResult, ProjectIdentity } from "./project-delivery.ts";

export interface DeliveryJob {
  id: string; cwd: string; task: string; status: string; deliveryManaged?: boolean; deliveryAttempt?: number;
  projectIdentity?: ProjectIdentity; finishedAt?: string; cleanupPending?: boolean; closedAt?: string;
}
export interface DeliveryOutcome { record?: DeliveryRecord; text: string; delivered: boolean; holdProject: boolean }
type Engine = Pick<ProjectDelivery, "get" | "capture" | "markReview" | "apply" | "rollback" | "cleanup">;

export function deliveryText(record: DeliveryRecord): string {
  const target = record.identity.targetCwd;
  const branch = record.identity.kind === "git" ? (record.identity.targetBranch?.replace(/^refs\/heads\//, "") ?? "detached HEAD") : "非 Git";
  const delivered = ["verified", "cleaned"].includes(record.state) && record.targetReview?.verdict === "passed";
  const lines = [`后台任务 ${record.id}：${delivered ? "本地代码交付完成" : "交付尚未完成，需要关注"}。`, `目标：${target}（${branch}）`];
  if (record.mode === "in-place") lines.push("非 Git 项目采用备份后原地修改，不是隔离工作树。");
  else if (record.state === "rolled_back") lines.push("目标复验未通过，本次回写已安全还原；隔离成果保留。");
  else if (record.state === "partial" || record.state === "applying") lines.push("目标可能有部分本次写入；为保护新改动，项目已暂停后续自动修改。");
  else if (record.targetUpdated) lines.push("本次增量已回写到原项目。");
  else if (record.alreadyPresent) lines.push("原项目已包含相同结果，没有重复覆盖。");
  else lines.push("尚未执行自动回写原项目。");
  lines.push(`本次变更文件：${record.changes.length} 个。`);
  if (record.executionReview) lines.push(`执行目录验收：${record.executionReview.verdict}。`);
  if (record.targetReview) lines.push(`原目标复验：${record.targetReview.verdict}。${record.targetReview.summary.slice(0, 1600)}`);
  if (record.worktreePath) lines.push(record.cleanupDone ? "任务临时工作树已清理，基线和增量证据仍保留。" : `隔离目录保留：${record.worktreePath}`);
  if (record.error) lines.push(`原因：${record.error}`);
  if (record.cleanupError) lines.push(`清理未完成：${record.cleanupError}`);
  lines.push("本任务没有提交、推送、部署或重启业务服务。");
  return lines.join("\n");
}

interface PipelineOptions {
  projects: Engine;
  review: (job: DeliveryJob, stage: "execution" | "target", record: DeliveryRecord) => Promise<ReviewResult>;
  onChange?: (record: DeliveryRecord) => void;
}
export class DeliveryPipeline {
  private active = new Map<string, { attempt: number; promise: Promise<DeliveryOutcome> }>();
  private readonly opts: PipelineOptions;
  constructor(opts: PipelineOptions) { this.opts = opts; }
  run(job: DeliveryJob): Promise<DeliveryOutcome> {
    const running = this.active.get(job.id); const attempt = job.deliveryAttempt ?? 0;
    if (running) {
      if (running.attempt !== attempt) return Promise.reject(new Error("上一轮交付仍在执行"));
      return running.promise;
    }
    const promise = this.execute(job);
    this.active.set(job.id, { attempt, promise });
    void promise.finally(() => { if (this.active.get(job.id)?.promise === promise) this.active.delete(job.id); }).catch(() => {});
    return promise;
  }
  private observe(record: DeliveryRecord): DeliveryRecord {
    try { this.opts.onChange?.(record); } catch { /* 状态推送不能打断文件事务。 */ }
    return record;
  }
  private outcome(record: DeliveryRecord): DeliveryOutcome {
    return { record, text: deliveryText(record), delivered: ["verified", "cleaned"].includes(record.state) && record.targetReview?.verdict === "passed", holdProject: ["partial", "applying"].includes(record.state) };
  }
  private async execute(job: DeliveryJob): Promise<DeliveryOutcome> {
    let record: DeliveryRecord | undefined;
    try {
      if (!job.deliveryManaged || job.status !== "completed" || (job.cleanupPending && !job.closedAt)) throw new Error("任务尚不满足文件交付前提");
      record = this.opts.projects.get(job.id);
      if (!record) throw new Error("缺少准备阶段记录，拒绝猜测基线或接管任意副本");
      if (job.projectIdentity && JSON.stringify(job.projectIdentity) !== JSON.stringify(record.identity)) throw new Error("交付记录与提交时目标身份不一致");
      if (record.state === "cleaned") return this.outcome(record);
      if (record.state === "verified") return this.outcome(this.observe(await this.opts.projects.cleanup(job.id)));
      if (!["applying", "partial", "applied"].includes(record.state)) {
        record = this.observe(await this.opts.projects.capture(job.id));
        if (record.state !== "changes_ready") return this.outcome(record);
        const review = await this.opts.review(job, "execution", record);
        record = this.observe(await this.opts.projects.markReview(job.id, "execution", review));
        if (review.verdict !== "passed") return this.outcome(record);
      }
      record = this.observe(await this.opts.projects.apply(job.id));
      if (record.state === "partial") return this.outcome(this.observe(await this.opts.projects.rollback(job.id)));
      if (record.state !== "applied") return this.outcome(record);
      const targetReview = record.mode === "in-place" ? record.executionReview! : await this.opts.review(job, "target", record);
      record = this.observe(await this.opts.projects.markReview(job.id, "target", targetReview));
      if (targetReview.verdict !== "passed") {
        if (record.mode === "git-worktree") record = this.observe(await this.opts.projects.rollback(job.id));
        else record = { ...record, state: "blocked", error: "原地验收未通过，备份保留；不盲目回滚可能混入的用户修改" };
        return this.outcome(record);
      }
      return this.outcome(this.observe(await this.opts.projects.cleanup(job.id)));
    } catch (error) {
      try { record = this.opts.projects.get(job.id); } catch { /* 损坏记录不能覆盖成新任务。 */ }
      return { record, delivered: false, holdProject: !record || ["applying", "partial", "applied"].includes(record.state),
        text: `后台任务 ${job.id} 的文件交付异常，未宣称完成：${error instanceof Error ? error.message : String(error)}。\n隔离目录与备份保留，不会自动提交、推送或重跑 CA。` };
    }
  }
}
