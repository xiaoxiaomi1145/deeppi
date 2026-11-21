import { useId, useRef } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { composerShortcut } from '../client-logic';
import { IconButton } from '../upstream/IconButton';
import { IconSendOutline16, IconStopFill16 } from '../upstream/icons';
import type { SessionStatus } from '../types';
import type { Delivery, PiSkill } from './model';
import styles from './Pi.module.css';

interface Props {
  text: string;
  setText: (text: string) => void;
  skill: string;
  setSkill: (skill: string) => void;
  skills: readonly PiSkill[];
  delivery: Delivery;
  setDelivery: (delivery: Delivery) => void;
  status: SessionStatus;
  canSend: boolean;
  canStop: boolean;
  onSend: () => void;
  onStop: () => void;
  pending: boolean;
  disabledReason?: string;
}

export function PiComposer({ text, setText, skill, setSkill, skills, delivery, setDelivery, status, canSend, canStop, onSend, onStop, pending, disabledReason }: Props) {
  const composing = useRef(false);
  const hintId = useId();
  const sendingLabel = status === 'running' ? delivery === 'steer' ? '发给当前轮' : '加入下一轮' : '发送消息';
  const selectedSkill = skills.find(({ name }) => name === skill);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSend && text.trim()) onSend();
  }
  function keys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const intent = composerShortcut({
      key: event.key, shiftKey: event.shiftKey, keyCode: event.keyCode,
      isComposing: composing.current || event.nativeEvent.isComposing,
    });
    if (intent === 'cancel' && canStop) {
      event.preventDefault();
      onStop();
    } else if (intent === 'send' && canSend && text.trim()) {
      event.preventDefault();
      onSend();
    }
  }
  return <form className={styles.composer} onSubmit={submit} aria-label="发送消息给 Pi">
    <div className={styles.editor}>
      <div className={styles.editorMirror} aria-hidden="true">{text}{'\n'}</div>
      <textarea className={styles.editorInput} rows={2} aria-label="消息" aria-describedby={hintId} aria-keyshortcuts="Enter Escape"
        placeholder="发消息给 Pi" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={keys}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
    </div>
    <div className={styles.composerBar}>
      <div className={styles.composerOptions}>
        {skills.length > 0 && <label className={styles.composerOption} title={selectedSkill?.description}>
          <span>技能</span><select aria-label="随消息使用的技能" value={selectedSkill?.name ?? ''} onChange={(event) => setSkill(event.target.value)}>
            <option value="">不使用</option>
            {skills.map(({ name }) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>}
        {status === 'running' && <label className={styles.composerOption}>
          <span>送达</span><select aria-label="生成中消息送达方式" value={delivery} onChange={(event) => setDelivery(event.target.value as Delivery)}>
            <option value="followUp">下一轮</option>
            <option value="steer">当前轮</option>
          </select>
        </label>}
      </div>
      <div className={styles.composerButtons}>
        {status !== 'idle' && <IconButton className={styles.stop} icon={<IconStopFill16 />} size="xl" label={status === 'stopping' ? '正在停止' : '停止当前操作'} disabled={!canStop} onClick={onStop} />}
        <IconButton className={styles.send} icon={<IconSendOutline16 />} size="xl" label={pending ? '正在发送' : sendingLabel} disabled={!canSend || !text.trim()} type="submit" />
      </div>
    </div>
    <p id={hintId} className={styles.composerHint}>
      {disabledReason || (status === 'running' ? delivery === 'steer' ? '发送到正在进行的这一轮' : '当前操作结束后，Pi 会处理下一轮' : 'Enter 发送 · Shift + Enter 换行')}
    </p>
  </form>;
}
