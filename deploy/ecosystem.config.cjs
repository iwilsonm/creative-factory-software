module.exports = {
  apps: [
    {
      name: 'ad-platform',
      script: 'server.js',
      cwd: '/opt/ad-platform/backend',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        CONVEX_URL: 'https://energized-hare-760.convex.cloud'
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      max_memory_restart: '2G',
      error_file: '/opt/ad-platform/logs/error.log',
      out_file: '/opt/ad-platform/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true
    }
  ]
};
