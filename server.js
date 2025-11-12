require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const { createClient } = require('@libsql/client'); // Turso
const nodemailer = require('nodemailer');
const path = require('path');
const { Parser } = require('json2csv');

const app = express();

// -------- Middlewares base --------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// -------- Turso (BD) --------
const turso = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

// Crea tablas si no existen
(async () => {
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS postulaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT,
      email TEXT,
      telefono TEXT,
      cargo TEXT,
      mensaje TEXT,
      archivo_url TEXT,
      fecha_envio TEXT
    );
  `);

  await turso.execute(`
    CREATE TABLE IF NOT EXISTS quejas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT,
      email TEXT,
      telefono TEXT,
      sucursal TEXT,
      asunto TEXT,
      mensaje TEXT,
      archivo_url TEXT,
      fecha_envio TEXT
    );
  `);
})().catch(err => console.error('Error creando tablas:', err));

// -------- Google Drive --------
const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});
const drive = google.drive({ version: 'v3', auth });

const FOLDER_POSTULACIONES = process.env.GOOGLE_FOLDER_ID;           // Carpeta para /api/formulario
const FOLDER_QUEJAS = process.env.GOOGLE_FOLDER_QUEJAS_ID || FOLDER_POSTULACIONES;

// -------- Subida de archivos (memoria) --------
const upload = multer({ storage: multer.memoryStorage() });

// -------- Correo --------
async function enviarCorreo({ to, subject, html }) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_PASS }, // usa App Password
  });

  await transporter.sendMail({
    from: `"La Casa del Kumis" <${process.env.EMAIL_FROM}>`,
    to,
    subject,
    html,
  });
}

// -------- Util: subir archivo a Drive y hacerlo público --------
async function subirAStorageDrive({ buffer, originalname, mimetype, folderId }) {
  const { Readable } = require('stream');

  // 1) Crear archivo
  const createRes = await drive.files.create({
    requestBody: { name: originalname },
    media: { mimeType: mimetype, body: Readable.from(buffer) },
    fields: 'id',
  });

  const fileId = createRes.data.id;

  // 2) Mover a carpeta
  if (folderId) {
    await drive.files.update({
      fileId,
      addParents: folderId,
      fields: 'id, parents',
    });
  }

  // 3) Hacer público (lector)
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return `https://drive.google.com/file/d/${fileId}/view`;
}

// ================== RUTAS API ==================

// POST /api/formulario  (Trabaja con nosotros)
app.post('/api/formulario', upload.single('archivo'), async (req, res) => {
  try {
    const { nombre, email, telefono, cargo, mensaje } = req.body;

    // Archivo opcional pero recomendado
    let fileUrl = '';
    if (req.file) {
      fileUrl = await subirAStorageDrive({
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        folderId: FOLDER_POSTULACIONES,
      });
    }

    const fecha = new Date().toISOString();

    // Guardar en Turso
    await turso.execute({
      sql: `
        INSERT INTO postulaciones (nombre, email, telefono, cargo, mensaje, archivo_url, fecha_envio)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      args: [nombre, email, telefono, cargo, mensaje || '', fileUrl, fecha],
    });

    // Correo (opcional pero configurado)
    if (process.env.EMAIL_TO) {
      await enviarCorreo({
        to: [process.env.EMAIL_TO, process.env.EMAIL_CC].filter(Boolean),
        subject: `📩 Nueva postulación - ${nombre || 'Sin nombre'}`,
        html: `
          <h2>📋 Nueva postulación recibida</h2>
          <ul>
            <li><strong>Nombre:</strong> ${nombre || '-'}</li>
            <li><strong>Correo:</strong> ${email || '-'}</li>
            <li><strong>Teléfono:</strong> ${telefono || '-'}</li>
            <li><strong>Cargo:</strong> ${cargo || '-'}</li>
            <li><strong>Mensaje:</strong> ${mensaje || '(Sin mensaje)'}</li>
            <li><strong>Archivo:</strong> ${fileUrl ? `<a href="${fileUrl}" target="_blank">Ver archivo</a>` : '—'}</li>
            <li><strong>Fecha:</strong> ${new Date(fecha).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}</li>
          </ul>
        `,
      });
    }

    res.status(200).json({ ok: true, message: 'Formulario enviado con éxito.' });
  } catch (error) {
    console.error('❌ Error /api/formulario:', error);
    res.status(500).json({ ok: false, message: 'Error al procesar el formulario.' });
  }
});

// GET /api/descargar-postulaciones (CSV UTF-8 con BOM y ; para Excel)
app.get('/api/descargar-postulaciones', async (_req, res) => {
  try {
    const result = await turso.execute('SELECT * FROM postulaciones ORDER BY fecha_envio DESC');
    const registros = result.rows || [];
    if (!registros.length) return res.status(404).send('No hay postulaciones registradas.');

    const data = registros.map(r => ({
      Nombre: r.nombre,
      Correo: r.email,
      Teléfono: r.telefono,
      Cargo: r.cargo,
      Mensaje: r.mensaje,
      'Archivo (Google Drive)': r.archivo_url,
      'Fecha de Envío': new Date(r.fecha_envio).toLocaleString('es-CO', { timeZone: 'America/Bogota', hour12: true }),
    }));

    const parser = new Parser({ fields: Object.keys(data[0]), delimiter: ';' });
    const csv = '\uFEFF' + parser.parse(data); // BOM

    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.attachment('postulaciones.csv');
    res.send(csv);
  } catch (error) {
    console.error('❌ Error generando CSV:', error);
    res.status(500).send('Error al generar el archivo.');
  }
});

// POST /api/quejas  (archivo opcional)
app.post('/api/quejas', upload.single('archivo'), async (req, res) => {
  try {
    const { nombre, email, telefono, sucursal, asunto, mensaje } = req.body;

    let fileUrl = '';
    if (req.file) {
      fileUrl = await subirAStorageDrive({
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        folderId: FOLDER_QUEJAS,
      });
    }

    const fecha = new Date().toISOString();

    await turso.execute({
      sql: `
        INSERT INTO quejas (nombre, email, telefono, sucursal, asunto, mensaje, archivo_url, fecha_envio)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [nombre, email, telefono, sucursal, asunto, mensaje || '', fileUrl, fecha],
    });

    if (process.env.EMAIL_TO) {
      await enviarCorreo({
        to: [process.env.EMAIL_TO, process.env.EMAIL_CC].filter(Boolean),
        subject: `[QUEJA] ${asunto || '(Sin asunto)'} - ${nombre || 'Usuario'}`,
        html: `
          <h2>Formulario de Quejas</h2>
          <p><strong>Nombre:</strong> ${nombre || '-'}</p>
          <p><strong>Email:</strong> ${email || '-'}</p>
          <p><strong>Teléfono:</strong> ${telefono || '-'}</p>
          <p><strong>Sucursal:</strong> ${sucursal || '-'}</p>
          <p><strong>Asunto:</strong> ${asunto || '-'}</p>
          <p><strong>Mensaje:</strong><br>${(mensaje || '').replace(/\n/g, '<br>')}</p>
          ${fileUrl ? `<p><strong>Archivo:</strong> <a href="${fileUrl}" target="_blank">Ver archivo</a></p>` : ''}
        `,
      });
    }

    res.status(200).json({ ok: true, message: '✅ Queja enviada con éxito' });
  } catch (error) {
    console.error('❌ Error /api/quejas:', error);
    res.status(500).json({ ok: false, message: '❌ Error al enviar la queja.' });
  }
});

// Healthcheck sencillo
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Fallback SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Arranque
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor escuchando en http://localhost:${PORT}`));
