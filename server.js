require('dotenv').config();

const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const { createClient } = require('@libsql/client');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();

// ====== CORS (Render + Vercel) ======
const ALLOWED_ORIGINS = [
  'https://casa-kumis-frontend.vercel.app',
  'https://casa-kumis-frontend.onrender.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5500'
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ====== STATIC SOLO EN LOCAL (para pruebas) ======
const publicDir = path.join(__dirname, 'public');
if (process.env.NODE_ENV !== 'production' && fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// ====== Turso (ya con tablas creadas) ======
const turso = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN
});

(async () => {
  try {
    await turso.execute('SELECT 1;');
    console.log('✅ Conectado a Turso');
  } catch (e) {
    console.error('❌ Error conectando a Turso:', e.message);
  }
})();

// ====== Google Drive Auth ======
const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/drive.file']
});
const drive = google.drive({ version: 'v3', auth });

// ====== Multer (para subir archivos en memoria) ======
const upload = multer({ storage: multer.memoryStorage() });

// ====== Helper para enviar correos ======
async function enviarCorreo({ to, subject, html }) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_FROM,
      pass: process.env.EMAIL_PASS
    }
  });

  await transporter.sendMail({
    from: `"La Casa del Kumis" <${process.env.EMAIL_FROM}>`,
    to,
    subject,
    html
  });
}

// ====== Health check ======
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, ts: new Date().toISOString() });
});

// ====== POST /api/formulario ======
app.post('/api/formulario', upload.single('archivo'), async (req, res) => {
  try {
    const { nombre, email, telefono, cargo, mensaje } = req.body;
    const archivo = req.file;
    if (!archivo) return res.status(400).send('Archivo requerido.');

    const { Readable } = require('stream');
    const fileMetadata = { name: archivo.originalname };
    const media = { mimeType: archivo.mimetype, body: Readable.from(archivo.buffer) };

    const result = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id'
    });
    const fileId = result.data.id;

    await drive.files.update({ fileId, addParents: process.env.GOOGLE_FOLDER_ID });
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' }
    });

    const fileUrl = `https://drive.google.com/file/d/${fileId}/view`;
    const fecha = new Date().toISOString();

    await turso.execute({
      sql: `
        INSERT INTO postulaciones (nombre, email, telefono, cargo, mensaje, archivo_url, fecha_envio)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      args: [nombre, email, telefono, cargo, mensaje || '', fileUrl, fecha]
    });

    await enviarCorreo({
      to: [process.env.EMAIL_TO, process.env.EMAIL_CC].filter(Boolean),
      subject: `📩 Nueva postulación - ${nombre}`,
      html: `
        <h2>📋 Nueva postulación</h2>
        <ul>
          <li><b>Nombre:</b> ${nombre}</li>
          <li><b>Correo:</b> ${email}</li>
          <li><b>Teléfono:</b> ${telefono}</li>
          <li><b>Cargo:</b> ${cargo}</li>
          <li><b>Mensaje:</b> ${mensaje || '(Sin mensaje)'}</li>
          <li><b>Archivo:</b> <a href="${fileUrl}" target="_blank">Ver archivo</a></li>
          <li><b>Fecha:</b> ${new Date(fecha).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}</li>
        </ul>
      `
    });

    res.status(200).send('Formulario enviado con éxito.');
  } catch (error) {
    console.error('❌ Error /api/formulario:', error);
    res.status(500).send('Error al procesar el formulario.');
  }
});

// ====== GET /api/descargar-postulaciones ======
const { Parser } = require('json2csv');
app.get('/api/descargar-postulaciones', async (req, res) => {
  try {
    const result = await turso.execute('SELECT * FROM postulaciones ORDER BY fecha_envio DESC');
    const registros = result.rows || [];
    if (!registros.length) return res.status(404).send('No hay postulaciones registradas.');

    const dataLimpia = registros.map(r => ({
      Nombre: r.nombre,
      Correo: r.email,
      Teléfono: r.telefono,
      Cargo: r.cargo,
      Mensaje: r.mensaje,
      'Archivo (Google Drive)': r.archivo_url,
      'Fecha de Envío': new Date(r.fecha_envio).toLocaleString('es-CO', { timeZone: 'America/Bogota', hour12: true })
    }));

    const parser = new Parser({ fields: Object.keys(dataLimpia[0]), delimiter: ';' });
    const csv = parser.parse(dataLimpia);
    const bom = '\uFEFF';

    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.attachment('postulaciones.csv');
    res.send(bom + csv);
  } catch (err) {
    console.error('❌ Error generando CSV:', err);
    res.status(500).send('Error al generar el archivo.');
  }
});

// ====== POST /api/quejas ======
app.post('/api/quejas', upload.single('archivo'), async (req, res) => {
  try {
    const { nombre, email, telefono, sucursal, asunto, mensaje } = req.body;
    const archivo = req.file;

    let fileUrl = '';
    if (archivo) {
      const { Readable } = require('stream');
      const result = await drive.files.create({
        resource: { name: archivo.originalname },
        media: { mimeType: archivo.mimetype, body: Readable.from(archivo.buffer) },
        fields: 'id'
      });
      const fileId = result.data.id;

      await drive.files.update({
        fileId,
        addParents: process.env.GOOGLE_FOLDER_QUEJAS_ID || process.env.GOOGLE_FOLDER_ID
      });
      await drive.permissions.create({
        fileId,
        requestBody: { role: 'reader', type: 'anyone' }
      });
      fileUrl = `https://drive.google.com/file/d/${fileId}/view`;
    }

    const fecha = new Date().toISOString();
    await turso.execute({
      sql: `
        INSERT INTO quejas (nombre, email, telefono, sucursal, asunto, mensaje, archivo_url, fecha_envio)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [nombre, email, telefono, sucursal, asunto, mensaje || '', fileUrl, fecha]
    });

    await enviarCorreo({
      to: [process.env.EMAIL_TO, process.env.EMAIL_CC].filter(Boolean),
      subject: `[QUEJA] ${asunto} - ${nombre}`,
      html: `
        <h2>Formulario de Quejas</h2>
        <p><b>Nombre:</b> ${nombre}</p>
        <p><b>Email:</b> ${email}</p>
        <p><b>Teléfono:</b> ${telefono}</p>
        <p><b>Sucursal:</b> ${sucursal}</p>
        <p><b>Asunto:</b> ${asunto}</p>
        <p><b>Mensaje:</b><br>${mensaje || ''}</p>
        ${fileUrl ? `<p><b>Archivo:</b> <a href="${fileUrl}" target="_blank">Ver archivo</a></p>` : ''}
      `
    });

    res.status(200).send('✅ Queja enviada con éxito');
  } catch (err) {
    console.error('❌ Error /api/quejas:', err);
    res.status(500).send('❌ Error al enviar la queja.');
  }
});

// ====== Arranque ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en http://localhost:${PORT}`);
});
