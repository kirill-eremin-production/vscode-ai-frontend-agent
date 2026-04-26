import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import clsx from 'clsx';
import { Avatar, type Role } from '@shared/ui';
import { formatRelativeTime } from '@shared/lib/time';
import type { ChatMessage as ChatMessageData } from '@shared/runs/types';
import { resolveRoleFrom } from '../lib/roles';

/**
 * Одно сообщение чата (#0020) — bubble с аватаром, именем автора,
 * относительным временем и markdown-телом.
 *
 * `from` приходит из storage в формате `user`, `agent:product`,
 * `agent:architect`, `agent:programmer`, `agent:system` (см. `from:`
 * в product-role/run.ts и пр.). Маппинг в роль/имя вынесен в
 * `../lib/roles.ts`, чтобы тот же справочник переиспользовался шапкой
 * чата (`ParticipantsHeader`) и системными строками
 * (`ParticipantJoinedRow`) — #0041.
 *
 * Markdown через `react-markdown` + `remark-gfm` без подсветки синтаксиса —
 * webview уже изолирован, дополнительная sanitize-обёртка не нужна.
 */
export interface ChatMessageProps {
  message: ChatMessageData;
}

/**
 * Цвет левой границы bubble'а по роли автора (#0041). Для `user` — keep
 * existing focusBorder (как и до #0041); для `system` — без отдельного
 * маркера (опасно перегружать; и так есть `opacity-80`). Для агентов —
 * берём `--color-role-*`, тот же набор, что и в аватарах: одна палитра
 * на всё UI.
 */
const ROLE_BUBBLE_BORDER: Record<Role, string> = {
  user: 'border-l-[var(--vscode-focusBorder)]',
  product: 'border-l-[var(--color-role-product)]',
  architect: 'border-l-[var(--color-role-architect)]',
  programmer: 'border-l-[var(--color-role-programmer)]',
  system: 'border-l-[var(--color-role-system)]',
};

export function ChatMessage(props: ChatMessageProps) {
  const { message } = props;
  const info = useMemo(() => resolveRoleFrom(message.from), [message.from]);
  const time = useMemo(() => formatRelativeTime(message.at), [message.at]);
  const isUser = info.role === 'user';
  const isSystem = info.role === 'system';

  return (
    <article
      className={clsx(
        'chat-message flex gap-2 px-3 py-2 rounded-sm border bg-surface-elevated border-l-2',
        ROLE_BUBBLE_BORDER[info.role],
        isUser ? 'border-border bg-[var(--vscode-list-hoverBackground)]' : 'border-border-subtle',
        isSystem && 'opacity-80'
      )}
      data-from={message.from}
      data-role={info.role}
    >
      <Avatar role={info.role} size="sm" title={info.name} />
      <div className="flex-1 min-w-0">
        <header className="flex items-baseline gap-2 mb-1">
          <span className="chat-message__name text-[12px] font-semibold leading-none">
            {info.name}
          </span>
          <time
            className="chat-message__time text-[11px] text-muted leading-none"
            dateTime={message.at}
            title={time.tooltip}
          >
            {time.label}
          </time>
        </header>
        <div className="chat-message__body text-[12px] leading-relaxed [overflow-wrap:anywhere]">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: (p) => <h1 className="text-[14px] font-semibold mt-2 mb-1" {...p} />,
              h2: (p) => <h2 className="text-[13px] font-semibold mt-2 mb-1" {...p} />,
              h3: (p) => <h3 className="text-[12px] font-semibold mt-2 mb-1" {...p} />,
              p: (p) => <p className="my-1" {...p} />,
              ul: (p) => <ul className="list-disc pl-5 my-1" {...p} />,
              ol: (p) => <ol className="list-decimal pl-5 my-1" {...p} />,
              li: (p) => <li className="my-0.5" {...p} />,
              a: (p) => (
                <a
                  className="text-[var(--vscode-textLink-foreground)] underline"
                  target="_blank"
                  rel="noreferrer"
                  {...p}
                />
              ),
              code: ({ className, children, ...rest }) => {
                const isBlock = /language-/.test(className ?? '');
                if (isBlock) {
                  return (
                    <code className={clsx('font-mono text-[11px]', className)} {...rest}>
                      {children}
                    </code>
                  );
                }
                return (
                  <code
                    className="font-mono text-[11px] px-1 rounded-sm bg-[var(--vscode-textBlockQuote-background)]"
                    {...rest}
                  >
                    {children}
                  </code>
                );
              },
              pre: (p) => (
                <pre
                  className="font-mono text-[11px] p-2 my-1 rounded-sm bg-[var(--vscode-textBlockQuote-background)] overflow-x-auto"
                  {...p}
                />
              ),
              blockquote: (p) => (
                <blockquote className="border-l-2 border-border pl-2 my-1 text-muted" {...p} />
              ),
            }}
          >
            {message.text}
          </ReactMarkdown>
        </div>
      </div>
    </article>
  );
}
