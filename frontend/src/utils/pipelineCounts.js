const TERMINAL_PLANNER_STATUSES = new Set(['ready_to_post', 'posted']);
const PLANNER_AD_SET_LIFECYCLES = new Set(['draft']);
const READY_AD_SET_LIFECYCLES = new Set(['ready']);

function adSetId(adSet) {
  return adSet?.externalId || adSet?.id || adSet?.ad_set_id || '';
}

function childIdsForAdSet(adSet, deployments) {
  const id = adSetId(adSet);
  const fromLocalAdSet = (deployments || [])
    .filter(dep => dep.local_adset_id === id)
    .map(dep => dep.id || dep.externalId)
    .filter(Boolean);

  let fromStored = [];
  try {
    const parsed = JSON.parse(adSet?.child_deployment_ids || '[]');
    fromStored = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    fromStored = [];
  }

  return [...new Set([...fromLocalAdSet, ...fromStored])];
}

export function computePlannerCardCount(deployments = [], adSets = []) {
  const safeDeployments = Array.isArray(deployments) ? deployments : [];
  const safeAdSets = Array.isArray(adSets) ? adSets : [];
  const depById = new Map(safeDeployments.map(dep => [dep.id || dep.externalId, dep]));

  const visibleAdSets = safeAdSets.filter(adSet => {
    const lifecycle = adSet.lifecycle_status || '';
    if (lifecycle && !PLANNER_AD_SET_LIFECYCLES.has(lifecycle)) return false;
    const childIds = childIdsForAdSet(adSet, safeDeployments);
    if (childIds.length === 0) return lifecycle === 'draft';
    return childIds.some(id => {
      const dep = depById.get(id);
      return dep && !TERMINAL_PLANNER_STATUSES.has(dep.status);
    });
  });

  const groupedChildIds = new Set(
    visibleAdSets.flatMap(adSet => childIdsForAdSet(adSet, safeDeployments))
  );

  const standalonePlannerAds = safeDeployments.filter(dep =>
    dep.local_campaign_id !== 'unplanned' &&
    !TERMINAL_PLANNER_STATUSES.has(dep.status) &&
    !groupedChildIds.has(dep.id || dep.externalId)
  );

  return standalonePlannerAds.length + visibleAdSets.length;
}

export function computeReadyCardCount(deployments = [], adSets = []) {
  const safeDeployments = Array.isArray(deployments) ? deployments : [];
  const safeAdSets = Array.isArray(adSets) ? adSets : [];
  const readyDeployments = safeDeployments.filter(dep => dep.status === 'ready_to_post');
  const readyDepIds = new Set(readyDeployments.map(dep => dep.id || dep.externalId));

  const readyAdSets = safeAdSets.filter(adSet => {
    const lifecycle = adSet.lifecycle_status || '';
    if (lifecycle && !READY_AD_SET_LIFECYCLES.has(lifecycle)) return false;
    return childIdsForAdSet(adSet, safeDeployments).some(id => readyDepIds.has(id));
  });

  const groupedChildIds = new Set(
    readyAdSets.flatMap(adSet => childIdsForAdSet(adSet, safeDeployments))
  );
  const groupedAdSetIds = new Set(readyAdSets.map(adSetId));
  const legacyFlexIds = new Set();

  for (const dep of readyDeployments) {
    if (dep.flex_ad_id && !groupedAdSetIds.has(dep.flex_ad_id)) legacyFlexIds.add(dep.flex_ad_id);
  }

  const standaloneReadyAds = readyDeployments.filter(dep =>
    !groupedChildIds.has(dep.id || dep.externalId) &&
    !(dep.flex_ad_id && legacyFlexIds.has(dep.flex_ad_id))
  );

  return standaloneReadyAds.length + readyAdSets.length + legacyFlexIds.size;
}
