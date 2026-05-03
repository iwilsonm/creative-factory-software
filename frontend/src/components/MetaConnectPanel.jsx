import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import InfoTooltip from './InfoTooltip';

// Phase 2A — Per-project Meta OAuth + ad-account picker + integration path toggle.
// Lives as the "Meta" sub-tab inside Project Settings. No data is shown until the
// user clicks "Connect Meta Account" and completes the OAuth dance in a popup.
//
// On the popup completing, it postMessages back here with { type: 'meta-oauth-result',
// payload: { ok, error? } }. We listen for that and refetch connection status.
export default function MetaConnectPanel({ projectId }) {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  // Phase 2B — Facebook Page picker
  const [pages, setPages] = useState([]);
  const [pagesLoading, setPagesLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.getMetaConnectionStatus(projectId);
      setStatus(s);
      if (s?.connected) {
        setAccountsLoading(true);
        try {
          const list = await api.getMetaAdAccounts(projectId);
          setAccounts(list);
        } catch (err) {
          if (/expired|reconnect/i.test(err?.message || '')) {
            // token died; status will reflect that on next loadStatus
            await loadStatus();
          } else {
            setError(err?.message || 'Could not load ad accounts');
          }
        } finally {
          setAccountsLoading(false);
        }
        // Phase 2B — load Pages too. Independent of accounts; Pages are
        // user-scoped (`/me/accounts`) not account-scoped.
        setPagesLoading(true);
        try {
          const list = await api.getMetaPages(projectId);
          setPages(list);
        } catch (err) {
          // Don't bail the whole panel; just log
          console.warn('Pages load failed:', err?.message);
          setPages([]);
        } finally {
          setPagesLoading(false);
        }
      } else {
        setAccounts([]);
        setPages([]);
      }
    } catch (err) {
      setError(err?.message || 'Failed to load connection status');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { setLoading(true); loadStatus(); }, [loadStatus]);

  // Listen for the OAuth popup posting back to us
  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'meta-oauth-result') return;
      const { ok, error: errMsg } = event.data.payload || {};
      if (ok) {
        toast.success('Meta account connected');
        loadStatus();
      } else {
        setError(errMsg || 'Meta OAuth failed');
        toast.error(errMsg || 'Meta OAuth failed');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadStatus, toast]);

  // Polling state for the OAuth-completion fallback (postMessage from the popup
  // can be blocked by Cross-Origin-Opener-Policy when the popup navigates to
  // facebook.com and back). We poll connection-status until the backend shows
  // a token, or until the popup is closed, or until a 5-minute timeout.
  const pollIntervalRef = useRef(null);
  const pollTimeoutRef = useRef(null);
  const popupRef = useRef(null);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; }
    if (pollTimeoutRef.current) { clearTimeout(pollTimeoutRef.current); pollTimeoutRef.current = null; }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleConnect = async () => {
    setBusy(true); setError('');
    try {
      const { authUrl } = await api.initMetaOAuth(projectId);
      const w = 600, h = 720;
      const left = window.screenX + (window.outerWidth - w) / 2;
      const top = window.screenY + (window.outerHeight - h) / 2;
      const popup = window.open(authUrl, 'meta-oauth', `width=${w},height=${h},left=${left},top=${top}`);
      popupRef.current = popup;

      // Capture a snapshot of "currently connected?" before the user authorizes
      // so we can detect the transition false → true. Otherwise on a re-connect
      // we'd see "still connected" and stop polling immediately.
      const beforeStatus = await api.getMetaConnectionStatus(projectId).catch(() => null);
      const wasConnectedBefore = !!beforeStatus?.connected;

      // Polling fallback: every 2s, check backend status. Stop on detect, on
      // popup close, or after 5 min.
      stopPolling();
      pollIntervalRef.current = setInterval(async () => {
        try {
          const s = await api.getMetaConnectionStatus(projectId);
          if (s?.connected && !wasConnectedBefore) {
            stopPolling();
            toast.success('Meta account connected');
            try { popupRef.current?.close(); } catch {}
            await loadStatus();
          } else if (popupRef.current && popupRef.current.closed) {
            // Popup closed without completing — stop polling silently
            stopPolling();
          }
        } catch { /* keep polling */ }
      }, 2000);
      pollTimeoutRef.current = setTimeout(() => {
        stopPolling();
      }, 5 * 60 * 1000);
    } catch (err) {
      setError(err?.message || 'Could not start Meta OAuth');
      toast.error(err?.message || 'Could not start Meta OAuth');
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect this project from Meta? Stored token will be cleared.')) return;
    setBusy(true);
    try {
      await api.disconnectMeta(projectId);
      toast.success('Disconnected from Meta');
      await loadStatus();
    } catch (err) {
      toast.error(err?.message || 'Disconnect failed');
    } finally {
      setBusy(false);
    }
  };

  const handleSelectAccount = async (acct) => {
    setBusy(true);
    try {
      await api.selectMetaAdAccount(projectId, {
        accountId: acct.id,
        accountName: acct.name,
        businessId: acct.business?.id,
      });
      toast.success(`Selected ${acct.name}`);
      await loadStatus();
    } catch (err) {
      toast.error(err?.message || 'Could not select account');
    } finally {
      setBusy(false);
    }
  };

  // Phase 2B — pick a Facebook Page for posting ads from
  const handleSelectPage = async (pg) => {
    setBusy(true);
    try {
      await api.selectMetaPage(projectId, {
        pageId: pg.id,
        pageName: pg.name,
      });
      toast.success(`Page set to ${pg.name}`);
      await loadStatus();
    } catch (err) {
      toast.error(err?.message || 'Could not select Page');
    } finally {
      setBusy(false);
    }
  };

  const handleTogglePath = async (path) => {
    setBusy(true);
    try {
      await api.setMetaIntegrationPath(projectId, path);
      await loadStatus();
    } catch (err) {
      toast.error(err?.message || 'Could not change integration path');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="ed-card p-6 text-sm text-ed-ink2">Loading Meta connection…</div>;
  }

  return (
    <div className="ed-card p-6 space-y-5">
      <div>
        <h2 className="text-[15px] font-serif font-[420] text-ed-ink tracking-tight flex items-center gap-1">
          Meta integration
          <InfoTooltip text="Connect the Meta ad account and Facebook Page this project should use for analytics, posting, and observation." position="right" />
        </h2>
        <p className="text-xs text-ed-ink2 mt-1">
          Connect this project to Meta so the app can read performance data, prepare posts, and track posted ad sets through Observation.
        </p>
      </div>

      {!status?.connected && (
        <div>
          <div className="rounded-xl border border-ed-line bg-ed-bg/60 p-4 mb-4">
            <h3 className="text-[13px] font-semibold text-ed-ink mb-2">Meta setup checklist</h3>
            <ol className="list-decimal pl-4 space-y-1.5 text-[12px] text-ed-ink2 leading-relaxed">
              <li>In global Settings, save the Meta App ID and App Secret from the Meta developer app.</li>
              <li>In Meta's OAuth settings, add this exact redirect URI: <code className="bg-cream px-1 rounded">https://creative-factory-software.vercel.app/api/meta/oauth/callback</code>.</li>
              <li>Make sure the Meta user connecting here has access to the ad account and at least one Facebook Page.</li>
              <li>Click Connect, approve the requested ads permissions, then select this project's ad account and Page.</li>
            </ol>
            <p className="text-[11px] text-ed-ink3 mt-3 leading-relaxed">
              Common setup errors usually mean the App ID/Secret are missing, the redirect URI does not match exactly, the Meta user cannot access an ad account/Page, or the token expired and needs reconnecting.
            </p>
          </div>
          <button
            type="button"
            onClick={handleConnect}
            disabled={busy}
            className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-[#fbfaf6] hover:bg-ed-accent/90 transition-colors disabled:opacity-50"
          >
            {busy ? 'Opening…' : 'Connect Meta Account'}
          </button>
          {error && <div className="mt-3 text-sm text-ed-rust">{error}</div>}
          <p className="mt-3 text-xs text-ed-ink3">
            Requires Meta App ID + Secret in global Settings. Create one Facebook App once at
            developers.facebook.com; Creative Factory reuses it for every project's OAuth.
          </p>
        </div>
      )}

      {status?.connected && (
        <>
          <div className="bg-ed-green/10 border border-ed-green/20 rounded-lg p-3 text-sm">
            <div className="font-semibold text-ed-green">✓ Connected</div>
            <div className="text-xs text-ed-ink2 mt-1">
              As <strong>{status.user_name}</strong> ({status.user_id})
              {status.token_expires_at && (
                <span> · token refreshes daily, currently valid until {new Date(status.token_expires_at).toLocaleDateString()}</span>
              )}
            </div>
          </div>

          {/* Ad account picker */}
          <div>
            <div className="text-xs font-semibold text-ed-ink2 mb-1">Ad account</div>
            {status.account_id ? (
              <div className="flex items-center justify-between gap-2 bg-cream rounded p-2 text-sm">
                <div>
                  <div className="font-semibold">{status.account_name || status.account_id}</div>
                  <div className="text-xs text-ed-ink3">{status.account_id}</div>
                </div>
                <button type="button" onClick={() => loadStatus()} className="ed-ghost text-xs">Re-pick</button>
              </div>
            ) : null}
            {(!status.account_id || accountsLoading || accounts.length > 0) && (
              <div className="mt-2">
                <div className="text-xs text-ed-ink2 mb-1">
                  {status.account_id ? 'Switch to a different account:' : 'Select the ad account this project should use:'}
                </div>
                {accountsLoading && <div className="text-xs text-ed-ink3">Loading accounts…</div>}
                {!accountsLoading && accounts.length === 0 && (
                  <div className="text-xs text-ed-ink3">No ad accounts available for this Meta user.</div>
                )}
                {!accountsLoading && accounts.length > 0 && (
                  <div className="space-y-1 max-h-60 overflow-y-auto">
                    {accounts.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => handleSelectAccount(a)}
                        disabled={busy || a.id === status.account_id}
                        className={`w-full text-left p-2 rounded text-sm transition ${a.id === status.account_id ? 'bg-ed-green/10 border border-ed-green/30' : 'hover:bg-ed-bg'} disabled:cursor-not-allowed`}
                      >
                        <div className="font-semibold">{a.name}</div>
                        <div className="text-xs text-ed-ink3">{a.id} · {a.business?.name || 'No business'}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Facebook Page picker */}
          <div>
            <div className="text-xs font-semibold text-ed-ink2 mb-1">Facebook Page</div>
            {!status.account_id ? (
              <div className="text-xs text-ed-ink3">Pick an ad account first.</div>
            ) : (
              <>
                {status.page_id && (
                  <div className="bg-cream rounded p-2 text-sm flex items-center justify-between">
                    <div>
                      <div className="font-semibold">{status.page_name || status.page_id}</div>
                      <div className="text-xs text-ed-ink3">{status.page_id}</div>
                    </div>
                    <span className="text-xs text-ed-green">✓ Page selected</span>
                  </div>
                )}
                {pagesLoading && <div className="text-xs text-ed-ink3">Loading Pages…</div>}
                {!pagesLoading && pages.length === 0 && (
                  <div className="text-xs text-ed-ink3 bg-cream rounded p-2">
                    No Pages available for this Meta user. Posting requires admin/editor access on at least one Facebook Page. Add yourself as an admin in Meta Business Manager and refresh.
                  </div>
                )}
                {!pagesLoading && pages.length > 0 && (
                  <div className="mt-2">
                    <div className="text-xs text-ed-ink2 mb-1">
                      {status.page_id ? 'Switch to a different Page:' : 'Select the Page to post ads from:'}
                    </div>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {pages.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => handleSelectPage(p)}
                          disabled={busy || p.id === status.page_id}
                          className={`w-full text-left p-2 rounded text-sm transition ${p.id === status.page_id ? 'bg-ed-green/10 border border-ed-green/30' : 'hover:bg-ed-bg'} disabled:cursor-not-allowed`}
                        >
                          <div className="font-semibold">{p.name}</div>
                          <div className="text-xs text-ed-ink3">{p.id} · {p.category || 'Page'}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Integration path toggle */}
          <div className="border-t border-cream pt-4">
            <div className="text-xs font-semibold text-ed-ink2 mb-1 flex items-center gap-1">
              Integration path
              <InfoTooltip text="Choose how this app talks to Meta when posting. The recommended connector path is slower but safer; Direct API is faster but can carry more account risk." position="right" />
            </div>
            <p className="text-[11px] text-ed-ink3 mb-2">
              Connector routes Meta operations through the safer posting path. Direct API uses Meta's Marketing API directly.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleTogglePath('mcp')}
                disabled={busy || status.integration_path === 'mcp'}
                className={`flex-1 text-sm px-3 py-2 rounded ${status.integration_path === 'mcp' ? 'bg-ed-accent text-[#fbfaf6]' : 'bg-cream text-ed-ink hover:bg-cream/70'} disabled:opacity-100 disabled:cursor-default`}
              >
                MCP — recommended
              </button>
              <button
                type="button"
                onClick={() => handleTogglePath('api')}
                disabled={busy || status.integration_path === 'api'}
                className={`flex-1 text-sm px-3 py-2 rounded ${status.integration_path === 'api' ? 'bg-ed-accent text-[#fbfaf6]' : 'bg-cream text-ed-ink hover:bg-cream/70'} disabled:opacity-100 disabled:cursor-default`}
              >
                Direct API
              </button>
            </div>
            {status.integration_path === 'api' && (
              <div className="mt-2 text-xs text-orange-700 bg-orange-50 border border-orange-200 p-2 rounded">
                <strong>Warning:</strong> Direct API posting can carry account risk. Use the connector path unless you intentionally want the faster direct route.
              </div>
            )}
          </div>

          {/* Disconnect */}
          <div className="border-t border-cream pt-4">
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={busy}
              className="ed-ghost text-xs"
            >
              Disconnect Meta
            </button>
          </div>

          {error && <div className="text-sm text-ed-rust">{error}</div>}
        </>
      )}
    </div>
  );
}
