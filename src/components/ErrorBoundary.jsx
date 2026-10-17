import { Component } from 'react';

// Without this, any render-time exception anywhere in the tree (e.g. a
// missing field on data returned by the API) unmounts the whole app and
// leaves the user staring at a blank page with no indication anything
// went wrong.
//
// It clears itself when `resetKey` changes (App passes the current route) or
// the URL hash changes, so navigating away from a broken screen recovers
// instead of showing "Something went wrong" on every page.
export class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Unhandled render error:', error, info);
  }

  componentDidMount() {
    this.handleHashChange = () => { if (this.state.error) this.setState({ error: null }); };
    window.addEventListener('hashchange', this.handleHashChange);
  }

  componentWillUnmount() {
    window.removeEventListener('hashchange', this.handleHashChange);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '32px 20px', textAlign: 'center', fontFamily: 'sans-serif' }}>
          <h2 style={{ marginBottom: '8px' }}>Something went wrong</h2>
          <p style={{ color: '#666', marginBottom: '20px' }}>
            {this.state.error.message || 'The page hit an unexpected error.'}
          </p>
          <button
            onClick={() => { this.setState({ error: null }); window.location.hash = '#home'; }}
            style={{ padding: '10px 20px', cursor: 'pointer' }}
          >
            Back to Home
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
