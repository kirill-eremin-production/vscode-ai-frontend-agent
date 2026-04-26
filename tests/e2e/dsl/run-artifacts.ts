import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Read-only акcессор к артефактам одного рана.
 *
 * Layout (после #0008 + #0011):
 *   .agents/runs/<runId>/
 *     meta.json              # RunMeta (activeSessionId, usage, sessions[], briefPath)
 *     sessions/<sessionId>/
 *       meta.json            # SessionMeta
 *       chat.jsonl
 *       tools.jsonl
 *       loop.json
 *
 * `chat`, `toolEvents` по умолчанию читают **активную** сессию из RunMeta.
 * Когда #0013 (компактификация) подключится, тесты, которым нужно сравнить
 * содержимое старых сессий, могут передать sessionId явно.
 *
 * Все методы синхронные и читают диск каждый раз — для тестов это дешевле
 * любой логики кеширования и гарантирует свежие данные после действия.
 */

/** Одна запись из `tools.jsonl`. */
export interface ToolEvent {
  kind: 'assistant' | 'tool_result' | 'system';
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  tool_name?: string;
  tool_call_id?: string;
  result?: unknown;
  error?: string;
  content?: string | null;
  message?: string;
  /**
   * Usage assistant-шага (#0008). Заполняется agent-loop'ом, если
   * OpenRouter вернул `usage`. Тесты на cost-tracking проверяют именно
   * это поле + агрегаты в meta.json.
   */
  usage?: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number | null;
  };
}

/** Одна запись из `chat.jsonl`. */
export interface ChatEntry {
  id: string;
  from: string;
  at: string;
  text: string;
}

/** Агрегат usage — зеркало `UsageAggregate` из extension/types.ts. */
export interface UsageAggregate {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  lastTotalTokens: number;
  lastModel: string | null;
}

/** Описание сессии для шапки RunMeta. */
export interface SessionSummary {
  id: string;
  kind: 'user-agent' | 'agent-agent';
  status: string;
  createdAt: string;
  updatedAt: string;
  parentSessionId?: string;
  usage: UsageAggregate;
}

/** Снимок RunMeta в той форме, что лежит на диске. */
export interface RunMetaSnapshot {
  id: string;
  title: string;
  prompt: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  activeSessionId: string;
  sessions: SessionSummary[];
  usage: UsageAggregate;
  /** Путь к brief.md в kb относительно workspace (после #0011). */
  briefPath?: string;
  /** Путь к plan.md в kb относительно workspace (после #0004). */
  planPath?: string;
  /** Путь к summary.md в kb относительно workspace (после #0027). */
  summaryPath?: string;
}

/** Снимок SessionMeta в той форме, что лежит на диске. */
export interface SessionMetaSnapshot {
  id: string;
  runId: string;
  kind: 'user-agent' | 'agent-agent';
  participants: Array<{ kind: 'user' } | { kind: 'agent'; role: string }>;
  parentSessionId?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  usage: UsageAggregate;
}

export class RunArtifacts {
  constructor(
    private readonly workspacePath: string,
    public readonly runId: string
  ) {}

  /** Корень папки рана: `<workspace>/.agents/runs/<runId>/`. */
  private get runDir(): string {
    return path.join(this.workspacePath, '.agents', 'runs', this.runId);
  }

  /** Папка конкретной сессии. */
  private sessionDir(sessionId: string): string {
    return path.join(this.runDir, 'sessions', sessionId);
  }

  /** Папка активной сессии (по `meta.activeSessionId`). undefined = меты нет. */
  private activeSessionDir(): string | undefined {
    const meta = this.meta;
    if (!meta) return undefined;
    return this.sessionDir(meta.activeSessionId);
  }

  /** Распарсенные события `tools.jsonl` активной сессии. */
  get toolEvents(): ToolEvent[] {
    return this.toolEventsForSession(this.meta?.activeSessionId);
  }

  /** Распарсенный `chat.jsonl` активной сессии. */
  get chat(): ChatEntry[] {
    return this.chatForSession(this.meta?.activeSessionId);
  }

  /** События конкретной сессии (для тестов на компактификацию #0013). */
  toolEventsForSession(sessionId: string | undefined): ToolEvent[] {
    if (!sessionId) return [];
    return readJsonl<ToolEvent>(path.join(this.sessionDir(sessionId), 'tools.jsonl'));
  }

  /** chat.jsonl конкретной сессии. */
  chatForSession(sessionId: string | undefined): ChatEntry[] {
    if (!sessionId) return [];
    return readJsonl<ChatEntry>(path.join(this.sessionDir(sessionId), 'chat.jsonl'));
  }

  /** SessionMeta активной сессии. undefined = меты нет. */
  get sessionMeta(): SessionMetaSnapshot | undefined {
    return this.sessionMetaForSession(this.meta?.activeSessionId);
  }

  /** SessionMeta конкретной сессии. */
  sessionMetaForSession(sessionId: string | undefined): SessionMetaSnapshot | undefined {
    if (!sessionId) return undefined;
    const filePath = path.join(this.sessionDir(sessionId), 'meta.json');
    if (!fs.existsSync(filePath)) return undefined;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SessionMetaSnapshot;
  }

  /**
   * `meta.json` рана. Содержит активную сессию, агрегат usage и список
   * сессий — тесты на cost-tracking (TC-25, TC-27) ходят сюда.
   */
  get meta(): RunMetaSnapshot | undefined {
    const filePath = path.join(this.runDir, 'meta.json');
    if (!fs.existsSync(filePath)) return undefined;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RunMetaSnapshot;
  }

  /**
   * Содержимое `brief.md` рана. Хранится в общей kb
   * (`.agents/knowledge/product/briefs/...` после #0011); путь лежит в
   * `meta.briefPath` (workspace-relative). Undefined — брифа ещё нет
   * (роль не финализировала ран) или мета отсутствует.
   */
  get brief(): string | undefined {
    const briefPath = this.meta?.briefPath;
    if (!briefPath) return undefined;
    const filePath = path.join(this.workspacePath, briefPath);
    if (!fs.existsSync(filePath)) return undefined;
    return fs.readFileSync(filePath, 'utf8');
  }

  /**
   * Содержимое `plan.md` рана. Хранится в общей kb
   * (`.agents/knowledge/architect/plans/...` после #0004); путь —
   * `meta.planPath` (workspace-relative). Undefined — плана ещё нет.
   */
  get plan(): string | undefined {
    const planPath = this.meta?.planPath;
    if (!planPath) return undefined;
    const filePath = path.join(this.workspacePath, planPath);
    if (!fs.existsSync(filePath)) return undefined;
    return fs.readFileSync(filePath, 'utf8');
  }

  /**
   * Содержимое `summary.md` рана. Хранится в kb
   * (`.agents/knowledge/programmer/summaries/...` после #0027); путь —
   * `meta.summaryPath` (workspace-relative). Undefined — программист
   * не дошёл до `writeSummary`.
   */
  get summary(): string | undefined {
    const summaryPath = this.meta?.summaryPath;
    if (!summaryPath) return undefined;
    const filePath = path.join(this.workspacePath, summaryPath);
    if (!fs.existsSync(filePath)) return undefined;
    return fs.readFileSync(filePath, 'utf8');
  }

  /** Существует ли в активной сессии папка с loop.json. Для durability-тестов. */
  hasActiveSession(): boolean {
    return this.activeSessionDir() !== undefined && fs.existsSync(this.activeSessionDir()!);
  }

  /** Достать содержимое файла из knowledge-песочницы. */
  knowledgeFile(relativePath: string): string {
    return fs.readFileSync(
      path.join(this.workspacePath, '.agents', 'knowledge', relativePath),
      'utf8'
    );
  }

  /** Существует ли файл в knowledge-песочнице. */
  hasKnowledgeFile(relativePath: string): boolean {
    return fs.existsSync(path.join(this.workspacePath, '.agents', 'knowledge', relativePath));
  }
}

export function listRuns(workspacePath: string): RunArtifacts[] {
  const runsDir = path.join(workspacePath, '.agents', 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir)
    .filter((entry) => fs.statSync(path.join(runsDir, entry)).isDirectory())
    .map((id) => new RunArtifacts(workspacePath, id));
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (raw.length === 0) return [];
  return raw.split('\n').map((line) => JSON.parse(line) as T);
}
