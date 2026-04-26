import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner';

/**
 * Базовая кнопка для всего webview'а.
 *
 * Варианты — семантические:
 *  - `primary` — основной CTA, vscode-button фоновые токены;
 *  - `secondary` — второстепенный, нейтральная подсветка;
 *  - `ghost` — без фона, hover-only (для toolbar'ов и icon-кнопок);
 *  - `danger` — деструктивные действия.
 *
 * Loading состояние подменяет содержимое на спиннер, но сохраняет ширину
 * (через invisible-clone) — чтобы layout не «прыгал» при переключении.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  children: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:enabled:bg-[var(--vscode-button-hoverBackground)] border border-transparent',
  secondary:
    'bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:enabled:bg-[var(--vscode-button-secondaryHoverBackground)] border border-border-subtle',
  ghost:
    'bg-transparent text-foreground hover:enabled:bg-[var(--vscode-list-hoverBackground)] border border-transparent',
  danger:
    'bg-[var(--vscode-errorForeground)] text-[var(--vscode-button-foreground)] hover:enabled:opacity-90 border border-transparent',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-6 px-2 text-[11px] gap-1',
  md: 'h-7 px-3 text-[12px] gap-1.5',
};

export function Button(props: ButtonProps) {
  const {
    variant = 'primary',
    size = 'md',
    loading = false,
    disabled,
    iconLeft,
    iconRight,
    children,
    className,
    type,
    ...rest
  } = props;
  const isDisabled = disabled || loading;
  return (
    <button
      // type="button" по умолчанию — иначе кнопка внутри <form> сабмитит
      // её, что почти всегда не то, что хочется в нашем UI.
      type={type ?? 'button'}
      disabled={isDisabled}
      className={clsx(
        'inline-flex items-center justify-center rounded-sm font-medium leading-none whitespace-nowrap transition-colors',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-1',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className
      )}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        // Сохраняем «слот» для контента, чтобы ширина не прыгала
        <span className="inline-flex items-center gap-[inherit]">
          <Spinner size={size === 'sm' ? 'xs' : 'sm'} />
          <span className="invisible inline-flex items-center gap-[inherit]">
            {iconLeft}
            {children}
            {iconRight}
          </span>
        </span>
      ) : (
        <>
          {iconLeft}
          {children}
          {iconRight}
        </>
      )}
    </button>
  );
}
