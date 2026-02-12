#!/bin/bash
# =============================================================================
# VPS Setup Script — Run once on a fresh Ubuntu 22.04/24.04 Hostinger VPS
# Usage: ssh root@YOUR_VPS_IP 'bash -s' < setup.sh
# =============================================================================

set -euo pipefail

echo "=== Updating system packages ==="
apt update && apt upgrade -y

echo "=== Installing essential tools ==="
apt install -y curl git build-essential

echo "=== Installing Node.js 22 LTS ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
echo "Node.js version: $(node -v)"
echo "npm version: $(npm -v)"

echo "=== Installing PM2 ==="
npm install -g pm2

echo "=== Installing Nginx ==="
apt install -y nginx
systemctl enable nginx
systemctl start nginx

echo "=== Installing Certbot (Let's Encrypt) ==="
apt install -y certbot python3-certbot-nginx

echo "=== Setting up application directory ==="
mkdir -p /opt/ad-platform/logs
mkdir -p /opt/ad-platform/backend/data/generated-images
mkdir -p /opt/ad-platform/backend/data/templates
mkdir -p /opt/ad-platform/backend/data/uploads
mkdir -p /opt/ad-platform/backend/data/batch-product-images
mkdir -p /opt/ad-platform/backend/data/inspiration

echo "=== Configuring UFW firewall ==="
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
echo "Firewall status:"
ufw status

echo "=== Setting up PM2 startup ==="
pm2 startup systemd -u root --hp /root
# If running as a non-root user, replace 'root' above with the username

echo ""
echo "============================================"
echo "  VPS setup complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Point your domain's A record to this server's IP"
echo "  2. Run deploy.sh from your local machine to push the app"
echo "  3. Set up Nginx config:"
echo "     - Copy nginx.conf to /etc/nginx/sites-available/ad-platform"
echo "     - Replace YOUR_DOMAIN with your actual domain"
echo "     - ln -s /etc/nginx/sites-available/ad-platform /etc/nginx/sites-enabled/"
echo "     - rm /etc/nginx/sites-enabled/default"
echo "     - nginx -t && systemctl reload nginx"
echo "  4. Get SSL certificate:"
echo "     - certbot --nginx -d YOUR_DOMAIN"
echo "  5. Start the app:"
echo "     - cd /opt/ad-platform && pm2 start deploy/ecosystem.config.cjs"
echo "     - pm2 save"
echo ""
