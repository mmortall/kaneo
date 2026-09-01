import type { TaskCategory } from "./task-category";
import type { TaskHorizon } from "./task-horizon";

export type TaskMetadataCandidate = {
  blockedReason?: string | null;
  status?: string | null;
  title: string;
};

export type ClassifiedTaskMetadata = {
  strategyHorizons: TaskHorizon[];
  taskCategory: TaskCategory;
};

const BLOCKER_TITLE =
  /^\s*(?:blocker|blocked|блокер|блокирует|нужен доступ|требуется доступ|open questions?)\b/iu;
const RESEARCH_TITLE =
  /^\s*(?:research|investigat(?:e|ion)|analy[sz]e|audit|validate|re-?test|backtest|исслед|анализ|аудит|проверь|проверить|разобрат|протест)|\b(?:research|investigation|audit|hypothesis|validation|cross-validation|experiment|forensic)\b|исследован|аудит|гипотез|валидац|эксперимент|диагност/iu;

const SHORT_HORIZON =
  /\b(?:m(?:1|5|15|30)|h1|1\s*(?:h|hr|hour)|hourly)\b|часов/iu;
const POSITION_HORIZON =
  /\b(?:h(?:2|4|8|12)|d1|(?:2|4|8|12)\s*(?:h|hr|hour)|intraday|position(?:al)?|swing)\b|внутриднев|позицион/iu;
const LONG_TERM_HORIZON = /\b(?:d1|w1|daily|weekly|day|week)\b|дневн|недел/iu;
const ULTRA_LONG_TERM_HORIZON =
  /\b(?:ultra[-\s]?long|multi[-\s]?year|annual|yearly|[1-9]\d*\s*(?:y|yr|year)s?)\b|многолет|годов/iu;

export function classifyTaskMetadata({
  blockedReason,
  status,
  title,
}: TaskMetadataCandidate): ClassifiedTaskMetadata {
  const taskCategory = inferTaskCategory({ blockedReason, status, title });
  const strategyHorizons = inferStrategyHorizons(title);

  return { taskCategory, strategyHorizons };
}

function inferTaskCategory({
  blockedReason,
  status,
  title,
}: TaskMetadataCandidate): TaskCategory {
  if (
    status === "blocked" ||
    blockedReason?.trim() ||
    BLOCKER_TITLE.test(title)
  ) {
    return "agent_blocker";
  }

  return RESEARCH_TITLE.test(title) ? "research" : "live_implementation";
}

function inferStrategyHorizons(title: string): TaskHorizon[] {
  const horizons: TaskHorizon[] = [];

  if (SHORT_HORIZON.test(title)) horizons.push("short");
  if (POSITION_HORIZON.test(title)) horizons.push("position");
  if (LONG_TERM_HORIZON.test(title)) horizons.push("long_term");
  if (ULTRA_LONG_TERM_HORIZON.test(title)) horizons.push("ultra_long_term");

  return horizons;
}
