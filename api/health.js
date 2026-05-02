export default async (req, res) => {
  const checks = {};

  try {
    const {
      getSetting,
      getSystemCapabilities,
      getConvexHost,
    } = await import('../backend/convexClient.js');

    checks.convexHost = getConvexHost();

    try {
      await getSetting('session_secret');
      checks.convex = 'ok';
    } catch (err) {
      checks.convex = 'error';
      checks.convex_error = err?.message || 'Convex connectivity check failed';
    }

    try {
      const system = await getSystemCapabilities();
      checks.capabilities = system?.capabilities || {};
      checks.adSetAtomicCombine = checks.capabilities.adSetAtomicCombine === true ? 'ok' : 'missing';
    } catch (err) {
      checks.capabilities = {};
      checks.adSetAtomicCombine = 'error';
      checks.capability_error = err?.message || 'Capability check failed';
    }
  } catch (err) {
    checks.convex = 'error';
    checks.convexHost = 'unavailable';
    checks.capabilities = {};
    checks.adSetAtomicCombine = 'error';
    checks.health_error = err?.message || 'Health check failed';
  }

  const status = checks.convex === 'ok' && checks.adSetAtomicCombine === 'ok' ? 'ok' : 'degraded';
  res.status(200).json({
    ok: status === 'ok',
    status,
    service: 'creative-factory',
    timestamp: new Date().toISOString(),
    checks,
  });
};
