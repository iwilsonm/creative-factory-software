import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../../api';

export function useAnalyticsCharts(projectId, { datePreset, dateFrom, dateTo, campaignId }) {
  const [timeseries, setTimeseries] = useState(null);
  const [byCampaign, setByCampaign] = useState(null);
  const [apiCampaignNames, setApiCampaignNames] = useState({});
  const [hourly, setHourly] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const lastHash = useRef('');
  const debounceRef = useRef(null);

  const fetchData = useCallback(async () => {
    if (!projectId) return;

    const hash = `${projectId}|${datePreset}|${dateFrom}|${dateTo}|${campaignId}`;
    if (hash === lastHash.current) return;
    lastHash.current = hash;

    setLoading(true);
    setError(null);

    const opts = {};
    if (datePreset) opts.datePreset = datePreset;
    if (dateFrom) opts.dateFrom = dateFrom;
    if (dateTo) opts.dateTo = dateTo;
    if (campaignId) opts.campaignId = campaignId;

    try {
      const [tsData, hrData] = await Promise.all([
        api.getAnalyticsTimeseries(projectId, opts),
        api.getAnalyticsHourly(projectId, opts),
      ]);
      setTimeseries(tsData.timeseries || []);
      setByCampaign(tsData.byCampaign || {});
      setApiCampaignNames(tsData.campaignNames || {});
      setHourly(hrData.hours || []);
    } catch (err) {
      setError(err);
      setTimeseries(null);
      setByCampaign(null);
      setHourly(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, datePreset, dateFrom, dateTo, campaignId]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(fetchData, 500);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [fetchData]);

  return { timeseries, byCampaign, hourly, loading, error, apiCampaignNames };
}
