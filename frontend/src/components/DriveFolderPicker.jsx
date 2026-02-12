import { useState, useEffect } from 'react';
import { api } from '../api';

export default function DriveFolderPicker({ value, onChange, label }) {
  const [open, setOpen] = useState(false);
  const [driveOk, setDriveOk] = useState(null); // null = loading, true/false
  const [serviceEmail, setServiceEmail] = useState('');
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [atRoot, setAtRoot] = useState(true);
  const [breadcrumb, setBreadcrumb] = useState([]);
  const [selectedId, setSelectedId] = useState(value || '');
  const [selectedName, setSelectedName] = useState('');
  const [error, setError] = useState('');
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    if (open) {
      // Always re-fetch status and folders when opening — each picker
      // instance needs fresh data (folders may have been shared since last open)
      api.driveStatus().then(data => {
        setDriveOk(data.configured);
        setServiceEmail(data.serviceAccountEmail || '');
        if (data.configured) loadFolders(null);
      }).catch(() => setDriveOk(false));
    }
  }, [open]);

  // If there's an existing value, try to get its name
  useEffect(() => {
    if (value && !selectedName) {
      api.driveFolderInfo(value).then(data => {
        setSelectedName(data.folder.name);
      }).catch(() => {});
    }
  }, [value]);

  const loadFolders = async (parentId) => {
    setLoading(true);
    setError('');
    setAtRoot(!parentId);
    try {
      const data = await api.driveFolders(parentId);
      setFolders(data.folders);

      if (parentId) {
        const info = await api.driveFolderInfo(parentId);
        setBreadcrumb(info.breadcrumb);
      } else {
        setBreadcrumb([]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (folder) => {
    setSelectedId(folder.id);
    setSelectedName(folder.name);
  };

  const handleConfirm = () => {
    onChange(selectedId);
    setOpen(false);
  };

  const handleNavigate = (folder) => {
    loadFolders(folder.id);
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Google Drive folder ID"
        />
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="border border-gray-300 px-3 py-2 rounded-md text-sm hover:bg-gray-50 whitespace-nowrap"
        >
          Browse
        </button>
      </div>
      {selectedName && value && (
        <p className="text-xs text-gray-500 mt-1">📁 {selectedName}</p>
      )}

      {/* Folder browser modal */}
      {open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
            <div className="p-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="font-semibold text-gray-900">{label}</h3>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
            </div>

            {driveOk === false && (
              <div className="p-6 text-center">
                <p className="text-gray-500 mb-2">Google Drive not configured.</p>
                <p className="text-xs text-gray-400">
                  Place your <code className="bg-gray-100 px-1 rounded">service-account.json</code> in the <code className="bg-gray-100 px-1 rounded">config/</code> directory, then share your Drive folders with the service account email.
                </p>
              </div>
            )}

            {driveOk && (
              <>
                {/* Breadcrumb */}
                <div className="px-4 pt-3 flex flex-wrap items-center gap-1 text-xs text-gray-500">
                  <button
                    onClick={() => loadFolders(null)}
                    className="hover:text-blue-600 font-medium"
                  >
                    Root
                  </button>
                  {breadcrumb.map((item, i) => (
                    <span key={item.id} className="flex items-center gap-1">
                      <span>/</span>
                      <button
                        onClick={() => loadFolders(item.id)}
                        className="hover:text-blue-600"
                      >
                        {item.name}
                      </button>
                    </span>
                  ))}
                </div>

                {error && (
                  <div className="mx-4 mt-2 bg-red-50 text-red-700 text-xs rounded p-2">{error}</div>
                )}

                {/* Folder list */}
                <div className="flex-1 overflow-y-auto p-4">
                  {loading ? (
                    <p className="text-gray-400 text-sm text-center py-4">Loading...</p>
                  ) : folders.length === 0 ? (
                    <p className="text-gray-400 text-sm text-center py-4">
                      {atRoot ? 'No folders shared with this service account yet.' : 'This folder is empty.'}
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {folders.map(folder => (
                        <div
                          key={folder.id}
                          className={`flex items-center justify-between px-3 py-2 rounded cursor-pointer ${
                            selectedId === folder.id ? 'bg-blue-50 border border-blue-200' : 'hover:bg-gray-50'
                          }`}
                          onClick={() => handleSelect(folder)}
                          onDoubleClick={() => handleNavigate(folder)}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-yellow-500">📁</span>
                            <span className="text-sm text-gray-900">{folder.name}</span>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleNavigate(folder); }}
                            className="text-xs text-gray-400 hover:text-blue-600"
                          >
                            Open →
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Share a new folder — always visible at root */}
                {atRoot && serviceEmail && (
                  <div className="px-4 pb-3">
                    <button
                      type="button"
                      onClick={() => setShowHelp(!showHelp)}
                      className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
                    >
                      <span>{showHelp ? '▾' : '▸'}</span>
                      Don't see your folder? Share it with the service account
                    </button>
                    {showHelp && (
                      <div className="mt-2 bg-blue-50 border border-blue-200 rounded-md p-3">
                        <ol className="text-xs text-blue-700 space-y-1 list-decimal list-inside">
                          <li>Open Google Drive in your browser</li>
                          <li>Right-click the folder you want to use</li>
                          <li>Click <strong>Share</strong></li>
                          <li>Add this email as an <strong>Editor</strong>:</li>
                        </ol>
                        <div className="mt-2 bg-white rounded px-2 py-1.5 text-xs font-mono text-blue-900 select-all break-all border border-blue-200">
                          {serviceEmail}
                        </div>
                        <button
                          onClick={() => loadFolders(null)}
                          className="mt-2 text-xs text-blue-600 hover:underline"
                        >
                          Refresh folder list
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Footer */}
                <div className="p-4 border-t border-gray-200 flex items-center justify-between">
                  <p className="text-xs text-gray-500">
                    {selectedName ? `Selected: ${selectedName}` : 'Click a folder to select, double-click to open'}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setOpen(false)}
                      className="border border-gray-300 px-3 py-1.5 rounded text-sm hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleConfirm}
                      disabled={!selectedId}
                      className="bg-blue-600 text-white px-3 py-1.5 rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                    >
                      Select Folder
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
