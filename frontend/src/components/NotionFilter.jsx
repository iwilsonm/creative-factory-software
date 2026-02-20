import { useState, useEffect, useRef } from 'react';

const PROPERTY_COLORS = {
  problem:   { bg: 'bg-blue-50',   text: 'text-blue-700',   border: 'border-blue-200',   dot: 'bg-blue-400',   hoverBg: 'hover:bg-blue-50'   },
  emotion:   { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', dot: 'bg-purple-400', hoverBg: 'hover:bg-purple-50' },
  tag:       { bg: 'bg-teal-50',   text: 'text-teal-700',   border: 'border-teal-200',   dot: 'bg-teal-400',   hoverBg: 'hover:bg-teal-50'   },
  technique: { bg: 'bg-amber-50',  text: 'text-amber-700',  border: 'border-amber-200',  dot: 'bg-amber-400',  hoverBg: 'hover:bg-amber-50'  },
  status:    { bg: 'bg-gray-50',   text: 'text-gray-700',   border: 'border-gray-200',   dot: 'bg-gray-400',   hoverBg: 'hover:bg-gray-50'   },
};

// properties: [{ key: 'problem', label: 'Problem', values: ['...'] }, ...]
// filters: Map<propertyKey, Set<selectedValues>>
// onToggle: (propertyKey, value) => void
// onClear: (propertyKey?) => void  — no arg = clear all
export default function NotionFilter({ properties, filters, onToggle, onClear }) {
  const [addingFilter, setAddingFilter] = useState(false);
  const [openDropdown, setOpenDropdown] = useState(null); // propertyKey or null
  const [searchText, setSearchText] = useState('');
  const dropdownRef = useRef(null);
  const addBtnRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target) &&
          addBtnRef.current && !addBtnRef.current.contains(e.target)) {
        setOpenDropdown(null);
        setAddingFilter(false);
        setSearchText('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Get active filter entries: [{ key, label, values: Set, colors }]
  const activeFilters = properties
    .filter(p => filters.get(p.key)?.size > 0)
    .map(p => ({ ...p, selected: filters.get(p.key), colors: PROPERTY_COLORS[p.key] || PROPERTY_COLORS.status }));

  const hasAnyFilter = activeFilters.length > 0;

  // Properties that have values to filter by
  const availableProps = properties.filter(p => p.values.length > 0);

  return (
    <div className="flex items-center gap-1.5 flex-wrap min-h-[28px]">
      {/* Active filter pills */}
      {activeFilters.map(af => (
        <div key={af.key} className="relative inline-flex">
          <button
            onClick={() => { setOpenDropdown(openDropdown === af.key ? null : af.key); setAddingFilter(false); setSearchText(''); }}
            className={`inline-flex items-center gap-1 text-[11px] pl-2 pr-1.5 py-1 rounded-lg border transition-all ${af.colors.bg} ${af.colors.text} ${af.colors.border}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${af.colors.dot}`} />
            <span className="font-medium">{af.label}</span>
            <span className="text-[10px] opacity-60">is</span>
            <span className="font-semibold max-w-[180px] truncate">
              {[...af.selected].join(', ')}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onClear(af.key); }}
              className="ml-0.5 opacity-50 hover:opacity-100 transition-opacity"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </button>

          {/* Value dropdown for existing filter */}
          {openDropdown === af.key && (
            <div ref={dropdownRef} className="absolute top-full left-0 mt-1 z-50 w-56 bg-white rounded-xl border border-gray-200 shadow-lg shadow-gray-200/50 overflow-hidden">
              <div className="p-1.5">
                <input
                  autoFocus
                  value={searchText}
                  onChange={e => setSearchText(e.target.value)}
                  placeholder={`Filter ${af.label.toLowerCase()}...`}
                  className="w-full text-[12px] px-2.5 py-1.5 rounded-lg border border-gray-200 outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-200 bg-gray-50/50"
                />
              </div>
              <div className="max-h-48 overflow-y-auto">
                {af.values
                  .filter(v => !searchText || v.toLowerCase().includes(searchText.toLowerCase()))
                  .map(v => {
                    const isSelected = af.selected.has(v);
                    return (
                      <button
                        key={v}
                        onClick={() => onToggle(af.key, v)}
                        className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left transition-colors ${
                          isSelected ? `${af.colors.bg} font-medium` : 'hover:bg-gray-50'
                        }`}
                      >
                        <span className={`flex-shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center ${
                          isSelected ? `${af.colors.border} ${af.colors.bg}` : 'border-gray-300'
                        }`}>
                          {isSelected && (
                            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                            </svg>
                          )}
                        </span>
                        <span className={`truncate ${isSelected ? af.colors.text : 'text-gray-700'}`}>{v}</span>
                      </button>
                    );
                  })}
              </div>
              <div className="border-t border-gray-100 px-3 py-1.5 flex items-center justify-between">
                <span className="text-[10px] text-gray-400">{af.selected.size} selected</span>
                <button onClick={() => onClear(af.key)} className="text-[10px] text-gray-400 hover:text-gray-600">Clear</button>
              </div>
            </div>
          )}
        </div>
      ))}

      {/* "+ Add a filter" button */}
      {availableProps.length > 0 && (
        <div className="relative inline-flex">
          <button
            ref={addBtnRef}
            onClick={() => { setAddingFilter(!addingFilter); setOpenDropdown(null); setSearchText(''); }}
            className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border border-dashed transition-all ${
              hasAnyFilter
                ? 'border-gray-200 text-gray-400 hover:border-gray-300 hover:text-gray-600'
                : 'border-gray-300 text-gray-500 hover:border-blue-300 hover:text-blue-600'
            }`}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" />
            </svg>
            {hasAnyFilter ? 'Add filter' : 'Filter'}
          </button>

          {/* Property picker dropdown */}
          {addingFilter && (
            <div ref={dropdownRef} className="absolute top-full left-0 mt-1 z-50 w-48 bg-white rounded-xl border border-gray-200 shadow-lg shadow-gray-200/50 overflow-hidden">
              <div className="px-3 py-2 border-b border-gray-100">
                <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Filter by property</p>
              </div>
              {availableProps.map(prop => {
                const colors = PROPERTY_COLORS[prop.key] || PROPERTY_COLORS.status;
                const isActive = filters.get(prop.key)?.size > 0;
                return (
                  <button
                    key={prop.key}
                    onClick={() => { setAddingFilter(false); setOpenDropdown(prop.key); setSearchText(''); }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12px] text-left transition-colors hover:bg-gray-50 ${isActive ? 'opacity-50' : ''}`}
                  >
                    <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
                    <span className="text-gray-700">{prop.label}</span>
                    <span className="text-[10px] text-gray-300 ml-auto">{prop.values.length}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Value dropdown for newly picked property (not yet in activeFilters) */}
          {openDropdown && !activeFilters.find(af => af.key === openDropdown) && (() => {
            const prop = properties.find(p => p.key === openDropdown);
            if (!prop) return null;
            const colors = PROPERTY_COLORS[prop.key] || PROPERTY_COLORS.status;
            const selected = filters.get(prop.key) || new Set();
            return (
              <div ref={dropdownRef} className="absolute top-full left-0 mt-1 z-50 w-56 bg-white rounded-xl border border-gray-200 shadow-lg shadow-gray-200/50 overflow-hidden">
                <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
                  <span className="text-[11px] font-medium text-gray-600">{prop.label}</span>
                </div>
                <div className="p-1.5">
                  <input
                    autoFocus
                    value={searchText}
                    onChange={e => setSearchText(e.target.value)}
                    placeholder={`Search ${prop.label.toLowerCase()}...`}
                    className="w-full text-[12px] px-2.5 py-1.5 rounded-lg border border-gray-200 outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-200 bg-gray-50/50"
                  />
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {prop.values
                    .filter(v => !searchText || v.toLowerCase().includes(searchText.toLowerCase()))
                    .map(v => {
                      const isSelected = selected.has(v);
                      return (
                        <button
                          key={v}
                          onClick={() => onToggle(prop.key, v)}
                          className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left transition-colors ${
                            isSelected ? `${colors.bg} font-medium` : 'hover:bg-gray-50'
                          }`}
                        >
                          <span className={`flex-shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center ${
                            isSelected ? `${colors.border} ${colors.bg}` : 'border-gray-300'
                          }`}>
                            {isSelected && (
                              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                              </svg>
                            )}
                          </span>
                          <span className={`truncate ${isSelected ? colors.text : 'text-gray-700'}`}>{v}</span>
                        </button>
                      );
                    })}
                </div>
                {selected.size > 0 && (
                  <div className="border-t border-gray-100 px-3 py-1.5 flex items-center justify-between">
                    <span className="text-[10px] text-gray-400">{selected.size} selected</span>
                    <button onClick={() => onClear(prop.key)} className="text-[10px] text-gray-400 hover:text-gray-600">Clear</button>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Clear all */}
      {hasAnyFilter && (
        <button
          onClick={() => onClear()}
          className="text-[10px] text-gray-400 hover:text-gray-600 transition-colors ml-1"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
