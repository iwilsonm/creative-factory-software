export function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
  return {
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
  };
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
