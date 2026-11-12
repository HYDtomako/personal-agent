import type { ProjectDelivery, DeliveryRecord, ReviewResult, ProjectIdentity } from "./project-delivery.ts";

export interface DeliveryJob {
  id: string; cwd: string; task: string; status: string; deliveryManaged?: boolean; deliveryAttempt?: number;
  projectIdentity?: ProjectIdentity; finishedAt?: string; cleanupPending?: boolean; closedAt?: string;
}
export interface DeliveryOutcome {
  record?: DeliveryRecord;
  text: string;
  delivered: boolean;
  holdProject: boolean;
  interrupted?: boolean;
  interruptError?: string;
}
type Engine = Pick<ProjectDelivery, "get" | "capture" | "markReview" | "apply" | "rollback" | "cleanup">;

/** 任务列表上的短状态。 */
export function deliveryText(record: DeliveryRecord): string {
  const failed = record.executionReview?.verdict === "failed" || record.targetReview?.verdict === "failed";
  if ((record.state === "verified" || record.state === "cleaned") && record.targetReview?.verdict === "passed") return "原项目已更新";
  if (record.state === "rolled_back") return "改动已撤回";
  if (failed) return "验收没通过";
  return "这块还没核过";
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
        interrupted: true, interruptError: error instanceof Error ? error.message : String(error), text: "" };
    }
  }
}
