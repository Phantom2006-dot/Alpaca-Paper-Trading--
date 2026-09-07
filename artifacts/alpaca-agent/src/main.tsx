import { ClerkProvider, useAuth } from '@clerk/react';
import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';
import { setAuthTokenGetter, setBaseUrl } from '@workspace/api-client-react';

import './index.css';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const apiUrl = import.meta.env.VITE_API_URL as string | undefined;

if (!publishableKey) {
  console.warn('VITE_CLERK_PUBLISHABLE_KEY is not set — running without authentication');
}

function AuthenticatedApp() {
  const { getToken } = useAuth();

  useEffect(() => {
    setBaseUrl(apiUrl ?? null);
    setAuthTokenGetter(getToken);
    return () => setAuthTokenGetter(null);
  }, [getToken]);

  return <App />;
}

// Set base URL synchronously before any render so no query fires against the wrong origin.
setBaseUrl(apiUrl ?? null);

createRoot(document.getElementById('root')!, {
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    {publishableKey ? (
      <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
        <AuthenticatedApp />
      </ClerkProvider>
    ) : (
      <App />
    )}
  </ErrorBoundary>,
);
