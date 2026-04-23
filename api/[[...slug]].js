// Vercel catch-all serverless handler.
// All /api/* requests route through here; the Express app dispatches internally.
import app from '../backend/server.js';
export default app;
