import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Read-only акcессор к артефактам одного рана: `.agents/runs/<id>/...`
 * + `.agents/knowledge/...`.
 *
 * Все методы синхронные и читают диск каждый раз — для тестов это
 * дешевле логики кеширования и гарантирует свежие данные после
 * любого действия.
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
}

/** Одна запись из `chat.jsonl`. */
export interface ChatEntry {
  id: string;
  from: string;
  at: string;
  text: string;
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

  /** Распарсенные события `tools.jsonl`. */
  get toolEvents(): ToolEvent[] {
    return readJsonl<ToolEvent>(path.join(this.runDir, 'tools.jsonl'));
  }

  /** Распарсенный `chat.jsonl`. */
  get chat(): ChatEntry[] {
    return readJsonl<ChatEntry>(path.join(this.runDir, 'chat.jsonl'));
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

/**
 * Найти все раны в workspace и вернуть accessor'ы. Полезно, когда
 * тест ожидает ровно один ран и хочет до него добраться без guessing'а
 * id'а.
 */
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
