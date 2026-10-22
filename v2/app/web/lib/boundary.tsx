// A screen that throws while it draws (docs/v2/ui-overhaul-plan.md, U10,
// lane 34): its place says which screen failed and offers to draw it again;
// the header and the other screens stay.
import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button.tsx';
import type { Translate } from './i18n.ts';

type Props = { readonly t: Translate; readonly screen: string; readonly children: ReactNode };

export class ScreenBoundary extends Component<Props, { readonly failed: boolean; readonly attempt: number }> {
  override state = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<{ failed: boolean }> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error(`cleared-v2: the ${this.props.screen} screen failed (${error instanceof Error ? error.name : typeof error})`);
  }

  override render(): ReactNode {
    const { t, screen, children } = this.props;
    if (!this.state.failed) return <ScreenAttempt key={this.state.attempt}>{children}</ScreenAttempt>;
    return (
      <div className="index" role="alert" data-failed={screen}>
        <p className="empty error">{t('boundary_failed', { screen: t(`title_${screen}`) })}</p>
        <Button variant="chip" className="chip-button" id="boundary-retry" onClick={() => this.setState((state) => ({ failed: false, attempt: state.attempt + 1 }))}>{t('boundary_retry')}</Button>
      </div>
    );
  }
}

function ScreenAttempt({ children }: { readonly children: ReactNode }) {
  return <>{children}</>;
}
