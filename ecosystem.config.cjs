// PM2 keeps the API running: restarts it if it crashes or leaks memory, backs
// off if it keeps failing (e.g. port taken, database unreachable at boot),
// and brings it back after a reboot (see scripts/install-autostart.ps1).
//
//   npm run serve          build, then start or reload under PM2
//   npm run serve:status   is it up? restarts, memory, uptime
//   npm run serve:logs     follow the logs
//   npm run serve:stop     stop it (stays stopped until `npm run serve`)
//
// Don't also run `npm run start:dev` — both want port 3000.
module.exports = {
  apps: [
    {
      name: 'lazo-api',
      cwd: __dirname,
      script: 'dist/main.js',
      node_args: '--enable-source-maps',
      exec_mode: 'fork',
      instances: 1,

      autorestart: true,
      // Wait before restarting, doubling up to ~15s while it keeps failing.
      exp_backoff_restart_delay: 500,
      // A start that survives 10s counts as healthy and resets the backoff.
      min_uptime: '10s',
      max_restarts: 1000,
      // Restart before a leak can take the machine down.
      max_memory_restart: '700M',
      // Time for enableShutdownHooks() to close connections on restart.
      kill_timeout: 10000,

      time: true,
      merge_logs: true,
      out_file: 'logs/api-out.log',
      error_file: 'logs/api-error.log',

      env: {
        PORT: 3000,
      },
      // pm2 start ecosystem.config.cjs --env production
      env_production: {
        PORT: 3000,
        NODE_ENV: 'production',
      },
    },
  ],
};
