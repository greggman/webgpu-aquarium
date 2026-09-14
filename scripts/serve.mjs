// Local static server for dist/ (express).
//
//   node scripts/serve.mjs [port]
import express from 'express';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';

export function startServer(dir, port = 8080) {
  const app = express();
  app.use(express.static(dir, {etag: false, lastModified: false}));
  return new Promise(resolve => {
    const server = app.listen(port, () => {
      const actual = server.address().port;
      console.log(`[serve] http://localhost:${actual}/`);
      resolve({server, port: actual});
    });
  });
}

if (process.argv[1] === url.fileURLToPath(import.meta.url)) {
  const dir = path.resolve(import.meta.dirname, '../dist');
  await startServer(dir, Number(process.argv[2] ?? 8080));
}
