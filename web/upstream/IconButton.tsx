/*! Portions from DeepSeek chat-demo, Copyright (c) 2026 DeepSeek. MIT License; see LICENSE and THIRD_PARTY_NOTICES. */
import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './IconButton.module.css';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> & {
  icon: ReactNode;
  size?: 'xs' | 'm' | 'xl';
  tone?: 'tertiary' | 'primary';
  label: string;
};

export function IconButton({ icon, label, size = 'xs', tone = 'primary', className, ...props }: Props) {
  return (
    <button
      type="button"
      className={clsx(styles.button, styles[size], styles[tone], className)}
      aria-label={label}
      title={label}
      {...props}
    >
      <span className="icon" aria-hidden="true">{icon}</span>
    </button>
  );
}
