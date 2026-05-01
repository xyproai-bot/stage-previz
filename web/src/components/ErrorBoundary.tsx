import { Component, type ReactNode } from 'react';
import './ErrorBoundary.css';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** 顯示給用戶的標題（預設「畫面崩潰了」） */
  title?: string;
}

interface State {
  error: Error | null;
}

/**
 * 包住任何子樹避免整頁崩。預設 fallback 顯示錯誤訊息 + 「再試一次」按鈕。
 *
 * 用法：
 *   <ErrorBoundary><StageScene .../></ErrorBoundary>
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return (
        <div className="err-boundary">
          <div className="err-boundary__icon">⚠</div>
          <h2>{this.props.title || '畫面崩潰了'}</h2>
          <p className="err-boundary__msg">{this.state.error.message}</p>
          <details className="err-boundary__details">
            <summary>技術細節</summary>
            <pre>{this.state.error.stack}</pre>
          </details>
          <div className="err-boundary__actions">
            <button className="btn btn--primary" onClick={this.reset}>↻ 再試一次</button>
            <button className="btn btn--ghost" onClick={() => window.location.reload()}>重新整理頁面</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
