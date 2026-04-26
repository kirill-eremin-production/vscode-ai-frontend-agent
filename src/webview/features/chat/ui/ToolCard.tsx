import { createElement, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { AlertCircle, CheckCircle2, FileText } from 'lucide-react';
import { Badge, Collapsible, toolIconFor } from '@shared/ui';
import { openFile } from '@shared/runs/store';

/**
 * Структурированная карточка одного tool-вызова (#0021).
 *
 * В свёрнутом виде — однострочный summary: иконка тула, имя моноширью,
 * бейдж статуса, короткие аргументы, время и (если завершён) длительность.
 * В развёрнутом — input/output JSON блоками, для error — подсветка ошибки
 * сверху. Auto-expand для последней error-карточки решает RunDetails
 * (через `defaultOpen`), сама карточка про «последнюю» ничего не знает.
 *
 * Кликабельные пути: `path` в аргументах и в `result.path` (US-11) —
 * открываются через store.openFile, который шлёт IPC `workspace.openFile`.
 */
export type ToolCardStatus = 'running' | 'ok' | 'error';

export interface ToolCardProps {
  name: string;
  argumentsJson: string;
  startedAt: string;
  endedAt?: string;
  status: ToolCardStatus;
  result?: unknown;
  error?: string;
  defaultOpen?: boolean;
}

const PREVIEW_LIMIT = 4 * 1024;

export function ToolCard(props: ToolCardProps) {
  const parsedArgs = useMemo(() => safeParse(props.argumentsJson), [props.argumentsJson]);
  const argsSummary = useMemo(() => summarizeArgs(parsedArgs), [parsedArgs]);
  const argPath = useMemo(() => extractPath(parsedArgs), [parsedArgs]);
  const resultPath = useMemo(() => extractPath(props.result), [props.result]);
  const filePath = argPath ?? resultPath;
  // Иконка выбирается динамически по `name` (из данных). Используем
  // createElement, потому что JSX `<I />` с локально-объявленной
  // переменной триггерит линт-правило `react-hooks/static-components`.
  const iconNode = useMemo(
    () =>
      createElement(toolIconFor(props.name), {
        size: 12,
        'aria-hidden': true,
        className: props.status === 'error' ? 'text-[var(--vscode-errorForeground)]' : 'text-muted',
      }),
    [props.name, props.status]
  );

  return (
    <div
      className={clsx(
        'tool-card border rounded-sm bg-[var(--vscode-input-background)] text-[12px]',
        props.status === 'error'
          ? 'border-[var(--vscode-inputValidation-errorBorder)]'
          : 'border-border-subtle'
      )}
      data-tool={props.name}
      data-status={props.status}
    >
      <Collapsible
        defaultOpen={props.defaultOpen}
        trigger={
          <span className="flex items-center gap-2 min-w-0">
            {iconNode}
            <code className="font-mono text-[11px] shrink-0">{props.name}</code>
            <StatusBadge status={props.status} />
            {argsSummary && (
              <span className="text-[11px] text-muted truncate min-w-0" title={argsSummary}>
                {argsSummary}
              </span>
            )}
            <span className="ml-auto text-[11px] text-muted shrink-0">
              {formatTime(props.startedAt)}
              {props.endedAt && ` · ${formatDuration(props.startedAt, props.endedAt)}`}
              {!props.endedAt && props.status === 'running' && (
                <RunningDuration startedAt={props.startedAt} />
              )}
            </span>
          </span>
        }
      >
        <div className="flex flex-col gap-1.5 pt-1">
          {props.error !== undefined && (
            <div className="flex items-start gap-1 px-2 py-1 rounded-sm bg-[var(--vscode-inputValidation-errorBackground)] text-[var(--vscode-errorForeground)]">
              <AlertCircle size={12} aria-hidden className="mt-0.5 shrink-0" />
              <pre className="font-mono text-[11px] whitespace-pre-wrap m-0 [overflow-wrap:anywhere]">
                {props.error}
              </pre>
            </div>
          )}
          {filePath && (
            <button
              className="tool-card__file-link self-start inline-flex items-center gap-1 text-[11px] text-[var(--vscode-textLink-foreground)] underline"
              type="button"
              onClick={() => openFile(toWorkspacePath(filePath))}
              title="Открыть в редакторе"
            >
              <FileText size={12} aria-hidden />
              {filePath}
            </button>
          )}
          <JsonBlock label="Аргументы" json={props.argumentsJson} parsed={parsedArgs} />
          {props.error === undefined && props.result !== undefined && (
            <JsonBlock label="Результат" json={undefined} parsed={props.result} />
          )}
        </div>
      </Collapsible>
    </div>
  );
}

function StatusBadge({ status }: { status: ToolCardStatus }) {
  if (status === 'running') {
    return (
      <Badge variant="neutral" title="Выполняется">
        <span className="inline-flex items-center gap-1">
          <span className="tool-card__pulse h-1.5 w-1.5 rounded-full bg-[var(--vscode-progressBar-background)] animate-pulse" />
          running
        </span>
      </Badge>
    );
  }
  if (status === 'error') {
    return (
      <Badge variant="danger" title="Ошибка">
        error
      </Badge>
    );
  }
  return (
    <Badge variant="success" title="Успех">
      <span className="inline-flex items-center gap-1">
        <CheckCircle2 size={10} aria-hidden />
        ok
      </span>
    </Badge>
  );
}

function RunningDuration({ startedAt }: { startedAt: string }) {
  // Тикаем раз в секунду, пока тул бежит — иначе пользователь не понимает,
  // живой ли вызов. Останавливаемся автоматически: как только статус
  // сменится на ok/error, сам компонент-обёртка перестанет рендерить нас.
  const [, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <> · {formatDuration(startedAt, new Date().toISOString())}</>;
}

function JsonBlock(props: { label: string; json?: string; parsed: unknown }) {
  const text = useMemo(() => {
    if (props.parsed !== undefined && typeof props.parsed !== 'string') {
      try {
        return JSON.stringify(props.parsed, null, 2);
      } catch {
        // упадём ниже на raw json/строку
      }
    }
    if (typeof props.parsed === 'string') return props.parsed;
    return props.json ?? String(props.parsed);
  }, [props.parsed, props.json]);
  const truncated = text.length > PREVIEW_LIMIT;
  const preview = truncated ? `${text.slice(0, PREVIEW_LIMIT)}\n…` : text;
  return (
    <div>
      <div className="text-[11px] text-muted mb-0.5">{props.label}</div>
      <pre className="font-mono text-[11px] p-2 m-0 rounded-sm bg-[var(--vscode-textBlockQuote-background)] overflow-x-auto whitespace-pre [overflow-wrap:anywhere]">
        {preview}
      </pre>
      {truncated && (
        <div className="text-[11px] text-muted mt-0.5">
          показано первые {PREVIEW_LIMIT / 1024} KB из {Math.ceil(text.length / 1024)} KB
        </div>
      )}
    </div>
  );
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

function summarizeArgs(parsed: unknown): string {
  if (parsed === null || parsed === undefined) return '';
  if (typeof parsed !== 'object') return String(parsed);
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return '';
  const [key, value] = entries[0];
  let valueStr: string;
  if (typeof value === 'string') valueStr = `"${value}"`;
  else if (typeof value === 'object' && value !== null) valueStr = '{…}';
  else valueStr = String(value);
  if (valueStr.length > 60) valueStr = `${valueStr.slice(0, 60)}…`;
  const more = entries.length > 1 ? ` +${entries.length - 1}` : '';
  return `${key}: ${valueStr}${more}`;
}

function extractPath(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as { path?: unknown }).path;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function toWorkspacePath(relativeFromKb: string): string {
  return `.agents/knowledge/${relativeFromKb}`;
}

function formatTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms} мс`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} с`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}м ${seconds}с`;
}
