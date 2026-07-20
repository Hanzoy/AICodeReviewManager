import { createHmac } from "node:crypto";
import type { ReviewResult, ReviewTask } from "../../shared/contracts.js";

export interface FeishuTextMessage {
  timestamp?: string;
  sign?: string;
  msg_type: "text";
  content: {
    text: string;
  };
}

export function buildMergeRequestTriggeredText(groupName: string, task: ReviewTask) {
  return [
    "🔔 MR 已触发自动 Review",
    `项目组：${groupName}`,
    `项目：${task.projectName}`,
    `Merge Request：!${task.mergeRequestIid} ${task.mergeRequestTitle}`,
    `提交人：${task.authorName}`,
    `分支：${task.sourceBranch} → ${task.targetBranch}`,
    `Commit：${task.headSha.slice(0, 10)}`,
    "队列状态：已进入串行 Review 队列",
    ...(task.mergeRequestUrl ? [`查看 MR：${task.mergeRequestUrl}`] : [])
  ].join("\n");
}

const verdictLabels: Record<ReviewResult["verdict"], string> = {
  approve: "通过",
  comment: "有建议",
  request_changes: "需要修改"
};

const riskLabels: Record<ReviewResult["riskLevel"], string> = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低"
};

function truncate(value: string, maxLength: number) {
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function reviewLink(task: ReviewTask, preferredUrl?: string) {
  const url = preferredUrl || task.mergeRequestUrl;
  return url ? [`查看结果：${url}`] : [];
}

function reviewSubject(task: ReviewTask) {
  return task.triggerType === "manual"
    ? `手动 Review：${task.mergeRequestTitle}`
    : `Merge Request：!${task.mergeRequestIid} ${task.mergeRequestTitle}`;
}

export function buildReviewCompletedText(
  groupName: string,
  task: ReviewTask,
  result: ReviewResult,
  noteUrl?: string
) {
  const severityCounts = result.findings.reduce<Record<string, number>>((counts, finding) => {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
    return counts;
  }, {});
  const countSummary = [
    severityCounts.critical ? `严重 ${severityCounts.critical}` : "",
    severityCounts.high ? `高 ${severityCounts.high}` : "",
    severityCounts.medium ? `中 ${severityCounts.medium}` : "",
    severityCounts.low ? `低 ${severityCounts.low}` : ""
  ].filter(Boolean).join(" / ");
  return [
    "✅ 自动 Review 已完成",
    `项目组：${groupName}`,
    `项目：${task.projectName}`,
    reviewSubject(task),
    `Review 结论：${verdictLabels[result.verdict]}`,
    `风险等级：${riskLabels[result.riskLevel]}`,
    `发现问题：${result.findings.length}${countSummary ? `（${countSummary}）` : ""}`,
    `结果摘要：${truncate(result.summary, 1000)}`,
    ...reviewLink(task, noteUrl)
  ].join("\n");
}

export function buildManualReviewCompletedText(
  groupName: string,
  task: ReviewTask,
  result: ReviewResult
) {
  const selection = task.manualSelection;
  const range = selection?.mode === "branch"
    ? `${selection.branch} → ${selection.targetBranch}`
    : `${selection?.commitShas.length ?? 0} 个指定 Commit`;
  return [
    "🧑‍💻 手动 Code Review 已完成",
    `项目组：${groupName}`,
    `项目：${task.projectName}`,
    `发起人：${task.requestedBy ?? task.authorName}`,
    `审查范围：${range}`,
    ...(task.manualPreview ? [
      `变更规模：${task.manualPreview.commitCount} 个 Commit / ${task.manualPreview.fileCount} 个文件 / +${task.manualPreview.additions} -${task.manualPreview.deletions}`
    ] : []),
    `Review 结论：${verdictLabels[result.verdict]}`,
    `风险等级：${riskLabels[result.riskLevel]}`,
    `发现问题：${result.findings.length}`,
    `结果摘要：${truncate(result.summary, 1000)}`
  ].join("\n");
}

export function buildReviewFailedText(groupName: string, task: ReviewTask, error: string) {
  return [
    "❌ 自动 Review 执行失败",
    `项目组：${groupName}`,
    `项目：${task.projectName}`,
    reviewSubject(task),
    `提交人：${task.authorName}`,
    `分支：${task.sourceBranch} → ${task.targetBranch}`,
    `重试次数：${task.retryCount}`,
    `失败原因：${truncate(error, 1200)}`,
    "处理建议：请在项目组 Review 任务页面检查配置或重新入队。",
    ...reviewLink(task)
  ].join("\n");
}

export function buildCriticalFindingText(
  groupName: string,
  task: ReviewTask,
  result: ReviewResult,
  noteUrl?: string
) {
  const criticalFindings = result.findings.filter((finding) => finding.severity === "critical");
  const findingLines = criticalFindings.slice(0, 5).map((finding, index) =>
    `${index + 1}. ${finding.file}${finding.line ? `:${finding.line}` : ""} · ${truncate(finding.title, 180)}`
  );
  if (criticalFindings.length > findingLines.length) {
    findingLines.push(`其余 ${criticalFindings.length - findingLines.length} 个严重问题请在完整 Review 结果中查看。`);
  }
  return [
    "🚨 自动 Review 发现严重问题",
    `项目组：${groupName}`,
    `项目：${task.projectName}`,
    reviewSubject(task),
    `严重问题：${criticalFindings.length} 个`,
    ...findingLines,
    `结果摘要：${truncate(result.summary, 800)}`,
    "处理建议：建议阻止合并并优先处理以上问题。",
    ...reviewLink(task, noteUrl)
  ].join("\n");
}

export function buildFeishuTextMessage(text: string, signingSecret?: string): FeishuTextMessage {
  const message: FeishuTextMessage = {
    msg_type: "text",
    content: { text }
  };
  if (!signingSecret) return message;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = `${timestamp}\n${signingSecret}`;
  message.timestamp = timestamp;
  message.sign = createHmac("sha256", stringToSign).update("").digest("base64");
  return message;
}

async function sendFeishuTextNotification(input: {
  webhookUrl: string;
  signingSecret?: string;
  text: string;
}) {
  const message = buildFeishuTextMessage(input.text, input.signingSecret);
  const response = await fetch(input.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(10_000)
  });
  const responseText = await response.text();
  let result: { code?: number; msg?: string; StatusCode?: number; StatusMessage?: string } | undefined;
  try {
    result = responseText ? JSON.parse(responseText) as typeof result : undefined;
  } catch {
    result = undefined;
  }
  const businessCode = result?.code ?? result?.StatusCode;
  if (!response.ok || (typeof businessCode === "number" && businessCode !== 0)) {
    throw new Error(
      `飞书通知发送失败：${response.status} ${result?.msg ?? result?.StatusMessage ?? responseText}`.trim()
    );
  }
  return message;
}

export function sendMergeRequestTriggeredNotification(input: {
  webhookUrl: string;
  signingSecret?: string;
  groupName: string;
  task: ReviewTask;
}) {
  return sendFeishuTextNotification({
    webhookUrl: input.webhookUrl,
    signingSecret: input.signingSecret,
    text: buildMergeRequestTriggeredText(input.groupName, input.task)
  });
}

export function sendReviewCompletedNotification(input: {
  webhookUrl: string;
  signingSecret?: string;
  groupName: string;
  task: ReviewTask;
  result: ReviewResult;
  noteUrl?: string;
}) {
  return sendFeishuTextNotification({
    webhookUrl: input.webhookUrl,
    signingSecret: input.signingSecret,
    text: buildReviewCompletedText(input.groupName, input.task, input.result, input.noteUrl)
  });
}

export function sendReviewFailedNotification(input: {
  webhookUrl: string;
  signingSecret?: string;
  groupName: string;
  task: ReviewTask;
  error: string;
}) {
  return sendFeishuTextNotification({
    webhookUrl: input.webhookUrl,
    signingSecret: input.signingSecret,
    text: buildReviewFailedText(input.groupName, input.task, input.error)
  });
}

export function sendManualReviewCompletedNotification(input: {
  webhookUrl: string;
  signingSecret?: string;
  groupName: string;
  task: ReviewTask;
  result: ReviewResult;
}) {
  return sendFeishuTextNotification({
    webhookUrl: input.webhookUrl,
    signingSecret: input.signingSecret,
    text: buildManualReviewCompletedText(input.groupName, input.task, input.result)
  });
}

export function sendCriticalFindingNotification(input: {
  webhookUrl: string;
  signingSecret?: string;
  groupName: string;
  task: ReviewTask;
  result: ReviewResult;
  noteUrl?: string;
}) {
  return sendFeishuTextNotification({
    webhookUrl: input.webhookUrl,
    signingSecret: input.signingSecret,
    text: buildCriticalFindingText(input.groupName, input.task, input.result, input.noteUrl)
  });
}
