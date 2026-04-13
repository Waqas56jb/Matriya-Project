#!/usr/bin/env node
/**
 * Minimal HTTP server: only GET/POST under /api/lab (labChainRoutes).
 * For Milestone 1 proof when full management-back cannot start (missing Supabase keys).
 *
 * Requires: POSTGRES_URL in .env (same DB as lab chain).
 * Run from matriya-back root: node scripts/standaloneLabBridgeServer.js
 * Default port: 8001
 */
import 'dotenv/config';
import express from 'express';
import labChainRoutes from '../maneger-back--main/routes/labChainRoutes.js';

const port = parseInt(process.env.LAB_BRIDGE_PORT || process.env.PORT || '8001', 10);
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/lab', labChainRoutes);
app.get('/health', (_req, res) => res.json({ ok: true, service: 'standalone-lab-bridge' }));

app.listen(port, '0.0.0.0', () => {
  console.log(`standaloneLabBridgeServer listening http://127.0.0.1:${port}/api/lab/*`);
});
