import { config } from 'dotenv';
config({ path: '/workspaces/three.ws/.env' });
config({ path: '/workspaces/three.ws/.env.local' });
await import('/workspaces/three.ws/server/index.mjs');
