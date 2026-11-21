import { useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { IconButton } from '../upstream/IconButton';
import { IconSendOutline16, IconStopFill16 } from '../upstream/icons';
import type { SessionStatus } from '../types';
import { composerControl, inputSuggestions, inputToken, insertInputToken, isSlashInput } from './input-model';
import type { InputSuggestion } from './input-model';
import type { Delivery, PiCommand, PiSkill } from './model';
import styles from './Pi.module.css';

interface Props {
  text: string;
  setText: (text: string) => void;
  skills: readonly PiSkill[];
  commands: readonly PiCommand[];
  status: SessionStatus;
  canSend: boolean;
  canStop: boolean;
  onSend: (delivery: Delivery) => void;
  onStop: () => void;
  pending: boolean;
  disabledReason?: string;
}

export function PiComposer({ text, setText, skills, commands, status, canSend, canStop, onSend, onStop, pending, disabledReason }: Props) {
  const editor = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const menuId = useId();
  const hintId = useId();
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [selection, setSelection] = useState(0);
  const token = inputToken(text, caret);
  const suggestions = focused && !dismissed ? inputSuggestions(token, skills, commands) : [];
  const active = Math.min(selection, suggestions.length - 1);
  const control = composerControl(status, !!text.trim(), isSlashInput(text));
  const optionId = (index: number) => `${menuId}-${index}`;

  function place(next: { text: string; caret: number }) {
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.setSelectionRange(next.caret, next.caret);
    });
  }
  function choose(option: InputSuggestion) {
    if (!token) return;
    place(insertInputToken(text, token, option.value));
    setDismissed(true);
  }
  function begin(kind: 'skill' | 'slash') {
    const position = editor.current?.selectionStart ?? text.length;
    if (kind === 'slash') {
      if (!text.trim()) place({ text: '/', caret: 1 });
      else {
        const current = text.trimStart();
        if (current.startsWith('/')) place({ text: current, caret: /^\/[^\s]*/u.exec(current)?.[0].length ?? 1 });
        else place({ text: `/ ${current}`, caret: 1 });
      }
    } else {
      const head = text.slice(0, position);
      const tail = text.slice(editor.current?.selectionEnd ?? position);
      const prefix = head + (head && !/\s$/u.test(head) ? ' ' : '') + '@skills:';
      place({ text: prefix + (tail && !/^\s/u.test(tail) ? ' ' : '') + tail, caret: prefix.length });
    }
    setSelection(0);
    setDismissed(false);
    setFocused(true);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSend && text.trim()) { setDismissed(true); onSend('followUp'); }
  }
  function keys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey) return;
    const accelerated = event.metaKey || event.ctrlKey;
    if (!accelerated && suggestions.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setSelection((active + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return; }
      if (!event.shiftKey && (event.key === 'Tab' || event.key === 'Enter')) {
        // Enter sends a fully typed, exact slash command; Tab still completes it.
        if (event.key === 'Tab' || token?.kind !== 'slash' || suggestions[active].value !== text.trim()) {
          event.preventDefault(); choose(suggestions[active]); return;
        }
      }
    }
    if (event.key === 'Escape' && !accelerated && canStop) { event.preventDefault(); onStop(); }
    else if (event.key === 'Enter' && !event.shiftKey && canSend && text.trim()) {
      event.preventDefault();
      setDismissed(true);
      onSend(accelerated && control.alternate ? 'steer' : 'followUp');
    }
  }
  return <form className={styles.composer} onSubmit={submit} aria-label="发送消息给 Pi">
    {suggestions.length > 0 && <ul id={menuId} className={styles.suggestions} role="listbox" aria-label={token?.kind === 'skill' ? '已安装技能' : 'Pi 指令'}>
      {suggestions.map((option, index) => <li id={optionId(index)} key={option.value} role="option" aria-selected={index === active}
        onPointerDown={event => { if (event.pointerType === 'mouse') event.preventDefault(); }}
        onClick={() => choose(option)}>
        <span><strong>{option.value}</strong>{option.hint && <small>{option.hint}</small>}{option.terminal && <small>仅终端</small>}</span>
        {option.description && <span>{option.description}</span>}
      </li>)}
    </ul>}
    <div className={styles.editor}>
      <div className={styles.editorMirror} aria-hidden="true">{text}{'\n'}</div>
      <textarea ref={editor} className={styles.editorInput} rows={2} aria-label="消息" aria-describedby={hintId}
        aria-autocomplete="list" aria-controls={suggestions.length ? menuId : undefined} aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        aria-keyshortcuts="Enter Control+Enter Meta+Enter Escape" placeholder="发消息给 Pi" value={text}
        onChange={event => { setText(event.target.value); setCaret(event.target.selectionStart); setDismissed(false); setSelection(0); }}
        onSelect={event => setCaret(event.currentTarget.selectionStart)} onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)} onKeyDown={keys}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
    </div>
    <div className={styles.composerBar}>
      <div className={styles.composerOptions}>
        <button type="button" className={styles.composerChip} onClick={() => begin('skill')} disabled={!skills.length}>@skills</button>
        <button type="button" className={styles.composerChip} onClick={() => begin('slash')} disabled={!commands.length} aria-label="插入 Pi 指令">/ 指令</button>
        {control.alternate && <button type="button" className={styles.composerChip} disabled={!canSend} onClick={() => { setDismissed(true); onSend('steer'); }}>引导当前轮</button>}
      </div>
      <div className={styles.composerButtons}>
        {control.primary === 'send' && status === 'running' && <IconButton className={styles.stop} icon={<IconStopFill16 />} size="xl" label="停止当前操作" disabled={!canStop} onClick={onStop} />}
        {control.primary === 'stop' ? <IconButton className={styles.send} icon={<IconStopFill16 />} size="xl" label={control.label} disabled={!canStop} onClick={onStop} />
          : <IconButton className={styles.send} icon={<IconSendOutline16 />} size="xl" label={pending ? '正在发送' : control.label} disabled={!canSend || !text.trim()} type="submit" />}
      </div>
    </div>
    <p id={hintId} className={styles.composerHint}>{disabledReason || (control.alternate ? 'Enter 排队 · Ctrl / ⌘ + Enter 引导当前轮' : 'Enter 发送 · Shift + Enter 换行')}</p>
  </form>;
}
