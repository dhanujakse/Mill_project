import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import requestRoutes from './routes/requests.js';
import supplierRoutes from './routes/suppliers.js';
import logRoutes from './routes/logs.js';
import departmentRoutes from './routes/departments.js';
import notificationRoutes from './routes/notifications.js';
import settingsRoutes from './routes/settings.js';

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map(o => o.trim());
app.use(cors({ origin: allowedOrigins, credentials: false }));

// Requests/suppliers carry base64-encoded LR copies and proof-of-receipt
// photos inline, so the JSON body limit needs headroom beyond Express's 100kb default.
app.use(express.json({ limit: '15mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/settings', settingsRoutes);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Alagiri backend listening on http://localhost:${PORT}`);
});
