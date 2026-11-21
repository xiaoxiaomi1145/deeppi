import clsx from 'clsx';
import { memo, useRef } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { composerShortcut } from './client-logic';
import { IconButton } from './upstream/IconButton';
import { IconSendOutline16, IconSettingsOutline16, IconStopFill16 } from './upstream/icons';
import input from './upstream/ChatInput.module.css';
import styles from './Client.module.css';

const markdownPlugins = [remarkGfm];
const markdownComponents: Components = {
  p: ({ children }) => <p className="ds-markdown-paragraph">{children}</p>,
  table: ({ children }) => <div className={styles.tableScroll}><table>{children}</table></div>,
  a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  img: ({ alt, src }) => <img src={src} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />,
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="ds-markdown">
      <ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents} skipHtml>{text}</ReactMarkdown>
    </div>
  );
});

interface ComposerProps {
  text: string;
  onText: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  onSettings: () => void;
  allowSend: boolean;
  canStop: boolean;
  busy: boolean;
  stopping: boolean;
  empty: boolean;
}

export function Composer(props: ComposerProps) {
  const { text, onText, onSend, onStop, onSettings, allowSend, canStop, busy, stopping, empty } = props;
  const composing = useRef(false);
  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (allowSend && text.trim()) onSend();
  }
  function keys(event: KeyboardEvent<HTMLTextAreaElement>) {
    const intent = composerShortcut({
      key: event.key, shiftKey: event.shiftKey, keyCode: event.keyCode,
      isComposing: composing.current || event.nativeEvent.isComposing,
    });
    if (intent === 'cancel' && canStop) {
      event.preventDefault();
      onStop();
    } else if (intent === 'send' && !busy) {
      event.preventDefault();
      if (allowSend && text.trim()) onSend();
    }
  }

  return (
    <form className={clsx(input.wrapper, empty ? input.home : input.session, styles.composer)} onSubmit={send}>
      <div className={input.textareaWrapper}>
        <textarea
          className={input.textarea}
          aria-label="消息"
          aria-keyshortcuts="Enter Escape"
          placeholder="发消息给 Deeppi"
          value={text}
          onChange={(event) => onText(event.target.value)}
          onKeyDown={keys}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
        />
        <div className={input.mirror} aria-hidden="true">{text}{'\n'}</div>
      </div>
      <div className={input.functionRow}>
        <div className={clsx(input.toggles, styles.composerActions)}>
          <button type="button" onClick={onSettings} className={input.toggle}>
            <span className="icon" aria-hidden="true"><IconSettingsOutline16 /></span>设置
          </button>
        </div>
        <div className={input.right}>
          {busy ? (
            <IconButton label={stopping ? '正在停止' : '停止生成'} icon={<IconStopFill16 />} size="xl"
              className={clsx(input.sendButton, styles.sendButton)} disabled={!canStop} onClick={onStop} />
          ) : (
            <IconButton label="发送消息" icon={<IconSendOutline16 />} size="xl" type="submit"
              className={clsx(input.sendButton, styles.sendButton)} disabled={!allowSend || !text.trim()} />
          )}
        </div>
      </div>
    </form>
  );
}
