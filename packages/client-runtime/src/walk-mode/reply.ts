import type { OrchestrationV2RunStatus, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

const CODE_BLOCK_SKIPPED = "Code block skipped.";

export type WalkModeQuestion = {
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string }>;
};

export type WalkModeTurnItem =
  | {
      readonly type: "assistant_message";
      readonly runId: string | null;
      readonly ordinal: number;
      readonly text: string;
    }
  | {
      readonly type: "user_input_request";
      readonly runId: string | null;
      readonly ordinal: number;
      readonly questions: ReadonlyArray<WalkModeQuestion>;
    };

export type WalkModeRun = {
  readonly id: string;
  readonly ordinal: number;
  readonly status: OrchestrationV2RunStatus;
};

/** What the session reads from a thread: its title, its runs, and the items a reply is made of. */
export type WalkModeTurns = {
  readonly title: string;
  readonly runs: ReadonlyArray<WalkModeRun>;
  readonly items: ReadonlyArray<WalkModeTurnItem>;
};

export type WalkModeReply = { readonly runId: string; readonly chunks: readonly string[] };

// rolled_back is terminal too, but its reply was taken back, so it is never read.
const READABLE_RUN_STATUSES = new Set<OrchestrationV2RunStatus>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

export function walkModeTurnsFromProjection(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "turnItems" | "messages">,
): WalkModeTurns {
  const items: WalkModeTurnItem[] = [];
  for (const item of projection.turnItems) {
    if (item.type === "assistant_message") {
      // Wire dedupe may move the body to the message record.
      const text =
        item.textOmitted === true
          ? (projection.messages.find((message) => message.id === item.messageId)?.text ?? "")
          : item.text;
      items.push({ type: item.type, runId: item.runId, ordinal: item.ordinal, text });
    } else if (item.type === "user_input_request") {
      items.push({
        type: item.type,
        runId: item.runId,
        ordinal: item.ordinal,
        questions: item.questions,
      });
    }
  }
  return { title: projection.thread.title, runs: projection.runs, items };
}

/** The question, then its options, as one plain sentence each. */
function flattenWalkModeQuestions(questions: ReadonlyArray<WalkModeQuestion>): string {
  return questions
    .map((question) => {
      const labels = question.options.map((option) => option.label.trim());
      if (labels.length === 0) return question.question;
      const list =
        labels.length === 1
          ? labels[0]
          : `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
      return `${question.question}\nOptions: ${list}.`;
    })
    .join("\n\n");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function replaceCodeBlocks(markdown: string): string {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const match = FENCE.exec(line);
    if (fence === null) {
      if (match) {
        fence = match[1]!;
        lines.push("", CODE_BLOCK_SKIPPED, "");
      } else {
        lines.push(line);
      }
    } else if (match && match[1]![0] === fence[0] && match[1]!.length >= fence.length) {
      fence = null;
    }
  }
  return lines.join("\n");
}

function stripInlineMarkdown(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/g, "$2")
    .trim();
}

/** Speech chunks: one per sentence, so a pause lands on a word inside a short utterance. */
function splitWalkModeReply(markdown: string): string[] {
  const chunks: string[] = [];
  for (const line of replaceCodeBlocks(markdown).split("\n")) {
    const text = stripInlineMarkdown(line);
    if (text.length === 0 || /^[-*_|:\s]+$/.test(text)) continue;
    for (const sentence of text.replace(/([.!?…]+["')\]]*)\s+/g, "$1\n").split("\n")) {
      const trimmed = sentence.trim();
      if (trimmed.length > 0) chunks.push(trimmed);
    }
  }
  return chunks;
}

/** The spoken reply of one run: its final assistant text, then any questions it asked. */
export function walkModeReplyForRun(turns: WalkModeTurns, runId: string): WalkModeReply | null {
  let finalText: { readonly ordinal: number; readonly text: string } | null = null;
  const questions: WalkModeQuestion[] = [];
  for (const item of turns.items) {
    if (item.runId !== runId) continue;
    if (item.type === "assistant_message") {
      if (item.text.trim().length > 0 && (finalText === null || item.ordinal > finalText.ordinal)) {
        finalText = item;
      }
    } else {
      questions.push(...item.questions);
    }
  }
  const parts = [finalText?.text ?? "", flattenWalkModeQuestions(questions)];
  const chunks = parts.flatMap(splitWalkModeReply);
  return chunks.length === 0 ? null : { runId, chunks };
}

/** Runs whose reply can be read, oldest first. */
export function readableWalkModeRuns(turns: WalkModeTurns): WalkModeRun[] {
  const runs = turns.runs.filter((run) => READABLE_RUN_STATUSES.has(run.status));
  return runs.sort((left, right) => left.ordinal - right.ordinal);
}
