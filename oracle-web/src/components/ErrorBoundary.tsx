import { Component, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-100">
          <div className="bg-white rounded-lg shadow p-8 max-w-lg text-center">
            <h2 className="text-xl font-bold text-red-700 mb-2">Something went wrong</h2>
            <p className="text-gray-600 mb-4">{this.state.error?.message ?? 'An unexpected error occurred.'}</p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="bg-gray-800 hover:bg-black text-white px-4 py-2 rounded text-sm"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
