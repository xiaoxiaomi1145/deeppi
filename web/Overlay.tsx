import clsx from 'clsx';
import { useLayoutEffect, useRef } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { IconButton } from './upstream/IconButton';
import { IconCloseOutline16 } from './upstream/icons';
import styles from './Client.module.css';

export function Overlay({ title, onClose, side, children }: {
  title: string;
  onClose: () => void;
  side?: 'left' | 'right';
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const trigger = document.activeElement;
    element.showModal();
    element.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => {
      if (element.open) element.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={title}
      className={clsx(styles.dialog, side === 'right' && styles.drawerRight, side === 'left' && styles.drawerLeft)}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className={styles.dialogInside}>{children}</div>
    </dialog>
  );
}

export function Panel({ title, onClose, children, footer, onSubmit }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const body = (
    <>
      <div className={styles.panelHeader}>
        <h2>{title}</h2>
        <IconButton icon={<IconCloseOutline16 />} label={`关闭${title}`} size="xl" onClick={onClose} />
      </div>
      <div className={styles.panelBody}>{children}</div>
      {footer && <div className={styles.panelFooter}>{footer}</div>}
    </>
  );
  return onSubmit ? <form className={styles.panel} onSubmit={onSubmit}>{body}</form> : <div className={styles.panel}>{body}</div>;
}
