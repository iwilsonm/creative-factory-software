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

export async function moveDeploymentsToPlanner({
  deploymentIds,
  getDeploymentByExternalId,
  updateDeployment,
  logger = console,
}) {
  if (!Array.isArray(deploymentIds) || deploymentIds.length === 0) {
    return { success: false, status: 400, error: 'deploymentIds required' };
  }

  const normalized = normalizeDeploymentIds(deploymentIds);
  if (normalized.error) {
    return {
      success: false,
      status: 400,
      error: normalized.error.replaceAll('deployment_ids', 'deploymentIds'),
    };
  }

  const deployments = [];
  const missingIds = [];
  const deletedIds = [];

  for (const deploymentId of normalized.ids) {
    const deployment = await getDeploymentByExternalId(deploymentId);
    if (!deployment) {
      missingIds.push(deploymentId);
    } else if (deployment.deleted_at) {
      deletedIds.push(deploymentId);
    } else {
      deployments.push(deployment);
    }
  }

  if (missingIds.length || deletedIds.length) {
    return {
      success: false,
      status: 400,
      error: 'Some selected ads are no longer available.',
      missingIds,
      deletedIds,
    };
  }

  const projectIds = [...new Set(deployments.map((deployment) => deployment.project_id).filter(Boolean))];
  if (projectIds.length !== 1) {
    return {
      success: false,
      status: 400,
      error: 'All selected ads must belong to the same project.',
      projectIds,
    };
  }

  const plannerFields = { local_campaign_id: 'planned', local_adset_id: '', flex_ad_id: '' };
  const initialResults = await Promise.allSettled(normalized.ids.map((id) => updateDeployment(id, plannerFields)));
  const failedIndexes = initialResults
    .map((result, index) => result.status === 'rejected' ? index : -1)
    .filter((index) => index >= 0);

  const failedIds = [];
  for (const index of failedIndexes) {
    const id = normalized.ids[index];
    try {
      await updateDeployment(id, plannerFields);
    } catch (err) {
      logger.error?.(`Move to Planner retry failed for ${id}:`, err);
      failedIds.push(id);
    }
  }

  if (failedIds.length) {
    return {
      success: false,
      status: 500,
      error: 'Failed to move some ads to Planner.',
      failedIds,
      count: normalized.ids.length - failedIds.length,
    };
  }

  return {
    success: true,
    status: 200,
    count: normalized.ids.length,
    projectId: projectIds[0],
  };
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
