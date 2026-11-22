import { useEffect, useState, type ReactNode } from 'react';
import styles from './Pi.module.css';

export function useMobileViewport() {
  const mobileQuery = '(max-width: 767px)';
  const [mobile, setMobile] = useState(() => matchMedia(mobileQuery).matches);
  useEffect(() => {
    const query = matchMedia(mobileQuery);
    const viewport = window.visualViewport;
    const root = document.documentElement;
    function update() {
      setMobile(query.matches);
      if (query.matches && viewport?.scale === 1) {
        root.style.setProperty('--app-viewport-height', `${viewport.height}px`);
        root.style.setProperty('--app-viewport-top', `${viewport.offsetTop}px`);
      } else {
        root.style.removeProperty('--app-viewport-height');
        root.style.removeProperty('--app-viewport-top');
      }
    }
    query.addEventListener('change', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    update();
    return () => {
      query.removeEventListener('change', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      root.style.removeProperty('--app-viewport-height');
      root.style.removeProperty('--app-viewport-top');
    };
  }, []);
  return mobile;
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.empty}><span className={styles.emptyMark} aria-hidden="true">π</span><h2>{title}</h2>{children}</section>;
}
