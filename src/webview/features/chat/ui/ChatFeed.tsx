import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Скролл-контейнер чат-ленты (#0020).
 *
 * Правила:
 *  - При появлении нового контента, если пользователь у дна (≤64px) —
 *    автоскроллим в самый низ. Иначе показываем закреплённую снизу
 *    пилюлю «↓ Новые сообщения», клик возвращает в самый низ.
 *  - При смене сессии (`resetKey`) скролл сбрасывается в самый низ
 *    без проверки порога — переключение читается как «новый контекст».
 *
 * `children` — это сама лента; ChatFeed остаётся чисто-визуальной
 * обёрткой, не диктует ни ChatMessage'у, ни tool-карточкам, как
 * рендериться. Это важно, потому что в этой же ленте живут tool-events
 * (см. RunDetails Timeline), которые до #0021 рендерятся прежним
 * способом.
 */
export interface ChatFeedProps {
  children: ReactNode;
  /** Любой стабильный идентификатор сессии/рана; смена → жёсткий скролл вниз. */
  resetKey: string;
  /** Подсказывает «контент изменился» (длина items, чтобы автоскроллить). */
  contentKey: string | number;
}

const STICK_THRESHOLD_PX = 64;

export function ChatFeed(props: ChatFeedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [hasNew, setHasNew] = useState(false);

  // Жёсткий скролл вниз при смене сессии — отдельным эффектом, чтобы
  // не зависеть от contentKey: первая отрисовка после смены может
  // ещё не содержать новых сообщений, но мы всё равно хотим оказаться
  // в самом низу. Сброс hasNew — синхронизация DOM-скролла с React,
  // лжеположительный сигнал «cascading renders» от линтера здесь
  // ожидаемый: альтернативой было бы отдельное событие скролла,
  // которое не успело бы выстрелить до следующего contentKey-update.
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasNew(false);
  }, [props.resetKey]);

  // Авто-скролл при росте контента, только если пользователь у дна.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (distanceFromBottom <= STICK_THRESHOLD_PX) {
      node.scrollTop = node.scrollHeight;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHasNew(false);
    } else {
      setHasNew(true);
    }
  }, [props.contentKey]);

  // Если пользователь сам докрутил вниз — гасим бейдж «новые».
  const onScroll = () => {
    const node = containerRef.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (distanceFromBottom <= STICK_THRESHOLD_PX && hasNew) setHasNew(false);
  };

  const scrollToBottom = () => {
    const node = containerRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    setHasNew(false);
  };

  return (
    <div className="chat-feed relative flex-1 min-h-0">
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="chat-feed__scroll h-full overflow-auto px-3 py-2 flex flex-col gap-2"
      >
        {props.children}
        <div ref={bottomRef} />
      </div>
      {hasNew && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="chat-feed__pill absolute left-1/2 bottom-2 -translate-x-1/2 inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] shadow"
          aria-label="Прокрутить к новым сообщениям"
        >
          <ChevronDown size={12} aria-hidden />
          Новые сообщения
        </button>
      )}
    </div>
  );
}
