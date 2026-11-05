import type { ProjectDelivery, DeliveryRecord, ReviewResult, ProjectIdentity } from "./project-delivery.ts";
import { deliveryExceptionNotice, renderFiveNotice, spoken } from "./user-notice.ts";

export interface DeliveryJob {
  id: string; cwd: string; task: string; status: string; deliveryManaged?: boolean; deliveryAttempt?: number;
  projectIdentity?: ProjectIdentity; finishedAt?: string; cleanupPending?: boolean; closedAt?: string;
}
export interface DeliveryOutcome { record?: DeliveryRecord; text: string; delivered: boolean; holdProject: boolean }
type Engine = Pick<ProjectDelivery, "get" | "capture" | "markReview" | "apply" | "rollback" | "cleanup">;

function deliveryReason(record: DeliveryRecord, fallback: string): string {
  const fromReview = spoken(record.targetReview?.summary) || spoken(record.executionReview?.summary);
  if (fromReview) return fromReview;
  const fromError = spoken(record.error);
  if (fromError && !/备份|回滚|工作树|隔离|目录|路径/.test(fromError)) return fromError;
  return fallback;
}

/** 聊天里的交付结论：五件事，不写路径、文件清单和命令。明细在交付记录里。 */
export function deliveryText(record: DeliveryRecord): string {
  const delivered = ["verified", "cleaned"].includes(record.state) && record.targetReview?.verdict === "passed";
  const inPlace = record.mode === "in-place";
  const failed = record.executionReview?.verdict === "failed" || record.targetReview?.verdict === "failed";
  if (delivered) {
    return renderFiveNotice({
      before: inPlace ? "原处还是旧样子" : "改动只在副本里",
      now: "原项目已经是改完的样子",
      did: record.alreadyPresent ? "发现原项目已经有同样结果，没有再盖一遍" : inPlace ? "直接在原处改完并核对通过" : "核对通过后放回原项目",
      outcome: "过",
      reason: deliveryReason(record, "复验通过"),
      action: "无需动手",
    });
  }
  if (record.state === "rolled_back") {
    return renderFiveNotice({
      before: "原项目是改之前的样子",
      now: "已经恢复成放回前的样子",
      did: "放回以后没通过，已经撤回",
      outcome: "挂",
      reason: deliveryReason(record, "复验没过"),
      action: "要修没通过的阻塞",
    });
  }
  if (record.state === "partial" || record.state === "applying") {
    return renderFiveNotice({
      before: "原项目是改之前的样子",
      now: "原项目里可能有一部分新改动",
      did: "往原项目放的时候没能安全收尾",
      outcome: "挂",
      reason: deliveryReason(record, "放回中断"),
      action: "要修放回中断的阻塞",
    });
  }
  if (record.state === "blocked") {
    return renderFiveNotice({
      before: inPlace ? "原处还是旧样子" : "原项目是改之前的样子",
      now: "不能确认现在是否已改好",
      did: inPlace ? "直接在原处改了一版但没通过" : "改完后没能安全放回原项目",
      outcome: failed ? "挂" : "未核实",
      reason: deliveryReason(record, failed ? "核对没过" : "还没核实完"),
      action: failed ? "要修没通过的阻塞" : "要确认预览",
    });
  }
  return renderFiveNotice({
    before: inPlace ? "原处还是旧样子" : "原项目还是改之前的样子",
    now: record.targetUpdated ? "原项目已放入新改动但还没确认通过" : "原项目还没更新",
    did: inPlace ? "直接在原处改了一版" : record.alreadyPresent ? "看到原项目里已有同样结果" : "先在副本里改好，还没放回原项目",
    outcome: failed ? "挂" : "未核实",
    reason: deliveryReason(record, failed ? "核对没过" : "还没核实完"),
    action: failed ? "要修没通过的阻塞" : "要确认预览",
  });
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
        text: deliveryExceptionNotice(error instanceof Error ? error.message : String(error)) };
    }
  }
}
