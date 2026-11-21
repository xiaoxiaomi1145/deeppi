import { thinkingFor, thinkingLabels } from './model';
import styles from './Pi.module.css';

export function ThinkingSlider({ levels, value, onChange, disabled = false }: {
  levels: readonly string[]; value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  const selected = thinkingFor(levels, value);
  const label = thinkingLabels[selected] ?? selected;
  const minimum = levels[0] ?? 'off';
  const maximum = levels.at(-1) ?? minimum;
  return <label className={styles.thinkingSlider}>
    <span className={styles.sliderHeading}><span>思考强度</span><strong>{label}</strong></span>
    {levels.length > 1 ? <>
      <input type="range" aria-label="思考强度" min={0} max={levels.length - 1} step={1} value={Math.max(0, levels.indexOf(selected))}
        aria-valuetext={label} disabled={disabled} onChange={(event) => onChange(levels[event.currentTarget.valueAsNumber] ?? selected)} />
      <span className={styles.sliderBounds} aria-hidden="true"><span>{thinkingLabels[minimum] ?? minimum}</span><span>{thinkingLabels[maximum] ?? maximum}</span></span>
    </> : <small className={styles.note}>这个模型没有其他可选思考档位。</small>}
  </label>;
}
