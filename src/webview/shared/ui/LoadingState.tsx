import clsx from 'clsx';
import { Spinner, type SpinnerProps } from './Spinner';

/**
 * Композиция Spinner + подпись. Для US-23 («Архитектор думает…»):
 * нужно показывать живой статус роли в шапках, кнопках, на канвасе —
 * и везде это одинаковая пара «крутилка + текст рядом».
 *
 * Live-region: `role="status"` + `aria-live="polite"` объявляет
 * скрин-ридерам появление новой подписи без прерывания текущего чтения.
 */
export interface LoadingStateProps {
  label: string;
  size?: SpinnerProps['size'];
  className?: string;
}

export function LoadingState(props: LoadingStateProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={clsx('inline-flex items-center gap-1.5 text-muted text-[11px]', props.className)}
    >
      <Spinner size={props.size ?? 'sm'} />
      {props.label}
    </span>
  );
}
