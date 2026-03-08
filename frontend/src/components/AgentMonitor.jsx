import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import LPAgentSettings from './LPAgentSettings';
import PipelineProgress from './PipelineProgress';
import { useToast } from './Toast';
import { ensureArray } from '../utils/collections';

const LEVEL_CONFIG = {
  OK:        { color: 'text-teal',       icon: '\u2713', bg: 'bg-teal/10' },
  INFO:      { color: 'text-textmid',    icon: '\u2022', bg: 'bg-black/5' },
  WARN:      { color: 'text-gold',       icon: '\u26A0', bg: 'bg-gold/10' },
  ERROR:     { color: 'text-red-400',    icon: '\u2717', bg: 'bg-red-50' },
  RESURRECT: { color: 'text-navy-light', icon: '\u21BB', bg: 'bg-navy/10' },
  SCORE:     { color: 'text-purple-500', icon: '\u2605', bg: 'bg-purple-50' },
};

const STATUS_CONFIG = {
  online:  { color: 'text-teal',      dot: 'bg-teal',      label: 'Online',  pulse: true },
  warning: { color: 'text-gold',      dot: 'bg-gold',      label: 'Delayed', pulse: true },
  offline: { color: 'text-red-400',   dot: 'bg-red-400',   label: 'Offline', pulse: false },
  paused:  { color: 'text-textlight', dot: 'bg-textlight', label: 'Paused',  pulse: false },
};

function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 0) return 'just now';
  if (diff < 60) return 'just now';
  if (diff < 3600) {
    const mins = Math.floor(diff / 60);
    return `${mins} min${mins !== 1 ? 's' : ''} ago`;
  }
  if (diff < 86400) {
    const hours = Math.floor(diff / 3600);
    return `${hours}h ago`;
  }
  return `${Math.floor(diff / 86400)}d ago`;
}

function timeUntil(dateStr) {
  if (!dateStr) return null;
  const diff = Math.floor((new Date(dateStr).getTime() - Date.now()) / 1000);
  if (diff <= 0) return 'any moment';
  if (diff < 60) return `~${diff}s`;
  const mins = Math.ceil(diff / 60);
  return `~${mins} min`;
}

function formatDateTime(value) {
  if (value === null || value === undefined || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(ms) {
  const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  if (!totalSeconds) return '0s';

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

function safeParseJSON(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getRunRounds(run) {
  if (!run) return [];
  if (Array.isArray(run.rounds)) {
    return ensureArray(run.rounds, 'AgentMonitor.run.rounds');
  }
  return ensureArray(safeParseJSON(run.rounds_json, []), 'AgentMonitor.run.rounds_json');
}

function getRunBatches(run) {
  if (!run) return [];
  if (Array.isArray(run.batches)) {
    return ensureArray(run.batches, 'AgentMonitor.run.batches');
  }
  return ensureArray(safeParseJSON(run.batches_created, []), 'AgentMonitor.run.batches_created');
}

function getRoundStatusClasses(round) {
  return round.status === 'threshold_reached' ? 'bg-teal/10 text-teal' : 'bg-gold/10 text-gold';
}

function getRunStatusLabel(run) {
  switch (run.terminal_status) {
    case 'deployed':
      return 'deployed';
    case 'cancelled':
      return 'cancelled';
    case 'waiting_on_gemini':
      return 'waiting on Gemini';
    case 'building_round':
      return 'building next round';
    case 'provider_failed':
      return 'provider failed';
    case 'failed_under_threshold_after_round_cap':
    case 'failed_under_threshold_after_54':
      return 'cap reached';
    case 'generation_failed':
      return 'generation failed';
    case 'grouping_failed':
      return 'grouping failed';
    case 'deploy_failed':
      return 'deploy failed';
    case 'batch_created':
      return 'batch created';
    default:
      return run.status || 'unknown';
  }
}

function getRunStatusClasses(run) {
  if (run.status === 'completed' && run.terminal_status === 'deployed') {
    return 'bg-teal/10 text-teal';
  }
  if (run.status === 'running') {
    return 'bg-gold/10 text-gold';
  }
  if (run.terminal_status === 'cancelled') {
    return 'bg-black/5 text-textmid';
  }
  if (run.status === 'failed') {
    return 'bg-red-50 text-red-500';
  }
  return 'bg-black/5 text-textmid';
}

function formatLaneLabel(lane) {
  if (!lane) return 'Unassigned';
  return lane
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatFailureLabel(key) {
  const labels = {
    spelling_grammar: 'Spelling / grammar',
    first_line_hook: 'First-line hook',
    cta_at_end: 'CTA at end',
    headline_alignment: 'Headline alignment',
    image_completeness: 'Image completeness',
  };
  return labels[key] || formatLaneLabel(key);
}

function formatBooleanStatus(value) {
  if (value === true) return 'Passed';
  if (value === false) return 'Failed';
  return '—';
}

function getLPStatusClasses(status) {
  switch (status) {
    case 'live':
    case 'published':
    case 'passed':
    case 'passed_dry_run':
      return 'bg-teal/10 text-teal';
    case 'generating':
    case 'scoring':
    case 'retrying':
      return 'bg-gold/10 text-gold';
    case 'failed':
    case 'error':
    case 'publish_failed':
    case 'smoke_failed':
      return 'bg-red-50 text-red-500';
    case 'skipped':
      return 'bg-black/5 text-textmid';
    default:
      return 'bg-black/5 text-textmid';
  }
}

function getRoundLaneEntries(round) {
  if (!round?.lane_distribution || typeof round.lane_distribution !== 'object') return [];
  return Object.entries(round.lane_distribution)
    .filter(([, count]) => Number(count) > 0)
    .sort((left, right) => {
      const countDiff = Number(right[1]) - Number(left[1]);
      return countDiff !== 0 ? countDiff : String(left[0]).localeCompare(String(right[0]));
    });
}

function hasHeadlineDiagnostics(round) {
  return (
    round &&
    (
      round.headline_candidates !== undefined ||
      round.duplicate_rejections !== undefined ||
      round.history_rejections !== undefined ||
      getRoundLaneEntries(round).length > 0
    )
  );
}

function RoundHeadlineDiagnostics({ round }) {
  if (!hasHeadlineDiagnostics(round)) return null;

  const laneEntries = getRoundLaneEntries(round);
  const headlineCandidates = Number(round.headline_candidates);
  const duplicateRejections = Number(round.duplicate_rejections);
  const historyRejections = Number(round.history_rejections);
  const headlineCount = Number(round.headline_count);
  const summaryBits = [];

  if (Number.isFinite(headlineCandidates)) summaryBits.push(`${headlineCandidates} candidates`);
  if (Number.isFinite(headlineCount)) summaryBits.push(`${headlineCount} selected`);
  if (Number.isFinite(duplicateRejections)) summaryBits.push(`${duplicateRejections} batch duplicates removed`);
  if (Number.isFinite(historyRejections)) summaryBits.push(`${historyRejections} history conflicts removed`);

  return (
    <div className="mt-2 rounded-lg bg-black/[0.02] border border-black/5 px-2.5 py-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[9px] uppercase tracking-wider text-textlight">Headline diversity</p>
        {laneEntries.length > 0 && (
          <span className="text-[9px] text-textmid">{laneEntries.length} lane{laneEntries.length !== 1 ? 's' : ''}</span>
        )}
      </div>
      {summaryBits.length > 0 && (
        <p className="text-[10px] text-textmid mt-1 leading-relaxed">{summaryBits.join(' · ')}</p>
      )}
      {laneEntries.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {laneEntries.map(([lane, count]) => (
            <span
              key={lane}
              className="inline-flex items-center gap-1 rounded-full bg-white/80 border border-black/5 px-2 py-1 text-[9px] text-textdark"
            >
              <span>{formatLaneLabel(lane)}</span>
              <span className="text-textmid">{count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function getRoundFailedAds(round) {
  return ensureArray(round?.failed_ads, 'AgentMonitor.run.round.failed_ads');
}

function formatFailureBucketLabel(bucket) {
  const labels = {
    image_only: 'Image only',
    copy_only: 'Copy only',
    mixed: 'Mixed',
    headline_alignment: 'Headline alignment',
  };
  return labels[bucket] || formatLaneLabel(bucket);
}

function RoundFailureSummary({ round }) {
  const summary = round?.failure_summary && typeof round.failure_summary === 'object'
    ? round.failure_summary
    : null;
  if (!summary) return null;

  const bucketEntries = Object.entries(summary.bucket_counts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]));
  const hardEntries = Object.entries(summary.hard_requirement_counts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, 4);
  const imageEntries = Object.entries(summary.image_theme_counts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, 4);

  if (bucketEntries.length === 0 && hardEntries.length === 0 && imageEntries.length === 0) return null;

  return (
    <div className="mt-2 rounded-lg bg-black/[0.02] border border-black/5 px-2.5 py-2">
      <p className="text-[9px] uppercase tracking-wider text-textlight">Failure summary</p>
      {bucketEntries.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {bucketEntries.map(([bucket, count]) => (
            <span key={bucket} className="inline-flex items-center gap-1 rounded-full bg-white/80 border border-black/5 px-2 py-1 text-[9px] text-textdark">
              <span>{formatFailureBucketLabel(bucket)}</span>
              <span className="text-textmid">{count}</span>
            </span>
          ))}
        </div>
      )}
      {hardEntries.length > 0 && (
        <p className="text-[10px] text-textmid mt-2 leading-relaxed">
          Hard fails: {hardEntries.map(([key, count]) => `${formatFailureLabel(key)} (${count})`).join(' · ')}
        </p>
      )}
      {imageEntries.length > 0 && (
        <p className="text-[10px] text-textmid mt-1 leading-relaxed">
          Image themes: {imageEntries.map(([key, count]) => `${formatLaneLabel(key)} (${count})`).join(' · ')}
        </p>
      )}
    </div>
  );
}

function RoundRepairSummary({ round }) {
  const summary = round?.repair_summary && typeof round.repair_summary === 'object'
    ? round.repair_summary
    : null;
  if (!summary || Number(summary.attempted) <= 0) return null;

  return (
    <div className="mt-2 rounded-lg bg-teal/5 border border-teal/15 px-2.5 py-2">
      <p className="text-[9px] uppercase tracking-wider text-textlight">Repair attempts</p>
      <p className="text-[10px] text-textmid mt-1 leading-relaxed">
        {summary.attempted} attempted · {summary.passed || 0} passed
        {summary.image_attempted ? ` · ${summary.image_attempted} image repairs` : ''}
        {summary.copy_attempted ? ` · ${summary.copy_attempted} copy repairs` : ''}
      </p>
    </div>
  );
}

function RoundFailedAds({ round }) {
  const failedAds = getRoundFailedAds(round);
  if (failedAds.length === 0) return null;

  return (
    <details className="mt-2 rounded-lg bg-red-50/70 border border-red-100">
      <summary className="cursor-pointer list-none px-3 py-2 flex items-center justify-between gap-3">
        <span className="text-[10px] font-medium text-red-600">Failed ads</span>
        <span className="text-[10px] text-red-500">{failedAds.length} to inspect</span>
      </summary>
      <div className="px-3 pb-3 pt-1 border-t border-red-100 space-y-2">
        {failedAds.map((failedAd, index) => {
          const hardFailures = ensureArray(failedAd.failed_hard_requirements, `AgentMonitor.run.round.failed_ads.${index}.hardFailures`);
          const complianceFlags = ensureArray(failedAd.compliance_flags, `AgentMonitor.run.round.failed_ads.${index}.complianceFlags`);
          const spellingErrors = ensureArray(failedAd.spelling_errors, `AgentMonitor.run.round.failed_ads.${index}.spellingErrors`);
          const weaknesses = ensureArray(failedAd.weaknesses, `AgentMonitor.run.round.failed_ads.${index}.weaknesses`);
          const strengths = ensureArray(failedAd.strengths, `AgentMonitor.run.round.failed_ads.${index}.strengths`);
          const imageIssues = ensureArray(failedAd.image_issues, `AgentMonitor.run.round.failed_ads.${index}.imageIssues`);
          const fellBelowThreshold = !failedAd.error && hardFailures.length === 0;

          return (
            <div key={failedAd.ad_id || `${round.batch_id || 'round'}-${index}`} className="rounded-lg bg-white/80 border border-red-100 px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-medium text-textdark">
                    Ad {index + 1}{failedAd.ad_id ? ` · ${failedAd.ad_id.slice(0, 8)}...` : ''}
                  </p>
                  {failedAd.headline && (
                    <p className="text-[11px] text-textdark mt-1 leading-relaxed">{failedAd.headline}</p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[9px] uppercase tracking-wider text-textlight">Score</p>
                  <p className="text-[12px] font-semibold text-red-500 mt-0.5">{failedAd.overall_score ?? 0}</p>
                </div>
              </div>

              {failedAd.body_copy_preview && (
                <p className="text-[10px] text-textmid mt-2 leading-relaxed whitespace-pre-line">{failedAd.body_copy_preview}</p>
              )}

              <div className="flex flex-wrap gap-1.5 mt-2">
                {failedAd.failure_bucket && (
                  <span className="inline-flex items-center rounded-full bg-black/5 text-textdark px-2 py-1 text-[9px] font-medium">
                    {formatFailureBucketLabel(failedAd.failure_bucket)}
                  </span>
                )}
                {failedAd.recommended_fix && (
                  <span className="inline-flex items-center rounded-full bg-gold/10 text-gold px-2 py-1 text-[9px] font-medium">
                    {formatLaneLabel(failedAd.recommended_fix)}
                  </span>
                )}
                {hardFailures.map((key) => (
                  <span key={key} className="inline-flex items-center rounded-full bg-red-100 text-red-600 px-2 py-1 text-[9px] font-medium">
                    Failed {formatFailureLabel(key)}
                  </span>
                ))}
                {fellBelowThreshold && (
                  <span className="inline-flex items-center rounded-full bg-gold/15 text-gold px-2 py-1 text-[9px] font-medium">
                    Below score threshold
                  </span>
                )}
                {failedAd.angle_category && (
                  <span className="inline-flex items-center rounded-full bg-black/5 text-textmid px-2 py-1 text-[9px]">
                    {failedAd.angle_category}
                  </span>
                )}
                {failedAd.error && (
                  <span className="inline-flex items-center rounded-full bg-red-100 text-red-600 px-2 py-1 text-[9px] font-medium">
                    {failedAd.error}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
                <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                  <p className="text-[9px] uppercase tracking-wider text-textlight">Copy</p>
                  <p className="text-[11px] font-medium text-textdark mt-0.5">{failedAd.copy_strength ?? '—'}</p>
                </div>
                <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                  <p className="text-[9px] uppercase tracking-wider text-textlight">Compliance</p>
                  <p className="text-[11px] font-medium text-textdark mt-0.5">{failedAd.compliance ?? '—'}</p>
                </div>
                <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                  <p className="text-[9px] uppercase tracking-wider text-textlight">Effectiveness</p>
                  <p className="text-[11px] font-medium text-textdark mt-0.5">{failedAd.effectiveness ?? '—'}</p>
                </div>
                <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                  <p className="text-[9px] uppercase tracking-wider text-textlight">Image</p>
                  <p className="text-[11px] font-medium text-textdark mt-0.5">{failedAd.image_quality ?? '—'}</p>
                </div>
              </div>

              {(weaknesses.length > 0 || complianceFlags.length > 0 || spellingErrors.length > 0 || imageIssues.length > 0 || strengths.length > 0) && (
                <div className="mt-2 space-y-2">
                  {weaknesses.length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-textlight">Weaknesses</p>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {weaknesses.map((item, itemIndex) => (
                          <span key={`${failedAd.ad_id || index}-weakness-${itemIndex}`} className="inline-flex items-center rounded-full bg-red-50 text-red-600 border border-red-100 px-2 py-1 text-[9px]">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {complianceFlags.length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-textlight">Compliance flags</p>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {complianceFlags.map((item, itemIndex) => (
                          <span key={`${failedAd.ad_id || index}-flag-${itemIndex}`} className="inline-flex items-center rounded-full bg-gold/10 text-gold border border-gold/20 px-2 py-1 text-[9px]">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {spellingErrors.length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-textlight">Spelling / grammar</p>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {spellingErrors.map((item, itemIndex) => (
                          <span key={`${failedAd.ad_id || index}-spelling-${itemIndex}`} className="inline-flex items-center rounded-full bg-red-50 text-red-600 border border-red-100 px-2 py-1 text-[9px]">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {imageIssues.length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-textlight">Image issues</p>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {imageIssues.map((item, itemIndex) => (
                          <span key={`${failedAd.ad_id || index}-image-${itemIndex}`} className="inline-flex items-center rounded-full bg-black/[0.02] text-textmid border border-black/5 px-2 py-1 text-[9px]">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {strengths.length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-textlight">Strengths</p>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {strengths.map((item, itemIndex) => (
                          <span key={`${failedAd.ad_id || index}-strength-${itemIndex}`} className="inline-flex items-center rounded-full bg-teal/10 text-teal border border-teal/20 px-2 py-1 text-[9px]">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function RoundLandingPageFunnel({ batchId, lpDetailState, loading }) {
  if (!batchId) return null;
  if (loading) {
    return (
      <div className="mt-2 rounded-lg bg-black/[0.02] border border-black/5 px-3 py-2">
        <p className="text-[10px] text-textmid">Loading landing page funnel details...</p>
      </div>
    );
  }

  if (lpDetailState?.error) {
    return (
      <div className="mt-2 rounded-lg bg-red-50/70 border border-red-100 px-3 py-2">
        <p className="text-[10px] text-red-500">{lpDetailState.error}</p>
      </div>
    );
  }

  const detail = lpDetailState?.data;
  if (!detail) return null;

  const batch = detail.batch || {};
  const summary = detail.summary || {};
  const landingPages = ensureArray(detail.landingPages, `AgentMonitor.run.lpDetails.${batchId}.landingPages`);
  const narrativeFrames = ensureArray(batch.lp_narrative_frames, `AgentMonitor.run.lpDetails.${batchId}.frames`);
  const publishedUrls = ensureArray(batch.gauntlet_lp_urls, `AgentMonitor.run.lpDetails.${batchId}.urls`);
  const hasLPActivity = landingPages.length > 0 || batch.lp_primary_status || batch.lp_secondary_status || publishedUrls.length > 0;

  if (!hasLPActivity) return null;

  return (
    <details className="mt-2 rounded-lg bg-black/[0.02] border border-black/5">
      <summary className="cursor-pointer list-none px-3 py-2 flex items-center justify-between gap-3">
        <span className="text-[10px] font-medium text-textdark">Landing page funnel</span>
        <span className="text-[10px] text-textmid">
          {landingPages.length > 0
            ? `${summary.published ?? 0}/${summary.total ?? landingPages.length} published`
            : `${batch.lp_primary_status || 'not started'}`}
        </span>
      </summary>
      <div className="px-3 pb-3 pt-1 border-t border-black/5 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="rounded-lg bg-white/70 border border-black/5 px-2 py-2">
            <p className="text-[9px] uppercase tracking-wider text-textlight">LPs</p>
            <p className="text-[12px] font-semibold text-textdark mt-0.5">{summary.total ?? landingPages.length ?? '—'}</p>
          </div>
          <div className="rounded-lg bg-white/70 border border-black/5 px-2 py-2">
            <p className="text-[9px] uppercase tracking-wider text-textlight">Published</p>
            <p className="text-[12px] font-semibold text-textdark mt-0.5">{summary.published ?? '—'}</p>
          </div>
          <div className="rounded-lg bg-white/70 border border-black/5 px-2 py-2">
            <p className="text-[9px] uppercase tracking-wider text-textlight">Headline Passed</p>
            <p className="text-[12px] font-semibold text-textdark mt-0.5">{summary.headlinePassed ?? '—'}</p>
          </div>
          <div className="rounded-lg bg-white/70 border border-black/5 px-2 py-2">
            <p className="text-[9px] uppercase tracking-wider text-textlight">Avg Score</p>
            <p className="text-[12px] font-semibold text-textdark mt-0.5">{summary.avgScore ?? '—'}</p>
          </div>
          <div className="rounded-lg bg-white/70 border border-black/5 px-2 py-2">
            <p className="text-[9px] uppercase tracking-wider text-textlight">Duration</p>
            <p className="text-[12px] font-semibold text-textdark mt-0.5">
              {summary.totalGenerationDurationMs ? formatDuration(summary.totalGenerationDurationMs) : '—'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="rounded-lg bg-white/70 border border-black/5 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-medium text-textdark">Primary LP</p>
              <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${getLPStatusClasses(batch.lp_primary_status)}`}>
                {batch.lp_primary_status || 'not started'}
              </span>
            </div>
            {batch.lp_primary_url && (
              <a href={batch.lp_primary_url} target="_blank" rel="noreferrer" className="text-[10px] text-gold hover:text-gold-light mt-1 inline-block break-all">
                {batch.lp_primary_url}
              </a>
            )}
            {batch.lp_primary_error && (
              <p className="text-[10px] text-red-500 mt-1 leading-relaxed">{batch.lp_primary_error}</p>
            )}
            {batch.lp_primary_retry_count ? (
              <p className="text-[9px] text-textlight mt-1">Retries: {batch.lp_primary_retry_count}</p>
            ) : null}
          </div>
          <div className="rounded-lg bg-white/70 border border-black/5 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-medium text-textdark">Secondary LP</p>
              <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${getLPStatusClasses(batch.lp_secondary_status)}`}>
                {batch.lp_secondary_status || 'not started'}
              </span>
            </div>
            {batch.lp_secondary_url && (
              <a href={batch.lp_secondary_url} target="_blank" rel="noreferrer" className="text-[10px] text-gold hover:text-gold-light mt-1 inline-block break-all">
                {batch.lp_secondary_url}
              </a>
            )}
            {batch.lp_secondary_error && (
              <p className="text-[10px] text-red-500 mt-1 leading-relaxed">{batch.lp_secondary_error}</p>
            )}
            {batch.lp_secondary_retry_count ? (
              <p className="text-[9px] text-textlight mt-1">Retries: {batch.lp_secondary_retry_count}</p>
            ) : null}
          </div>
        </div>

        {narrativeFrames.length > 0 && (
          <div>
            <p className="text-[9px] uppercase tracking-wider text-textlight">Narrative frames</p>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {narrativeFrames.map((frame) => (
                <span key={frame} className="inline-flex items-center rounded-full bg-white/80 border border-black/5 px-2 py-1 text-[9px] text-textdark">
                  {formatLaneLabel(frame)}
                </span>
              ))}
            </div>
          </div>
        )}

        {publishedUrls.length > 0 && (
          <div>
            <p className="text-[9px] uppercase tracking-wider text-textlight">Published URLs</p>
            <div className="space-y-1 mt-1">
              {publishedUrls.map((entry, index) => (
                <div key={`${entry.url || entry.frame || index}`} className="rounded-lg bg-white/70 border border-black/5 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] text-textdark">{formatLaneLabel(entry.frameName || entry.frame || `LP ${index + 1}`)}</span>
                    <span className="text-[9px] text-textmid">{entry.score ?? '—'}/11</span>
                  </div>
                  {entry.url && (
                    <a href={entry.url} target="_blank" rel="noreferrer" className="text-[10px] text-gold hover:text-gold-light mt-1 inline-block break-all">
                      {entry.url}
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {landingPages.length > 0 && (
          <div className="space-y-2">
            {landingPages.map((page) => (
              <details key={page.id} className="rounded-lg bg-white/70 border border-black/5">
                <summary className="cursor-pointer list-none px-3 py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-medium text-textdark">
                      {formatLaneLabel(page.narrative_frame || page.gauntlet_frame || page.name || 'Landing page')}
                    </p>
                    <p className="text-[9px] text-textlight mt-0.5">
                      {page.id ? `${page.id.slice(0, 8)}...` : '—'} · attempt {page.gauntlet_attempt ?? page.generation_attempts ?? 1}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {page.gauntlet_score != null && (
                      <span className="text-[10px] font-medium text-textdark">{page.gauntlet_score}/11</span>
                    )}
                    <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${getLPStatusClasses(page.status || page.gauntlet_status)}`}>
                      {page.status || page.gauntlet_status || 'unknown'}
                    </span>
                  </div>
                </summary>
                <div className="px-3 pb-3 pt-1 border-t border-black/5 space-y-2">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                      <p className="text-[9px] uppercase tracking-wider text-textlight">QA</p>
                      <p className="text-[11px] font-medium text-textdark mt-0.5">{page.qa_score ?? '—'}</p>
                    </div>
                    <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                      <p className="text-[9px] uppercase tracking-wider text-textlight">Issues</p>
                      <p className="text-[11px] font-medium text-textdark mt-0.5">{page.qa_issues_count ?? '—'}</p>
                    </div>
                    <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                      <p className="text-[9px] uppercase tracking-wider text-textlight">Smoke</p>
                      <p className="text-[11px] font-medium text-textdark mt-0.5">{page.smoke_test_status || '—'}</p>
                    </div>
                    <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                      <p className="text-[9px] uppercase tracking-wider text-textlight">Duration</p>
                      <p className="text-[11px] font-medium text-textdark mt-0.5">{page.generation_duration_ms ? formatDuration(page.generation_duration_ms) : '—'}</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {page.qa_status && (
                      <span className={`inline-flex items-center rounded-full px-2 py-1 text-[9px] border ${page.qa_status === 'passed' ? 'bg-teal/10 text-teal border-teal/20' : 'bg-red-50 text-red-500 border-red-100'}`}>
                        QA {page.qa_status}
                      </span>
                    )}
                    {page.smoke_test_status && (
                      <span className={`inline-flex items-center rounded-full px-2 py-1 text-[9px] border ${page.smoke_test_status === 'passed' ? 'bg-teal/10 text-teal border-teal/20' : 'bg-red-50 text-red-500 border-red-100'}`}>
                        Smoke {page.smoke_test_status}
                      </span>
                    )}
                    {page.gauntlet_retry_type && (
                      <span className="inline-flex items-center rounded-full bg-gold/10 text-gold border border-gold/20 px-2 py-1 text-[9px]">
                        Retry {page.gauntlet_retry_type}
                      </span>
                    )}
                    {page.gauntlet_image_prescore_attempts != null && (
                      <span className="inline-flex items-center rounded-full bg-black/[0.02] text-textmid border border-black/5 px-2 py-1 text-[9px]">
                        Image prescore attempts {page.gauntlet_image_prescore_attempts}
                      </span>
                    )}
                    {page.fix_attempts != null && (
                      <span className="inline-flex items-center rounded-full bg-black/[0.02] text-textmid border border-black/5 px-2 py-1 text-[9px]">
                        Fixes {page.fix_attempts}
                      </span>
                    )}
                  </div>

                  {(page.headline_text || page.subheadline_text) && (
                    <div className="space-y-1">
                      {page.headline_text && (
                        <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                          <p className="text-[9px] uppercase tracking-wider text-textlight">Headline</p>
                          <p className="text-[10px] text-textdark mt-1 leading-relaxed">{page.headline_text}</p>
                        </div>
                      )}
                      {page.subheadline_text && (
                        <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                          <p className="text-[9px] uppercase tracking-wider text-textlight">Subheadline</p>
                          <p className="text-[10px] text-textmid mt-1 leading-relaxed">{page.subheadline_text}</p>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {page.headline_frame_alignment_status && (
                      <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-textlight">Frame Fit</p>
                        <p className="text-[11px] font-medium text-textdark mt-0.5">{page.headline_frame_alignment_status}</p>
                        {page.headline_frame_alignment_reason && (
                          <p className="text-[9px] text-textmid mt-1 leading-relaxed">{page.headline_frame_alignment_reason}</p>
                        )}
                      </div>
                    )}
                    {page.headline_uniqueness_status && (
                      <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-textlight">5-Frame Uniqueness</p>
                        <p className="text-[11px] font-medium text-textdark mt-0.5">{page.headline_uniqueness_status}</p>
                        {page.headline_uniqueness_reason && (
                          <p className="text-[9px] text-textmid mt-1 leading-relaxed">{page.headline_uniqueness_reason}</p>
                        )}
                        {page.headline_duplicate_of_lp_id && (
                          <p className="text-[9px] text-textlight mt-1">Duplicate of {page.headline_duplicate_of_lp_id.slice(0, 8)}...</p>
                        )}
                      </div>
                    )}
                    {page.headline_history_status && (
                      <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-textlight">History Check</p>
                        <p className="text-[11px] font-medium text-textdark mt-0.5">{page.headline_history_status}</p>
                        {page.headline_history_reason && (
                          <p className="text-[9px] text-textmid mt-1 leading-relaxed">{page.headline_history_reason}</p>
                        )}
                      </div>
                    )}
                  </div>

                  {page.published_url && (
                    <a href={page.published_url} target="_blank" rel="noreferrer" className="text-[10px] text-gold hover:text-gold-light inline-block break-all">
                      {page.published_url}
                    </a>
                  )}

                  {page.error_message && (
                    <p className="text-[10px] text-red-500 leading-relaxed">{page.error_message}</p>
                  )}
                  {page.qa_summary && (
                    <p className="text-[10px] text-textdark leading-relaxed">{page.qa_summary}</p>
                  )}
                  {page.gauntlet_score_reasoning && (
                    <p className="text-[10px] text-textmid leading-relaxed">{page.gauntlet_score_reasoning}</p>
                  )}

                  {page.qa_categories && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {Object.entries(page.qa_categories).map(([key, value]) => (
                        <div key={key} className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                          <p className="text-[9px] uppercase tracking-wider text-textlight">{value?.label || formatLaneLabel(key)}</p>
                          <p className="text-[11px] font-medium text-textdark mt-0.5">
                            {value?.score ?? '—'}{value?.max ? `/${value.max}` : ''}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}

                  {ensureArray(page.qa_issues, `AgentMonitor.run.lpDetails.${page.id}.qaIssues`).length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-textlight">QA issues</p>
                      <div className="space-y-1 mt-1">
                        {ensureArray(page.qa_issues, `AgentMonitor.run.lpDetails.${page.id}.qaIssuesList`).map((issue, index) => (
                          <div key={`${page.id}-issue-${index}`} className="rounded-lg bg-red-50/70 border border-red-100 px-2 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[9px] font-medium text-red-500">{issue.severity || 'issue'}</span>
                              {issue.location && <span className="text-[9px] text-textlight">{issue.location}</span>}
                            </div>
                            <p className="text-[10px] text-textdark mt-1 leading-relaxed">{issue.description || 'Issue detected'}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {ensureArray(page.smoke_checks, `AgentMonitor.run.lpDetails.${page.id}.smokeChecks`).length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-textlight">Smoke checks</p>
                      <div className="space-y-1 mt-1">
                        {ensureArray(page.smoke_checks, `AgentMonitor.run.lpDetails.${page.id}.smokeChecksList`).map((check, index) => (
                          <div key={`${page.id}-smoke-${index}`} className={`rounded-lg border px-2 py-2 ${check.passed ? 'bg-teal/5 border-teal/20' : 'bg-red-50/70 border-red-100'}`}>
                            <div className="flex items-center justify-between gap-2">
                              <span className={`text-[9px] font-medium ${check.passed ? 'text-teal' : 'text-red-500'}`}>
                                {check.name}
                              </span>
                              <span className={`text-[9px] ${check.passed ? 'text-teal' : 'text-red-500'}`}>
                                {formatBooleanStatus(check.passed)}
                              </span>
                            </div>
                            {check.detail && (
                              <p className="text-[10px] text-textdark mt-1 leading-relaxed">{check.detail}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {(ensureArray(page.smoke_visible_placeholder_matches, `AgentMonitor.run.lpDetails.${page.id}.visiblePlaceholders`).length > 0 ||
                    ensureArray(page.smoke_raw_placeholder_matches, `AgentMonitor.run.lpDetails.${page.id}.rawPlaceholders`).length > 0) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-textlight">Visible Placeholders</p>
                        {ensureArray(page.smoke_visible_placeholder_matches, `AgentMonitor.run.lpDetails.${page.id}.visiblePlaceholderList`).length > 0 ? (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {ensureArray(page.smoke_visible_placeholder_matches, `AgentMonitor.run.lpDetails.${page.id}.visiblePlaceholderTags`).map((match, index) => (
                              <span key={`${page.id}-visible-placeholder-${index}`} className="inline-flex items-center rounded-full bg-red-50 text-red-500 border border-red-100 px-2 py-1 text-[9px]">
                                {match}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[10px] text-textmid mt-1">None detected in rendered page text.</p>
                        )}
                      </div>
                      <div className="rounded-lg bg-black/[0.02] border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-textlight">Raw HTML Placeholder Tokens</p>
                        {ensureArray(page.smoke_raw_placeholder_matches, `AgentMonitor.run.lpDetails.${page.id}.rawPlaceholderList`).length > 0 ? (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {ensureArray(page.smoke_raw_placeholder_matches, `AgentMonitor.run.lpDetails.${page.id}.rawPlaceholderTags`).map((match, index) => (
                              <span key={`${page.id}-raw-placeholder-${index}`} className="inline-flex items-center rounded-full bg-black/[0.02] text-textmid border border-black/5 px-2 py-1 text-[9px]">
                                {match}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[10px] text-textmid mt-1">None found in raw HTML source.</p>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-3 text-[9px] text-textlight">
                    {page.created_at && <span>Created {formatDateTime(page.created_at)}</span>}
                    {page.updated_at && <span>Updated {formatDateTime(page.updated_at)}</span>}
                    {page.gauntlet_batch_completed_at && <span>Completed {formatDateTime(page.gauntlet_batch_completed_at)}</span>}
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function buildServerQueueItem(active, existing = null) {
  return {
    id: existing?.id || active?.runId || active?.id || crypto.randomUUID(),
    status: active?.status === 'complete' ? 'complete' : active?.status === 'error' ? 'error' : 'running',
    progress: typeof active?.progress === 'number' ? active.progress : (existing?.progress || 0),
    phase: active?.phase || existing?.phase || 'Still processing in background...',
    startTime: existing?.startTime || active?.startTime || Date.now(),
    result: active?.result || existing?.result || null,
    angleId: existing?.angleId || null,
    generateLP: existing?.generateLP ?? false,
    sseConnected: false,
    serverRunId: active?.runId || active?.id || existing?.serverRunId || null,
  };
}

const VALID_AGENT_TABS = ['director', 'lp_agent', 'filter', 'fixer'];

export default function AgentMonitor() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [fixerData, setFixerData] = useState(null);
  const [filterData, setFilterData] = useState(null);
  const [pipelineStatus, setPipelineStatus] = useState(null);
  // Persist active tab in URL search params so it survives page refresh
  const tabFromUrl = searchParams.get('tab');
  const [activeTab, setActiveTabState] = useState(
    tabFromUrl && VALID_AGENT_TABS.includes(tabFromUrl) ? tabFromUrl : 'director'
  );
  const setActiveTab = useCallback((newTab) => {
    setActiveTabState(newTab);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', newTab);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const [statusLoading, setStatusLoading] = useState(true);
  const [error, setError] = useState(false);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      if (activeTab === 'director') {
        const [fixer, filter, pipeline] = await Promise.allSettled([
          api.getAgentMonitorStatus(),
          api.getFilterStatus(),
          api.getConductorPipelineStatus(),
        ]);
        if (fixer.status === 'fulfilled') setFixerData(fixer.value);
        if (filter.status === 'fulfilled') setFilterData(filter.value);
        if (pipeline.status === 'fulfilled') setPipelineStatus(pipeline.value);
        setError(
          fixer.status === 'rejected' &&
          filter.status === 'rejected' &&
          pipeline.status === 'rejected'
        );
      } else if (activeTab === 'filter') {
        const filter = await api.getFilterStatus();
        setFilterData(filter);
        setPipelineStatus(null);
        setError(false);
      } else if (activeTab === 'fixer') {
        const fixer = await api.getAgentMonitorStatus();
        setFixerData(fixer);
        setPipelineStatus(null);
        setError(false);
      } else {
        setPipelineStatus(null);
        setError(false);
      }
    } catch {
      setError(true);
    } finally {
      setStatusLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadStatus();
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadStatus();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [loadStatus]);

  const hasActiveTabData =
    activeTab === 'director'
      ? !!pipelineStatus || !!fixerData || !!filterData
      : activeTab === 'filter'
        ? !!filterData
        : activeTab === 'fixer'
          ? !!fixerData
          : true;

  const agentsOnline = [fixerData, filterData].filter(d => d?.status === 'online').length;
  const agentsTotal = [fixerData, filterData].filter(Boolean).length;

  const tabs = [
    { id: 'director', label: 'Creative Director' },
    { id: 'lp_agent', label: 'LP Agent' },
    { id: 'filter', label: 'Creative Filter' },
    { id: 'fixer', label: 'Fixer' },
  ];

  return (
    <div className="fade-in space-y-4">
      {/* Dashboard header */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-navy/10 flex items-center justify-center flex-shrink-0">
              <svg className="w-3.5 h-3.5 text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <h2 className="text-[15px] font-semibold text-textdark tracking-tight">Agent Dashboard</h2>
              <p className="text-[11px] text-textlight">Four automation systems managing your creative pipeline</p>
            </div>
          </div>
          <span className="text-[11px] text-textmid font-medium">{agentsOnline}/{agentsTotal} online</span>
        </div>

        {statusLoading && !hasActiveTabData ? (
          <div className="animate-pulse">
            <div className="h-3 w-28 bg-gray-200 rounded mb-3" />
            <div className="h-20 bg-gray-50 rounded-xl" />
          </div>
        ) : error && !hasActiveTabData ? (
          <div className="rounded-xl bg-black/[0.02] border border-black/5 p-4">
            <p className="text-[12px] font-medium text-textmid mb-1">Status Summary</p>
            <p className="text-[11px] text-textlight">Agent status is temporarily unavailable. The page shell stays interactive while the status endpoints recover.</p>
          </div>
        ) : activeTab === 'director' ? (
          <PipelineOverview data={pipelineStatus} fixerData={fixerData} filterData={filterData} />
        ) : (
          <div className="rounded-xl bg-black/[0.02] border border-black/5 p-4">
            <p className="text-[12px] font-medium text-textmid mb-1">Status Summary</p>
            <p className="text-[11px] text-textlight">
              Director pipeline metrics load only on the Creative Director tab to keep this page lighter while you work elsewhere.
            </p>
            <div className="flex items-center gap-4 mt-3 text-[10px] text-textmid">
              <span>Director: open tab to load</span>
              <span>Filter: {filterData?.status === 'online' ? '\u2713' : '\u2013'}</span>
              <span>Fixer: {fixerData?.status === 'online' ? '\u2713' : '\u2013'}</span>
            </div>
          </div>
        )}
      </div>

      {/* Agent Tabs */}
      <div className="card p-5">
        <div className="segmented-control mb-4">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={activeTab === tab.id ? 'active' : ''}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'director' && <DirectorTab onRefresh={loadStatus} />}
        {activeTab === 'lp_agent' && <LPAgentTab />}
        {activeTab === 'filter' && filterData && <FilterPanel data={filterData} onRefresh={loadStatus} />}
        {activeTab === 'fixer' && fixerData && <FixerPanel data={fixerData} onRefresh={loadStatus} />}
      </div>
    </div>
  );
}

// =============================================
// Pipeline Overview
// =============================================
function PipelineOverview({ data, fixerData, filterData }) {
  const projects = ensureArray(data?.projects, 'AgentMonitor.pipeline.projects');
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Get the next 5 weekdays
  const getUpcomingDays = () => {
    const days = [];
    const now = new Date();
    let d = new Date(now);
    while (days.length < 5) {
      d.setDate(d.getDate() + 1);
      const dow = d.getDay();
      if (dow >= 1 && dow <= 5) {
        days.push({
          date: d.toISOString().split('T')[0],
          dayName: dayNames[dow],
          label: days.length === 0 ? 'Tomorrow' : `${dayNames[dow]} ${d.getDate()}`,
        });
      }
    }
    return days;
  };

  const upcomingDays = getUpcomingDays();

  if (projects.length === 0) {
    return (
      <div className="rounded-xl bg-black/[0.02] border border-black/5 p-4">
        <p className="text-[12px] font-medium text-textmid mb-1">Pipeline Overview</p>
        <p className="text-[11px] text-textlight">No projects configured for the Creative Director yet. Enable a project in the Director tab to see pipeline status.</p>
        <div className="flex items-center gap-4 mt-3 text-[10px] text-textmid">
          <span>Director: {'\u2013'}</span>
          <span>Filter: {filterData?.status === 'online' ? '\u2713' : '\u2013'}</span>
          <span>Fixer: {fixerData?.status === 'online' ? '\u2713' : '\u2013'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-black/[0.02] border border-black/5 p-4">
      <p className="text-[12px] font-medium text-textmid mb-3">Pipeline Overview</p>

      {upcomingDays.slice(0, 3).map(day => (
        <div key={day.date} className="mb-3 last:mb-0">
          <p className="text-[10px] text-textlight font-medium uppercase tracking-wider mb-1.5">{day.label}</p>
          {projects.map(project => {
            const produced = project.flex_by_day?.[day.date] || 0;
            const target = project.daily_flex_target ?? 5;
            const activeBatches = project.active_batches_by_day?.[day.date] || 0;
            const pct = Math.min((produced / target) * 100, 100);
            const isMet = produced >= target;

            return (
              <div key={project.project_id} className="flex items-center gap-3 mb-1">
                <span className="text-[11px] text-textdark font-medium w-32 truncate">{project.brand_name || project.project_name}</span>
                <div className="flex-1 h-2.5 rounded-full bg-black/5 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${isMet ? 'bg-teal' : 'bg-navy'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-[10px] text-textmid tabular-nums w-16 text-right">
                  {produced}/{target}
                  {isMet && <span className="text-teal ml-1">{'\u2713'}</span>}
                </span>
                {activeBatches > 0 && (
                  <span className="text-[9px] text-gold font-medium">{activeBatches} in progress</span>
                )}
              </div>
            );
          })}
        </div>
      ))}

      <div className="flex items-center gap-4 mt-3 pt-2 border-t border-black/5 text-[10px] text-textmid">
        <span>Director {'\u2713'}</span>
        <span>Filter: {filterData?.status === 'online' ? '\u2713' : '\u2717'}</span>
        <span>Fixer: {fixerData?.status === 'online' ? '\u2713' : '\u2717'}</span>
      </div>
    </div>
  );
}

// =============================================
// LP Generation Stats Panel
// =============================================
function GauntletStatsPanel({ projectId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [loadedProjectId, setLoadedProjectId] = useState(null);

  useEffect(() => {
    setExpanded(false);
    setData(null);
    setLoading(false);
    setLoadedProjectId(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !expanded || loadedProjectId === projectId) return;
    setLoading(true);
    api.getGauntletStats(projectId)
      .then(res => {
        setData(res);
        setLoadedProjectId(projectId);
      })
      .catch(() => {
        setData(null);
        setLoadedProjectId(null);
      })
      .finally(() => setLoading(false));
  }, [expanded, loadedProjectId, projectId]);

  const s = data?.stats || null;
  const FRAME_LABELS = {
    testimonial: 'Testimonial',
    mechanism: 'Mechanism',
    problem_agitation: 'Problem',
    myth_busting: 'Myth Bust',
    listicle: 'Listicle',
  };

  return (
    <div className="card p-4 space-y-3 mb-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold text-navy">LP Generation Stats</h3>
          <p className="text-[10px] text-textlight mt-0.5">Loaded on demand so the LP Agent tab opens faster.</p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(prev => !prev)}
          className="btn-secondary text-[11px] px-3 py-1.5 shrink-0"
        >
          {expanded ? 'Hide Stats' : loadedProjectId === projectId ? 'Show Stats' : 'Load Stats'}
        </button>
      </div>

      {!expanded ? (
        <div className="rounded-xl bg-black/[0.02] border border-black/5 px-3 py-2.5">
          <p className="text-[11px] text-textmid">Open this panel only when you need gauntlet pass/fail and score breakdowns.</p>
        </div>
      ) : loading ? (
        <div className="py-3 text-center text-[11px] text-textmid">Loading LP stats...</div>
      ) : !data?.hasData ? (
        <div className="rounded-xl bg-black/[0.02] border border-black/5 px-3 py-2.5">
          <p className="text-[11px] text-textmid">No gauntlet runs found for this project yet.</p>
        </div>
      ) : (
        <>

          {/* Summary grid */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-offwhite rounded-lg p-2.5 text-center">
              <div className="text-[18px] font-bold text-navy">{s.gauntletRuns}</div>
              <div className="text-[10px] text-textmid">Runs</div>
            </div>
            <div className="bg-offwhite rounded-lg p-2.5 text-center">
              <div className="text-[18px] font-bold text-teal">{s.passRate}%</div>
              <div className="text-[10px] text-textmid">Pass Rate</div>
            </div>
            <div className="bg-offwhite rounded-lg p-2.5 text-center">
              <div className="text-[18px] font-bold text-navy">{s.avgScore ?? '—'}</div>
              <div className="text-[10px] text-textmid">Avg Score</div>
            </div>
            <div className="bg-offwhite rounded-lg p-2.5 text-center">
              <div className="text-[18px] font-bold text-gold">{s.retryRate}%</div>
              <div className="text-[10px] text-textmid">Retry Rate</div>
            </div>
          </div>

          {/* Detail stats */}
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <div className="bg-offwhite rounded-lg px-2.5 py-2">
              <span className="text-textmid">Total LPs: </span>
              <span className="font-medium text-navy">{s.totalLPs}</span>
            </div>
            <div className="bg-offwhite rounded-lg px-2.5 py-2">
              <span className="text-textmid">Passed: </span>
              <span className="font-medium text-teal">{s.passed}</span>
            </div>
            <div className="bg-offwhite rounded-lg px-2.5 py-2">
              <span className="text-textmid">Failed: </span>
              <span className="font-medium text-red-400">{s.failed}</span>
            </div>
            <div className="bg-offwhite rounded-lg px-2.5 py-2">
              <span className="text-textmid">Image 1st Pass: </span>
              <span className="font-medium text-navy">{s.firstPassRate != null ? `${s.firstPassRate}%` : '—'}</span>
            </div>
            <div className="bg-offwhite rounded-lg px-2.5 py-2">
              <span className="text-textmid">Avg Img Retries: </span>
              <span className="font-medium text-navy">{s.avgPrescoreAttempts ?? '—'}</span>
            </div>
            <div className="bg-offwhite rounded-lg px-2.5 py-2">
              <span className="text-textmid">Score Range: </span>
              <span className="font-medium text-navy">{s.minScore != null ? `${s.minScore}–${s.maxScore}` : '—'}</span>
            </div>
          </div>

          {/* Score by frame (mini bar chart) */}
          {Object.keys(s.scoreByFrame || {}).length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold text-textmid uppercase tracking-wide">Score by Frame</div>
              {Object.entries(s.scoreByFrame).map(([frame, score]) => (
                <div key={frame} className="flex items-center gap-2">
                  <span className="text-[10px] text-textmid w-20 flex-shrink-0 truncate">{FRAME_LABELS[frame] || frame}</span>
                  <div className="flex-1 h-4 bg-offwhite rounded-full overflow-hidden">
                    <div
                      className="h-full bg-navy/70 rounded-full transition-all"
                      style={{ width: `${Math.min(100, (score / 10) * 100)}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-medium text-navy w-8 text-right">{score}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// =============================================
// LP Agent Tab
// =============================================
function LPAgentTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProjectState] = useState('');
  const [loading, setLoading] = useState(true);

  const setSelectedProject = useCallback((projectId) => {
    setSelectedProjectState(projectId);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (projectId) next.set('project', projectId);
      else next.delete('project');
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const safeProjects = ensureArray(projects, 'AgentMonitor.lpAgent.projectsState');

  useEffect(() => {
    (async () => {
      try {
        const res = await api.getProjectOptions();
        const list = ensureArray(res?.projects ?? res, 'AgentMonitor.lpAgent.projects');
        setProjects(list);
        const projectFromUrl = searchParams.get('project');
        if (projectFromUrl && list.some(p => p.id === projectFromUrl)) {
          setSelectedProjectState(projectFromUrl);
        } else if (list.length > 0) {
          setSelectedProject(list[0].id);
        }
      } catch { /* ignore */ }
      finally { setLoading(false); }
    })();
  }, []);

  if (loading) {
    return <div className="py-4 text-center text-[12px] text-textmid">Loading...</div>;
  }

  return (
    <div>
      {/* Project selector */}
      {safeProjects.length > 1 && (
        <div className="mb-4">
          <select
            value={selectedProject}
            onChange={e => setSelectedProject(e.target.value)}
            className="input-apple text-[12px]"
          >
            {safeProjects.map(p => (
              <option key={p.id} value={p.id}>{p.displayName || p.brand_name || p.name}</option>
            ))}
          </select>
        </div>
      )}

      {selectedProject ? (
        <>
          <GauntletStatsPanel projectId={selectedProject} />
          <LPAgentSettings projectId={selectedProject} />
        </>
      ) : (
        <div className="py-6 text-center text-[12px] text-textmid">No projects found. Create a project first.</div>
      )}
    </div>
  );
}

// =============================================
// Creative Director Tab
// =============================================
function DirectorTab({ onRefresh }) {
  const toast = useToast();
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [config, setConfig] = useState(null);
  const [angles, setAngles] = useState([]);
  const [angleOptions, setAngleOptions] = useState([]);
  const [runs, setRuns] = useState([]);
  const [playbooks, setPlaybooks] = useState([]);
  const [subTab, setSubTab] = useState('history');
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [projectLoading, setProjectLoading] = useState(true);
  const [baseLoading, setBaseLoading] = useState(false);
  const [anglesLoading, setAnglesLoading] = useState(false);
  const [angleOptionsLoading, setAngleOptionsLoading] = useState(false);
  const [runsLoading, setRunsLoading] = useState(false);
  const [playbooksLoading, setPlaybooksLoading] = useState(false);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [anglesLoadedFor, setAnglesLoadedFor] = useState('');
  const [angleOptionsLoadedFor, setAngleOptionsLoadedFor] = useState('');
  const [runsLoadedFor, setRunsLoadedFor] = useState('');
  const [playbooksLoadedFor, setPlaybooksLoadedFor] = useState('');
  const [campaignsLoadedFor, setCampaignsLoadedFor] = useState('');
  const [runningAction, setRunningAction] = useState(null);
  const [saving, setSaving] = useState(false);
  const [expandedRuns, setExpandedRuns] = useState({});
  const [lpDetailsByBatchId, setLpDetailsByBatchId] = useState({});
  const [lpDetailsLoadingByBatchId, setLpDetailsLoadingByBatchId] = useState({});

  const [campaigns, setCampaigns] = useState([]);

  // Angle selection and LP toggle for test runs
  const [selectedAngleId, setSelectedAngleId] = useState('');
  const [generateLP, setGenerateLP] = useState(false);

  // Test run queue — persisted to localStorage so it survives refresh/navigation
  const QUEUE_KEY = 'dacia_testRunQueue';
  const [testRunQueue, setTestRunQueue] = useState(() => {
    try {
      const saved = localStorage.getItem(QUEUE_KEY);
      if (!saved) return [];
      const parsed = ensureArray(JSON.parse(saved), 'AgentMonitor.director.savedRunQueue');
      // Clear stale items older than 2 hours
      const cutoff = Date.now() - 2 * 60 * 60 * 1000;
      return parsed.filter(r => r.startTime ? r.startTime > cutoff : true);
    } catch { return []; }
  });
  const safeTestRunQueue = ensureArray(testRunQueue, 'AgentMonitor.director.testRunQueue');
  const activeRun = safeTestRunQueue.find(r => r.status === 'running');
  const queuedCount = safeTestRunQueue.filter(r => r.status === 'queued').length;
  const finishedRuns = safeTestRunQueue.filter(r => r.status === 'complete' || r.status === 'error');
  const activeRunRecord = activeRun?.result || null;
  const activeRunRounds = getRunRounds(activeRunRecord);
  const activeRunBatches = getRunBatches(activeRunRecord);
  const activeRunRequiredPasses = activeRunRecord?.required_passes || 10;
  const activeRunPassed = activeRunRecord?.total_ads_passed ?? activeRunRounds[activeRunRounds.length - 1]?.cumulative_passed ?? null;
  const showActiveRunBreakdown = activeRun && (activeRunRounds.length > 0 || activeRunBatches.length > 0);
  const sseActiveRef = useRef(false); // tracks if we have a live SSE connection for the active run
  const abortRef = useRef(null); // stores the SSE abort function for active run cancellation

  // Sync queue to localStorage on every change
  useEffect(() => {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(safeTestRunQueue));
  }, [safeTestRunQueue]);

  // Auto-clear finished results after 5 minutes
  useEffect(() => {
    if (finishedRuns.length === 0) return;
    const timer = setInterval(() => {
      const cutoff = Date.now() - 5 * 60 * 1000;
      setTestRunQueue(prev => prev.filter(r => !(r.finishedAt && r.finishedAt < cutoff)));
    }, 30000);
    return () => clearInterval(timer);
  }, [finishedRuns.length]);

  const navigate = useNavigate();

  // New angle form
  const [showAddAngle, setShowAddAngle] = useState(false);
  const [newAngle, setNewAngle] = useState({ name: '', description: '', prompt_hints: '', priority: 'medium', frame: 'symptom-first', core_buyer: '', symptom_pattern: '', failed_solutions: '', current_belief: '', objection: '', emotional_state: '', scene: '', desired_belief_shift: '', tone: '', avoid_list: '' });

  // Import angles
  const [showImport, setShowImport] = useState(false);
  const [importDragOver, setImportDragOver] = useState(false);
  const [importResult, setImportResult] = useState(null); // { newAngles: [], skipped: [] }
  const [importing, setImporting] = useState(false);
  const importFileRef = useRef(null);
  const debounceRef = useRef(null);
  const pendingConfigRef = useRef({});
  const saveInFlightRef = useRef(false);
  const selectedProjectRef = useRef('');

  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  useEffect(() => {
    setLpDetailsByBatchId({});
    setLpDetailsLoadingByBatchId({});
  }, [selectedProject]);

  // Load projects list
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getProjectOptions();
        const list = ensureArray(res?.projects ?? res, 'AgentMonitor.director.projects');
        if (cancelled) return;
        setProjects(list);
        if (list.length > 0 && !selectedProjectRef.current) {
          setSelectedProject(list[0].id);
        }
      } catch { /* ignore */ }
      finally {
        if (!cancelled) setProjectLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load project-specific data when selection changes
  useEffect(() => {
    if (!selectedProject) return;
    pendingConfigRef.current = {};
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSelectedAngleId('');
    let cancelled = false;
    setBaseLoading(true);
    setAnglesLoading(false);
    setAngleOptionsLoading(false);
    setRunsLoading(false);
    setPlaybooksLoading(false);
    setCampaignsLoading(false);
    setConfig(null);
    setAngles([]);
    setAngleOptions([]);
    setRuns([]);
    setPlaybooks([]);
    setCampaigns([]);
    setAnglesLoadedFor('');
    setAngleOptionsLoadedFor('');
    setRunsLoadedFor('');
    setPlaybooksLoadedFor('');
    setCampaignsLoadedFor('');
    (async () => {
      try {
        const [cfgRes] = await Promise.allSettled([
          api.getConductorConfig(selectedProject),
        ]);
        if (cancelled) return;
        if (cfgRes.status === 'fulfilled') setConfig(cfgRes.value?.config || null);
      } catch { /* ignore */ }
      finally {
        if (!cancelled) setBaseLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedProject]);

  const loadAngles = useCallback(async (projectId = selectedProjectRef.current) => {
    if (!projectId || anglesLoading || anglesLoadedFor === projectId) return;
    setAnglesLoading(true);
    try {
      const angRes = await api.getConductorAngles(projectId);
      if (selectedProjectRef.current !== projectId) return;
      setAngles(ensureArray(angRes?.angles, 'AgentMonitor.director.angles'));
      setAnglesLoadedFor(projectId);
    } catch { /* ignore */ }
    finally {
      if (selectedProjectRef.current === projectId) setAnglesLoading(false);
    }
  }, [anglesLoadedFor, anglesLoading]);

  const loadAngleOptions = useCallback(async (projectId = selectedProjectRef.current, { force = false } = {}) => {
    if (!projectId || angleOptionsLoading || (!force && angleOptionsLoadedFor === projectId)) return;
    setAngleOptionsLoading(true);
    try {
      const angRes = await api.getConductorActiveAngles(projectId);
      if (selectedProjectRef.current !== projectId) return;
      setAngleOptions(ensureArray(angRes?.angles, 'AgentMonitor.director.angleOptions'));
      setAngleOptionsLoadedFor(projectId);
    } catch { /* ignore */ }
    finally {
      if (selectedProjectRef.current === projectId) setAngleOptionsLoading(false);
    }
  }, [angleOptionsLoadedFor, angleOptionsLoading]);

  const loadRuns = useCallback(async (projectId = selectedProjectRef.current) => {
    if (!projectId || runsLoading || runsLoadedFor === projectId) return;
    setRunsLoading(true);
    try {
      const runRes = await api.getConductorRuns(projectId, 20);
      if (selectedProjectRef.current !== projectId) return;
      setRuns(ensureArray(runRes?.runs, 'AgentMonitor.director.runs'));
      setRunsLoadedFor(projectId);
    } catch { /* ignore */ }
    finally {
      if (selectedProjectRef.current === projectId) setRunsLoading(false);
    }
  }, [runsLoadedFor, runsLoading]);

  const loadPlaybooks = useCallback(async (projectId = selectedProjectRef.current) => {
    if (!projectId || playbooksLoading || playbooksLoadedFor === projectId) return;
    setPlaybooksLoading(true);
    try {
      const pbRes = await api.getConductorPlaybooks(projectId);
      if (selectedProjectRef.current !== projectId) return;
      setPlaybooks(ensureArray(pbRes?.playbooks, 'AgentMonitor.director.playbooks'));
      setPlaybooksLoadedFor(projectId);
    } catch { /* ignore */ }
    finally {
      if (selectedProjectRef.current === projectId) setPlaybooksLoading(false);
    }
  }, [playbooksLoadedFor, playbooksLoading]);

  const loadCampaigns = useCallback(async (projectId = selectedProjectRef.current) => {
    if (!projectId || campaignsLoading || campaignsLoadedFor === projectId) return;
    setCampaignsLoading(true);
    try {
      const campRes = await api.getCampaigns(projectId);
      if (selectedProjectRef.current !== projectId) return;
      setCampaigns(ensureArray(campRes?.campaigns, 'AgentMonitor.director.campaigns'));
      setCampaignsLoadedFor(projectId);
    } catch { /* ignore */ }
    finally {
      if (selectedProjectRef.current === projectId) setCampaignsLoading(false);
    }
  }, [campaignsLoadedFor, campaignsLoading]);

  useEffect(() => {
    if (!selectedProject) return;
    loadAngleOptions(selectedProject);
  }, [loadAngleOptions, selectedProject]);

  useEffect(() => {
    if (!selectedProject) return;
    if (subTab === 'angles') {
      loadAngles(selectedProject);
      loadPlaybooks(selectedProject);
    }
    if (subTab === 'playbooks') {
      loadPlaybooks(selectedProject);
    }
    if (subTab === 'history') {
      loadRuns(selectedProject);
    }
    if (subTab === 'settings') {
      loadCampaigns(selectedProject);
    }
  }, [loadAngles, loadCampaigns, loadPlaybooks, loadRuns, selectedProject, subTab]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const flushPendingConfig = useCallback(async () => {
    if (!selectedProject || saveInFlightRef.current) return;
    const updates = pendingConfigRef.current;
    if (Object.keys(updates).length === 0) return;

    pendingConfigRef.current = {};
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const res = await api.updateConductorConfig(selectedProject, updates);
      if (res?.config) setConfig(res.config);
    } catch {
      pendingConfigRef.current = { ...updates, ...pendingConfigRef.current };
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
      if (Object.keys(pendingConfigRef.current).length > 0) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(flushPendingConfig, 500);
      }
    }
  }, [selectedProject]);

  const handleSaveConfig = useCallback((updates) => {
    setConfig(prev => ({ ...(prev || {}), ...updates }));
    pendingConfigRef.current = { ...pendingConfigRef.current, ...updates };
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(flushPendingConfig, 500);
  }, [flushPendingConfig]);

  const STEP_PROGRESS = {
    // Director phase (~5s) — 0-2%
    'initializing': 1,
    'selecting_angle': 1,
    'building_prompt': 1,
    'creating_batch': 2,
    'saving_run': 2,
    'launching_batch': 2,
    // Batch pipeline (~3-8 min) — 2-15%
    'batch_brief': 4,
    'batch_headlines': 6,
    'batch_body_copy': 9,
    'batch_image_prompts': 12,
    'batch_submitting': 14,
    'batch_submitted': 15,
    // Gemini processing (~5-20 min) — 15-60%
    'gemini_waiting': 15,
    'gemini_complete': 60,
    // Creative Filter (~2-5 min) — 60-95%
    'filter_scoring': 62,
    'filter_grouping': 82,
    'filter_copy_gen': 86,
    'filter_deploying': 92,
    'filter_complete': 95,
  };

  const handleTestRun = () => {
    const queueItem = { id: crypto.randomUUID(), status: 'queued', progress: 0, phase: '', startTime: null, result: null, angleId: selectedAngleId || null, generateLP, sseConnected: false, serverRunId: null };
    setTestRunQueue(prev => [...prev, queueItem]);
    setSubTab('history');
  };

  const updateQueueItem = useCallback((id, updates) => {
    setTestRunQueue(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r));
  }, []);

  const finishRun = useCallback((runId, isError) => {
    setTimeout(async () => {
      setRunningAction(null);
      sseActiveRef.current = false;
      abortRef.current = null;
      // Keep completed/errored items visible — don't remove from queue
      // Mark with finishedAt so we can auto-clear later
      setTestRunQueue(prev => prev.map(r => r.id === runId ? { ...r, finishedAt: Date.now() } : r));
      try {
        const runRes = await api.getConductorRuns(selectedProject, 20);
        setRuns(ensureArray(runRes?.runs, 'AgentMonitor.director.runs'));
        setRunsLoadedFor(selectedProject);
      } catch {}
      if (!isError) onRefresh();
    }, isError ? 3000 : 2000);
  }, [selectedProject, onRefresh]);

  // Dismiss a completed/errored result
  const handleDismissResult = useCallback((runId) => {
    setTestRunQueue(prev => prev.filter(r => r.id !== runId));
  }, []);

  // Cancel the active running test run
  const handleCancelRun = useCallback(async () => {
    if (!activeRun) return;
    // Abort SSE connection
    abortRef.current?.();
    abortRef.current = null;
    sseActiveRef.current = false;
    updateQueueItem(activeRun.id, { sseConnected: false, phase: 'Cancelling...' });
    try {
      const res = await api.cancelTestRun(selectedProject);
      if (!res?.cancelled) {
        updateQueueItem(activeRun.id, { status: 'error', progress: 0, phase: 'No active run found to cancel.' });
        setRunningAction(null);
      }
    } catch (err) {
      updateQueueItem(activeRun.id, { status: 'error', progress: 0, phase: err.message || 'Cancel failed' });
      setRunningAction(null);
    }
  }, [activeRun, selectedProject, updateQueueItem]);

  // Remove a queued (not yet running) test run
  const handleRemoveQueued = useCallback((runId) => {
    setTestRunQueue(prev => prev.filter(r => r.id !== runId));
  }, []);

  // Clear all queued runs
  const handleClearQueue = useCallback(() => {
    setTestRunQueue(prev => prev.filter(r => r.status !== 'queued'));
  }, []);

  const loadLPDetailsForBatch = useCallback(async (batchId) => {
    if (!selectedProject || !batchId) return;
    if (lpDetailsByBatchId[batchId] || lpDetailsLoadingByBatchId[batchId]) return;

    setLpDetailsLoadingByBatchId(prev => ({ ...prev, [batchId]: true }));
    try {
      const data = await api.getConductorBatchLPDetails(selectedProject, batchId);
      setLpDetailsByBatchId(prev => ({ ...prev, [batchId]: { data } }));
    } catch (err) {
      setLpDetailsByBatchId(prev => ({ ...prev, [batchId]: { error: err.message || 'Failed to load LP details.' } }));
    } finally {
      setLpDetailsLoadingByBatchId(prev => ({ ...prev, [batchId]: false }));
    }
  }, [lpDetailsByBatchId, lpDetailsLoadingByBatchId, selectedProject]);

  const toggleRunExpanded = useCallback((runId, batchIds = []) => {
    const willExpand = !expandedRuns[runId];
    setExpandedRuns(prev => ({ ...prev, [runId]: willExpand }));
    if (willExpand) {
      ensureArray(batchIds, `AgentMonitor.run.${runId}.batchIds`)
        .filter(Boolean)
        .forEach((batchId) => {
          loadLPDetailsForBatch(batchId);
        });
    }
  }, [expandedRuns, loadLPDetailsForBatch]);

  // Queue processor — starts next queued run via SSE when no active run
  useEffect(() => {
    const running = testRunQueue.find(r => r.status === 'running');
    const nextQueued = testRunQueue.find(r => r.status === 'queued');

    // If there's a running item with a live SSE connection, nothing to do
    if (running && sseActiveRef.current) return;
    // If there's a running item without SSE (restored from localStorage), polling handles it — don't start a new one
    if (running && !sseActiveRef.current) return;
    if (!nextQueued) return;

    const runId = nextQueued.id;
    setTestRunQueue(prev => prev.map(r => r.id === runId ? { ...r, status: 'running', startTime: Date.now(), phase: 'Starting test run...', sseConnected: true } : r));
    setRunningAction('run');
    sseActiveRef.current = true;

    const body = {
      ...(nextQueued.angleId ? { angle_id: nextQueued.angleId } : {}),
      generate_lp: nextQueued.generateLP ?? false,
    };

    let sawEvent = false;
    const { abort, done } = api.triggerConductorTestRun(selectedProject, body, (event) => {
      sawEvent = true;
      if (event.type === 'progress') {
        const updates = { phase: event.message || '' };

        if (typeof event.progressValue === 'number') {
          setTestRunQueue(prev => prev.map(r => r.id === runId ? { ...r, ...updates, progress: Math.max(r.progress, event.progressValue) } : r));
          return;
        }

        if (event.step && STEP_PROGRESS[event.step] !== undefined) {
          setTestRunQueue(prev => prev.map(r => r.id === runId ? { ...r, ...updates, progress: Math.max(r.progress, STEP_PROGRESS[event.step]) } : r));
          return;
        }

        if (event.step === 'gemini_polling' && event.elapsed) {
          const pct = 15 + Math.round(Math.min(event.elapsed / 600, 0.95) * 43);
          setTestRunQueue(prev => prev.map(r => r.id === runId ? { ...r, ...updates, progress: Math.max(r.progress, pct) } : r));
          return;
        }

        if (event.step === 'filter_scoring' && event.scoringProgress) {
          const { current, total } = event.scoringProgress;
          const pct = 62 + Math.round((current / total) * 18);
          setTestRunQueue(prev => prev.map(r => r.id === runId ? { ...r, ...updates, progress: Math.max(r.progress, pct) } : r));
          return;
        }

        if (event.imageProgress) {
          const { current, total } = event.imageProgress;
          const pct = 12 + Math.round((current / total) * 2);
          setTestRunQueue(prev => prev.map(r => r.id === runId ? { ...r, ...updates, progress: Math.max(r.progress, pct) } : r));
          return;
        }

        updateQueueItem(runId, updates);
      } else if (event.type === 'complete') {
        const roundsUsed = event.rounds_used || event.rounds?.length || 1;
        const generated = event.total_ads_generated || event.ads_scored || '?';
        const passed = event.ads_passed ?? '?';
        const readyCount = event.ready_to_post_count ?? 0;
        const msg = event.flex_ads_created > 0
          ? `Reached ${passed}/10 after ${roundsUsed} round${roundsUsed !== 1 ? 's' : ''} (${generated} generated). ${readyCount} Ready to Post ads created.`
          : `Complete — ${passed}/10 passed after ${generated} generated.`;
        updateQueueItem(runId, { status: 'complete', progress: 100, phase: msg, result: event, serverRunId: event.runId || null });
        finishRun(runId, false);
      } else if (event.type === 'background') {
        sseActiveRef.current = false;
        abortRef.current = null;
        updateQueueItem(runId, {
          status: 'running',
          sseConnected: false,
          progress: Math.max(nextQueued.progress || 0, 22),
          phase: event.phase || event.background_message || 'Still processing in background...',
          result: event,
          serverRunId: event.runId || null,
        });
      } else if (event.type === 'error') {
        const cancelled = event.terminal_status === 'cancelled' || event.message === 'Cancelled by user';
        updateQueueItem(runId, { status: 'error', progress: 0, phase: event.message || 'Failed', result: event, serverRunId: event.runId || null });
        if (!cancelled) {
          toast.error(event.message || 'Test run failed');
        }
        finishRun(runId, true);
      }
    });

    abortRef.current = abort;

    done.catch((err) => {
      if (err.name !== 'AbortError') {
        sseActiveRef.current = false;
        if (!sawEvent) {
          updateQueueItem(runId, { status: 'error', progress: 0, phase: err.message || 'Failed to start test run' });
          toast.error(err.message || 'Failed to start test run');
          finishRun(runId, true);
          return;
        }
        // SSE disconnected after the run had already started — let polling reconnect.
        updateQueueItem(runId, { sseConnected: false });
      }
    });
  }, [testRunQueue, selectedProject, updateQueueItem, finishRun, toast]);

  // Polling reconnect / hydration — keeps the server-backed progress bar alive after refresh
  useEffect(() => {
    const running = testRunQueue.find(r => r.status === 'running');
    if (sseActiveRef.current) return;
    if (!selectedProject) return;

    const poll = async () => {
      try {
        const res = await api.getTestRunProgress(selectedProject);
        if (res.active) {
          setRunningAction('run');
          if (running) {
            updateQueueItem(running.id, {
              progress: res.active.progress,
              phase: res.active.phase,
              startTime: running.startTime || res.active.startTime,
              result: res.active.result || running.result || null,
              serverRunId: res.active.runId || res.active.id || running.serverRunId || null,
            });
          } else {
            setTestRunQueue(prev => {
              const safePrev = ensureArray(prev, 'AgentMonitor.director.testRunQueueState');
              const existing = safePrev.find(item => item.serverRunId && item.serverRunId === (res.active.runId || res.active.id));
              if (existing) {
                return safePrev.map(item => item.id === existing.id ? buildServerQueueItem(res.active, item) : item);
              }
              return [buildServerQueueItem(res.active), ...safePrev];
            });
          }
          return;
        }

        if (!running) {
          setRunningAction(null);
          return;
        }

        // No active tracker: check the durable run record before deciding the run is done.
        const runRes = await api.getConductorRuns(selectedProject, 5);
        const safeRuns = ensureArray(runRes?.runs, 'AgentMonitor.director.runs');
        setRuns(safeRuns);
        setRunsLoadedFor(selectedProject);
        const latest = safeRuns[0];
        if (latest?.status === 'running') {
          updateQueueItem(running.id, {
            status: 'running',
            progress: Math.max(running.progress || 0, latest?.terminal_status === 'waiting_on_gemini' ? 22 : running.progress || 0),
            phase: latest?.decisions || 'Still processing in background...',
            result: latest || null,
            serverRunId: latest?.externalId || running.serverRunId || null,
          });
          return;
        }

        const succeeded = latest?.status === 'completed';
        updateQueueItem(running.id, {
          status: succeeded ? 'complete' : 'error',
          progress: succeeded ? 100 : 0,
          phase: succeeded ? (latest?.decisions || 'Complete') : (latest?.failure_reason || latest?.error || 'Failed'),
          result: latest || null,
          serverRunId: latest?.externalId || running.serverRunId || null,
        });
        finishRun(running.id, !succeeded);
        return; // Stop polling
      } catch {}
    };

    // Poll immediately, then every 3 seconds
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [activeRun?.id, selectedProject, updateQueueItem, finishRun]);

  const handleAddAngle = async () => {
    if (!newAngle.name) return;
    // Auto-compute description if structured fields are present but description is empty
    let description = newAngle.description;
    if (!description && (newAngle.core_buyer || newAngle.symptom_pattern)) {
      const parts = [];
      if (newAngle.core_buyer) parts.push(`Core Buyer: ${newAngle.core_buyer}`);
      if (newAngle.symptom_pattern) parts.push(`Symptom Pattern: ${newAngle.symptom_pattern}`);
      if (newAngle.objection) parts.push(`Objection: ${newAngle.objection}`);
      if (newAngle.scene) parts.push(`Scene: ${newAngle.scene}`);
      if (newAngle.desired_belief_shift) parts.push(`Desired Belief Shift: ${newAngle.desired_belief_shift}`);
      description = parts.join('\n');
    }
    if (!description) return;
    try {
      await api.createConductorAngle(selectedProject, {
        name: newAngle.name,
        description,
        prompt_hints: newAngle.prompt_hints || undefined,
        source: 'manual',
        status: 'active',
        priority: newAngle.priority || undefined,
        frame: newAngle.frame || undefined,
        core_buyer: newAngle.core_buyer || undefined,
        symptom_pattern: newAngle.symptom_pattern || undefined,
        failed_solutions: newAngle.failed_solutions || undefined,
        current_belief: newAngle.current_belief || undefined,
        objection: newAngle.objection || undefined,
        emotional_state: newAngle.emotional_state || undefined,
        scene: newAngle.scene || undefined,
        desired_belief_shift: newAngle.desired_belief_shift || undefined,
        tone: newAngle.tone || undefined,
        avoid_list: newAngle.avoid_list || undefined,
      });
      setNewAngle({ name: '', description: '', prompt_hints: '', priority: 'medium', frame: 'symptom-first', core_buyer: '', symptom_pattern: '', failed_solutions: '', current_belief: '', objection: '', emotional_state: '', scene: '', desired_belief_shift: '', tone: '', avoid_list: '' });
      setShowAddAngle(false);
      const angRes = await api.getConductorAngles(selectedProject);
      setAngles(ensureArray(angRes?.angles, 'AgentMonitor.director.angles'));
      setAnglesLoadedFor(selectedProject);
      loadAngleOptions(selectedProject, { force: true });
    } catch { /* ignore */ }
  };

  const handleAngleStatusChange = async (angleId, newStatus) => {
    try {
      await api.updateConductorAngle(selectedProject, angleId, { status: newStatus });
      setAngles(prev => ensureArray(prev, 'AgentMonitor.director.anglesState').map(a => a.externalId === angleId ? { ...a, status: newStatus } : a));
      setAngleOptions(prev => {
        const safePrev = ensureArray(prev, 'AgentMonitor.director.angleOptionsState');
        if (newStatus === 'active') {
          const fullMatch = ensureArray(angles, 'AgentMonitor.director.anglesState').find(a => a.externalId === angleId);
          if (fullMatch && !safePrev.some(a => a.externalId === angleId)) return [...safePrev, { ...fullMatch, status: newStatus }];
          return safePrev.map(a => a.externalId === angleId ? { ...a, status: newStatus } : a);
        }
        return safePrev.filter(a => a.externalId !== angleId);
      });
    } catch { /* ignore */ }
  };

  const handleToggleFocus = async (angleId, focused) => {
    try {
      await api.updateConductorAngle(selectedProject, angleId, { focused });
      setAngles(prev => ensureArray(prev, 'AgentMonitor.director.anglesState').map(a => a.externalId === angleId ? { ...a, focused } : a));
    } catch { /* ignore */ }
  };

  const handleUpdateAngle = async (angleId, updates) => {
    await api.updateConductorAngle(selectedProject, angleId, updates);
    setAngles(prev => ensureArray(prev, 'AgentMonitor.director.anglesState').map(a => a.externalId === angleId ? { ...a, ...updates } : a));
    setAngleOptions(prev => ensureArray(prev, 'AgentMonitor.director.angleOptionsState').map(a => a.externalId === angleId ? { ...a, ...updates } : a));
  };

  const handleToggleLPEnabled = async (angleId, lpEnabled) => {
    try {
      await api.updateConductorAngle(selectedProject, angleId, { lp_enabled: lpEnabled });
      setAngles(prev => ensureArray(prev, 'AgentMonitor.director.anglesState').map(a => a.externalId === angleId ? { ...a, lp_enabled: lpEnabled } : a));
    } catch (err) {
      console.error('[AgentMonitor] Failed to toggle LP enabled:', err);
    }
  };

  const handleToggleAllLP = async (lpEnabled) => {
    const active = ensureArray(angles, 'AgentMonitor.director.anglesState').filter(a => a.status === 'active');
    // Optimistic update
    setAngles(prev => ensureArray(prev, 'AgentMonitor.director.anglesState').map(a => a.status === 'active' ? { ...a, lp_enabled: lpEnabled } : a));
    // Fire all API calls in parallel
    await Promise.allSettled(
      active.map(a => api.updateConductorAngle(selectedProject, a.externalId, { lp_enabled: lpEnabled }))
    );
  };

  // --- Export angles as markdown ---
  const handleDownloadAngles = () => {
    const allAngles = ensureArray(angles, 'AgentMonitor.director.anglesState');
    if (allAngles.length === 0) return;
    const grouped = { active: [], testing: [], archived: [] };
    allAngles.forEach(a => {
      const bucket = a.status === 'retired' ? grouped.archived : (grouped[a.status] || grouped.active);
      bucket.push(a);
    });

    let md = '# Angles\n\n';
    const writeSection = (list) => {
      list.forEach(a => {
        md += `## ${a.name}\n`;
        md += `- **Status**: ${a.status || 'active'}\n`;
        md += `- **Source**: ${a.source || 'manual'}\n`;
        md += `- **Focused**: ${a.focused ? 'yes' : 'no'}\n`;
        if (a.prompt_hints) md += `- **Prompt Hints**: ${a.prompt_hints}\n`;
        if (a.performance_note) md += `- **Performance Note**: ${a.performance_note}\n`;
        md += `\n${a.description || ''}\n\n---\n\n`;
      });
    };
    if (grouped.active.length) { md += '<!-- Active -->\n\n'; writeSection(grouped.active); }
    if (grouped.testing.length) { md += '<!-- Testing -->\n\n'; writeSection(grouped.testing); }
    if (grouped.archived.length) { md += '<!-- Archived -->\n\n'; writeSection(grouped.archived); }

    const blob = new Blob([md.trim() + '\n'], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'angles-export.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // --- Parse markdown into angle objects (supports both old flat + new structured formats) ---
  const SECTION_MAP = {
    'core buyer': 'core_buyer',
    'symptom pattern': 'symptom_pattern',
    'failed solutions': 'failed_solutions',
    'current belief': 'current_belief',
    'objection': 'objection',
    'emotional state': 'emotional_state',
    'scene to center the ad on': 'scene',
    'desired belief shift': 'desired_belief_shift',
    'tone': 'tone',
    'avoid': 'avoid_list',
  };

  const parseAnglesMarkdown = (text) => {
    // Split by --- separators (new format) or ## headings (old format)
    const hasStructuredSections = text.includes('### Core Buyer') || text.includes('### Symptom Pattern');

    if (hasStructuredSections) {
      // New structured format: split by --- separators
      const blocks = text.split(/\n---\n/).map(b => b.trim()).filter(Boolean);
      const parsed = [];
      for (const block of blocks) {
        const titleMatch = block.match(/^##\s+(.+)/m);
        if (!titleMatch) continue;
        const name = titleMatch[1].trim();
        // Skip meta sections
        if (name.startsWith('Removed from') || name === 'De-prioritized or Removed' ||
            name.startsWith('Notes for System') || name.startsWith('Best categories') ||
            name.startsWith('What should') || name.startsWith('Strong output') ||
            name.startsWith('Weak output')) continue;

        const angle = { name, source: 'imported', status: 'active' };

        // Extract metadata bullets
        const statusMatch = block.match(/\*\*Status\*\*:\s*(.+)/i);
        if (statusMatch) angle.status = statusMatch[1].trim().toLowerCase();
        const priorityMatch = block.match(/\*\*Priority\*\*:\s*(.+)/i);
        if (priorityMatch) angle.priority = priorityMatch[1].trim().toLowerCase();
        const frameMatch = block.match(/\*\*Frame\*\*:\s*(.+)/i);
        if (frameMatch) angle.frame = frameMatch[1].trim().toLowerCase();

        // Extract ### sections
        const sectionRegex = /###\s+(.+)\n([\s\S]*?)(?=###|\n---|\n##|$)/g;
        let match;
        while ((match = sectionRegex.exec(block)) !== null) {
          const sectionTitle = match[1].trim().toLowerCase();
          const sectionContent = match[2].trim();
          const fieldKey = SECTION_MAP[sectionTitle];
          if (fieldKey && sectionContent) angle[fieldKey] = sectionContent;
        }

        // Auto-compute description from structured fields
        const descParts = [];
        if (angle.core_buyer) descParts.push(`Core Buyer: ${angle.core_buyer}`);
        if (angle.symptom_pattern) descParts.push(`Symptom Pattern: ${angle.symptom_pattern}`);
        if (angle.objection) descParts.push(`Objection: ${angle.objection}`);
        if (angle.scene) descParts.push(`Scene: ${angle.scene}`);
        if (angle.desired_belief_shift) descParts.push(`Desired Belief Shift: ${angle.desired_belief_shift}`);
        angle.description = descParts.length > 0 ? descParts.join('\n') : 'No structured brief provided.';

        if (angle.name && (angle.core_buyer || angle.symptom_pattern)) parsed.push(angle);
      }
      return parsed;
    }

    // Old flat format fallback
    const sections = text.split(/\n## /).slice(1);
    const parsed = [];
    for (const section of sections) {
      const lines = section.split('\n');
      const name = lines[0].trim();
      if (!name) continue;

      let status = 'active', source = 'manual', focused = false, promptHints = '', performanceNote = '';
      const descLines = [];
      let pastMeta = false;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const metaMatch = line.match(/^- \*\*(.+?)\*\*:\s*(.+)/);
        if (metaMatch && !pastMeta) {
          const key = metaMatch[1].toLowerCase();
          const val = metaMatch[2].trim();
          if (key === 'status') status = val.toLowerCase();
          else if (key === 'source') source = val.toLowerCase();
          else if (key === 'focused') focused = val.toLowerCase() === 'yes';
          else if (key === 'prompt hints') promptHints = val;
          else if (key === 'performance note') performanceNote = val;
        } else {
          pastMeta = true;
          if (line.trim() !== '---') descLines.push(line);
        }
      }
      const description = descLines.join('\n').trim();
      if (!description) continue;

      parsed.push({ name, description, status, source, focused, prompt_hints: promptHints, performance_note: performanceNote });
    }
    return parsed;
  };

  // --- Handle file read for import ---
  const handleImportFile = (file) => {
    if (!file || !file.name.endsWith('.md')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const parsed = parseAnglesMarkdown(text);
      const existingNames = new Set(ensureArray(angles, 'AgentMonitor.director.anglesState').map(a => a.name.toLowerCase()));
      const newAngles = parsed.filter(a => !existingNames.has(a.name.toLowerCase()));
      const skipped = parsed.filter(a => existingNames.has(a.name.toLowerCase()));
      setImportResult({ newAngles, skipped });
    };
    reader.readAsText(file);
  };

  const handleConfirmImport = async () => {
    if (!importResult?.newAngles?.length) return;
    setImporting(true);
    try {
      for (const angle of importResult.newAngles) {
        await api.createConductorAngle(selectedProject, {
          name: angle.name,
          description: angle.description,
          prompt_hints: angle.prompt_hints || undefined,
          source: angle.source || 'imported',
          status: angle.status || 'active',
          priority: angle.priority || undefined,
          frame: angle.frame || undefined,
          core_buyer: angle.core_buyer || undefined,
          symptom_pattern: angle.symptom_pattern || undefined,
          failed_solutions: angle.failed_solutions || undefined,
          current_belief: angle.current_belief || undefined,
          objection: angle.objection || undefined,
          emotional_state: angle.emotional_state || undefined,
          scene: angle.scene || undefined,
          desired_belief_shift: angle.desired_belief_shift || undefined,
          tone: angle.tone || undefined,
          avoid_list: angle.avoid_list || undefined,
        });
      }
      const angRes = await api.getConductorAngles(selectedProject);
      setAngles(ensureArray(angRes?.angles, 'AgentMonitor.director.angles'));
      setAnglesLoadedFor(selectedProject);
      loadAngleOptions(selectedProject, { force: true });
      setImportResult(null);
      setShowImport(false);
    } catch { /* ignore */ }
    finally { setImporting(false); }
  };

  const safeProjects = ensureArray(projects, 'AgentMonitor.director.projectsState');
  const safeAngles = ensureArray(angles, 'AgentMonitor.director.anglesState');
  const safeAngleOptions = ensureArray(angleOptions, 'AgentMonitor.director.angleOptionsState');
  const safeRuns = ensureArray(runs, 'AgentMonitor.director.runsState');
  const safePlaybooks = ensureArray(playbooks, 'AgentMonitor.director.playbooksState');
  const safeCampaigns = ensureArray(campaigns, 'AgentMonitor.director.campaignsState');

  if (projectLoading) return <div className="text-[11px] text-textlight py-4">Loading projects...</div>;
  if (safeProjects.length === 0) return <div className="text-[11px] text-textlight py-4">No projects found.</div>;
  if (!selectedProject) return <div className="text-[11px] text-textlight py-4">Select a project to load Director settings.</div>;

  const subTabs = [
    { id: 'history', label: 'Run History' },
    { id: 'angles', label: 'Angles' },
    { id: 'playbooks', label: 'Playbooks' },
    { id: 'settings', label: 'Settings' },
  ];

  const activeAngles = subTab === 'angles' || anglesLoadedFor === selectedProject
    ? safeAngles.filter(a => a.status === 'active')
    : [];
  const testingAngles = subTab === 'angles' || anglesLoadedFor === selectedProject
    ? safeAngles.filter(a => a.status === 'testing')
    : [];
  const archivedAngles = subTab === 'angles' || anglesLoadedFor === selectedProject
    ? safeAngles.filter(a => a.status === 'archived' || a.status === 'retired')
    : [];
  const canChooseAngle = !angleOptionsLoading;
  const canTriggerTestRun = !baseLoading && !!config && (anglesLoadedFor !== selectedProject || activeAngles.length > 0);

  return (
    <div>
      {/* Project selector + controls */}
      <div className="flex items-center gap-3 mb-4">
        <select
          value={selectedProject}
          onChange={e => setSelectedProject(e.target.value)}
          className="text-[12px] text-textdark bg-offwhite border border-black/10 rounded-lg px-3 py-1.5 cursor-pointer"
        >
          {safeProjects.map(p => (
            <option key={p.id} value={p.id}>{p.displayName || p.brand_name || p.name}</option>
          ))}
        </select>

        <label className={`flex items-center gap-2 text-[11px] ${baseLoading || !config ? 'text-textlight cursor-not-allowed' : 'text-textmid cursor-pointer'}`}>
          <div
            onClick={() => {
              if (!config) return;
              handleSaveConfig({ enabled: !config.enabled });
            }}
            className={`relative w-7 h-4 rounded-full transition-colors duration-200 ${config ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'} ${config?.enabled ? 'bg-teal/30' : 'bg-black/10'}`}
          >
            <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all duration-200 shadow-sm ${config?.enabled ? 'left-3.5 bg-teal' : 'left-0.5 bg-textlight'}`} />
          </div>
          Enabled
        </label>

        <div className="flex items-center gap-2 ml-auto">
          <select
            value={selectedAngleId}
            onChange={e => setSelectedAngleId(e.target.value)}
            onFocus={() => {
              if (angleOptionsLoadedFor !== selectedProject) {
                loadAngleOptions(selectedProject);
              }
            }}
            disabled={!canChooseAngle}
            className="text-[11px] text-textdark bg-offwhite border border-black/10 rounded-lg px-2 py-1.5 cursor-pointer max-w-[140px]"
          >
            <option value="">
              {angleOptionsLoading ? 'Loading angles...' : angleOptionsLoadedFor === selectedProject ? 'Auto-select angle' : 'Loading angle options...'}
            </option>
            {safeAngleOptions.map(a => (
              <option key={a.externalId} value={a.externalId}>{a.name}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-[11px] text-textmid cursor-pointer select-none">
            <input type="checkbox" checked={generateLP} onChange={e => setGenerateLP(e.target.checked)} className="rounded border-black/20" />
            Generate LPs
          </label>
          <button
            onClick={handleTestRun}
            disabled={!canTriggerTestRun}
            className="btn-primary text-[11px] px-3 py-1.5 flex items-center gap-1 disabled:opacity-50"
          >
            {activeRun ? <><Spinner /> {queuedCount > 0 ? `Running (${queuedCount} queued)` : 'Running...'}</> : queuedCount > 0 ? `Queue Run (${queuedCount} queued)` : 'Test Run'}
          </button>
        </div>
      </div>

      {/* Test run progress bar + cancel */}
      {activeRun && (
        <div className="mb-4">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <PipelineProgress
                progress={activeRun.progress}
                message={activeRun.phase}
                startTime={activeRun.startTime}
              />
            </div>
            <button
              onClick={handleCancelRun}
              className="text-[10px] text-red-500 hover:text-red-700 font-medium px-2 py-0.5 rounded hover:bg-red-50 transition-colors shrink-0"
              title="Cancel running test"
            >
              Cancel
            </button>
          </div>
          {showActiveRunBreakdown && (
            <details key={activeRun.serverRunId || activeRun.id} className="mt-2 rounded-lg bg-black/[0.02] border border-black/5">
              <summary className="flex items-center justify-between gap-3 cursor-pointer list-none px-3 py-2 text-[11px] text-textmid">
                <span className="font-medium text-textdark">Current round details</span>
                <span>
                  {activeRunPassed === null || activeRunPassed === undefined
                    ? 'Show details'
                    : `${activeRunPassed}/${activeRunRequiredPasses} passed so far`}
                </span>
              </summary>
              <div className="px-3 pb-3 pt-1 border-t border-black/5 space-y-2">
                {activeRunRounds.length > 0 ? (
                  activeRunRounds.map((round, index) => (
                    <div key={round.batch_id || `${activeRun.id}-${index}`} className="rounded-lg bg-white/70 border border-black/5 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[11px] font-medium text-textdark">Round {round.round || index + 1}</p>
                        <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${getRoundStatusClasses(round)}`}>
                          {round.status === 'threshold_reached' ? 'threshold reached' : 'below threshold'}
                        </span>
                      </div>
                      <p className="text-[10px] text-textmid mt-1">
                        Batch {round.batch_id ? `${round.batch_id.slice(0, 8)}...` : '\u2013'}
                      </p>
                      <p className="text-[11px] text-textdark mt-1">
                        {round.ads_generated ?? round.ads_scored ?? 0} generated, {round.ads_passed ?? 0}/{round.ads_scored ?? round.ads_generated ?? 0} passed in this round, {round.cumulative_passed ?? 0}/{activeRunRequiredPasses} cumulative.
                      </p>
                      <RoundHeadlineDiagnostics round={round} />
                      {round.completed_at && (
                        <p className="text-[9px] text-textlight mt-1">{timeAgo(round.completed_at)}</p>
                      )}
                    </div>
                  ))
                ) : (
                  activeRunBatches.map((batch, index) => (
                    <div key={batch.batch_id || `${activeRun.id}-${index}`} className="rounded-lg bg-white/70 border border-black/5 px-3 py-2">
                      <p className="text-[11px] font-medium text-textdark">Batch {index + 1}</p>
                      <p className="text-[10px] text-textmid mt-1">
                        ID {batch.batch_id ? `${batch.batch_id.slice(0, 8)}...` : '\u2013'} · {batch.ad_count || '\u2013'} ads
                      </p>
                    </div>
                  ))
                )}
              </div>
            </details>
          )}
        </div>
      )}
      {queuedCount > 0 && (
        <div className="flex items-center gap-2 mb-4">
          <p className="text-[10px] text-textlight">
            {queuedCount} run{queuedCount !== 1 ? 's' : ''} queued{activeRun ? '' : ', waiting...'}
          </p>
          <button
            onClick={handleClearQueue}
            className="text-[10px] text-textlight hover:text-red-500 transition-colors"
          >
            Clear queue
          </button>
        </div>
      )}

      {/* Recent test run results */}
      {finishedRuns.length > 0 && (
        <div className="mb-4 space-y-2">
          {finishedRuns.map(run => (
            <div
              key={run.id}
              className={`flex items-start gap-2 px-3 py-2 rounded-lg text-[11px] ${
                run.status === 'complete' ? 'bg-teal/5 border border-teal/20' : 'bg-red-50 border border-red-200'
              }`}
            >
              <span className="mt-0.5 shrink-0">
                {run.status === 'complete' ? (
                  <svg className="w-3.5 h-3.5 text-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                ) : (
                  <svg className="w-3.5 h-3.5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                )}
              </span>
              <div className="flex-1 min-w-0">
                <p className={`font-medium ${run.status === 'complete' ? 'text-teal' : 'text-red-600'}`}>
                  {run.status === 'complete' ? 'Test Run Complete' : 'Test Run Failed'}
                </p>
                <p className="text-textmid mt-0.5">{run.phase}</p>
                {run.result?.flex_ads_created > 0 && (
                  <button
                    onClick={() => navigate(run.result?.flex_ad_id
                      ? `/projects/${selectedProject}?tab=tracker&view=ready_to_post&flexAdId=${run.result.flex_ad_id}`
                      : '/ads?tab=ready')}
                    className="text-[10px] text-gold hover:text-gold-light font-medium mt-1 inline-flex items-center gap-1"
                  >
                    View in Ready to Post {'\u2192'}
                  </button>
                )}
              </div>
              <button
                onClick={() => handleDismissResult(run.id)}
                className="text-textlight hover:text-textdark transition-colors shrink-0 mt-0.5"
                title="Dismiss"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Quick stats */}
      <div className="grid grid-cols-4 gap-2 mb-4">
        <StatCell value={config?.daily_flex_target ?? '—'} label="Daily Target" color="text-textdark" />
        <StatCell value={config?.ads_per_batch ?? '—'} label="Ads/Batch" color="text-textdark" />
        <StatCell value={anglesLoadedFor === selectedProject ? activeAngles.length : '—'} label="Angles" color="text-navy" />
        <StatCell value={runsLoadedFor === selectedProject ? safeRuns.filter(r => r.status === 'completed').length : '—'} label="Runs" color="text-teal" />
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 mb-4 border-b border-black/5">
        {subTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setSubTab(tab.id)}
            className={`text-[11px] font-medium py-2 px-3 border-b-2 transition-colors ${
              subTab === tab.id
                ? 'border-navy text-navy'
                : 'border-transparent text-textmid hover:text-textdark'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      {subTab === 'angles' && (
        <div>
          {anglesLoading && anglesLoadedFor !== selectedProject && (
            <div className="rounded-xl bg-black/[0.02] border border-black/5 px-3 py-3 mb-3">
              <p className="text-[11px] text-textmid">Loading angles and playbook notes...</p>
            </div>
          )}

          {/* Focus mode banner */}
          {activeAngles.some(a => a.focused) && (
            <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-gold/10 border border-gold/20">
              <svg className="w-3.5 h-3.5 text-gold flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
              <span className="text-[11px] text-gold/90 font-medium">Focus mode — Director will only use focused angles</span>
            </div>
          )}

          {/* Export / Import toolbar */}
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={handleDownloadAngles}
              disabled={safeAngles.length === 0}
              className="btn-secondary text-[11px] px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-40"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3" /></svg>
              Export
            </button>
            <button
              onClick={() => { setShowImport(!showImport); setImportResult(null); }}
              className={`btn-secondary text-[11px] px-3 py-1.5 flex items-center gap-1.5 ${showImport ? 'ring-1 ring-navy/30' : ''}`}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M17 8l-5-5m0 0L7 8m5-5v12" /></svg>
              Import
            </button>
          </div>

          {playbooksLoading && playbooksLoadedFor !== selectedProject && (
            <p className="text-[10px] text-textlight mb-3">Loading playbook notes...</p>
          )}

          {/* Import panel */}
          {showImport && (
            <div className="mb-4 rounded-xl bg-offwhite border border-black/10 p-4">
              {!importResult ? (
                <>
                  <p className="text-[12px] font-medium text-textdark mb-2">Import Angles from Markdown</p>
                  <p className="text-[10px] text-textmid mb-3">Upload a .md file with angles formatted as ## sections. Existing angles (matched by name) will be skipped.</p>
                  <div
                    onClick={() => importFileRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setImportDragOver(true); }}
                    onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setImportDragOver(true); }}
                    onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setImportDragOver(false); }}
                    onDrop={(e) => {
                      e.preventDefault(); e.stopPropagation(); setImportDragOver(false);
                      const file = e.dataTransfer?.files?.[0];
                      if (file) handleImportFile(file);
                    }}
                    className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-all ${
                      importDragOver ? 'border-gold bg-gold/5' : 'border-gray-300 hover:border-gold hover:bg-offwhite'
                    }`}
                  >
                    <div className="text-2xl text-gray-400 mb-2">{importDragOver ? '📂' : '📄'}</div>
                    <p className={`text-[12px] font-medium ${importDragOver ? 'text-gold' : 'text-textmid'}`}>
                      {importDragOver ? 'Drop file here' : 'Drop your .md file here, or click to browse'}
                    </p>
                    <p className="text-[10px] text-gray-400 mt-1">Markdown files only (.md)</p>
                  </div>
                  <input
                    ref={importFileRef}
                    type="file"
                    accept=".md"
                    onChange={(e) => { const file = e.target.files?.[0]; if (file) handleImportFile(file); e.target.value = ''; }}
                    className="hidden"
                  />
                </>
              ) : (
                <>
                  <p className="text-[12px] font-medium text-textdark mb-2">Import Preview</p>
                  {importResult.newAngles.length > 0 ? (
                    <div className="mb-3">
                      <p className="text-[11px] text-teal font-medium mb-1.5">{importResult.newAngles.length} new angle{importResult.newAngles.length !== 1 ? 's' : ''} to import:</p>
                      <div className="space-y-1 max-h-40 overflow-y-auto">
                        {importResult.newAngles.map((a, i) => (
                          <div key={i} className="text-[11px] text-textdark bg-teal/5 rounded px-2.5 py-1.5 border border-teal/10">
                            <span className="font-medium">{a.name}</span>
                            <span className="text-textmid ml-2">{a.description.slice(0, 80)}{a.description.length > 80 ? '...' : ''}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-[11px] text-textmid mb-3">No new angles found — all angles in the file already exist.</p>
                  )}
                  {importResult.skipped.length > 0 && (
                    <p className="text-[10px] text-textlight mb-3">{importResult.skipped.length} angle{importResult.skipped.length !== 1 ? 's' : ''} skipped (already exist)</p>
                  )}
                  <div className="flex gap-2">
                    {importResult.newAngles.length > 0 && (
                      <button onClick={handleConfirmImport} disabled={importing} className="btn-primary text-[11px] px-3 py-1.5 disabled:opacity-50">
                        {importing ? 'Importing...' : `Import ${importResult.newAngles.length} Angle${importResult.newAngles.length !== 1 ? 's' : ''}`}
                      </button>
                    )}
                    <button onClick={() => { setImportResult(null); setShowImport(false); }} className="btn-secondary text-[11px] px-3 py-1.5">Cancel</button>
                    {!importing && importResult.newAngles.length === 0 && (
                      <button onClick={() => setImportResult(null)} className="btn-secondary text-[11px] px-3 py-1.5">Try Another File</button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Active angles */}
          {activeAngles.length > 0 && (
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] text-textlight font-medium uppercase tracking-wider">Active</p>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-textmid">Generate landing pages for all angles</span>
                  <button
                    onClick={() => handleToggleAllLP(!activeAngles.every(a => a.lp_enabled))}
                    title={activeAngles.every(a => a.lp_enabled) ? 'Disable LPs for all angles' : 'Enable LPs for all angles'}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      activeAngles.every(a => a.lp_enabled) ? 'bg-teal' : 'bg-gray-200'
                    }`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                      activeAngles.every(a => a.lp_enabled) ? 'translate-x-[18px]' : 'translate-x-[3px]'
                    }`} />
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                {activeAngles.map(a => (
                  <AngleCard key={a.externalId} angle={a} playbooks={playbooks} onStatusChange={handleAngleStatusChange} onToggleFocus={handleToggleFocus} onToggleLPEnabled={handleToggleLPEnabled} onUpdate={handleUpdateAngle} />
                ))}
              </div>
            </div>
          )}

          {/* Testing angles */}
          {testingAngles.length > 0 && (
            <div className="mb-4">
              <p className="text-[10px] text-textlight font-medium uppercase tracking-wider mb-2">Testing (auto-generated)</p>
              <div className="space-y-2">
                {testingAngles.map(a => (
                  <AngleCard key={a.externalId} angle={a} playbooks={playbooks} onStatusChange={handleAngleStatusChange} onUpdate={handleUpdateAngle} showActions />
                ))}
              </div>
            </div>
          )}

          {/* Archived — collapsible */}
          {archivedAngles.length > 0 && (
            <div className="mb-4">
              <button
                onClick={() => setArchivedOpen(v => !v)}
                className="flex items-center gap-1.5 mb-2 group cursor-pointer"
              >
                <svg className={`w-3 h-3 text-textlight transition-transform ${archivedOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                <p className="text-[10px] text-textlight font-medium uppercase tracking-wider group-hover:text-textmid transition-colors">Archived ({archivedAngles.length})</p>
              </button>
              {archivedOpen && (
                <div className="space-y-2">
                  {archivedAngles.map(a => (
                    <AngleCard key={a.externalId} angle={a} playbooks={playbooks} onStatusChange={handleAngleStatusChange} onUpdate={handleUpdateAngle} />
                  ))}
                </div>
              )}
            </div>
          )}

          {!baseLoading && activeAngles.length === 0 && testingAngles.length === 0 && archivedAngles.length === 0 && (
            <div className="rounded-xl bg-black/[0.02] border border-black/5 px-3 py-3 mb-4">
              <p className="text-[11px] text-textmid">No angles yet. Add one to start using the Creative Director.</p>
            </div>
          )}

          {/* Add angle */}
          {showAddAngle ? (
            <div className="rounded-xl bg-offwhite border border-black/10 p-4 mt-2">
              <p className="text-[12px] font-medium text-textdark mb-3">New Angle (Creative Brief)</p>
              <input
                type="text"
                placeholder="Angle name (e.g., Broken Sleep / Wake Up at 2 to 4 AM)"
                value={newAngle.name}
                onChange={e => setNewAngle(prev => ({ ...prev, name: e.target.value }))}
                className="input-apple w-full mb-2 text-[12px]"
              />
              <div className="grid grid-cols-2 gap-2 mb-2">
                <select value={newAngle.priority} onChange={e => setNewAngle(prev => ({ ...prev, priority: e.target.value }))} className="input-apple text-[12px]">
                  <option value="highest">Priority: Highest</option>
                  <option value="high">Priority: High</option>
                  <option value="medium">Priority: Medium</option>
                  <option value="test">Priority: Test</option>
                </select>
                <select value={newAngle.frame} onChange={e => setNewAngle(prev => ({ ...prev, frame: e.target.value }))} className="input-apple text-[12px]">
                  <option value="symptom-first">Frame: Symptom-first</option>
                  <option value="scam">Frame: Scam</option>
                  <option value="objection-first">Frame: Objection-first</option>
                  <option value="identity-first">Frame: Identity-first</option>
                  <option value="MAHA">Frame: MAHA</option>
                  <option value="news-first">Frame: News-first</option>
                  <option value="consequence-first">Frame: Consequence-first</option>
                </select>
              </div>
              <textarea placeholder="Core Buyer — who is this ad for?" value={newAngle.core_buyer} onChange={e => setNewAngle(prev => ({ ...prev, core_buyer: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Symptom Pattern — what specific experience?" value={newAngle.symptom_pattern} onChange={e => setNewAngle(prev => ({ ...prev, symptom_pattern: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Failed Solutions — what have they already tried?" value={newAngle.failed_solutions} onChange={e => setNewAngle(prev => ({ ...prev, failed_solutions: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Current Belief — what do they believe now?" value={newAngle.current_belief} onChange={e => setNewAngle(prev => ({ ...prev, current_belief: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Objection — primary resistance to the product" value={newAngle.objection} onChange={e => setNewAngle(prev => ({ ...prev, objection: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Emotional State — how do they feel right now?" value={newAngle.emotional_state} onChange={e => setNewAngle(prev => ({ ...prev, emotional_state: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Scene — the specific moment the ad centers on" value={newAngle.scene} onChange={e => setNewAngle(prev => ({ ...prev, scene: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Desired Belief Shift — what should they believe after?" value={newAngle.desired_belief_shift} onChange={e => setNewAngle(prev => ({ ...prev, desired_belief_shift: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <div className="grid grid-cols-2 gap-2 mb-2">
                <input type="text" placeholder="Tone (e.g., Calm, specific, skeptical-friendly)" value={newAngle.tone} onChange={e => setNewAngle(prev => ({ ...prev, tone: e.target.value }))} className="input-apple text-[12px]" />
                <input type="text" placeholder="Avoid (e.g., Generic insomnia language, young models)" value={newAngle.avoid_list} onChange={e => setNewAngle(prev => ({ ...prev, avoid_list: e.target.value }))} className="input-apple text-[12px]" />
              </div>
              <textarea placeholder="Prompt hints — additional creative direction (optional)" value={newAngle.prompt_hints} onChange={e => setNewAngle(prev => ({ ...prev, prompt_hints: e.target.value }))} className="input-apple w-full mb-3 text-[12px] h-14 resize-none" />
              <div className="flex gap-2">
                <button onClick={handleAddAngle} className="btn-primary text-[11px] px-3 py-1.5">Save Angle</button>
                <button onClick={() => setShowAddAngle(false)} className="btn-secondary text-[11px] px-3 py-1.5">Cancel</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowAddAngle(true)}
              className="btn-secondary text-[11px] px-3 py-1.5 mt-1"
            >
              + Add Angle
            </button>
          )}
        </div>
      )}

      {subTab === 'playbooks' && (
        <div>
          {playbooksLoading && playbooksLoadedFor !== selectedProject ? (
            <p className="text-[11px] text-textlight py-4">Loading playbooks...</p>
          ) : safePlaybooks.length === 0 ? (
            <p className="text-[11px] text-textlight py-4">No playbooks yet. Playbooks are created automatically after the Creative Filter scores batches for each angle.</p>
          ) : (
            <div className="space-y-3">
              {safePlaybooks.map(pb => (
                <div key={pb.angle_name} className="rounded-xl bg-black/[0.02] border border-black/5 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[13px] font-medium text-textdark">{pb.angle_name}</p>
                    <span className="text-[10px] text-textmid">v{pb.version} {'\u2022'} {Math.round((pb.pass_rate || 0) * 100)}% pass rate</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <StatCell value={pb.total_scored || 0} label="Scored" color="text-textdark" />
                    <StatCell value={pb.total_passed || 0} label="Passed" color="text-teal" />
                  </div>
                  {pb.visual_patterns && (
                    <div className="mb-1.5">
                      <p className="text-[10px] text-textmid font-medium">Visual Patterns</p>
                      <p className="text-[11px] text-textdark leading-relaxed">{pb.visual_patterns}</p>
                    </div>
                  )}
                  {pb.copy_patterns && (
                    <div className="mb-1.5">
                      <p className="text-[10px] text-textmid font-medium">Copy Patterns</p>
                      <p className="text-[11px] text-textdark leading-relaxed">{pb.copy_patterns}</p>
                    </div>
                  )}
                  {pb.avoid_patterns && (
                    <div className="mb-1.5">
                      <p className="text-[10px] text-gold font-medium">Avoid</p>
                      <p className="text-[11px] text-textdark leading-relaxed">{pb.avoid_patterns}</p>
                    </div>
                  )}
                  {pb.generation_hints && (
                    <div>
                      <p className="text-[10px] text-teal font-medium">Generation Hints</p>
                      <p className="text-[11px] text-textdark leading-relaxed">{pb.generation_hints}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {subTab === 'settings' && !config && (
        <div className="rounded-xl bg-black/[0.02] border border-black/5 px-3 py-3">
          <p className="text-[11px] text-textmid">Loading Director settings...</p>
        </div>
      )}

      {subTab === 'settings' && config && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] text-textmid font-medium block mb-1">Daily Flex Ad Target</label>
              <input
                type="number"
                min="0"
                max="20"
                value={config.daily_flex_target ?? 5}
                onChange={e => handleSaveConfig({ daily_flex_target: parseInt(e.target.value) ?? 5 })}
                className="input-apple w-full text-[12px]"
              />
            </div>
            <div>
              <label className="text-[11px] text-textmid font-medium block mb-1">Ads Per Batch</label>
              <input
                type="number"
                min="6"
                max="30"
                value={config.ads_per_batch || 18}
                onChange={e => handleSaveConfig({ ads_per_batch: parseInt(e.target.value) || 18 })}
                className="input-apple w-full text-[12px]"
              />
              <p className="text-[9px] text-textlight mt-0.5">Auto-adjusts with learning</p>
            </div>
          </div>

          <div>
            <label className="text-[11px] text-textmid font-medium block mb-1">Angle Mode</label>
            <div className="flex gap-3">
              {['manual', 'auto', 'mixed'].map(mode => (
                <label key={mode} className="flex items-center gap-1.5 text-[11px] text-textdark cursor-pointer">
                  <input
                    type="radio"
                    name="angle_mode"
                    checked={config.angle_mode === mode}
                    onChange={() => handleSaveConfig({ angle_mode: mode })}
                    className="accent-navy"
                  />
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </label>
              ))}
            </div>
          </div>

          {config.angle_mode === 'mixed' && (
            <div>
              <label className="text-[11px] text-textmid font-medium block mb-1">Explore Ratio</label>
              <input
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={config.explore_ratio || 0.2}
                onChange={e => handleSaveConfig({ explore_ratio: parseFloat(e.target.value) || 0.2 })}
                className="input-apple w-24 text-[12px]"
              />
              <p className="text-[9px] text-textlight mt-0.5">Fraction of batches using auto-generated angles</p>
            </div>
          )}

          <div>
            <label className="text-[11px] text-textmid font-medium block mb-1">Rotation Strategy</label>
            <select
              value={config.angle_rotation || 'round_robin'}
              onChange={e => handleSaveConfig({ angle_rotation: e.target.value })}
              className="text-[12px] text-textdark bg-offwhite border border-black/10 rounded-lg px-3 py-1.5 cursor-pointer"
            >
              <option value="round_robin">Round Robin</option>
              <option value="weighted">Weighted (favor least-used)</option>
              <option value="random">Random (weighted)</option>
            </select>
          </div>

          <div>
            <label className="text-[11px] text-textmid font-medium block mb-1">Headline Style (optional)</label>
            <input
              type="text"
              placeholder="e.g., Short, punchy, curiosity-driven"
              value={config.headline_style || ''}
              onChange={e => handleSaveConfig({ headline_style: e.target.value })}
              className="input-apple w-full text-[12px]"
            />
          </div>

          <div>
            <label className="text-[11px] text-textmid font-medium block mb-1">Primary Text Style (optional)</label>
            <input
              type="text"
              placeholder="e.g., Story-based, emotional, 3 paragraphs"
              value={config.primary_text_style || ''}
              onChange={e => handleSaveConfig({ primary_text_style: e.target.value })}
              className="input-apple w-full text-[12px]"
            />
          </div>

          <div>
            <label className="text-[11px] text-textmid font-medium block mb-1">Default Campaign for Auto-Deployed Ads</label>
            {campaignsLoading && campaignsLoadedFor !== selectedProject ? (
              <p className="text-[11px] text-textlight">Loading campaigns...</p>
            ) : safeCampaigns.length > 0 ? (
              <select
                value={config.default_campaign_id || ''}
                onChange={e => handleSaveConfig({ default_campaign_id: e.target.value })}
                className="text-[12px] text-textdark bg-offwhite border border-black/10 rounded-lg px-3 py-1.5 cursor-pointer w-full"
              >
                <option value="">Select a campaign...</option>
                {safeCampaigns.map(c => (
                  <option key={c.externalId || c.id} value={c.externalId || c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-[11px] text-textlight">No campaigns found — create one in the project's Creative Filter settings or Ad Pipeline tab first.</p>
            )}
            <p className="text-[9px] text-textlight mt-0.5">Flex ads from the Director pipeline will auto-deploy to this campaign</p>
          </div>

          {saving && <p className="text-[10px] text-textlight">Saving...</p>}
        </div>
      )}

      {subTab === 'history' && (
        <div>
          {anglesLoadedFor !== selectedProject && (
            <div className="rounded-xl bg-black/[0.02] border border-black/5 px-3 py-3 mb-3">
              <p className="text-[11px] text-textmid">Angles stay hidden until you open the Angles tab so the Director loads faster.</p>
            </div>
          )}
          {runsLoading && runsLoadedFor !== selectedProject ? (
            <p className="text-[11px] text-textlight py-4">Loading run history...</p>
          ) : safeRuns.length === 0 ? (
            <p className="text-[11px] text-textlight py-4">No runs yet. Click "Test Run" to trigger the Director, or wait for the next scheduled run.</p>
          ) : (
            <div className="space-y-2">
              {safeRuns.map(run => {
                const rounds = getRunRounds(run);
                const batches = getRunBatches(run);
                const flexAdId = run.flex_ad_id || batches.find(batch => batch.flex_ad_id)?.flex_ad_id || null;
                const angleName = rounds[0]?.angle_name || batches[0]?.angle_name || 'Unassigned angle';
                const roundsUsed = run.total_rounds || rounds.length || batches.length || 1;
                const totalGenerated = run.total_ads_generated || batches.reduce((sum, batch) => sum + (Number(batch.ad_count) || 0), 0);
                const totalPassed = run.total_ads_passed ?? rounds[rounds.length - 1]?.cumulative_passed ?? null;
                const requiredPasses = run.required_passes || 10;
                const readyCount = run.ready_to_post_count ?? (flexAdId ? 10 : 0);
                const failureText = run.failure_reason || run.error || '';
                const isExpanded = !!expandedRuns[run.externalId];
                const runBatchIds = [
                  ...new Set(
                    [
                      ...rounds.map((round) => round.batch_id),
                      ...batches.map((batch) => batch.batch_id),
                    ].filter(Boolean)
                  ),
                ];
                const runStartMs = Number(run.run_at);
                const startedAt = formatDateTime(runStartMs);
                const finishedAt = run.duration_ms && Number.isFinite(runStartMs)
                  ? formatDateTime(runStartMs + run.duration_ms)
                  : null;
                const durationLabel = run.duration_ms ? formatDuration(run.duration_ms) : null;

                return (
                  <div
                    key={run.externalId}
                    className="rounded-lg bg-black/[0.02] border border-black/5 p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${getRunStatusClasses(run)}`}>
                            {getRunStatusLabel(run)}
                          </span>
                          <span className="text-[10px] text-textlight">{run.run_type}</span>
                          <span className="text-[10px] text-textmid truncate">{angleName}</span>
                        </div>
                        <p className="text-[11px] text-textdark leading-relaxed mt-1">
                          {run.decisions || `Run used ${roundsUsed} round${roundsUsed !== 1 ? 's' : ''}.`}
                        </p>
                        {!!failureText && (
                          <p className="text-[11px] text-red-500 leading-relaxed mt-1">{failureText}</p>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-[9px] uppercase tracking-wider text-textlight">Started</p>
                        <p className="text-[10px] text-textmid mt-0.5 whitespace-nowrap">{startedAt}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
                      <div className="rounded-lg bg-white/70 border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-textlight">Rounds</p>
                        <p className="text-[12px] font-semibold text-textdark mt-0.5">{roundsUsed}</p>
                      </div>
                      <div className="rounded-lg bg-white/70 border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-textlight">Generated</p>
                        <p className="text-[12px] font-semibold text-textdark mt-0.5">{totalGenerated || '\u2013'}</p>
                      </div>
                      <div className="rounded-lg bg-white/70 border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-textlight">Passed</p>
                        <p className="text-[12px] font-semibold text-textdark mt-0.5">
                          {totalPassed === null || totalPassed === undefined ? '\u2013' : `${totalPassed}/${requiredPasses}`}
                        </p>
                      </div>
                      <div className="rounded-lg bg-white/70 border border-black/5 px-2 py-2">
                        <p className="text-[9px] uppercase tracking-wider text-textlight">Ready</p>
                        <p className="text-[12px] font-semibold text-textdark mt-0.5">{readyCount}</p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 mt-3">
                      <div className="flex flex-wrap items-center gap-3 text-[9px] text-textlight">
                        {durationLabel ? (
                          <span>Duration {durationLabel}</span>
                        ) : (
                          <span>In progress</span>
                        )}
                        {finishedAt && (
                          <span>Finished {finishedAt}</span>
                        )}
                        {batches.length > 0 && (
                          <span>{batches.length} batch{batches.length !== 1 ? 'es' : ''}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {flexAdId && (
                          <button
                            onClick={() => navigate(`/projects/${selectedProject}?tab=tracker&view=ready_to_post&flexAdId=${flexAdId}`)}
                            className="text-[10px] text-gold hover:text-gold-light font-medium"
                          >
                            View in Ready to Post {'\u2192'}
                          </button>
                        )}
                        {(rounds.length > 0 || batches.length > 0) && (
                          <button
                            onClick={() => toggleRunExpanded(run.externalId, runBatchIds)}
                            className="text-[10px] text-textmid hover:text-navy font-medium"
                          >
                            {isExpanded ? 'Hide details' : 'Show details'}
                          </button>
                        )}
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="mt-3 pt-3 border-t border-black/5 space-y-2">
                        {rounds.length > 0 ? (
                          <div className="space-y-2">
                            {rounds.map((round, index) => (
                              <div key={round.batch_id || `${run.externalId}-${index}`} className="rounded-lg bg-white/70 border border-black/5 px-3 py-2">
                                <div className="flex items-center justify-between gap-3">
                                  <p className="text-[11px] font-medium text-textdark">Round {round.round || index + 1}</p>
                                  <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${getRoundStatusClasses(round)}`}>
                                    {round.status === 'threshold_reached' ? 'threshold reached' : 'below threshold'}
                                  </span>
                                </div>
                                <p className="text-[10px] text-textmid mt-1">
                                  Batch {round.batch_id ? `${round.batch_id.slice(0, 8)}...` : '\u2013'}
                                </p>
                                <p className="text-[11px] text-textdark mt-1">
                                  {round.ads_generated ?? round.ads_scored ?? 0} generated, {round.ads_passed ?? 0}/{round.ads_scored ?? round.ads_generated ?? 0} passed in this round, {round.cumulative_passed ?? 0}/{requiredPasses} cumulative.
                                </p>
                                <RoundHeadlineDiagnostics round={round} />
                                <RoundFailureSummary round={round} />
                                <RoundRepairSummary round={round} />
                                <RoundFailedAds round={round} />
                                <RoundLandingPageFunnel
                                  batchId={round.batch_id}
                                  lpDetailState={lpDetailsByBatchId[round.batch_id]}
                                  loading={!!lpDetailsLoadingByBatchId[round.batch_id]}
                                />
                                {round.completed_at && (
                                  <p className="text-[9px] text-textlight mt-1">{timeAgo(round.completed_at)}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : batches.length > 0 ? (
                          <div className="space-y-2">
                            {batches.map((batch, index) => (
                              <div key={batch.batch_id || `${run.externalId}-${index}`} className="rounded-lg bg-white/70 border border-black/5 px-3 py-2">
                                <p className="text-[11px] font-medium text-textdark">Batch {index + 1}</p>
                                <p className="text-[10px] text-textmid mt-1">
                                  ID {batch.batch_id ? `${batch.batch_id.slice(0, 8)}...` : '\u2013'} · {batch.ad_count || '\u2013'} ads
                                </p>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================
// Angle Card
// =============================================
const PRIORITY_OPTIONS = ['highest', 'high', 'medium', 'test'];
const FRAME_OPTIONS = ['symptom-first', 'scam', 'objection-first', 'identity-first', 'MAHA', 'news-first', 'consequence-first'];

function AngleCard({ angle, playbooks, onStatusChange, onToggleFocus, onToggleLPEnabled, onUpdate, showActions }) {
  const pb = ensureArray(playbooks, 'AgentMonitor.angleCard.playbooks').find(p => p.angle_name === angle.name);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const hasStructured = !!(angle.core_buyer || angle.symptom_pattern || angle.scene);

  const PRIORITY_COLORS = { highest: 'bg-red-100 text-red-700', high: 'bg-gold/15 text-gold', medium: 'bg-navy/10 text-navy', test: 'bg-gray-100 text-textmid' };
  const FRAME_COLORS = { 'symptom-first': 'bg-teal/10 text-teal', 'scam': 'bg-red-50 text-red-600', 'objection-first': 'bg-amber-50 text-amber-700', 'identity-first': 'bg-purple-50 text-purple-600', 'MAHA': 'bg-blue-50 text-blue-600', 'news-first': 'bg-indigo-50 text-indigo-600', 'consequence-first': 'bg-orange-50 text-orange-600' };

  const startEdit = (e) => {
    e.stopPropagation();
    setEditForm({
      name: angle.name || '', description: angle.description || '', prompt_hints: angle.prompt_hints || '',
      priority: angle.priority || 'medium', frame: angle.frame || 'symptom-first',
      core_buyer: angle.core_buyer || '', symptom_pattern: angle.symptom_pattern || '',
      failed_solutions: angle.failed_solutions || '', current_belief: angle.current_belief || '',
      objection: angle.objection || '', emotional_state: angle.emotional_state || '',
      scene: angle.scene || '', desired_belief_shift: angle.desired_belief_shift || '',
      tone: angle.tone || '', avoid_list: angle.avoid_list || '',
    });
    setEditing(true);
    setExpanded(true);
  };

  const handleSave = async () => {
    if (!editForm.name) return;
    setSaving(true);
    try {
      await onUpdate(angle.externalId, editForm);
      setEditing(false);
    } catch {} finally { setSaving(false); }
  };

  if (editing) {
    return (
      <div className={`rounded-lg border p-3 ${angle.focused ? 'bg-gold/5 border-gold/30' : 'bg-white/60 border-black/5'}`}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-medium text-textdark uppercase tracking-wider">Edit Angle</span>
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={saving} className="btn-primary text-[11px] px-3 py-1 disabled:opacity-50">{saving ? 'Saving...' : 'Save'}</button>
            <button onClick={() => setEditing(false)} className="btn-secondary text-[11px] px-3 py-1">Cancel</button>
          </div>
        </div>
        <input type="text" placeholder="Angle name" value={editForm.name} onChange={e => setEditForm(prev => ({ ...prev, name: e.target.value }))} className="input-apple w-full mb-2 text-[12px]" />
        <textarea placeholder="Description" value={editForm.description} onChange={e => setEditForm(prev => ({ ...prev, description: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-16 resize-none" />
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div>
            <label className="text-[10px] text-textmid font-medium block mb-0.5">Priority</label>
            <select value={editForm.priority} onChange={e => setEditForm(prev => ({ ...prev, priority: e.target.value }))} className="text-[12px] text-textdark bg-offwhite border border-black/10 rounded-lg px-2 py-1.5 w-full cursor-pointer">
              {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-textmid font-medium block mb-0.5">Frame</label>
            <select value={editForm.frame} onChange={e => setEditForm(prev => ({ ...prev, frame: e.target.value }))} className="text-[12px] text-textdark bg-offwhite border border-black/10 rounded-lg px-2 py-1.5 w-full cursor-pointer">
              {FRAME_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </div>
        <textarea placeholder="Core Buyer" value={editForm.core_buyer} onChange={e => setEditForm(prev => ({ ...prev, core_buyer: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
        <textarea placeholder="Symptom Pattern" value={editForm.symptom_pattern} onChange={e => setEditForm(prev => ({ ...prev, symptom_pattern: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
        <textarea placeholder="Failed Solutions" value={editForm.failed_solutions} onChange={e => setEditForm(prev => ({ ...prev, failed_solutions: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
        <textarea placeholder="Current Belief" value={editForm.current_belief} onChange={e => setEditForm(prev => ({ ...prev, current_belief: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
        <textarea placeholder="Objection" value={editForm.objection} onChange={e => setEditForm(prev => ({ ...prev, objection: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
        <textarea placeholder="Emotional State" value={editForm.emotional_state} onChange={e => setEditForm(prev => ({ ...prev, emotional_state: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
        <textarea placeholder="Scene" value={editForm.scene} onChange={e => setEditForm(prev => ({ ...prev, scene: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
        <textarea placeholder="Desired Belief Shift" value={editForm.desired_belief_shift} onChange={e => setEditForm(prev => ({ ...prev, desired_belief_shift: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
        <div className="grid grid-cols-2 gap-2 mb-2">
          <input type="text" placeholder="Tone" value={editForm.tone} onChange={e => setEditForm(prev => ({ ...prev, tone: e.target.value }))} className="input-apple text-[12px]" />
          <input type="text" placeholder="Avoid" value={editForm.avoid_list} onChange={e => setEditForm(prev => ({ ...prev, avoid_list: e.target.value }))} className="input-apple text-[12px]" />
        </div>
        <textarea placeholder="Prompt hints (optional)" value={editForm.prompt_hints} onChange={e => setEditForm(prev => ({ ...prev, prompt_hints: e.target.value }))} className="input-apple w-full text-[12px] h-14 resize-none" />
      </div>
    );
  }

  return (
    <div className={`rounded-lg border ${angle.focused ? 'bg-gold/5 border-gold/30' : 'bg-white/60 border-black/5'}`}>
      {/* Clickable header row */}
      <div
        className="flex items-center justify-between p-3 cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          {angle.status === 'active' && onToggleFocus && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleFocus(angle.externalId, !angle.focused); }}
              title={angle.focused ? 'Remove focus' : 'Focus on this angle'}
              className={`transition-colors flex-shrink-0 ${angle.focused ? 'text-gold' : 'text-textlight/40 hover:text-gold/60'}`}
            >
              <svg className="w-3.5 h-3.5" fill={angle.focused ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
            </button>
          )}
          {!(angle.status === 'active' && onToggleFocus) && (
            <span className="text-[11px] flex-shrink-0">{'\u25CF'}</span>
          )}
          <span className={`text-[11px] text-textlight flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}>&#9656;</span>
          <span className="text-[13px] font-medium text-textdark">{angle.name}</span>
          {angle.focused && <span className="text-[9px] font-medium text-gold uppercase tracking-wider">Focused</span>}
          {angle.priority && <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${PRIORITY_COLORS[angle.priority] || 'bg-gray-100 text-gray-600'}`}>{angle.priority}</span>}
          {angle.frame && <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${FRAME_COLORS[angle.frame] || 'bg-gray-100 text-gray-600'}`}>{angle.frame}</span>}
          <span className="text-[10px] text-textlight">used {angle.times_used || 0}x</span>
          {pb && (
            <span className="text-[10px] text-textmid">
              pass: {Math.round((pb.pass_rate || 0) * 100)}%
              {pb.pass_rate > 0.6 ? ' \u2191' : pb.pass_rate < 0.4 ? ' \u2193' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          {onUpdate && (
            <button onClick={startEdit} className="text-[10px] text-textlight hover:text-navy" title="Edit angle">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" /></svg>
            </button>
          )}
          {showActions && (
            <div className="flex gap-1">
              <button onClick={() => onStatusChange(angle.externalId, 'active')} className="text-[10px] text-teal hover:underline">Activate</button>
              <button onClick={() => onStatusChange(angle.externalId, 'archived')} className="text-[10px] text-red-400 hover:underline ml-2">Archive</button>
            </div>
          )}
          {!showActions && angle.status === 'active' && (
            <button onClick={() => onStatusChange(angle.externalId, 'archived')} className="text-[10px] text-textlight hover:text-red-400">Archive</button>
          )}
          {!showActions && (angle.status === 'archived' || angle.status === 'retired') && (
            <button onClick={() => onStatusChange(angle.externalId, 'active')} className="text-[10px] text-teal hover:underline">Unarchive</button>
          )}
        </div>
      </div>

      {/* Expanded: show full structured brief */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-black/5 space-y-2 text-[12px]">
          {angle.description && <div><span className="font-semibold text-textdark">Description:</span> <span className="text-textmid">{angle.description}</span></div>}
          {angle.core_buyer && <div><span className="font-semibold text-textdark">Core Buyer:</span> <span className="text-textmid">{angle.core_buyer}</span></div>}
          {angle.symptom_pattern && <div><span className="font-semibold text-textdark">Symptom Pattern:</span> <span className="text-textmid">{angle.symptom_pattern}</span></div>}
          {angle.failed_solutions && <div><span className="font-semibold text-textdark">Failed Solutions:</span> <span className="text-textmid">{angle.failed_solutions}</span></div>}
          {angle.current_belief && <div><span className="font-semibold text-textdark">Current Belief:</span> <span className="text-textmid">{angle.current_belief}</span></div>}
          {angle.objection && <div><span className="font-semibold text-textdark">Objection:</span> <span className="text-textmid">{angle.objection}</span></div>}
          {angle.emotional_state && <div><span className="font-semibold text-textdark">Emotional State:</span> <span className="text-textmid">{angle.emotional_state}</span></div>}
          {angle.scene && <div><span className="font-semibold text-textdark">Scene:</span> <span className="text-textmid italic">{angle.scene}</span></div>}
          {angle.desired_belief_shift && <div><span className="font-semibold text-textdark">Belief Shift:</span> <span className="text-textmid italic">"{angle.desired_belief_shift}"</span></div>}
          {angle.tone && <div><span className="font-semibold text-textdark">Tone:</span> <span className="text-textmid">{angle.tone}</span></div>}
          {angle.avoid_list && <div><span className="font-semibold text-textdark">Avoid:</span> <span className="text-red-500">{angle.avoid_list}</span></div>}
          {angle.prompt_hints && <div><span className="font-semibold text-textdark">Prompt Hints:</span> <span className="text-textmid">{angle.prompt_hints}</span></div>}
        </div>
      )}

      {pb && pb.generation_hints && (
        <p className="text-[10px] text-teal mt-1 leading-relaxed px-3">
          Playbook v{pb.version}: "{pb.generation_hints.slice(0, 120)}{pb.generation_hints.length > 120 ? '...' : ''}"
        </p>
      )}
      {onToggleLPEnabled && angle.status === 'active' && (
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-black/5">
          <span className="text-[10px] text-textmid">Generate landing pages</span>
          <button
            onClick={() => onToggleLPEnabled(angle.externalId, !angle.lp_enabled)}
            title={angle.lp_enabled ? 'Disable LP generation for this angle' : 'Enable LP generation for this angle'}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              angle.lp_enabled ? 'bg-teal' : 'bg-gray-200'
            }`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
              angle.lp_enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
            }`} />
          </button>
        </div>
      )}
    </div>
  );
}

// =============================================
// Agent Panel Wrapper
// =============================================
function AgentPanel({ children, icon, name, subtitle, status, paused, onTogglePause, togglingPause }) {
  const statusCfg = STATUS_CONFIG[status] || STATUS_CONFIG.offline;

  return (
    <div>
      {/* Agent header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-md bg-navy/10 flex items-center justify-center flex-shrink-0">
            {icon}
          </div>
          <div>
            <p className="text-[13px] font-semibold text-textdark tracking-tight leading-tight">{name}</p>
            <p className="text-[10px] text-textlight">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onTogglePause}
            disabled={togglingPause}
            className="group flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            title={paused ? 'Resume agent' : 'Pause agent'}
          >
            <div className={`relative w-7 h-4 rounded-full transition-colors duration-200 ${paused ? 'bg-black/10' : 'bg-teal/30'}`}>
              <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all duration-200 shadow-sm ${paused ? 'left-0.5 bg-textlight' : 'left-3.5 bg-teal'}`} />
            </div>
          </button>
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${statusCfg.dot} ${statusCfg.pulse ? 'animate-pulse' : ''}`} />
            <span className={`text-[10px] font-medium ${statusCfg.color}`}>{statusCfg.label}</span>
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

// =============================================
// Fixer Panel (Agent #1)
// =============================================
function FixerPanel({ data, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [runningAction, setRunningAction] = useState(null);
  const [togglingPause, setTogglingPause] = useState(false);
  const [fixerPlaybooks, setFixerPlaybooks] = useState([]);
  const [healthRecords, setHealthRecords] = useState([]);

  useEffect(() => {
    (async () => {
      const [pbRes, healthRes] = await Promise.allSettled([
        api.getFixerPlaybooks(),
        api.getConductorHealth(10),
      ]);
      if (pbRes.status === 'fulfilled') setFixerPlaybooks(pbRes.value?.playbooks || []);
      if (healthRes.status === 'fulfilled') setHealthRecords(healthRes.value?.health || []);
    })();
  }, []);

  const handleRun = async () => {
    setRunningAction('run');
    try {
      await api.runAgentFixer();
      setTimeout(onRefresh, 3000);
    } catch { /* ignore */ }
    finally { setRunningAction(null); }
  };

  const handleResurrect = async () => {
    setRunningAction('resurrect');
    try {
      await api.runAgentResurrect();
      setTimeout(onRefresh, 3000);
    } catch { /* ignore */ }
    finally { setRunningAction(null); }
  };

  const handleTogglePause = async () => {
    setTogglingPause(true);
    try {
      await api.toggleFixerPause();
      await onRefresh();
    } catch { /* ignore */ }
    finally { setTogglingPause(false); }
  };

  const budgetPct = data.budget.daily_budget_cents > 0
    ? (data.budget.spent_cents / data.budget.daily_budget_cents) * 100
    : 0;
  const budgetBarColor = budgetPct < 50 ? 'bg-teal' : budgetPct < 80 ? 'bg-gold' : 'bg-red-400';

  return (
    <AgentPanel
      name="Dacia Fixer"
      subtitle="Runs every 5 min — tests code, auto-fixes, resurrects stuck batches, monitors agent team"
      status={data.status}
      paused={data.paused}
      onTogglePause={handleTogglePause}
      togglingPause={togglingPause}
      icon={
        <svg className="w-3 h-3 text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      }
    >
      <BudgetBar spent={data.budget.spent_cents} total={data.budget.daily_budget_cents} pct={budgetPct} barColor={budgetBarColor} />

      <div className="grid grid-cols-4 gap-2 mb-3">
        <StatCell value={data.stats.runs} label="Runs" color="text-textdark" />
        <StatCell value={data.stats.fixes} label="Fixes" color="text-teal" />
        <StatCell value={data.stats.failures} label="Fails" color={data.stats.failures > 0 ? 'text-red-400' : 'text-textdark'} />
        <StatCell value={data.stats.resurrections} label="Resurrects" color="text-navy-light" />
      </div>

      <p className="text-[10px] text-textmid mb-2.5">
        Last: <span className="font-medium text-textdark">{timeAgo(data.lastRun)}</span>
        {data.paused ? (
          <span className="text-textlight ml-1">{'\u00B7'} Paused</span>
        ) : data.nextRun ? (
          <>{' \u00B7 '} Next: <span className="font-medium text-textdark">{timeUntil(data.nextRun)}</span></>
        ) : null}
      </p>

      <div className="flex gap-2 mb-3">
        <button
          onClick={handleRun}
          disabled={!!runningAction}
          className="btn-primary text-[11px] px-2.5 py-1 flex items-center gap-1 disabled:opacity-50"
        >
          {runningAction === 'run' ? <><Spinner /> Running...</> : <>{'\u25B6'} Run Now</>}
        </button>
        <button
          onClick={handleResurrect}
          disabled={!!runningAction}
          className="btn-secondary text-[11px] px-2.5 py-1 flex items-center gap-1 disabled:opacity-50"
        >
          {runningAction === 'resurrect' ? <><Spinner /> Checking...</> : <>{'\u21BB'} Resurrect</>}
        </button>
      </div>

      {/* Health checks (from Fixer's agent monitoring) */}
      {healthRecords.length > 0 && (
        <div className="border-t border-black/5 pt-2.5 mb-2.5">
          <p className="text-[11px] font-medium text-textmid mb-1.5">Health Checks</p>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {healthRecords.slice(0, 5).map((hc, i) => (
              <div key={i} className="flex items-start gap-1.5 py-0.5 px-1 text-[10px]">
                <span className={hc.status === 'ok' ? 'text-teal' : 'text-gold'}>{hc.status === 'ok' ? '\u2713' : '\u26A0'}</span>
                <span className="text-textmid">{hc.details || 'Health check'}</span>
                <span className="text-textlight ml-auto">{timeAgo(new Date(hc.check_at).toISOString())}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fixer playbook */}
      {fixerPlaybooks.length > 0 && (
        <div className="border-t border-black/5 pt-2.5 mb-2.5">
          <p className="text-[11px] font-medium text-textmid mb-1.5">Fixer Playbook (learned patterns)</p>
          <div className="space-y-1">
            {fixerPlaybooks.map((pb, i) => (
              <div key={i} className="text-[10px] px-2 py-1.5 rounded-lg bg-white/60">
                <span className="font-medium text-textdark">{pb.issue_category}</span>
                <span className="text-textlight ml-1">{'\u2014'} {pb.occurrences} occurrences, {pb.auto_resolved} auto-resolved</span>
                {pb.occurrences >= 10 && <span className="text-teal ml-1 font-medium">PREVENTIVE</span>}
                {pb.resolution_steps && (
                  <p className="text-textmid mt-0.5">"{pb.resolution_steps.slice(0, 100)}"</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <ActivityLog activity={data.activity} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
    </AgentPanel>
  );
}

// =============================================
// Creative Filter Panel (Agent #2)
// =============================================
function FilterPanel({ data, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [runningAction, setRunningAction] = useState(null);
  const [togglingPause, setTogglingPause] = useState(false);
  const [volumes, setVolumes] = useState(null);
  const [loadingVolumes, setLoadingVolumes] = useState(false);
  const [savingVolume, setSavingVolume] = useState(null);

  const loadVolumes = useCallback(async () => {
    setLoadingVolumes(true);
    try {
      const res = await api.getFilterVolumes();
      setVolumes(ensureArray(res?.projects, 'AgentMonitor.filter.volumes'));
    } catch { /* ignore */ }
    finally { setLoadingVolumes(false); }
  }, []);

  useEffect(() => { loadVolumes(); }, [loadVolumes]);

  const handleVolumeChange = async (projectId, newValue) => {
    setSavingVolume(projectId);
    try {
      await api.updateFilterVolume(projectId, newValue);
      setVolumes(prev => ensureArray(prev, 'AgentMonitor.filter.volumesState').map(p =>
        p.id === projectId ? { ...p, scout_daily_flex_ads: newValue } : p
      ));
    } catch { /* ignore */ }
    finally { setSavingVolume(null); }
  };

  const handleDryRun = async () => {
    setRunningAction('dry');
    try {
      await api.runFilterDryRun();
      setTimeout(onRefresh, 3000);
    } catch { /* ignore */ }
    finally { setRunningAction(null); }
  };

  const handleRunLive = async () => {
    setRunningAction('live');
    try {
      await api.runFilterLive();
      setTimeout(onRefresh, 5000);
    } catch { /* ignore */ }
    finally { setRunningAction(null); }
  };

  const handleTogglePause = async () => {
    setTogglingPause(true);
    try {
      await api.toggleFilterPause();
      await onRefresh();
    } catch { /* ignore */ }
    finally { setTogglingPause(false); }
  };

  const budgetPct = data.budget.daily_budget_cents > 0
    ? (data.budget.spent_cents / data.budget.daily_budget_cents) * 100
    : 0;
  const budgetBarColor = budgetPct < 50 ? 'bg-teal' : budgetPct < 80 ? 'bg-gold' : 'bg-red-400';

  return (
    <AgentPanel
      name="Dacia Creative Filter"
      subtitle="Runs every 30 min — scores batch ads, groups winners into flex ads, deploys to Ready to Post"
      status={data.status}
      paused={data.paused}
      onTogglePause={handleTogglePause}
      togglingPause={togglingPause}
      icon={
        <svg className="w-3 h-3 text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
        </svg>
      }
    >
      <BudgetBar spent={data.budget.spent_cents} total={data.budget.daily_budget_cents} pct={budgetPct} barColor={budgetBarColor} />

      <div className="grid grid-cols-5 gap-2 mb-3">
        <StatCell value={data.stats.batches} label="Batches" color="text-textdark" />
        <StatCell value={data.stats.scored} label="Scored" color="text-textdark" />
        <StatCell value={data.stats.passed} label="Passed" color="text-teal" />
        <StatCell value={data.stats.failed} label="Failed" color={data.stats.failed > 0 ? 'text-red-400' : 'text-textdark'} />
        <StatCell value={data.stats.flexAds} label="Flex Ads" color="text-navy-light" />
      </div>

      <p className="text-[10px] text-textmid mb-2.5">
        Last: <span className="font-medium text-textdark">{timeAgo(data.lastRun)}</span>
        {data.paused ? (
          <span className="text-textlight ml-1">{'\u00B7'} Paused</span>
        ) : data.nextRun ? (
          <>{' \u00B7 '} Next: <span className="font-medium text-textdark">{timeUntil(data.nextRun)}</span></>
        ) : null}
      </p>

      <div className="flex gap-2 mb-3">
        <button
          onClick={handleRunLive}
          disabled={!!runningAction}
          className="btn-primary text-[11px] px-2.5 py-1 flex items-center gap-1 disabled:opacity-50"
        >
          {runningAction === 'live' ? <><Spinner /> Running...</> : <>{'\u25B6'} Run Now</>}
        </button>
        <button
          onClick={handleDryRun}
          disabled={!!runningAction}
          className="btn-secondary text-[11px] px-2.5 py-1 flex items-center gap-1 disabled:opacity-50"
        >
          {runningAction === 'dry' ? <><Spinner /> Running...</> : <>{'\u2699'} Dry Run</>}
        </button>
      </div>

      {/* Per-Brand Daily Volume Controls */}
      <div className="border-t border-black/5 pt-2.5 mb-2.5">
        <p className="text-[11px] font-medium text-textmid mb-1.5">Daily Flex Ad Volume</p>
        <p className="text-[9px] text-textlight mb-2">
          Flex ads created per day per brand. Each flex ad = 10 images.
        </p>
        {loadingVolumes ? (
          <div className="text-[10px] text-textlight py-2">Loading projects...</div>
        ) : ensureArray(volumes, 'AgentMonitor.filter.volumesState').length > 0 ? (
          <div className="space-y-1">
            {ensureArray(volumes, 'AgentMonitor.filter.volumesState').filter(p => p.scout_enabled !== false).map(project => (
              <div key={project.id} className="flex items-center justify-between gap-2 py-1.5 px-2.5 rounded-lg bg-white/60">
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-medium text-textdark truncate">
                    {project.brand_name || project.name}
                  </p>
                  <p className="text-[9px] text-textlight">
                    Today: {project.today_flex_ads}/{project.scout_daily_flex_ads} flex ads ({project.today_flex_ads * 10}/{project.scout_daily_flex_ads * 10} images)
                  </p>
                </div>
                <select
                  value={project.scout_daily_flex_ads}
                  onChange={e => handleVolumeChange(project.id, parseInt(e.target.value))}
                  disabled={savingVolume === project.id}
                  className="text-[11px] text-textdark bg-offwhite border border-black/10 rounded-lg px-2 py-1 w-14 cursor-pointer"
                >
                  {[1, 2, 3, 4, 5, 6, 8, 10].map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[10px] text-textlight py-1.5">No projects configured.</p>
        )}
      </div>

      <ActivityLog activity={data.activity} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
    </AgentPanel>
  );
}

// =============================================
// Shared sub-components
// =============================================

function BudgetBar({ spent, total, pct, barColor }) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-textmid font-medium">Budget</span>
        <span className="text-[10px] text-textmid tabular-nums">
          {spent}{'\u00A2'} / {total}{'\u00A2'}
          <span className="text-textlight ml-1">
            (${(spent / 100).toFixed(2)} / ${(total / 100).toFixed(2)})
          </span>
        </span>
      </div>
      <div className="h-1 rounded-full bg-black/5 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}

function ActivityLog({ activity, expanded, onToggle }) {
  return (
    <div className="border-t border-black/5 pt-2.5">
      <button
        onClick={onToggle}
        className="flex items-center justify-between w-full group"
      >
        <span className="text-[11px] font-medium text-textmid">Recent Activity</span>
        <svg
          className={`w-3 h-3 text-textlight transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-1.5 max-h-44 overflow-y-auto scrollbar-thin">
          {activity && activity.length > 0 ? (
            <div className="space-y-0">
              {activity.map((entry, i) => {
                const cfg = LEVEL_CONFIG[entry.level] || LEVEL_CONFIG.INFO;
                return (
                  <div key={i} className="flex items-start gap-1.5 py-0.5 px-1 rounded hover:bg-black/[0.02]">
                    <span className="text-[9px] text-textlight font-mono flex-shrink-0 mt-px w-8">
                      {entry.time.slice(0, 5)}
                    </span>
                    <span className={`text-[10px] flex-shrink-0 w-3 text-center ${cfg.color}`}>
                      {cfg.icon}
                    </span>
                    <span className={`text-[10px] ${cfg.color} leading-tight`}>
                      {entry.message}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[10px] text-textlight py-1.5">No activity recorded today.</p>
          )}
        </div>
      )}
    </div>
  );
}

function StatCell({ value, label, color }) {
  return (
    <div className="text-center py-1.5 px-1 rounded-lg bg-white/60">
      <p className={`text-base font-semibold ${color} tabular-nums leading-tight`}>{value}</p>
      <p className="text-[9px] text-textlight uppercase tracking-wider mt-0.5">{label}</p>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
