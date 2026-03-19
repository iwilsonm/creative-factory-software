/**
 * Sales Page HTML Preview Renderer
 * Renders section_data JSON into a complete styled HTML page.
 */

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fff; color: #1a1a2e; line-height: 1.6; }
  a { color: #c4975a; text-decoration: none; }
  a:hover { text-decoration: underline; }

  .section { padding: 48px 20px; }
  .section:nth-child(even) { background: #f8f8f6; }
  .inner { max-width: 860px; margin: 0 auto; }

  /* Announcement Bar */
  .announcement-bar { padding: 12px 20px; text-align: center; font-size: 14px; font-weight: 600; letter-spacing: 0.02em; }

  /* Product Hero */
  .hero-title { font-size: clamp(26px, 5vw, 38px); font-weight: 800; color: #1a3a5c; line-height: 1.2; margin-bottom: 12px; }
  .rating-row { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; font-size: 14px; color: #555; }
  .stars { color: #c4975a; font-size: 16px; letter-spacing: 1px; }
  .price-row { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .price { font-size: 32px; font-weight: 800; color: #1a3a5c; }
  .compare-price { font-size: 20px; color: #999; text-decoration: line-through; }
  .discount-badge { background: #c4975a; color: #fff; font-size: 13px; font-weight: 700; padding: 4px 10px; border-radius: 4px; }
  .emoji-benefits { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
  .emoji-benefit { font-size: 15px; color: #333; }
  .cta-btn { display: inline-block; background: #c4975a; color: #1a3a5c; font-weight: 800; font-size: 16px; padding: 16px 32px; border-radius: 6px; border: none; cursor: pointer; text-align: center; margin-bottom: 28px; text-decoration: none; }
  .bundle-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-top: 8px; }
  .bundle-card { border: 2px solid #e0d5c5; border-radius: 8px; padding: 16px; text-align: center; }
  .bundle-card .bundle-name { font-weight: 700; color: #1a3a5c; font-size: 15px; margin-bottom: 4px; }
  .bundle-card .bundle-price { font-size: 22px; font-weight: 800; color: #c4975a; margin-bottom: 4px; }
  .bundle-card .bundle-items { font-size: 13px; color: #666; margin-bottom: 6px; }
  .bundle-card .bundle-gift { font-size: 12px; color: #2a9d8f; font-weight: 600; }

  /* Section Headings */
  .section-heading { font-size: clamp(22px, 4vw, 30px); font-weight: 800; color: #1a3a5c; margin-bottom: 20px; line-height: 1.25; }
  .section-intro { font-size: 16px; color: #555; margin-bottom: 24px; line-height: 1.7; }

  /* FAQ / Accordion (rendered open) */
  .faq-list { display: flex; flex-direction: column; gap: 16px; }
  .faq-item { border: 1px solid #e8e8e4; border-radius: 8px; padding: 20px; }
  .faq-question { font-weight: 700; color: #1a3a5c; font-size: 15px; margin-bottom: 10px; }
  .faq-answer { font-size: 14px; color: #444; line-height: 1.7; }
  .faq-answer p { margin-bottom: 8px; }
  .faq-answer p:last-child { margin-bottom: 0; }

  /* Trust Badges */
  .badge-strip { display: flex; flex-wrap: wrap; justify-content: center; gap: 20px; }
  .badge-item { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; min-width: 90px; }
  .badge-icon { font-size: 28px; }
  .badge-text { font-size: 12px; font-weight: 700; color: #1a3a5c; text-transform: uppercase; letter-spacing: 0.04em; }

  /* Education Sections */
  .richtext { font-size: 15px; color: #333; line-height: 1.75; }
  .richtext p { margin-bottom: 16px; }
  .richtext p:last-child { margin-bottom: 0; }
  .richtext strong { color: #1a3a5c; font-weight: 700; }
  .richtext em { color: #555; font-style: italic; }

  /* Benefits Tabs (stacked) */
  .benefit-cards { display: flex; flex-direction: column; gap: 20px; }
  .benefit-card { border-left: 4px solid #c4975a; padding: 20px 24px; background: #fff; border-radius: 0 8px 8px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .benefit-label { font-size: 12px; font-weight: 700; color: #c4975a; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
  .benefit-heading { font-size: 18px; font-weight: 700; color: #1a3a5c; margin-bottom: 10px; }
  .benefit-body { font-size: 14px; color: #444; line-height: 1.7; }
  .benefit-body p { margin-bottom: 8px; }
  .benefit-body p:last-child { margin-bottom: 0; }

  /* How It Works */
  .steps-grid { display: flex; flex-direction: column; gap: 20px; }
  .step-card { display: flex; gap: 20px; align-items: flex-start; }
  .step-number { width: 40px; height: 40px; border-radius: 50%; background: #1a3a5c; color: #fff; font-weight: 800; font-size: 18px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .step-title { font-weight: 700; color: #1a3a5c; font-size: 16px; margin-bottom: 4px; }
  .step-desc { font-size: 14px; color: #555; line-height: 1.6; }

  /* Results & Stats */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 20px; margin: 24px 0; }
  .stat-card { text-align: center; padding: 24px 16px; background: #fff; border-radius: 8px; border: 1px solid #e8e8e4; }
  .stat-percent { font-size: 40px; font-weight: 900; color: #c4975a; line-height: 1; margin-bottom: 8px; }
  .stat-desc { font-size: 13px; color: #555; line-height: 1.4; }
  .stats-caption { font-size: 12px; color: #888; text-align: center; margin-top: 8px; font-style: italic; }

  /* Written Testimonials */
  .testimonial-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; }
  .testimonial-card { background: #fff; border: 1px solid #e8e8e4; border-radius: 10px; padding: 22px; }
  .testimonial-stars { color: #c4975a; font-size: 16px; margin-bottom: 8px; }
  .testimonial-headline { font-weight: 700; color: #1a3a5c; font-size: 15px; margin-bottom: 10px; }
  .testimonial-quote { font-size: 14px; color: #444; line-height: 1.65; margin-bottom: 12px; font-style: italic; }
  .testimonial-name { font-size: 13px; font-weight: 700; color: #888; }

  /* Guarantee */
  .guarantee-body { font-size: 15px; color: #333; line-height: 1.75; margin-bottom: 24px; }
  .guarantee-body p { margin-bottom: 12px; }
  .guarantee-body p:last-child { margin-bottom: 0; }
  .badge-pills { display: flex; flex-wrap: wrap; gap: 10px; }
  .badge-pill { display: flex; align-items: center; gap: 8px; background: #1a3a5c; color: #fff; padding: 8px 16px; border-radius: 24px; font-size: 13px; font-weight: 600; }
  .badge-pill-icon { font-size: 18px; }

  /* Footer spacer */
  .page-footer { padding: 40px 20px; text-align: center; font-size: 12px; color: #bbb; background: #1a3a5c; color: rgba(255,255,255,0.5); }

  @media (max-width: 600px) {
    .section { padding: 36px 16px; }
    .bundle-grid { grid-template-columns: 1fr; }
    .testimonial-grid { grid-template-columns: 1fr; }
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
  }
`;

// Map icon names to emoji approximations
function iconToEmoji(icon) {
  const map = {
    'shield': '🛡️', 'shield-check': '✅', 'truck': '🚚', 'truck-fast': '🚚',
    'leaf': '🌿', 'flask': '🧪', 'award': '🏆', 'lock': '🔒',
    'star': '⭐', 'heart': '❤️', 'check': '✔️', 'checkmark': '✔️',
    'certificate': '📜', 'users': '👥', 'globe': '🌍', 'box': '📦',
    'clock': '⏱️', 'tag': '🏷️', 'percent': '💯', 'beaker': '🧪',
    'recycle': '♻️', 'fire': '🔥', 'lightning': '⚡', 'sun': '☀️',
  };
  if (!icon) return '✅';
  const key = icon.toLowerCase().replace(/[^a-z-]/g, '');
  return map[key] || '✅';
}

function stars(n) {
  const count = Math.round(parseFloat(n) || 5);
  return '★'.repeat(Math.min(count, 5));
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Render richtext — if it looks like HTML, pass through; otherwise wrap in <p>
function richtext(str) {
  if (!str) return '';
  const s = String(str).trim();
  if (s.startsWith('<')) return s;
  return `<p>${esc(s)}</p>`;
}

// ── Section renderers ─────────────────────────────────────────

function renderAnnouncementBar(d) {
  if (!d?.announcement_text) return '';
  const bg = d.bg_color || '#1a3a5c';
  const tc = d.text_color || '#ffffff';
  return `<div class="announcement-bar" style="background:${esc(bg)};color:${esc(tc)}">${esc(d.announcement_text)}</div>`;
}

function renderProductHero(d) {
  if (!d?.product_title) return '';

  const ratingScore = d.rating_score || '4.8';
  const ratingCount = d.rating_count || '';
  const price = d.price || '';
  const comparePrice = d.compare_price || '';
  const discountBadge = d.discount_badge || '';
  const eb1 = d.emoji_benefit_1 || '';
  const eb2 = d.emoji_benefit_2 || '';
  const ctaText = d.cta_text || 'Get Yours Now';
  const tiers = Array.isArray(d.bundle_tiers) ? d.bundle_tiers : [];

  const bundleHtml = tiers.length ? `
    <div class="bundle-grid">
      ${tiers.map(t => `
        <div class="bundle-card">
          <div class="bundle-name">${esc(t.name)}</div>
          <div class="bundle-price">${esc(t.price)}</div>
          <div class="bundle-items">${esc(t.items)}</div>
          ${t.free_gift ? `<div class="bundle-gift">🎁 ${esc(t.free_gift)}</div>` : ''}
        </div>`).join('')}
    </div>` : '';

  return `
    <section class="section">
      <div class="inner">
        <h1 class="hero-title">${esc(d.product_title)}</h1>
        <div class="rating-row">
          <span class="stars">${stars(ratingScore)}</span>
          <span>${esc(ratingScore)}</span>
          ${ratingCount ? `<span>(${esc(ratingCount)} reviews)</span>` : ''}
        </div>
        <div class="price-row">
          ${price ? `<span class="price">${esc(price)}</span>` : ''}
          ${comparePrice ? `<span class="compare-price">${esc(comparePrice)}</span>` : ''}
          ${discountBadge ? `<span class="discount-badge">${esc(discountBadge)}</span>` : ''}
        </div>
        <div class="emoji-benefits">
          ${eb1 ? `<div class="emoji-benefit">${esc(eb1)}</div>` : ''}
          ${eb2 ? `<div class="emoji-benefit">${esc(eb2)}</div>` : ''}
        </div>
        <a class="cta-btn">${esc(ctaText)}</a>
        ${bundleHtml}
      </div>
    </section>`;
}

function renderProductFaq(d) {
  const items = Array.isArray(d?.accordion_items) ? d.accordion_items : [];
  if (!items.length) return '';
  return `
    <section class="section">
      <div class="inner">
        <h2 class="section-heading">Common Questions</h2>
        <div class="faq-list">
          ${items.map(item => `
            <div class="faq-item">
              <div class="faq-question">${esc(item.question)}</div>
              <div class="faq-answer">${richtext(item.answer)}</div>
            </div>`).join('')}
        </div>
      </div>
    </section>`;
}

function renderTrustBadges(d) {
  const badges = Array.isArray(d?.badges) ? d.badges : [];
  if (!badges.length) return '';
  return `
    <section class="section">
      <div class="inner">
        <div class="badge-strip">
          ${badges.map(b => `
            <div class="badge-item">
              <div class="badge-icon">${iconToEmoji(b.icon)}</div>
              <div class="badge-text">${esc(b.text)}</div>
            </div>`).join('')}
        </div>
      </div>
    </section>`;
}

function renderEducation(d, sectionId) {
  if (!d?.heading && !d?.body_text) return '';
  return `
    <section class="section">
      <div class="inner">
        <h2 class="section-heading">${esc(d.heading || '')}</h2>
        <div class="richtext">${richtext(d.body_text)}</div>
        ${d.link_text && d.link_url ? `<p style="margin-top:16px"><a href="${esc(d.link_url)}">${esc(d.link_text)}</a></p>` : ''}
      </div>
    </section>`;
}

function renderBenefitsTabs(d) {
  const tabs = Array.isArray(d?.tabs) ? d.tabs : [];
  if (!tabs.length && !d?.heading) return '';
  return `
    <section class="section">
      <div class="inner">
        ${d.heading ? `<h2 class="section-heading">${esc(d.heading)}</h2>` : ''}
        <div class="benefit-cards">
          ${tabs.map(t => `
            <div class="benefit-card">
              ${t.tab_label ? `<div class="benefit-label">${esc(t.tab_label)}</div>` : ''}
              ${t.tab_heading ? `<div class="benefit-heading">${esc(t.tab_heading)}</div>` : ''}
              ${t.tab_body ? `<div class="benefit-body">${richtext(t.tab_body)}</div>` : ''}
            </div>`).join('')}
        </div>
      </div>
    </section>`;
}

function renderHowItWorks(d) {
  const steps = Array.isArray(d?.steps) ? d.steps : [];
  if (!steps.length && !d?.heading) return '';
  return `
    <section class="section">
      <div class="inner">
        ${d.heading ? `<h2 class="section-heading">${esc(d.heading)}</h2>` : ''}
        <div class="steps-grid">
          ${steps.map((s, i) => `
            <div class="step-card">
              <div class="step-number">${i + 1}</div>
              <div>
                <div class="step-title">${esc(s.step_title || '')}</div>
                <div class="step-desc">${esc(s.step_description || '')}</div>
              </div>
            </div>`).join('')}
        </div>
      </div>
    </section>`;
}

function renderResultsStats(d) {
  const statItems = Array.isArray(d?.stats) ? d.stats : [];
  if (!statItems.length && !d?.heading) return '';
  return `
    <section class="section">
      <div class="inner">
        ${d.heading ? `<h2 class="section-heading">${esc(d.heading)}</h2>` : ''}
        ${d.intro_text ? `<p class="section-intro">${esc(d.intro_text)}</p>` : ''}
        ${statItems.length ? `
          <div class="stats-grid">
            ${statItems.map(s => `
              <div class="stat-card">
                <div class="stat-percent">${esc(s.percentage)}</div>
                <div class="stat-desc">${esc(s.description)}</div>
              </div>`).join('')}
          </div>` : ''}
        ${d.caption ? `<div class="stats-caption">${esc(d.caption)}</div>` : ''}
      </div>
    </section>`;
}

function renderWrittenTestimonials(d) {
  const items = Array.isArray(d?.testimonials) ? d.testimonials : [];
  if (!items.length && !d?.heading) return '';
  return `
    <section class="section">
      <div class="inner">
        ${d.heading ? `<h2 class="section-heading">${esc(d.heading)}</h2>` : ''}
        <div class="testimonial-grid">
          ${items.map(t => `
            <div class="testimonial-card">
              <div class="testimonial-stars">${'★'.repeat(Math.min(parseInt(t.star_rating) || 5, 5))}</div>
              ${t.headline ? `<div class="testimonial-headline">${esc(t.headline)}</div>` : ''}
              ${t.quote ? `<div class="testimonial-quote">"${esc(t.quote)}"</div>` : ''}
              ${t.customer_name ? `<div class="testimonial-name">— ${esc(t.customer_name)}</div>` : ''}
            </div>`).join('')}
        </div>
      </div>
    </section>`;
}

function renderGuarantee(d) {
  if (!d?.heading && !d?.body_text) return '';
  const pills = Array.isArray(d?.guarantee_badges) ? d.guarantee_badges : [];
  return `
    <section class="section">
      <div class="inner">
        ${d.heading ? `<h2 class="section-heading">${esc(d.heading)}</h2>` : ''}
        ${d.body_text ? `<div class="guarantee-body richtext">${richtext(d.body_text)}</div>` : ''}
        ${pills.length ? `
          <div class="badge-pills">
            ${pills.map(p => `
              <div class="badge-pill">
                ${p.badge_icon ? `<span class="badge-pill-icon">${iconToEmoji(p.badge_icon)}</span>` : ''}
                ${esc(p.badge_text)}
              </div>`).join('')}
          </div>` : ''}
      </div>
    </section>`;
}

function renderBuyingFaq(d) {
  const items = Array.isArray(d?.faq_items) ? d.faq_items : [];
  if (!items.length && !d?.heading) return '';
  return `
    <section class="section">
      <div class="inner">
        ${d.heading ? `<h2 class="section-heading">${esc(d.heading)}</h2>` : ''}
        <div class="faq-list">
          ${items.map(item => `
            <div class="faq-item">
              <div class="faq-question">${esc(item.question)}</div>
              <div class="faq-answer">${richtext(item.answer)}</div>
            </div>`).join('')}
        </div>
      </div>
    </section>`;
}

// ── Main export ───────────────────────────────────────────────

/**
 * @param {object} page - Sales page record with section_data already parsed as object
 * @returns {string} Complete <!DOCTYPE html> string
 */
export function renderSalesPageHtml(page) {
  const sd = page.section_data || {};
  const title = page.name || 'Sales Page Preview';

  const body = [
    renderAnnouncementBar(sd.announcement_bar),
    renderProductHero(sd.product_hero),
    renderProductFaq(sd.product_faq),
    renderTrustBadges(sd.trust_badges),
    // video_testimonials — always empty, skip
    renderEducation(sd.education_concept, 'education_concept'),
    renderEducation(sd.education_product, 'education_product'),
    renderBenefitsTabs(sd.benefits_tabs),
    renderHowItWorks(sd.how_it_works),
    renderResultsStats(sd.results_stats),
    renderWrittenTestimonials(sd.written_testimonials),
    renderGuarantee(sd.guarantee),
    renderBuyingFaq(sd.buying_faq),
  ].filter(Boolean).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)} — Preview</title>
  <style>${CSS}</style>
</head>
<body>
${body}
<div class="page-footer">Sales Page Preview — ${esc(title)}</div>
</body>
</html>`;
}
