'use strict';

// pm2-runtime config for the Docker image. Kept to a single instance —
// room state lives in-process memory (see README), so clustering here
// would split members/activity state across workers just like unsticky Docker
// replicas would.
module.exports = {
  apps: [
    {
      name: 'lfg-buddy',
      script: 'index.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '300M',
      // pm2-runtime is PID 1 in the container — stream straight to
      // stdout/stderr instead of writing log files no one will read.
      out_file: '/dev/stdout',
      error_file: '/dev/stderr',
      merge_logs: true,
    },
  ],
};
