import { getConductorConfig, getProjectRawForMeta, getAdSet } from '../convexClient.js';

function ictDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

export async function evaluateAutoPostGate(projectId, adSetId) {
  const config = await getConductorConfig(projectId);
  if (!config || !config.auto_post_enabled) {
    return { allowed: false, reason: 'Auto-post is not enabled for this project' };
  }

  if (config.auto_post_paused_reason) {
    return { allowed: false, reason: `Auto-post paused: ${config.auto_post_paused_reason}` };
  }

  const project = await getProjectRawForMeta(projectId);
  if (!project) {
    return { allowed: false, reason: 'Project not found' };
  }
  if (!project.meta_access_token || !project.meta_account_id || !project.meta_page_id) {
    return { allowed: false, reason: 'Project missing Meta connection (token, account, or page)' };
  }

  const maxDaily = config.auto_post_max_daily_sets ?? 10;
  const today = ictDateString();
  const todayCount = (config.auto_post_today_date === today) ? (config.auto_post_today_count ?? 0) : 0;
  if (todayCount >= maxDaily) {
    return { allowed: false, reason: `Daily limit reached (${todayCount}/${maxDaily})` };
  }

  const errorThreshold = config.auto_post_error_threshold ?? 3;
  const consecutiveErrors = config.auto_post_consecutive_errors ?? 0;
  if ((config.auto_post_pause_on_error !== false) && consecutiveErrors >= errorThreshold) {
    return { allowed: false, reason: `Consecutive error threshold reached (${consecutiveErrors}/${errorThreshold})` };
  }

  const adSet = await getAdSet(adSetId);
  if (!adSet) {
    return { allowed: false, reason: 'Ad set not found' };
  }
  if (adSet.meta_adset_id) {
    return { allowed: false, reason: 'Ad set already posted to Meta' };
  }

  if (config.auto_post_require_min_score != null && config.auto_post_require_min_score > 0) {
    const score = adSet.avg_filter_score ?? adSet.filter_score ?? 0;
    if (score < config.auto_post_require_min_score) {
      return { allowed: false, reason: `Filter score ${score.toFixed(2)} below minimum ${config.auto_post_require_min_score}` };
    }
  }

  return { allowed: true };
}
