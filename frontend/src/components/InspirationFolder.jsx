import { useState, useEffect } from 'react';
import { api } from '../api';

export default function InspirationFolder({ projectId, inspirationFolderId }) {
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [syncResult, setSyncResult] = useState(null);
  const [viewImage, setViewImage] = useState(null);

  useEffect(() => {
    if (inspirationFolderId) {
      loadImages();
    } else {
      setLoading(false);
    }
  }, [projectId, inspirationFolderId]);

  const loadImages = async () => {
    try {
      setError('');
      const data = await api.getInspirationImages(projectId);
      setImages(data.images || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setError('');
    setSyncResult(null);
    try {
      const result = await api.syncInspiration(projectId);
      setImages(result.images || []);
      setSyncResult({ synced: result.synced, removed: result.removed, total: result.total });
      setTimeout(() => setSyncResult(null), 5000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  };

  // No folder configured
  if (!inspirationFolderId) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
        <div className="text-4xl mb-3">📁</div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">No Inspiration Folder Configured</h3>
        <p className="text-sm text-gray-500 max-w-md mx-auto">
          Set an Inspiration Folder ID in the project's Overview tab to sync reference images from Google Drive.
          These images will be used as inspiration for ad generation.
        </p>
      </div>
    );
  }

  if (loading) {
    return <div className="text-gray-400 text-center py-8 animate-pulse">Loading inspiration images...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500">
            {images.length} image{images.length !== 1 ? 's' : ''} synced from Google Drive
          </p>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {syncing ? (
            <>
              <span className="animate-spin">&#8635;</span> Syncing...
            </>
          ) : (
            <>
              <span>&#8635;</span> Sync Now
            </>
          )}
        </button>
      </div>

      {/* Sync result */}
      {syncResult && (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded p-3">
          Sync complete: {syncResult.total} images total
          {syncResult.synced > 0 && `, ${syncResult.synced} new`}
          {syncResult.removed > 0 && `, ${syncResult.removed} removed`}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded p-3">
          {error}
        </div>
      )}

      {/* Empty state */}
      {images.length === 0 && !error && (
        <div className="bg-white rounded-lg shadow-sm border border-dashed border-gray-300 p-8 text-center">
          <div className="text-3xl mb-3">🖼️</div>
          <h3 className="font-medium text-gray-600 mb-2">No Images Found</h3>
          <p className="text-sm text-gray-400 max-w-md mx-auto">
            Add images to your Google Drive inspiration folder, then click "Sync Now" to pull them in.
          </p>
        </div>
      )}

      {/* Image grid */}
      {images.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {images.map(img => (
            <div
              key={img.id}
              className="group relative bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => setViewImage(img)}
            >
              <div className="aspect-square bg-gray-100">
                <img
                  src={img.thumbnailUrl}
                  alt={img.name}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              </div>
              <div className="p-2">
                <p className="text-xs text-gray-600 truncate" title={img.name}>
                  {img.name}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Full-size image modal */}
      {viewImage && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
          onClick={() => setViewImage(null)}
        >
          <div
            className="relative max-w-4xl max-h-[90vh] bg-white rounded-lg overflow-hidden shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-200">
              <p className="text-sm font-medium text-gray-900 truncate">{viewImage.name}</p>
              <button
                onClick={() => setViewImage(null)}
                className="text-gray-400 hover:text-gray-600 text-lg"
              >
                &times;
              </button>
            </div>
            <div className="p-2 flex items-center justify-center bg-gray-50" style={{ maxHeight: 'calc(90vh - 60px)' }}>
              <img
                src={viewImage.thumbnailUrl}
                alt={viewImage.name}
                className="max-w-full max-h-[80vh] object-contain"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
