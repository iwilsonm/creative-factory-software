function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export const DEMO_TIMESERIES = Array.from({ length: 14 }, (_, i) => ({
  date: daysAgo(13 - i),
  spend: 120 + Math.random() * 80,
  impressions: 8000 + Math.random() * 4000,
  clicks: 200 + Math.random() * 120,
  purchase_count: Math.floor(3 + Math.random() * 5),
  roas: 1.4 + Math.random() * 1.8,
  ctr: 2.1 + Math.random() * 1.2,
}));

export const DEMO_BY_CAMPAIGN = {
  'camp_1': DEMO_TIMESERIES.map(d => ({ ...d, campaign_id: 'camp_1', spend: d.spend * 0.4 })),
  'camp_2': DEMO_TIMESERIES.map(d => ({ ...d, campaign_id: 'camp_2', spend: d.spend * 0.35 })),
  'camp_3': DEMO_TIMESERIES.map(d => ({ ...d, campaign_id: 'camp_3', spend: d.spend * 0.25 })),
};

export const DEMO_HOURLY = Array.from({ length: 24 }, (_, h) => {
  const peak = Math.exp(-((h - 14) ** 2) / 40);
  return {
    spend: peak * 25 + Math.random() * 5,
    impressions: Math.floor(peak * 800 + Math.random() * 100),
    clicks: Math.floor(peak * 30 + Math.random() * 8),
  };
});

export const DEMO_ANGLES = [
  { angle: 'Social Proof', spend: 342, roas: 2.8 },
  { angle: 'Pain Point', spend: 280, roas: 2.1 },
  { angle: 'Authority', spend: 195, roas: 1.6 },
  { angle: 'Urgency', spend: 160, roas: 0.9 },
  { angle: 'Curiosity', spend: 88, roas: 0 },
];

export const DEMO_SCATTER = [
  { spend: 342, roas: 2.8, ads: 6, status: 'passed' },
  { spend: 280, roas: 2.1, ads: 4, status: 'passed' },
  { spend: 195, roas: 1.6, ads: 5, status: 'observing' },
  { spend: 160, roas: 0.9, ads: 3, status: 'failed' },
  { spend: 88, roas: 0.4, ads: 2, status: 'failed' },
  { spend: 420, roas: 3.2, ads: 8, status: 'passed' },
  { spend: 55, roas: 1.1, ads: 2, status: 'observing' },
  { spend: 310, roas: 1.9, ads: 5, status: 'observing' },
];

export const DEMO_FUNNEL = [
  { stage: 'Impressions', value: 142000, rate: null },
  { stage: 'Clicks', value: 3800, rate: 3800 / 142000 },
  { stage: 'Add to Cart', value: 420, rate: 420 / 3800 },
  { stage: 'Purchases', value: 62, rate: 62 / 420 },
];
