import { useState, useRef, useCallback, useEffect } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import PipelineProgress from './PipelineProgress';
import MultiInput from './MultiInput';
import InfoTooltip from './InfoTooltip';

// Step progress mapping for PipelineProgress
const SP_STEP_PROGRESS = {
  foundation_analysis: 20,
  sections_1_7: 50,
  sections_8_13: 80,
  editorial_pass: 95,
};

const SP_STEP_LABELS = {
  foundation_analysis: 'Analyzing product & audience...',
  sections_1_7: 'Writing hero, education & trust sections...',
  sections_8_13: 'Writing benefits, proof & FAQ sections...',
  editorial_pass: 'Opus editorial review...',
};

const STATUS_BADGES = {
  draft: { label: 'Draft', bg: 'bg-navy/10', text: 'text-navy' },
  generating: { label: 'Generating', bg: 'bg-gold/15', text: 'text-gold' },
  partial: { label: 'Partial', bg: 'bg-gold/10', text: 'text-gold' },
  completed: { label: 'Completed', bg: 'bg-teal/10', text: 'text-teal' },
  failed: { label: 'Failed', bg: 'bg-red-50', text: 'text-red-600' },
  publish_failed: { label: 'Publish Failed', bg: 'bg-red-50', text: 'text-red-600' },
  published: { label: 'Published', bg: 'bg-teal/15', text: 'text-teal' },
  unpublished: { label: 'Unpublished', bg: 'bg-navy/10', text: 'text-textmid' },
};

const PRODUCT_CATEGORIES = [
  'Health & Wellness',
  'Beauty & Skincare',
  'Fitness & Sports',
  'Home & Garden',
  'Food & Supplements',
  'Technology & Gadgets',
  'Fashion & Apparel',
  'Pet Products',
  'Other',
];

// Section display config for preview
const SECTION_LABELS = {
  announcement_bar: 'Announcement Bar',
  product_hero: 'Product Hero',
  product_faq: 'Product FAQ',
  trust_badges: 'Trust Badges',
  video_testimonials: 'Video Testimonials',
  education_concept: 'Education: Concept',
  education_product: 'Education: Product',
  benefits_tabs: 'Benefits Tabs',
  how_it_works: 'How It Works',
  results_stats: 'Results & Stats',
  written_testimonials: 'Written Testimonials',
  guarantee: 'Risk-Free Guarantee',
  buying_faq: 'Buying FAQ',
};

const SECTION_ORDER = [
  'announcement_bar', 'product_hero', 'product_faq', 'trust_badges',
  'video_testimonials', 'education_concept', 'education_product',
  'benefits_tabs', 'how_it_works', 'results_stats', 'written_testimonials',
  'guarantee', 'buying_faq',
];

export default function SalesPageGen({ projectId, project }) {
  const toast = useToast();
  const [view, setView] = useState('list'); // list | configure | generating | preview
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPage, setSelectedPage] = useState(null);

  // Generation state
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const genStartRef = useRef(null);
  const [generatingPageId, setGeneratingPageId] = useState(null);

  // Publishing state
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState(null);
  const [shopifyConfigured, setShopifyConfigured] = useState(null); // null = loading

  // Product brief form
  const [productName, setProductName] = useState('');
  const [tagline, setTagline] = useState('');
  const [targetAudience, setTargetAudience] = useState('');
  const [keyBenefit, setKeyBenefit] = useState('');
  const [mechanism, setMechanism] = useState('');
  const [guaranteePeriod, setGuaranteePeriod] = useState('');
  const [features, setFeatures] = useState([]);
  const [price, setPrice] = useState('');
  const [comparePrice, setComparePrice] = useState('');
  const [category, setCategory] = useState('Health & Wellness');
  const [imageUrls, setImageUrls] = useState([]);

  // Load pages
  const loadPages = useCallback(async () => {
    try {
      const data = await api.getSalesPages(projectId);
      setPages(data?.pages || []);
    } catch (err) {
      console.error('Failed to load sales pages:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadPages();
    api.getShopifyStatus(projectId)
      .then((d) => setShopifyConfigured(d.configured))
      .catch(() => setShopifyConfigured(false));
  }, [loadPages, projectId]);

  // Generate
  const handleGenerate = async () => {
    if (!productName.trim()) {
      toast.error('Product name is required');
      return;
    }

    const productBrief = {
      name: productName.trim(),
      tagline: tagline.trim() || undefined,
      target_audience: targetAudience.trim() || undefined,
      key_benefit: keyBenefit.trim() || undefined,
      mechanism: mechanism.trim() || undefined,
      guarantee_period: guaranteePeriod.trim() || undefined,
      features,
      price: price.trim() || undefined,
      compare_price: comparePrice.trim() || undefined,
      category,
      image_urls: imageUrls.length > 0 ? imageUrls : undefined,
    };

    setView('generating');
    setProgress(0);
    setProgressMessage('Starting generation...');
    genStartRef.current = Date.now();
    setGeneratingPageId(null);

    try {
      await api.generateSalesPage(projectId, { product_brief: productBrief }, (event) => {
        if (event.type === 'warning') {
          setProgressMessage(event.message || '');
        }
        if (event.type === 'progress') {
          const stepProgress = SP_STEP_PROGRESS[event.step] || 0;
          setProgress(prev => Math.max(prev, stepProgress));
          setProgressMessage(SP_STEP_LABELS[event.step] || event.message || '');
        }
        if (event.type === 'complete') {
          setGeneratingPageId(event.pageId);
          setProgress(100);
          setProgressMessage('Sales page generated!');
          setTimeout(async () => {
            await loadPages();
            if (event.pageId) {
              const pageData = await api.getSalesPage(projectId, event.pageId);
              setSelectedPage(pageData?.page || null);
              setView('preview');
            } else {
              setView('list');
            }
          }, 500);
        }
        if (event.type === 'error') {
          toast.error(event.message || 'Generation failed');
          setView('list');
          loadPages();
        }
      });
    } catch (err) {
      toast.error(err.message || 'Generation failed');
      setView('list');
      loadPages();
    }
  };

  // Publish
  const handlePublish = async () => {
    if (!selectedPage) return;
    setPublishing(true);
    setPublishResult(null);
    try {
      const result = await api.publishSalesPage(projectId, selectedPage.id);
      setPublishResult(result);
      toast.success('Sales page published to Shopify (draft)');
      await loadPages();
      // Refresh selected page
      const updated = await api.getSalesPage(projectId, selectedPage.id);
      setSelectedPage(updated?.page || selectedPage);
    } catch (err) {
      toast.error(err.message || 'Publishing failed');
    } finally {
      setPublishing(false);
    }
  };

  // Unpublish
  const handleUnpublish = async () => {
    if (!selectedPage) return;
    try {
      await api.unpublishSalesPage(projectId, selectedPage.id);
      toast.success('Sales page unpublished');
      await loadPages();
      const updated = await api.getSalesPage(projectId, selectedPage.id);
      setSelectedPage(updated?.page || selectedPage);
    } catch (err) {
      toast.error(err.message || 'Unpublish failed');
    }
  };

  // Delete
  const handleDelete = async (pageId) => {
    if (!confirm('Delete this sales page? This cannot be undone.')) return;
    try {
      await api.deleteSalesPage(projectId, pageId);
      toast.success('Sales page deleted');
      if (selectedPage?.id === pageId) {
        setSelectedPage(null);
        setView('list');
      }
      await loadPages();
    } catch (err) {
      toast.error(err.message || 'Delete failed');
    }
  };

  // Open a page in preview
  const openPage = async (page) => {
    try {
      const data = await api.getSalesPage(projectId, page.id);
      setSelectedPage(data?.page || page);
      setView('preview');
    } catch {
      setSelectedPage(page);
      setView('preview');
    }
  };

  // Pre-fill configure form from existing page
  const handleRegenerate = () => {
    prefillFromPage(selectedPage);
    setView('configure');
  };

  // Pre-fill form fields from a page's product_brief
  const prefillFromPage = (page) => {
    if (page?.product_brief) {
      try {
        const brief = JSON.parse(page.product_brief);
        setProductName(brief.name || '');
        setTagline(brief.tagline || '');
        setTargetAudience(brief.target_audience || '');
        setKeyBenefit(brief.key_benefit || '');
        setMechanism(brief.mechanism || '');
        setGuaranteePeriod(brief.guarantee_period || '');
        setFeatures(brief.features || []);
        setPrice(brief.price || '');
        setComparePrice(brief.compare_price || '');
        setCategory(brief.category || 'Health & Wellness');
        setImageUrls(brief.image_urls || []);
      } catch { /* ignore parse errors */ }
    }
  };

  // Retry a failed page — go directly to configure with form pre-filled + error shown
  const [retryError, setRetryError] = useState(null);
  const retryPage = (page) => {
    prefillFromPage(page);
    setRetryError(page.error_message || 'Unknown error');
    setView('configure');
  };

  // ==================== VIEWS ====================

  // LIST VIEW
  if (view === 'list') {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-textdark">Sales Pages</h2>
            <p className="text-sm text-textmid mt-0.5">Generate product sales pages and publish to Shopify</p>
          </div>
          <button
            onClick={() => {
              setProductName('');
              setTagline('');
              setTargetAudience('');
              setKeyBenefit('');
              setMechanism('');
              setGuaranteePeriod('');
              setFeatures([]);
              setPrice('');
              setComparePrice('');
              setCategory('Health & Wellness');
              setImageUrls([]);
              setRetryError(null);
              setView('configure');
            }}
            className="btn-primary text-sm px-4 py-2"
          >
            New Sales Page
          </button>
        </div>

        {loading ? (
          <div className="text-center py-12 text-textmid">Loading...</div>
        ) : pages.length === 0 ? (
          <div className="card p-12 text-center">
            <p className="text-textmid mb-4">No sales pages yet</p>
            <button
              onClick={() => setView('configure')}
              className="btn-primary text-sm px-4 py-2"
            >
              Generate Your First Sales Page
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {pages.map((page) => {
              const badge = STATUS_BADGES[page.status] || STATUS_BADGES.draft;
              return (
                <div
                  key={page.id}
                  className={`card p-4 transition-shadow ${
                    ['completed', 'published', 'unpublished', 'partial', 'publish_failed', 'failed'].includes(page.status)
                      ? 'cursor-pointer hover:shadow-card-hover'
                      : ''
                  }`}
                  onClick={() => {
                    if (['completed', 'published', 'unpublished', 'partial', 'publish_failed'].includes(page.status)) openPage(page);
                    else if (page.status === 'failed') retryPage(page);
                  }}
                >
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-medium text-textdark text-sm truncate flex-1 mr-2">{page.name}</h3>
                    <span className={`badge text-[11px] px-2 py-0.5 rounded-full ${badge.bg} ${badge.text}`}>
                      {badge.label}
                    </span>
                  </div>
                  {page.error_message && (
                    <p className="text-xs text-red-500 mt-1 truncate">{page.error_message}</p>
                  )}
                  {page.status === 'failed' && (
                    <p className="text-xs text-gold mt-1">Click to retry →</p>
                  )}
                  {page.published_url && (
                    <p className="text-xs text-teal mt-1 truncate">{page.published_url}</p>
                  )}
                  <div className="flex items-center justify-between mt-3">
                    <span className="text-[11px] text-textlight">
                      {new Date(page.created_at).toLocaleDateString()}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(page.id);
                      }}
                      className="text-[11px] text-textlight hover:text-red-500 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // CONFIGURE VIEW
  if (view === 'configure') {
    return (
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center gap-3">
          <button onClick={() => { setRetryError(null); setView('list'); }} className="text-textmid hover:text-textdark text-sm">
            &larr; Back
          </button>
          <h2 className="text-lg font-semibold text-textdark">New Sales Page</h2>
        </div>

        {retryError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
            <p className="text-xs font-medium text-red-700">Previous attempt failed:</p>
            <p className="text-xs text-red-600 mt-0.5">{retryError}</p>
          </div>
        )}

        <div className="card p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-textdark mb-1">Product Name *</label>
            <input
              type="text"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              placeholder="e.g., Fitted Grounding Bedsheet"
              className="input-apple w-full"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-textdark mb-1">Product Features</label>
            <p className="text-xs text-textmid mb-1.5">Press Enter or comma to add</p>
            <MultiInput
              items={features}
              onAdd={(f) => setFeatures([...features, f])}
              onRemove={(i) => setFeatures(features.filter((_, idx) => idx !== i))}
              placeholder="Add a feature..."
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-textdark mb-1">Price</label>
              <input
                type="text"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="$89.99"
                className="input-apple w-full"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-textdark mb-1">Compare-at Price</label>
              <input
                type="text"
                value={comparePrice}
                onChange={(e) => setComparePrice(e.target.value)}
                placeholder="$149.99"
                className="input-apple w-full"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-textdark mb-1">Product Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="input-apple w-full"
            >
              {PRODUCT_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>

          <div className="border-t border-black/5 pt-4">
            <p className="text-xs font-semibold text-textmid uppercase tracking-wide mb-4">Product Story <span className="font-normal normal-case">(optional — improves copy quality)</span></p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-textdark mb-1">Tagline</label>
                <input
                  type="text"
                  value={tagline}
                  onChange={(e) => setTagline(e.target.value)}
                  placeholder="e.g., Electrolyte Hangover Defense"
                  className="input-apple w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-textdark mb-1">Who It's For</label>
                <input
                  type="text"
                  value={targetAudience}
                  onChange={(e) => setTargetAudience(e.target.value)}
                  placeholder="e.g., Social drinkers aged 25–40"
                  className="input-apple w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-textdark mb-1">Key Benefit</label>
                <input
                  type="text"
                  value={keyBenefit}
                  onChange={(e) => setKeyBenefit(e.target.value)}
                  placeholder="e.g., Wake up feeling refreshed after a night out"
                  className="input-apple w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-textdark mb-1">How It Works</label>
                <input
                  type="text"
                  value={mechanism}
                  onChange={(e) => setMechanism(e.target.value)}
                  placeholder="e.g., Replenishes electrolytes before they're depleted"
                  className="input-apple w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-textdark mb-1">Guarantee Period</label>
                <input
                  type="text"
                  value={guaranteePeriod}
                  onChange={(e) => setGuaranteePeriod(e.target.value)}
                  placeholder="e.g., 90 days, Lifetime"
                  className="input-apple w-full"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-textdark mb-1">Product Image URLs</label>
            <p className="text-xs text-textmid mb-1.5">Optional. Press Enter to add URLs.</p>
            <MultiInput
              items={imageUrls}
              onAdd={(url) => setImageUrls([...imageUrls, url])}
              onRemove={(i) => setImageUrls(imageUrls.filter((_, idx) => idx !== i))}
              placeholder="https://..."
            />
          </div>

          {(project?.docCount ?? 0) === 0 && (
            <div className="rounded-lg border border-gold/40 bg-gold/5 px-4 py-3">
              <p className="text-sm text-textmid">
                <span className="font-medium text-gold">No foundational docs yet.</span>{' '}
                Generation will work but copy quality may be reduced. Generate docs first for best results.
              </p>
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={!productName.trim()}
            className="btn-primary w-full py-2.5 text-sm disabled:opacity-50"
          >
            Generate Sales Page
          </button>
        </div>
      </div>
    );
  }

  // GENERATING VIEW
  if (view === 'generating') {
    return (
      <div className="space-y-6 max-w-2xl mx-auto">
        <h2 className="text-lg font-semibold text-textdark">Generating Sales Page</h2>
        <div className="card p-6">
          <PipelineProgress
            progress={progress}
            message={progressMessage}
            startTime={genStartRef.current}
          />
        </div>
      </div>
    );
  }

  // PREVIEW VIEW
  if (view === 'preview' && selectedPage) {
    const sectionData = selectedPage.section_data ? (() => {
      try { return JSON.parse(selectedPage.section_data); } catch { return null; }
    })() : null;

    const badge = STATUS_BADGES[selectedPage.status] || STATUS_BADGES.draft;

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => { setSelectedPage(null); setPublishResult(null); setView('list'); }} className="text-textmid hover:text-textdark text-sm">
              &larr; Back
            </button>
            <h2 className="text-lg font-semibold text-textdark">{selectedPage.name}</h2>
            <span className={`badge text-[11px] px-2 py-0.5 rounded-full ${badge.bg} ${badge.text}`}>
              {badge.label}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleRegenerate} className="btn-secondary text-sm px-3 py-1.5">
              Regenerate
            </button>
            {sectionData && (
              <a
                href={`/api/projects/${projectId}/sales-pages/${selectedPage.id}/preview`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary text-sm px-3 py-1.5"
              >
                Open Preview
              </a>
            )}
            {(selectedPage.status === 'completed' || selectedPage.status === 'unpublished' || selectedPage.status === 'publish_failed') && (
              shopifyConfigured === false ? (
                <div className="flex items-center gap-1.5">
                  <button disabled className="btn-primary text-sm px-3 py-1.5 opacity-40 cursor-not-allowed">
                    Publish to Shopify
                  </button>
                  <InfoTooltip text="Configure Shopify in LP Agent settings to enable publishing" position="bottom" />
                </div>
              ) : (
                <button
                  onClick={handlePublish}
                  disabled={publishing}
                  className="btn-primary text-sm px-3 py-1.5 disabled:opacity-50"
                >
                  {publishing ? 'Publishing...' : 'Publish to Shopify'}
                </button>
              )
            )}
            {selectedPage.status === 'published' && (
              <button onClick={handleUnpublish} className="btn-secondary text-sm px-3 py-1.5">
                Unpublish
              </button>
            )}
          </div>
        </div>

        {/* Publish result banner */}
        {(publishResult || selectedPage.published_url) && (
          <div className="card p-4 bg-teal/5 border border-teal/20">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-teal">Published (Draft)</p>
                <a
                  href={publishResult?.published_url || selectedPage.published_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-gold hover:underline"
                >
                  {publishResult?.published_url || selectedPage.published_url}
                </a>
              </div>
              {publishResult?.editor_url && (
                <a
                  href={publishResult.editor_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary text-xs px-3 py-1"
                >
                  Open in Shopify Editor
                </a>
              )}
            </div>
          </div>
        )}

        {/* Editorial notes */}
        {selectedPage.editorial_notes && (
          <div className="card p-4 bg-navy/5">
            <h3 className="text-sm font-medium text-textdark mb-1">Editorial Notes</h3>
            <p className="text-xs text-textmid whitespace-pre-wrap">{selectedPage.editorial_notes}</p>
          </div>
        )}

        {/* Section preview cards */}
        {sectionData ? (
          <div className="space-y-4">
            {SECTION_ORDER.map((sectionId) => {
              const data = sectionData[sectionId];
              if (!data) return null;
              return (
                <SectionPreview
                  key={sectionId}
                  sectionId={sectionId}
                  label={SECTION_LABELS[sectionId]}
                  data={data}
                />
              );
            })}
          </div>
        ) : (
          <div className="card p-8 text-center text-textmid">
            No section data available
          </div>
        )}
      </div>
    );
  }

  return null;
}

// Section preview component
function SectionPreview({ sectionId, label, data }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="card overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-black/[0.02] transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-textdark">{label}</span>
          <span className="text-[11px] text-textlight">
            {Object.keys(data).length} fields
          </span>
        </div>
        <svg
          className={`w-4 h-4 text-textmid transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-black/5 p-4 space-y-3">
          {Object.entries(data).map(([key, value]) => (
            <FieldPreview key={key} fieldKey={key} value={value} />
          ))}
        </div>
      )}
    </div>
  );
}

// Field preview component — handles strings, arrays, objects
function FieldPreview({ fieldKey, value }) {
  const label = fieldKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  if (value === null || value === undefined) return null;

  // Array of objects (blocks)
  if (Array.isArray(value)) {
    if (value.length === 0) return (
      <div>
        <span className="text-xs font-medium text-textmid">{label}</span>
        <p className="text-xs text-textlight italic">Empty</p>
      </div>
    );

    return (
      <div>
        <span className="text-xs font-medium text-textmid mb-1 block">{label} ({value.length})</span>
        <div className="space-y-2 pl-3 border-l-2 border-black/5">
          {value.map((item, i) => (
            <div key={i} className="text-xs space-y-0.5">
              {typeof item === 'object' ? (
                Object.entries(item).map(([k, v]) => (
                  <div key={k}>
                    <span className="text-textlight">{k.replace(/_/g, ' ')}:</span>{' '}
                    <span className="text-textdark" dangerouslySetInnerHTML={
                      typeof v === 'string' && v.includes('<') ? { __html: v } : undefined
                    }>
                      {typeof v === 'string' && v.includes('<') ? undefined : String(v)}
                    </span>
                  </div>
                ))
              ) : (
                <span className="text-textdark">{String(item)}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // String value (may contain HTML)
  if (typeof value === 'string') {
    const isHtml = value.includes('<p>') || value.includes('<ul>') || value.includes('<ol>');
    return (
      <div>
        <span className="text-xs font-medium text-textmid">{label}</span>
        {isHtml ? (
          <div className="text-sm text-textdark mt-0.5 prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: value }} />
        ) : (
          <p className="text-sm text-textdark mt-0.5">{value}</p>
        )}
      </div>
    );
  }

  // Number or other primitive
  return (
    <div>
      <span className="text-xs font-medium text-textmid">{label}</span>
      <p className="text-sm text-textdark mt-0.5">{String(value)}</p>
    </div>
  );
}
