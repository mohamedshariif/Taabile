import { createApp } from './app.js';
import { env } from './config/env.js';

const app = createApp({ corsOrigin: env.APP_BASE_URL });
app.listen(env.PORT, () => {
  console.log(`Taabile API listening on http://localhost:${env.PORT}`);
});
