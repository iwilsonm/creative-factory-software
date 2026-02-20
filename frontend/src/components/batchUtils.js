export const CRON_PRESETS = [
  { value: '0 * * * *',    label: 'Every hour' },
  { value: '0 */6 * * *',  label: 'Every 6 hours' },
  { value: '0 */12 * * *', label: 'Every 12 hours' },
  { value: '0 9 * * *',    label: 'Daily at 9 AM' },
  { value: '0 9 * * 1-5',  label: 'Weekdays at 9 AM' },
  { value: '0 9 * * 1',    label: 'Weekly (Monday 9 AM)' },
  { value: 'custom',       label: 'Custom interval...' },
];

export const INTERVAL_UNITS = [
  { value: 'minutes', label: 'minutes', min: 5,  max: 59 },
  { value: 'hours',   label: 'hours',   min: 1,  max: 23 },
  { value: 'days',    label: 'days',    min: 1,  max: 30 },
  { value: 'weeks',   label: 'weeks',   min: 1,  max: 4  },
  { value: 'months',  label: 'months',  min: 1,  max: 12 },
];

export const ASPECT_RATIOS = [
  { value: '1:1', label: '1:1 (Square)' },
  { value: '9:16', label: '9:16 (Story)' },
  { value: '16:9', label: '16:9 (Landscape)' },
  { value: '4:5', label: '4:5 (Portrait)' }
];

export const STATUS_COLORS = {
  pending: 'bg-gray-100/80 text-gray-600',
  generating_prompts: 'bg-blue-100/80 text-blue-600',
  submitting: 'bg-blue-100/80 text-blue-600',
  processing: 'bg-amber-100/80 text-amber-700',
  completed: 'bg-green-100/80 text-green-700',
  failed: 'bg-red-100/80 text-red-600'
};

export const STATUS_LABELS = {
  pending: 'Pending',
  generating_prompts: 'Generating Prompts',
  submitting: 'Step 5 of 5: Submitting',
  processing: 'Step 5 of 5: Generating Images',
  completed: 'Completed',
  failed: 'Failed'
};

export function intervalToCron(amount, unit) {
  const n = parseInt(amount);
  if (!n || n < 1) return null;
  switch (unit) {
    case 'minutes': return `*/${n} * * * *`;
    case 'hours':   return n === 1 ? '0 * * * *' : `0 */${n} * * *`;
    case 'days':    return n === 1 ? '0 9 * * *' : `0 9 */${n} * *`;
    case 'weeks':   return n === 1 ? '0 9 * * 1' : `0 9 */${n * 7} * *`;
    case 'months':  return n === 1 ? '0 9 1 * *' : `0 9 1 */${n} *`;
    default: return null;
  }
}

export function cronToLabel(cronStr) {
  if (!cronStr) return '';
  // Check presets first
  const preset = CRON_PRESETS.find(p => p.value === cronStr && p.value !== 'custom');
  if (preset) return preset.label;
  // Parse cron fields
  const parts = cronStr.trim().split(/\s+/);
  if (parts.length !== 5) return cronStr;
  const [minute, hour, dom, month, dow] = parts;
  // */N * * * * → Every N minutes
  if (minute.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(minute.slice(2));
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }
  // 0 */N * * * → Every N hours
  if (minute === '0' && hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(hour.slice(2));
    return n === 1 ? 'Every hour' : `Every ${n} hours`;
  }
  // 0 * * * * → Every hour
  if (minute === '0' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return 'Every hour';
  }
  // 0 H */N * * → Every N days
  if (minute === '0' && dom.startsWith('*/') && month === '*' && dow === '*') {
    const n = parseInt(dom.slice(2));
    if (n % 7 === 0) {
      const weeks = n / 7;
      return weeks === 1 ? 'Weekly' : `Every ${weeks} weeks`;
    }
    return n === 1 ? 'Daily' : `Every ${n} days`;
  }
  // 0 H 1 */N * → Every N months
  if (minute === '0' && dom === '1' && month.startsWith('*/') && dow === '*') {
    const n = parseInt(month.slice(2));
    return n === 1 ? 'Monthly' : `Every ${n} months`;
  }
  // 0 H 1 * * → Monthly
  if (minute === '0' && dom === '1' && month === '*' && dow === '*') {
    return 'Monthly';
  }
  return cronStr;
}

export function parseCronToInterval(cronStr) {
  if (!cronStr) return null;
  const parts = cronStr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  // */N * * * * → minutes
  if (minute.startsWith('*/') && hour === '*' && dom === '*') {
    return { amount: parseInt(minute.slice(2)), unit: 'minutes' };
  }
  // 0 */N * * * → hours
  if (minute === '0' && hour.startsWith('*/') && dom === '*' && month === '*') {
    return { amount: parseInt(hour.slice(2)), unit: 'hours' };
  }
  // 0 * * * * → 1 hour
  if (minute === '0' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return { amount: 1, unit: 'hours' };
  }
  // 0 H */N * * → days (or weeks if divisible by 7)
  if (minute === '0' && dom.startsWith('*/') && month === '*' && dow === '*') {
    const n = parseInt(dom.slice(2));
    if (n % 7 === 0) return { amount: n / 7, unit: 'weeks' };
    return { amount: n, unit: 'days' };
  }
  // 0 H * * N → weekly
  if (minute === '0' && dom === '*' && month === '*' && dow !== '*') {
    return { amount: 1, unit: 'weeks' };
  }
  // 0 H 1 */N * → months
  if (minute === '0' && dom === '1' && month.startsWith('*/') && dow === '*') {
    return { amount: parseInt(month.slice(2)), unit: 'months' };
  }
  // 0 H 1 * * → 1 month
  if (minute === '0' && dom === '1' && month === '*' && dow === '*') {
    return { amount: 1, unit: 'months' };
  }
  return null;
}

export function getNextRun(cronStr) {
  if (!cronStr) return null;
  const parts = cronStr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  const now = new Date();

  // */N * * * * → every N minutes
  if (minute.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(minute.slice(2));
    const next = new Date(now);
    const currentMin = next.getMinutes();
    const nextMin = Math.ceil((currentMin + 1) / n) * n;
    if (nextMin >= 60) {
      next.setHours(next.getHours() + 1);
      next.setMinutes(nextMin % 60);
    } else {
      next.setMinutes(nextMin);
    }
    next.setSeconds(0, 0);
    return next;
  }

  // 0 * * * * → every hour at :00
  if (minute === '0' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const next = new Date(now);
    next.setHours(next.getHours() + 1);
    next.setMinutes(0, 0, 0);
    return next;
  }

  // 0 */N * * * → every N hours at :00
  if (minute === '0' && hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(hour.slice(2));
    const next = new Date(now);
    const currentHr = next.getHours();
    const nextHr = Math.ceil((currentHr + 1) / n) * n;
    if (nextHr >= 24) {
      next.setDate(next.getDate() + 1);
      next.setHours(nextHr % 24);
    } else {
      next.setHours(nextHr);
    }
    next.setMinutes(0, 0, 0);
    return next;
  }

  // 0 H * * N or 0 H * * N-M → specific day(s) of week
  if (minute === '0' && dom === '*' && month === '*' && dow !== '*') {
    const targetHour = parseInt(hour) || 0;
    let days = [];
    if (dow.includes('-')) {
      const [start, end] = dow.split('-').map(Number);
      for (let d = start; d <= end; d++) days.push(d);
    } else {
      days = [parseInt(dow)];
    }
    const next = new Date(now);
    next.setHours(targetHour, 0, 0, 0);
    if (days.includes(next.getDay()) && next > now) return next;
    for (let i = 1; i <= 7; i++) {
      next.setDate(now.getDate() + i);
      next.setHours(targetHour, 0, 0, 0);
      if (days.includes(next.getDay())) return next;
    }
    return next;
  }

  // 0 H * * * → daily at specific hour
  if (minute === '0' && !hour.startsWith('*/') && hour !== '*' && dom === '*' && month === '*' && dow === '*') {
    const targetHour = parseInt(hour) || 0;
    const next = new Date(now);
    next.setHours(targetHour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  // 0 H */N * * → every N days at specific hour
  if (minute === '0' && dom.startsWith('*/') && month === '*' && dow === '*') {
    const n = parseInt(dom.slice(2));
    const targetHour = parseInt(hour) || 9;
    const next = new Date(now);
    const currentDom = next.getDate();
    next.setHours(targetHour, 0, 0, 0);
    next.setDate(currentDom + (n - ((currentDom - 1) % n)));
    if (next <= now) next.setDate(next.getDate() + n);
    next.setHours(targetHour, 0, 0, 0);
    return next;
  }

  // 0 H 1 */N * → every N months on the 1st
  if (minute === '0' && dom === '1' && month.startsWith('*/') && dow === '*') {
    const n = parseInt(month.slice(2));
    const targetHour = parseInt(hour) || 9;
    const next = new Date(now);
    next.setDate(1);
    next.setHours(targetHour, 0, 0, 0);
    if (next <= now) next.setMonth(next.getMonth() + n);
    return next;
  }

  // 0 H 1 * * → monthly on the 1st
  if (minute === '0' && dom === '1' && month === '*' && dow === '*') {
    const targetHour = parseInt(hour) || 9;
    const next = new Date(now);
    next.setDate(1);
    next.setHours(targetHour, 0, 0, 0);
    if (next <= now) next.setMonth(next.getMonth() + 1);
    return next;
  }

  return null;
}

export function formatNextRun(date) {
  if (!date) return '';
  const now = new Date();
  const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((target - today) / 86400000);
  if (diffDays === 0) return `Today at ${timeStr}`;
  if (diffDays === 1) return `Tomorrow at ${timeStr}`;
  if (diffDays < 7) {
    return `${date.toLocaleDateString([], { weekday: 'short' })} at ${timeStr}`;
  }
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${timeStr}`;
}

export function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

export function formatDuration(startedAt, completedAt) {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt) - new Date(startedAt);
  if (ms < 0) return null;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}
