export function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function compactConvexWrite(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, fieldValue]) => fieldValue !== null && fieldValue !== undefined)
  );
}

export function normalizeDeploymentIds(deploymentIds) {
  if (!Array.isArray(deploymentIds) || deploymentIds.length === 0) {
    return { ids: [], error: 'deployment_ids must be a non-empty array' };
  }

  const ids = [];
  const seen = new Set();
  const duplicates = new Set();
  const invalidIndexes = [];

  deploymentIds.forEach((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      invalidIndexes.push(index);
      return;
    }
    const id = value.trim();
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
    ids.push(id);
  });

  if (invalidIndexes.length) {
    return { ids: [], error: `deployment_ids contains invalid values at index ${invalidIndexes.join(', ')}` };
  }
  if (duplicates.size) {
    return { ids: [], error: `deployment_ids contains duplicate ids: ${[...duplicates].join(', ')}` };
  }

  return { ids, error: null };
}

export function isMissingAtomicAdSetFunctionError(err) {
  const raw = typeof err === 'string' ? err : (err?.message || '');
  return /Could not find public function.*adSets:createFromDeployments|adSets:createFromDeployments.*Could not find public function|Did you forget to run `npx convex dev`/i.test(raw);
}

export function getManualCombineErrorResponse(err, { convexHost } = {}) {
  const raw = err?.message || 'Failed to create ad set';
  if (isMissingAtomicAdSetFunctionError(raw)) {
    const target = convexHost ? ` (${convexHost})` : '';
    return {
      status: 503,
      message: `Ad set creation is temporarily unavailable because the configured Convex deployment${target} is missing the atomic ad-set combine function. Please deploy Convex functions to the same deployment this site is using, then try again.`,
    };
  }

  const invalidMatch = raw.match(/INVALID_DEPLOYMENTS:\s*([\s\S]+)/);
  if (invalidMatch) {
    return { status: 400, message: `Invalid deployment_ids: ${invalidMatch[1].trim()}` };
  }

  if (/Campaign not found|does not belong to this project/i.test(raw)) {
    return { status: 400, message: raw };
  }

  return { status: 500, message: raw };
}

export function getDeploymentExternalId(deployment) {
  return deployment?.externalId || deployment?.id || null;
}

export function buildManualAdSetCreateInput({
  adSetId,
  projectId,
  campaignId,
  name,
  angleId,
  defaults = {},
}) {
  return compactConvexWrite({
    id: adSetId,
    project_id: projectId,
    campaign_id: campaignId,
    name,
    sort_order: 0,
    angle_id: normalizeOptionalString(angleId),
    lifecycle_status: 'draft',
    meta_targeting: defaults.meta_targeting,
    meta_budget_type: defaults.meta_budget_type,
    meta_budget_amount_cents: defaults.meta_budget_amount_cents,
    meta_schedule: defaults.meta_schedule,
    meta_optimization_goal: defaults.meta_optimization_goal,
    meta_billing_event: defaults.meta_billing_event,
  });
}

export function snapshotDeploymentAssignments(deploymentIds, projectDeployments) {
  const byId = new Map();
  for (const deployment of projectDeployments || []) {
    const id = getDeploymentExternalId(deployment);
    if (id) byId.set(id, deployment);
  }

  const missingIds = [];
  const snapshots = new Map();
  for (const id of deploymentIds) {
    const deployment = byId.get(id);
    if (!deployment) {
      missingIds.push(id);
      continue;
    }
    snapshots.set(id, {
      local_adset_id: deployment.local_adset_id || '',
      local_campaign_id: deployment.local_campaign_id || 'unplanned',
    });
  }

  return { missingIds, snapshots };
}

export async function rollbackManualAdSetCombine({
  adSetId,
  updatedDeploymentIds,
  snapshots,
  updateDeployment,
  deleteAdSet,
  logger = console,
}) {
  for (const depId of updatedDeploymentIds || []) {
    const snapshot = snapshots?.get(depId) || {};
    try {
      await updateDeployment(depId, {
        local_adset_id: snapshot.local_adset_id || '',
        local_campaign_id: snapshot.local_campaign_id || 'unplanned',
      });
    } catch (err) {
      logger.warn?.(`[AdSetPlanner] Failed to restore deployment ${depId}: ${err.message}`);
    }
  }

  if (adSetId) {
    try {
      await deleteAdSet(adSetId);
    } catch (err) {
      logger.warn?.(`[AdSetPlanner] Failed to delete rolled-back ad set ${adSetId}: ${err.message}`);
    }
  }
}
