import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner';

/**
 * Квадратная кнопка с иконкой. `aria-label` обязателен на типе —
 * иконка-only кнопка без accessible name это баг доступности, и здесь
 * мы ловим это компилятором, а не отдельным lint-rule (как было заявлено
 * в #0016 acceptance, но один TS-required prop делает то же самое
 * без custom-rule).
 */
export type IconButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type IconButtonSize = 'sm' | 'md';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label'
> {
  /** Обязательное a11y-имя кнопки. */
  'aria-label': string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  loading?: boolean;
  icon: ReactNode;
}

const VARIANT_CLASS: Record<IconButtonVariant, string> = {
  primary:
    'bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:enabled:bg-[var(--vscode-button-hoverBackground)]',
  secondary:
    'bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:enabled:bg-[var(--vscode-button-secondaryHoverBackground)]',
  ghost: 'bg-transparent text-foreground hover:enabled:bg-[var(--vscode-list-hoverBackground)]',
  danger:
    'bg-[var(--vscode-errorForeground)] text-[var(--vscode-button-foreground)] hover:enabled:opacity-90',
};

const SIZE_CLASS: Record<IconButtonSize, string> = {
  sm: 'h-6 w-6',
  md: 'h-7 w-7',
};

export function IconButton(props: IconButtonProps) {
  const {
    variant = 'ghost',
    size = 'md',
    loading = false,
    disabled,
    icon,
    className,
    type,
    ...rest
  } = props;
  const isDisabled = disabled || loading;
  return (
    <button
      type={type ?? 'button'}
      disabled={isDisabled}
      className={clsx(
        'inline-flex items-center justify-center rounded-sm transition-colors',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-1',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className
      )}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 'xs' : 'sm'} /> : icon}
    </button>
  );
}
