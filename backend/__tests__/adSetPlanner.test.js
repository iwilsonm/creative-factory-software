import { describe, expect, it, vi } from 'vitest';
import {
  buildManualAdSetCreateInput,
  compactConvexWrite,
  getManualCombineErrorResponse,
  isMissingAtomicAdSetFunctionError,
  normalizeDeploymentIds,
  rollbackManualAdSetCombine,
  snapshotDeploymentAssignments,
} from '../services/adSetPlanner.js';

describe('manual ad set planning helpers', () => {
  it('builds a draft ad set payload without requiring angle_id', () => {
    const payload = buildManualAdSetCreateInput({
      adSetId: 'adset-1',
      projectId: 'project-1',
      campaignId: 'campaign-1',
      name: 'Manual Test',
      defaults: {
        meta_targeting: null,
        meta_budget_type: null,
        meta_budget_amount_cents: null,
        meta_schedule: null,
        meta_optimization_goal: null,
        meta_billing_event: null,
      },
    });

    expect(payload).toMatchObject({
      id: 'adset-1',
      project_id: 'project-1',
      campaign_id: 'campaign-1',
      name: 'Manual Test',
      sort_order: 0,
      lifecycle_status: 'draft',
    });
    expect(payload.angle_id).toBeUndefined();
    expect(payload.meta_targeting).toBeUndefined();
    expect(payload.meta_budget_type).toBeUndefined();
    expect(payload.meta_budget_amount_cents).toBeUndefined();
    expect(payload.meta_schedule).toBeUndefined();
    expect(payload.meta_optimization_goal).toBeUndefined();
    expect(payload.meta_billing_event).toBeUndefined();
  });

  it('preserves an explicit angle_id when one is provided', () => {
    const payload = buildManualAdSetCreateInput({
      adSetId: 'adset-1',
      projectId: 'project-1',
      campaignId: 'campaign-1',
      name: 'Director Test',
      angleId: ' angle-1 ',
    });

    expect(payload.angle_id).toBe('angle-1');
  });

  it('preserves valid Meta defaults while removing only nullish values', () => {
    const payload = buildManualAdSetCreateInput({
      adSetId: 'adset-1',
      projectId: 'project-1',
      campaignId: 'campaign-1',
      name: 'Manual Test',
      defaults: {
        meta_budget_type: 'daily',
        meta_budget_amount_cents: 5000,
        meta_billing_event: 'IMPRESSIONS',
        meta_optimization_goal: undefined,
      },
    });

    expect(payload.meta_budget_type).toBe('daily');
    expect(payload.meta_budget_amount_cents).toBe(5000);
    expect(payload.meta_billing_event).toBe('IMPRESSIONS');
    expect(payload.meta_optimization_goal).toBeUndefined();
  });

  it('compacts Convex write payloads without dropping falsey valid values', () => {
    expect(compactConvexWrite({
      empty: '',
      zero: 0,
      falseValue: false,
      nullValue: null,
      undefinedValue: undefined,
    })).toEqual({
      empty: '',
      zero: 0,
      falseValue: false,
    });
  });

  it('normalizes deployment ids and rejects duplicates before calling Convex', () => {
    expect(normalizeDeploymentIds([' dep-1 ', 'dep-2'])).toEqual({
      ids: ['dep-1', 'dep-2'],
      error: null,
    });

    expect(normalizeDeploymentIds(['dep-1', ' dep-1 ']).error)
      .toContain('duplicate ids: dep-1');
    expect(normalizeDeploymentIds(['dep-1', '']).error)
      .toContain('invalid values at index 1');
    expect(normalizeDeploymentIds([]).error)
      .toBe('deployment_ids must be a non-empty array');
  });

  it('maps missing Convex atomic combine functions to an operator action', () => {
    const err = new Error("[Request ID: abc] Server Error Could not find public function for 'adSets:createFromDeployments'. Did you forget to run `npx convex dev`?");

    expect(isMissingAtomicAdSetFunctionError(err)).toBe(true);
    expect(getManualCombineErrorResponse(err, { convexHost: 'elated-mastiff-709.convex.cloud' })).toEqual({
      status: 503,
      message: 'Ad set creation is temporarily unavailable because the configured Convex deployment (elated-mastiff-709.convex.cloud) is missing the atomic ad-set combine function. Please deploy Convex functions to the same deployment this site is using, then try again.',
    });
  });

  it('maps invalid deployment validation errors to clear 400 responses', () => {
    expect(getManualCombineErrorResponse(new Error('INVALID_DEPLOYMENTS: unknown: dep-1'))).toEqual({
      status: 400,
      message: 'Invalid deployment_ids: unknown: dep-1',
    });
  });

  it('snapshots original deployment assignments and reports unknown ids', () => {
    const result = snapshotDeploymentAssignments(['dep-1', 'dep-2'], [
      { externalId: 'dep-1', local_adset_id: 'old-adset', local_campaign_id: 'old-campaign' },
    ]);

    expect(result.missingIds).toEqual(['dep-2']);
    expect(result.snapshots.get('dep-1')).toEqual({
      local_adset_id: 'old-adset',
      local_campaign_id: 'old-campaign',
    });
  });

  it('restores updated deployments and deletes the newly-created ad set on rollback', async () => {
    const updateDeployment = vi.fn().mockResolvedValue(null);
    const deleteAdSet = vi.fn().mockResolvedValue(null);
    const logger = { warn: vi.fn() };
    const snapshots = new Map([
      ['dep-1', { local_adset_id: 'old-adset', local_campaign_id: 'old-campaign' }],
      ['dep-2', { local_adset_id: '', local_campaign_id: 'unplanned' }],
    ]);

    await rollbackManualAdSetCombine({
      adSetId: 'new-adset',
      updatedDeploymentIds: ['dep-1', 'dep-2'],
      snapshots,
      updateDeployment,
      deleteAdSet,
      logger,
    });

    expect(updateDeployment).toHaveBeenCalledWith('dep-1', {
      local_adset_id: 'old-adset',
      local_campaign_id: 'old-campaign',
    });
    expect(updateDeployment).toHaveBeenCalledWith('dep-2', {
      local_adset_id: '',
      local_campaign_id: 'unplanned',
    });
    expect(deleteAdSet).toHaveBeenCalledWith('new-adset');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
