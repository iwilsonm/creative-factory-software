#!/bin/bash
# =============================================================================
# Deploy Script — Run from your local machine to push updates to the VPS
#
# Usage:
#   VPS_HOST=your-vps-ip ./deploy.sh
#   VPS_HOST=your-vps-ip VPS_USER=root ./deploy.sh
# =============================================================================

set -euo pipefail

VPS_USER="${VPS_USER:-root}"
VPS_HOST="${VPS_HOST:?Set VPS_HOST to your server IP or domain}"
REMOTE_DIR="/opt/ad-platform"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Deploying from ${LOCAL_DIR} to ${VPS_USER}@${VPS_HOST}:${REMOTE_DIR} ==="

echo "=== Syncing files to VPS ==="
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.tmp' \
  --exclude 'backend/data/app.db' \
  --exclude 'backend/data/app.db-wal' \
  --exclude 'backend/data/app.db-shm' \
  --exclude 'backend/data/generated-images' \
  --exclude 'backend/data/templates' \
  --exclude 'backend/data/uploads' \
  --exclude 'backend/data/batch-product-images' \
  --exclude 'backend/data/inspiration' \
  --exclude 'backend/config/service-account.json' \
  --exclude 'frontend/dist' \
  --exclude '.vite' \
  --exclude '.claude' \
  "${LOCAL_DIR}/" "${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/"

echo "=== Installing backend dependencies ==="
ssh "${VPS_USER}@${VPS_HOST}" "cd ${REMOTE_DIR}/backend && npm install --production"

echo "=== Installing frontend dependencies & building ==="
ssh "${VPS_USER}@${VPS_HOST}" "cd ${REMOTE_DIR}/frontend && npm install && npm run build"

echo "=== Restarting application ==="
ssh "${VPS_USER}@${VPS_HOST}" "cd ${REMOTE_DIR} && pm2 restart ad-platform --update-env 2>/dev/null || pm2 start deploy/ecosystem.config.cjs"
ssh "${VPS_USER}@${VPS_HOST}" "pm2 save"

echo ""
echo "=== Deploy complete! ==="
echo "Check status: ssh ${VPS_USER}@${VPS_HOST} 'pm2 status'"
echo "View logs:    ssh ${VPS_USER}@${VPS_HOST} 'pm2 logs ad-platform'"
echo ""
