// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import { createClient } from '@libsql/client';

const app = express();

// --- CORS (ajusta origen para producción si usas dominio propio) ---
app.use(cors({ origin: true }));
app.use(express.json());

// --- Multer (memoria, 10 MB máx) ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    // whitelist simple (puedes ampliar)
    const ok = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/png'
    ].includes(file.mimetype);
    cb(ok ? null : new Error('Tipo de archivo no permitido'));
  }
});

// --- LibSQL/Turso ---
const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN
});

// --- Google Drive (Service Account) ---
const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/drive.file']
});
const drive = google.drive({ version: 'v3', auth });

// Helper: subir archivo a Drive
async function uploadToDrive(buffer, filename, mimetype, parentFolderId) {
  if (!buffer) return { id: null, url: null };

  const res = await drive.files.create({
    requestBody: { name: filename, parents: [parentFolderId] },
    media: { mimeType: mimetype, body: Buffer.from(buffer) }
  });

  const fileId = res.data.id;

  // Compartir con enlace (lectura)
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  const url = `https://drive.google.com/file/d/${fileId}/view`;
  return { id: fileId, url };
}

// --- Email (Gmail App Password) ---
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_PASS
  }
});
async function sendMail({ subject, html }) {
  const to = process.env.EMAIL_TO;
  const cc = process.env.EMAIL_CC || '';
  await transporter.sendMail({
    from: `"Casa del Kumis" <${process.env.EMAIL_FROM}>`,
    to,
    cc,
    subject,
    html
  });
}

// --- Util ---
const genId = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();

// Rate-limit MUY simple por IP (opcional)
const hits = new Map();
app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0] || req.socket.remoteAddress || 'unknown';
  const k = `${ip}:${new Date().getMinutes()}`;
  hits.set(k, (hits.get(k) || 0) + 1);
  if (hits.get(k) > 60) return res.status(429).send('Demasiadas solicitudes. Intenta en 1 minuto.');
  next();
});

// ---- ENDPOINT: /api/formulario  (trabaja.html) ----
app.post('/api/formulario', upload.single('archivo'), async (req, res) => {
  try {
    const { nombre, email, telefono, cargo, mensaje = '' } = req.body || {};
    if (!nombre || !email || !telefono || !cargo) {
      return res.status(400).send('Faltan campos obligatorios.');
    }

    // Subir archivo a la carpeta general de HV
    const parentFolderId = process.env.GOOGLE_FOLDER_ID;
    let drive_file_id = null;
    let drive_file_url = null;
    if (req.file) {
      const safeName = `HV_${nombre.replace(/\s+/g, '_')}_${Date.now()}`;
      const up = await uploadToDrive(req.file.buffer, safeName, req.file.mimetype, parentFolderId);
      drive_file_id = up.id;
      drive_file_url = up.url;
    }

    const id = genId();
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0] || req.socket.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;

    await db.execute({
      sql: `INSERT INTO postulaciones (id, nombre, email, telefono, cargo, mensaje, drive_file_id, drive_file_url, ip, user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, nombre, email, telefono, cargo, mensaje, drive_file_id, drive_file_url, ip, ua]
    });

    // Email notificación
    await sendMail({
      subject: `Nueva postulación: ${nombre} • ${cargo}`,
      html: `
        <h2>Nueva postulación</h2>
        <ul>
          <li><b>Nombre:</b> ${nombre}</li>
          <li><b>Email:</b> ${email}</li>
          <li><b>Teléfono:</b> ${telefono}</li>
          <li><b>Cargo:</b> ${cargo}</li>
          <li><b>Mensaje:</b> ${mensaje || '(sin mensaje)'}</li>
          <li><b>Archivo:</b> ${drive_file_url ? `<a href="${drive_file_url}">Ver en Drive</a>` : 'No adjunto'}</li>
          <li><b>Fecha:</b> ${nowISO()}</li>
        </ul>`
    });

    // El frontend espera texto
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Error /api/formulario:', err);
    return res.status(500).send('Error del servidor.');
  }
});

// ---- ENDPOINT: /api/quejas  (quejas.html) ----
app.post('/api/quejas', upload.single('archivo'), async (req, res) => {
  try {
    const { nombre, email, telefono, sucursal, asunto, mensaje } = req.body || {};
    if (!nombre || !email || !telefono || !sucursal || !asunto || !mensaje) {
      return res.status(400).send('Faltan campos obligatorios.');
    }

    // Subir archivo a la carpeta específica de QUEJAS
    const parentFolderId = process.env.GOOGLE_FOLDER_QUEJAS_ID || process.env.GOOGLE_FOLDER_ID;
    let drive_file_id = null;
    let drive_file_url = null;
    if (req.file) {
      const safeName = `QUEJA_${nombre.replace(/\s+/g, '_')}_${Date.now()}`;
      const up = await uploadToDrive(req.file.buffer, safeName, req.file.mimetype, parentFolderId);
      drive_file_id = up.id;
      drive_file_url = up.url;
    }

    const id = genId();
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0] || req.socket.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;

    await db.execute({
      sql: `INSERT INTO quejas (id, nombre, email, telefono, sucursal, asunto, mensaje, drive_file_id, drive_file_url, ip, user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, nombre, email, telefono, sucursal, asunto, mensaje, drive_file_id, drive_file_url, ip, ua]
    });

    // Email notificación
    await sendMail({
      subject: `Nuevo mensaje (${asunto}) de ${nombre}`,
      html: `
        <h2>Nuevo mensaje de PQRSF</h2>
        <ul>
          <li><b>Nombre:</b> ${nombre}</li>
          <li><b>Email:</b> ${email}</li>
          <li><b>Teléfono:</b> ${telefono}</li>
          <li><b>Sucursal:</b> ${sucursal}</li>
          <li><b>Asunto:</b> ${asunto}</li>
          <li><b>Mensaje:</b> ${mensaje}</li>
          <li><b>Adjunto:</b> ${drive_file_url ? `<a href="${drive_file_url}">Ver en Drive</a>` : 'No adjunto'}</li>
          <li><b>Fecha:</b> ${nowISO()}</li>
        </ul>`
    });

    // El frontend espera texto
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Error /api/quejas:', err);
    return res.status(500).send('Error del servidor.');
  }
});

// --- Estático (si sirves también el frontend con Express) ---
app.use(express.static('public')); // o la carpeta donde tengas .html

// --- Arranque ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en :${PORT}`);
});
