const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const admin  = require('firebase-admin');

// En producción (Render): usa variable de entorno FIREBASE_CREDENTIALS
// En local: usa el archivo JSON directamente
let serviceAccount;
if (process.env.FIREBASE_CREDENTIALS) {
  serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
} else {
  serviceAccount = require('./homealert-709d1-0a6c04c11a81.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://homealert-709d1-default-rtdb.firebaseio.com'
});

const db   = admin.firestore();
const rtdb = admin.database(); // Realtime Database para heartbeat
const auth = admin.auth();

const ADMIN_EMAIL      = 'administrador@homealert.com';
const FIREBASE_API_KEY = 'AIzaSyCODauFIh1T0shlPCmRVszZKpOj6tJyFsk';
const GOOGLE_WEB_CLIENT_ID = '354930817838-5jo3jkem1pib51qdq16rmq44ps29biu9.apps.googleusercontent.com';
const HEARTBEAT_TIMEOUT = 10; // segundos sin heartbeat = sabotaje
const ADMIN_SOUND_MAP = {
  admin_sound_01: 'sounds/admin_sound_01.wav',
  admin_sound_02: 'sounds/admin_sound_02.wav',
  admin_sound_03: 'sounds/admin_sound_03.wav',
  admin_sound_04: 'sounds/admin_sound_04.wav',
  admin_sound_05: 'sounds/admin_sound_05.wav',
  admin_sound_06: 'sounds/admin_sound_06.wav',
  admin_sound_07: 'sounds/admin_sound_07.wav',
  admin_sound_08: 'sounds/admin_sound_08.wav',
  admin_sound_09: 'sounds/admin_sound_09.wav',
  admin_sound_10: 'sounds/admin_sound_10.wav',
};

function soundFieldForLevel(nivel = '') {
  switch (String(nivel).toLowerCase().trim()) {
    case 'leve':
      return 'sonidoLeve';
    case 'severo':
      return 'sonidoSevero';
    default:
      return 'sonidoModerado';
  }
}

async function resolverSonidoAlerta({ uid = '', nivel = 'moderado', adminSoundId = '', sonidoAlerta = '' }) {
  const sonidoDirecto = String(sonidoAlerta || '').trim();
  if (sonidoDirecto) return sonidoDirecto;

  const sonidoAdmin = ADMIN_SOUND_MAP[String(adminSoundId || '').trim()] || '';
  if (sonidoAdmin) return sonidoAdmin;

  if (!esIdSeguro(uid)) return '';

  try {
    const sistemaSnap = await db.collection('sistema').doc(uid).get();
    const sistema = sistemaSnap.data() || {};
    const field = soundFieldForLevel(nivel);
    return String(sistema[field] || '').trim();
  } catch (e) {
    console.error(`Error resolviendo sonido del usuario ${uid}:`, e.message);
    return '';
  }
}

function esIdSeguro(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length < 80
    && /^[a-zA-Z0-9_-]+$/.test(value);
}

function isEntrada(tipoId = '') {
  return ['pir', 'door', 'smoke', 'temp'].includes(String(tipoId).toLowerCase());
}

function timestampToSeconds(value) {
  if (!value) return 0;
  if (typeof value.seconds === 'number') return value.seconds;
  if (typeof value._seconds === 'number') return value._seconds;
  if (value.toMillis) return Math.floor(value.toMillis() / 1000);
  return 0;
}

async function cargarComponentesUsuario(uid) {
  const sistemaDoc = await db.collection('sistema').doc(uid).get();
  const sistemaData = sistemaDoc.data() || {};
  const componentesIoT = Array.isArray(sistemaData.componentesIoT)
    ? sistemaData.componentesIoT
    : [];

  const estadoSnap = await db.collection('sistema').doc(uid)
    .collection('componentesEstado').get();
  const estados = {};
  estadoSnap.forEach(doc => {
    estados[doc.id] = doc.data() || {};
  });

  const componentes = componentesIoT.map(comp => ({
    ...comp,
    esEntrada: isEntrada(comp.tipoId),
    activo: typeof estados[comp.id]?.activo === 'boolean'
      ? estados[comp.id].activo
      : !!comp.activo,
  }));

  return { sistemaData, componentes };
}

async function cargarPerfilesUsuario(uid) {
  const hogarRef = db.collection('sistema').doc(uid);
  const [hogarSnap, perfilesSnap] = await Promise.all([
    hogarRef.get(),
    hogarRef.collection('perfiles').get(),
  ]);
  const hogar = hogarSnap.data() || {};
  const perfilActivoId = String(hogar.perfilActivoId || '');
  const perfiles = [];

  for (const doc of perfilesSnap.docs) {
    const data = doc.data() || {};
    const contactosSnap = await hogarRef
      .collection('perfiles')
      .doc(doc.id)
      .collection('contactos')
      .get();
    perfiles.push({
      id: doc.id,
      nombre: data.nombre || 'Perfil familiar',
      rol: data.rol || 'Familiar',
      tipoPerfil: data.tipoPerfil || 'general',
      checkInPreferidoMin: Number(data.checkInPreferidoMin || 30),
      tiempoEscoltaPreferidoMin: Number(data.tiempoEscoltaPreferidoMin || 30),
      confirmacionSimple: data.confirmacionSimple === true,
      zonasSeguras: Array.isArray(data.zonasSeguras) ? data.zonasSeguras : ['Casa'],
      activo: perfilActivoId ? perfilActivoId === doc.id : data.activo !== false,
      contactosCount: contactosSnap.size,
    });
  }

  return {
    perfilActivoId,
    perfiles,
  };
}

// ── Monitor de Heartbeat ────────────────────────────────────────
const estadoSensores = {}; // { uid:sensorId: { ultimoHB, sabotajeEnviado } }

async function iniciarMonitorHeartbeat() {
  console.log('💓 Monitor de Heartbeat iniciado...');

  // Verificar timeouts cada 5 segundos
  setInterval(async () => {
    try {
      const ahora = Math.floor(Date.now() / 1000);
      const snap = await db.collection('sensores').get();
      for (const doc of snap.docs) {
        const data = doc.data() || {};
        const sensorId = doc.id;
        const userId = data.userId || '';
        if (!esIdSeguro(sensorId) || !esIdSeguro(userId)) continue;

        const hbActual = timestampToSeconds(data.updatedAt);
        if (!hbActual) continue;

        const key = `${userId}:${sensorId}`;
        if (!estadoSensores[key]) {
          estadoSensores[key] = { ultimoHB: hbActual, sabotajeEnviado: false };
        } else if (hbActual > estadoSensores[key].ultimoHB) {
          if (estadoSensores[key].sabotajeEnviado) {
            console.log(`✅ Sensor '${sensorId}' restaurado — heartbeat recibido`);
            await notificarRestauracion(userId, sensorId, data.nombre || sensorId);
          }
          estadoSensores[key].sabotajeEnviado = false;
          estadoSensores[key].ultimoHB = hbActual;
        }

        const diff = ahora - hbActual;
        if (diff > HEARTBEAT_TIMEOUT && !estadoSensores[key].sabotajeEnviado) {
          console.log(`🚨 SABOTAJE detectado en sensor '${sensorId}' del usuario '${userId}' — Sin heartbeat por ${diff}s`);
          estadoSensores[key].sabotajeEnviado = true;
          await alertarSabotaje(userId, sensorId, data.nombre || sensorId, diff);
        }
      }
    } catch (e) {
      console.error('❌ Error en monitor heartbeat:', e.message);
    }
  }, 5000);
}

async function alertarSabotaje(userId, sensorId, nombre, segundos) {
  try {
    const mensaje = `⚠️ Sensor '${nombre}' desconectado (${segundos}s sin señal). Posible sabotaje o corte de energía.`;

    await db.collection('alerts').doc(userId).set({
      active: true, message: mensaje,
      nivel: 'severo', titulo: '⚠️ ALERTA DE SABOTAJE',
      sensor_id: sensorId, timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    await admin.messaging().send({
      topic: `user_${userId}`, android: { priority: 'high' },
      data: { alert: 'true', message: mensaje, nivel: 'severo', titulo: '⚠️ ALERTA DE SABOTAJE' },
    });

    await db.collection('sensores').doc(sensorId).set({
      online: false,
      activo: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`✅ Alerta de sabotaje enviada para sensor '${sensorId}'`);
  } catch(e) {
    console.error('❌ Error enviando alerta sabotaje:', e.message);
  }
}

async function notificarRestauracion(userId, sensorId, nombre) {
  try {
    await admin.messaging().send({
      topic: `user_${userId}`, android: { priority: 'high' },
      data: {
        alert: 'true',
        message: `✅ Sensor '${nombre}' restaurado y en línea nuevamente.`,
        nivel: 'leve',
        titulo: 'Sensor Restaurado',
      },
    });
    await db.collection('sensores').doc(sensorId).set({
      online: true,
      activo: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch(e) {
    console.error('❌ Error notificando restauración:', e.message);
  }
}

// ── Firebase Auth REST ──────────────────────────────────────────
const eventosProcesados = new Set();
let eventosInicializados = false;

async function enviarPushMovimientoDesdeEvento(eventoId, data) {
  const userId = data.userId || '';
  if (!esIdSeguro(userId)) return;

  const mensaje = String(
    data.mensaje ||
    data.message ||
    `Movimiento detectado en ${data.componenteNombre || 'tu sensor'}`
  );
  const nivel = String(data.nivel || 'moderado');
  const titulo = String(
    data.titulo ||
    data.componenteNombre ||
    'Movimiento detectado'
  );
  const sonidoAlerta = String(data.sonidoAlerta || '');

  try {
    await db.collection('alerts').doc(userId).set({
      active: true,
      message: mensaje,
      nivel,
      titulo,
      sonidoAlerta,
      sensorId: data.sensorId || '',
      componenteId: data.componenteId || '',
      componenteNombre: data.componenteNombre || '',
      zona: data.zona || 'General',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await admin.messaging().send({
      topic: `user_${userId}`,
      android: { priority: 'high' },
      data: {
        alert: 'true',
        message: mensaje,
        nivel,
        titulo,
        sonidoAlerta,
      },
    });

    await db.collection('eventos').doc(eventoId).set({
      pushEnviado: true,
      pushEnviadoAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`Push de movimiento enviado a ${userId} desde evento ${eventoId}`);
  } catch (e) {
    console.error(`Error enviando push de movimiento (${eventoId}):`, e.message);
  }
}

function iniciarMonitorEventosEsp32() {
  console.log('Monitor de eventos ESP32 iniciado...');

  db.collection('eventos').onSnapshot((snap) => {
    if (!eventosInicializados) {
      snap.docs.forEach((doc) => eventosProcesados.add(doc.id));
      eventosInicializados = true;
      return;
    }

    snap.docChanges().forEach(async (change) => {
      if (change.type !== 'added') return;

      const doc = change.doc;
      if (eventosProcesados.has(doc.id)) return;
      eventosProcesados.add(doc.id);

      const data = doc.data() || {};
      if ((data.tipo || '').toString().toLowerCase() !== 'movimiento') return;
      if (data.pushEnviado === true) return;

      await enviarPushMovimientoDesdeEvento(doc.id, data);
    });
  }, (error) => {
    console.error('Error en monitor de eventos ESP32:', error.message);
  });
}

function firebaseSignIn(email, password) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ email, password, returnSecureToken: true });
    const options = {
      hostname: 'identitytoolkit.googleapis.com',
      path: `/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (parsed.error) reject(new Error(parsed.error.message));
        else resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(postData); req.end();
  });
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); }});
  });
}

function generarCodigoUsuario() {
  const now = Date.now();
  const bloque1 = String(10000 + (now % 90000));
  const bloque2 = String(1000 + (Math.floor(now / 1000) % 9000)).padStart(4, '0');
  const bloque3 = String((new Date().getSeconds() % 99) + 1).padStart(2, '0');
  return `${bloque1}-${bloque2}-${bloque3}`;
}

async function generarCodigoUnico() {
  for (let i = 0; i < 25; i += 1) {
    const codigo = generarCodigoUsuario();
    const codigoDoc = await db.collection('codigoUsuarios').doc(codigo).get();
    if (!codigoDoc.exists) return codigo;
  }
  throw new Error('No se pudo generar un codigo unico.');
}

async function asegurarUsuarioBase({
  uid,
  email,
  nombre = '',
  proveedor = 'password',
  emailVerificado = false,
}) {
  const usersRef = db.collection('users').doc(uid);
  const userDoc = await usersRef.get();
  const userData = userDoc.data() || {};

  let codigo = String(userData.codigo || '').trim();
  if (!codigo) {
    const codigoSnap = await db.collection('codigoUsuarios')
      .where('uid', '==', uid)
      .limit(1)
      .get();
    if (!codigoSnap.empty) {
      codigo = String(codigoSnap.docs[0].id || '').trim();
    }
  }
  if (!codigo) {
    codigo = await generarCodigoUnico();
  }

  await usersRef.set({
    email,
    codigo,
    nombre: nombre || userData.nombre || email.split('@')[0],
    emailVerificado: emailVerificado === true,
    proveedor,
    rol: userData.rol || 'usuario',
    activo: userData.activo !== false,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(userDoc.exists ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
  }, { merge: true });

  await db.collection('codigoUsuarios').doc(codigo).set({
    uid,
    email,
    nombre: nombre || userData.nombre || email.split('@')[0],
    activo: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  const sistemaRef = db.collection('sistema').doc(uid);
  const sistemaDoc = await sistemaRef.get();
  const perfilActivoId = String(sistemaDoc.data()?.perfilActivoId || '').trim() || 'perfil_principal';
  await sistemaRef.set({
    ownerUid: uid,
    ownerEmail: email,
    ownerNombre: nombre || userData.nombre || email.split('@')[0],
    perfilActivoId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  const perfilRef = sistemaRef.collection('perfiles').doc(perfilActivoId);
  const perfilDoc = await perfilRef.get();
  if (!perfilDoc.exists) {
    await perfilRef.set({
      nombre: nombre || email.split('@')[0],
      rol: 'Familiar',
      tipoPerfil: 'general',
      checkInPreferidoMin: 30,
      tiempoEscoltaPreferidoMin: 30,
      confirmacionSimple: false,
      zonasSeguras: ['Casa'],
      activo: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  return { codigo };
}

async function construirSesionUsuario({
  uid,
  email,
  isAdmin = false,
  nombre = '',
  proveedor = 'password',
  emailVerificado = false,
}) {
  if (isAdmin) {
    return {
      ok: true,
      uid,
      isAdmin: true,
      email,
      codigo: '',
      nombre: nombre || email.split('@')[0],
    };
  }

  const { codigo } = await asegurarUsuarioBase({
    uid,
    email,
    nombre,
    proveedor,
    emailVerificado,
  });

  const userDoc = await db.collection('users').doc(uid).get();
  const userData = userDoc.data() || {};
  if (userData.activo === false) {
    return { ok: false, error: 'Cuenta desactivada.', code: 403 };
  }

  return {
    ok: true,
    uid,
    isAdmin: false,
    email,
    codigo,
    nombre: String(userData.nombre || nombre || email.split('@')[0]),
  };
}

function verificarGoogleCredential(credential) {
  return new Promise((resolve, reject) => {
    const token = encodeURIComponent(String(credential || '').trim());
    const options = {
      hostname: 'oauth2.googleapis.com',
      path: `/tokeninfo?id_token=${token}`,
      method: 'GET',
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error_description || parsed.error) {
            return reject(new Error(parsed.error_description || parsed.error));
          }
          if (parsed.aud !== GOOGLE_WEB_CLIENT_ID) {
            return reject(new Error('GOOGLE_AUDIENCE_MISMATCH'));
          }
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Servidor HTTP ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const json = (data, code=200) => { res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(data)); };
  const err  = (msg, code=500) => { res.writeHead(code,{'Content-Type':'text/plain'}); res.end(msg); };

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(302, { Location: '/usuario' });
    return res.end();
  }

  // ── Panel administrador ──
  if (req.method === 'GET' && req.url === '/admin') {
    const adminPath = path.join(__dirname,'panel.html');
    if (fs.existsSync(adminPath)) {
      res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
      return res.end(fs.readFileSync(adminPath));
    }
    res.writeHead(403,{'Content-Type':'text/html;charset=utf-8'});
    return res.end('<!DOCTYPE html><html><head><meta charset=\'utf-8\'><meta name=\'viewport\' content=\'width=device-width,initial-scale=1\'><title>Admin no disponible</title></head><body style=\'font-family:Arial,sans-serif;background:#0b1220;color:#eaf2ff;padding:32px\'><h2>Panel de administrador no disponible en este entorno</h2><p>Este despliegue solo incluye el panel de usuario.</p><p><a href=\'/usuario\' style=\'color:#7cc4ff\'>Ir al panel de usuario</a></p></body></html>');
  }

  // ── Panel usuario ──
  if (req.method === 'GET' && req.url === '/usuario') {
    res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
    return res.end(fs.readFileSync(path.join(__dirname,'panel_usuario.html')));
  }

  if (req.method === 'GET' && req.url === '/ping') return json({ ok:true });

  // ── Estado sensores (para el panel) ──
  // ── Sensores del usuario específico ──
  if (req.method === 'GET' && req.url.startsWith('/get-sensors-user')) {
    const url  = new URL(req.url, 'http://localhost');
    const uid  = url.searchParams.get('uid');
    if (!uid) return err('Falta uid');
    try {
      const sensoresSnap = await db.collection('sensores')
        .where('userId', '==', uid)
        .get();
      const { componentes } = await cargarComponentesUsuario(uid);
      const sensores = sensoresSnap.docs.map(doc => {
        const data = doc.data() || {};
        const updatedAt = timestampToSeconds(data.updatedAt);
        const ahora = Math.floor(Date.now() / 1000);
        return {
          id: doc.id,
          sensorId: doc.id,
          nombre: data.nombre || 'ESP32',
          tipo: data.tipo || 'ESP32',
          ip: data.ip || '--',
          activo: data.activo !== false,
          online: data.online !== false && (updatedAt ? (ahora - updatedAt) <= 30 : true),
          ultimoHeartbeat: updatedAt,
          componentes,
        };
      });
      return json({ sensores });
    } catch(e) { return err(e.message); }
  }

  // ── Registrar código de usuario para ESP32 ──
  if (req.method === 'POST' && req.url === '/registrar-codigo-esp32') {
    const { uid, codigo } = await parseBody(req);
    try {
      // Guardar en RTDB: codigoUsuarios/CODIGO → uid
      await rtdb.ref('codigoUsuarios/' + codigo.toUpperCase()).set(uid);
      return json({ ok: true });
    } catch(e) { return err(e.message); }
  }

  if (req.method === 'GET' && req.url === '/get-sensors') {
    try {
      const snap = await db.collection('sensores').get();
      const ahora = Math.floor(Date.now() / 1000);
      const lista = snap.docs.map(doc => {
        const d = doc.data() || {};
        const ultimoHeartbeat = timestampToSeconds(d.updatedAt);
        const segundosSinHB = ultimoHeartbeat ? ahora - ultimoHeartbeat : 9999;
        return {
          id: doc.id,
          nombre: d.nombre || doc.id,
          tipo: d.tipo || 'ESP32',
          ip: d.ip || '--',
          activo: d.activo !== false,
          ultimoHeartbeat,
          segundosSinHB,
          online: d.online !== false && segundosSinHB <= 30,
          userId: d.userId || '',
          numComponentes: d.numComponentes || 0,
        };
      });
      return json({ sensores: lista });
    } catch(e) { return err(e.message); }
  }

  // ── Toggle simulador de presencia ──
  if (req.method === 'POST' && req.url === '/toggle-simulador') {
    const { uid, activo } = await parseBody(req);
    try {
      if (uid) {
        await db.collection('sistema').doc(uid).set({
          simuladorPresencia: !!activo,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        await rtdb.ref(`/usuarios/${uid}/sistema/simuladorPresencia`).set(!!activo);
      }
      console.log(`💡 Simulador de presencia: ${activo ? 'ACTIVADO' : 'DESACTIVADO'}`);
      return json({ ok: true, activo });
    } catch(e) { return err(e.message); }
  }

  // ── Login ──
  if (req.method === 'POST' && req.url === '/login') {
    const { email, password } = await parseBody(req);
    if (!email || !password) return json({ ok:false, error:'Completa todos los campos.' }, 400);
    try {
      const result  = await firebaseSignIn(email, password);
      const isAdmin = email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
      const payload = await construirSesionUsuario({
        uid: result.localId,
        email,
        isAdmin,
        proveedor: 'password',
      });
      if (!payload.ok) {
        return json({ ok:false, error: payload.error || 'No se pudo iniciar sesion.' }, payload.code || 403);
      }
      console.log(`✅ Login: ${email} (${isAdmin ? 'ADMIN' : 'usuario'})`);
      return json(payload);
    } catch(e) {
      const msg = e.message.includes('INVALID_PASSWORD') || e.message.includes('EMAIL_NOT_FOUND')
        ? 'Email o contraseña incorrectos.' : 'Error al iniciar sesión.';
      return json({ ok:false, error: msg }, 401);
    }
  }

  // ── Usuarios (solo desde localhost) ──
  if (req.method === 'POST' && req.url === '/login-google') {
    const { credential } = await parseBody(req);
    if (!credential) return json({ ok:false, error:'Falta credencial de Google.' }, 400);
    try {
      const googleData = await verificarGoogleCredential(credential);
      const email = String(googleData.email || '').trim().toLowerCase();
      const nombre = String(googleData.name || googleData.given_name || email.split('@')[0] || '').trim();
      const emailVerificado = String(googleData.email_verified || '').toLowerCase() === 'true';
      if (!email || !emailVerificado) {
        return json({ ok:false, error:'La cuenta de Google no pudo verificarse.' }, 401);
      }

      const isAdmin = email === ADMIN_EMAIL.toLowerCase();
      let firebaseUser;
      try {
        firebaseUser = await auth.getUserByEmail(email);
      } catch (e) {
        if (e.code !== 'auth/user-not-found') throw e;
        firebaseUser = await auth.createUser({
          email,
          emailVerified: true,
          displayName: nombre || undefined,
        });
      }

      const payload = await construirSesionUsuario({
        uid: firebaseUser.uid,
        email,
        isAdmin,
        nombre,
        proveedor: 'google',
        emailVerificado: true,
      });
      if (!payload.ok) {
        return json({ ok:false, error: payload.error || 'No se pudo iniciar sesion con Google.' }, payload.code || 403);
      }

      console.log(`âœ… Login Google: ${email} (${isAdmin ? 'ADMIN' : 'usuario'})`);
      return json(payload);
    } catch (e) {
      console.error('Error login Google:', e.message);
      return json({ ok:false, error:'No se pudo iniciar sesion con Google.' }, 401);
    }
  }

  if (req.method === 'GET' && req.url === '/get-users') {
    try {
      const snap  = await db.collection('users').get();
      const users = [];
      for (const d of snap.docs) {
        try {
          await auth.getUser(d.id);
          const sistemaDoc = await db.collection('sistema').doc(d.id).get();
          const sistema = sistemaDoc.data() || {};
          const sensoresSnap = await db.collection('sensores').where('userId', '==', d.id).get();
          const ahora = Math.floor(Date.now() / 1000);
          let sensoresOnline = 0;
          sensoresSnap.forEach(sdoc => {
            const sdata = sdoc.data() || {};
            const updatedAt = timestampToSeconds(sdata.updatedAt);
            const online = sdata.online !== false && (updatedAt ? (ahora - updatedAt) <= 30 : true);
            if (online) sensoresOnline += 1;
          });
          users.push({ uid: d.id, ...d.data(), resumen: {
            codigo: d.data().codigo || '',
            camara: !!(sistema.camaraUrl || (Array.isArray(sistema.camaras) && sistema.camaras.length)),
            modoNoche: !!sistema.modoNoche,
            simulador: !!sistema.simuladorPresencia,
            sensores: sensoresSnap.size,
            sensoresOnline,
            sonidoLeve: sistema.sonidoLeve || '',
          } });
        } catch (e) {
          if (e.code === 'auth/user-not-found') {
            await d.ref.delete().catch(() => {});
            await db.collection('alerts').doc(d.id).delete().catch(() => {});
            await db.collection('anti_robo').doc(d.id).delete().catch(() => {});
            await db.collection('escolta').doc(d.id).delete().catch(() => {});
            await db.collection('sistema').doc(d.id).delete().catch(() => {});
            console.log(`🧹 Usuario huerfano limpiado del panel: ${d.id}`);
            continue;
          }
          throw e;
        }
      }
      return json({ users });
    } catch(e) { return err(e.message); }
  }

  // ── Buscar por código ──
  if (req.method === 'POST' && req.url === '/find-by-code') {
    const { codigo } = await parseBody(req);
    try {
      const snap = await db.collection('users').where('codigo', '==', codigo).limit(1).get();
      if (snap.empty) return json({ found: false });
      const doc = snap.docs[0];
      return json({ found: true, uid: doc.id, email: doc.data().email, codigo });
    } catch(e) { return err(e.message); }
  }

  // ── Enviar alarma ──
  if (req.method === 'POST' && req.url === '/send-alarm') {
    const { message, nivel, titulo, uid, uids, adminSoundId, sonidoAlerta: sonidoManual } = await parseBody(req);
    const msg  = message || 'ALERTA';
    const niv  = nivel   || 'moderado';
    const tit  = titulo  || 'Alerta Sismica';
    try {
      if (uids && Array.isArray(uids) && uids.length > 0) {
        for (const u of uids) {
          const sonidoAlerta = await resolverSonidoAlerta({
            uid: u,
            nivel: niv,
            adminSoundId,
            sonidoAlerta: sonidoManual,
          });
          const data = {
            alert:'true',
            message: msg,
            nivel: niv,
            titulo: tit,
            adminSoundId: adminSoundId || '',
            sonidoAlerta,
          };
          await db.collection('alerts').doc(u).set({
            active:true,
            message:msg,
            nivel:niv,
            titulo:tit,
            adminSoundId: adminSoundId || '',
            sonidoAlerta,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
          await admin.messaging().send({ topic:`user_${u}`, android:{priority:'high'}, data });
        }
        return json({ ok:true, count: uids.length, adminSoundId: adminSoundId || '' });
      } else if (uid) {
        const sonidoAlerta = await resolverSonidoAlerta({
          uid,
          nivel: niv,
          adminSoundId,
          sonidoAlerta: sonidoManual,
        });
        const data = {
          alert:'true',
          message: msg,
          nivel: niv,
          titulo: tit,
          adminSoundId: adminSoundId || '',
          sonidoAlerta,
        };
        await db.collection('alerts').doc(uid).set({
          active:true,
          message:msg,
          nivel:niv,
          titulo:tit,
          adminSoundId: adminSoundId || '',
          sonidoAlerta,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        const r = await admin.messaging().send({ topic:`user_${uid}`, android:{priority:'high'}, data });
        return json({ ok:true, response: r, adminSoundId: adminSoundId || '' });
      } else {
        const sonidoAlerta = await resolverSonidoAlerta({
          nivel: niv,
          adminSoundId,
          sonidoAlerta: sonidoManual,
        });
        const data = {
          alert:'true',
          message: msg,
          nivel: niv,
          titulo: tit,
          adminSoundId: adminSoundId || '',
          sonidoAlerta,
        };
        await db.collection('alerts').doc('alert1').set({
          active:true,
          message:msg,
          nivel:niv,
          titulo:tit,
          adminSoundId: adminSoundId || '',
          sonidoAlerta,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        const r = await admin.messaging().send({ topic:'alarm', android:{priority:'high'}, data });
        return json({ ok:true, response: r, adminSoundId: adminSoundId || '' });
      }
    } catch(e) { console.error('❌', e.message); return err(e.message); }
  }

  // ── Cancelar alarma ──
  if (req.method === 'POST' && req.url === '/cancel-alarm') {
    try {
      const { uid } = await parseBody(req);
      if (uid) {
        await db.collection('alerts').doc(uid).set({ active: false }, { merge: true });
        await rtdb.ref(`/usuarios/${uid}/sistema/cancelar_alarma`).set(true);
      } else {
        await db.collection('alerts').doc('alert1').set({ active: false }, { merge: true });
      }
      return json({ ok:true });
    } catch(e) { return err(e.message); }
  }

  // ── Toggle usuario (solo desde localhost) ──
  if (req.method === 'POST' && req.url === '/toggle-user') {
    const { uid, activo } = await parseBody(req);
    try {
      await db.collection('users').doc(uid).update({ activo });
      return json({ ok:true });
    } catch(e) { return err(e.message); }
  }

  // ── Guardar URL cámara ──
  if (req.method === 'POST' && req.url === '/save-camera-url') {
    const { uid, url, camaraUrl, camaras } = await parseBody(req);
    try {
      await db.collection('sistema').doc(uid).set({
        camaraUrl: camaraUrl || url || '',
        camaras: Array.isArray(camaras) ? camaras : admin.firestore.FieldValue.delete(),
      }, { merge: true });
      console.log(`📹 URL cámara guardada para ${uid}: ${camaraUrl || url || ''}`);
      return json({ ok: true });
    } catch(e) { return err(e.message); }
  }

  // ── Get sistema del usuario ──
  if (req.method === 'GET' && req.url.startsWith('/get-sistema')) {
    const uid = new URL('http://x'+req.url).searchParams.get('uid');
    try {
      const doc = await db.collection('sistema').doc(uid).get();
      return json({ ok:true, ...doc.data() });
    } catch(e) { return err(e.message); }
  }

  // ── Toggle sistema usuario ──
  if (req.method === 'POST' && req.url === '/toggle-sistema') {
    const body = await parseBody(req);
    const { uid, ...rest } = body;
    try {
      await db.collection('sistema').doc(uid).set(
        { ...rest, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true });
      if (typeof rest.armado === 'boolean') {
        await rtdb.ref(`/usuarios/${uid}/sistema/armado`).set(rest.armado);
        console.log(`🔄 Sistema ${rest.armado?'ARMADO':'DESARMADO'} por usuario ${uid}`);
      }
      return json({ ok:true });
    } catch(e) { return err(e.message); }
  }

  // ── Get miembros del hogar ──
  if (req.method === 'GET' && req.url.startsWith('/get-miembros')) {
    const uid = new URL('http://x'+req.url).searchParams.get('uid');
    try {
      const snap = await db.collection('sistema').doc(uid).collection('miembros').get();
      const miembros = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return json({ ok:true, miembros });
    } catch(e) { return err(e.message); }
  }

  if (req.method === 'GET' && req.url.startsWith('/get-perfiles')) {
    const uid = new URL('http://x' + req.url).searchParams.get('uid');
    if (!uid) return err('Falta uid', 400);
    try {
      const data = await cargarPerfilesUsuario(uid);
      return json({ ok: true, ...data });
    } catch (e) { return err(e.message); }
  }

  if (req.method === 'POST' && req.url === '/set-perfil-activo') {
    const { uid, profileId } = await parseBody(req);
    if (!uid || !profileId) return err('Faltan datos', 400);
    try {
      const perfilSnap = await db.collection('sistema').doc(uid)
        .collection('perfiles').doc(profileId).get();
      if (!perfilSnap.exists) return err('Perfil no encontrado', 404);
      const perfil = perfilSnap.data() || {};
      await db.collection('sistema').doc(uid).set({
        perfilActivoId: profileId,
        perfilActivoNombre: perfil.nombre || 'Perfil familiar',
      }, { merge: true });
      return json({ ok: true });
    } catch (e) { return err(e.message); }
  }

  if (req.method === 'POST' && req.url === '/update-perfil-escenario') {
    const {
      uid,
      profileId,
      tipoPerfil,
      checkInPreferidoMin,
      tiempoEscoltaPreferidoMin,
      confirmacionSimple,
      zonasSeguras,
    } = await parseBody(req);
    if (!uid || !profileId) return err('Faltan datos', 400);
    try {
      await db.collection('sistema').doc(uid)
        .collection('perfiles').doc(profileId)
        .set({
          tipoPerfil: tipoPerfil || 'general',
          checkInPreferidoMin: Number(checkInPreferidoMin || 30),
          tiempoEscoltaPreferidoMin: Number(tiempoEscoltaPreferidoMin || 30),
          confirmacionSimple: confirmacionSimple === true,
          zonasSeguras: Array.isArray(zonasSeguras) && zonasSeguras.length ? zonasSeguras : ['Casa'],
          actualizadoEn: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      return json({ ok: true });
    } catch (e) { return err(e.message); }
  }

  // ── Get historial de alarmas del usuario ──
  if (req.method === 'GET' && req.url.startsWith('/get-historial')) {
    const uid = new URL('http://x'+req.url).searchParams.get('uid');
    try {
      const snap = await db.collection('alerts').doc(uid).collection('historial')
        .orderBy('timestamp', 'desc').limit(20).get();
      const historial = snap.docs.map(d => ({
        ...d.data(),
        hora: d.data().timestamp?.toDate?.().toLocaleTimeString('es') || '--'
      }));
      return json({ ok:true, historial });
    } catch(e) { return json({ ok:true, historial:[] }); }
  }

  // ── Alerta escolta ──
  if (req.method === 'POST' && req.url === '/activar-escolta-web') {
    const { uid, profileId, minutos, checkInMinutos, pin, destinoSeguro } = await parseBody(req);
    if (!uid || !profileId || !pin) return err('Faltan datos', 400);
    try {
      const hogarRef = db.collection('sistema').doc(uid);
      const perfilSnap = await hogarRef.collection('perfiles').doc(profileId).get();
      if (!perfilSnap.exists) return err('Perfil no encontrado', 404);
      const perfil = perfilSnap.data() || {};
      const contactosSnap = await hogarRef.collection('perfiles').doc(profileId).collection('contactos').get();
      const contactosUids = contactosSnap.docs.map(doc => doc.id).filter(Boolean);

      await hogarRef.set({
        perfilActivoId: profileId,
        perfilActivoNombre: perfil.nombre || 'Perfil familiar',
      }, { merge: true });

      await db.collection('escolta').doc(uid).set({
        activo: true,
        perfilId: profileId,
        perfilNombre: perfil.nombre || 'Perfil familiar',
        perfilTipo: perfil.tipoPerfil || 'general',
        tiempoEstimado: Number(minutos || perfil.tiempoEscoltaPreferidoMin || 30),
        checkInMinutos: Number(checkInMinutos || perfil.checkInPreferidoMin || 30),
        confirmacionSimple: perfil.confirmacionSimple === true,
        zonasSeguras: Array.isArray(perfil.zonasSeguras) ? perfil.zonasSeguras : ['Casa'],
        destinoSeguro: destinoSeguro || '',
        checkInPendiente: false,
        confirmacionLlegadaPendiente: false,
        alertaEnviada: false,
        contactosUids,
        webPinTemporal: pin,
        ultimoCheckIn: admin.firestore.FieldValue.serverTimestamp(),
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      return json({ ok: true, perfilNombre: perfil.nombre || 'Perfil familiar', contactos: contactosUids.length });
    } catch (e) { return err(e.message); }
  }

  if (req.method === 'POST' && req.url === '/cancelar-escolta-web') {
    const { uid } = await parseBody(req);
    if (!uid) return err('Falta uid', 400);
    try {
      await db.collection('escolta').doc(uid).set({
        activo: false,
        alertaEnviada: false,
        checkInPendiente: false,
        confirmacionLlegadaPendiente: false,
        webCanceladoEn: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return json({ ok: true });
    } catch (e) { return err(e.message); }
  }

  if (req.method === 'POST' && req.url === '/escort-alert') {
    const { uid, message, lat, lng, perfilNombre, destinoSeguro } = await parseBody(req);
    try {
      const mapsUrl = `https://maps.google.com/?q=${lat},${lng}`;
      const detalleDestino = destinoSeguro
        ? ` hacia ${destinoSeguro}`
        : '';
      const msg = message || `Alerta de escolta${detalleDestino}. Ultima ubicacion: ${mapsUrl}`;
      await db.collection('alerts').doc('alert1').set({
        active: true, message: msg, nivel: 'severo',
        titulo: perfilNombre ? `ALERTA ESCOLTA · ${perfilNombre}` : 'ALERTA ESCOLTA',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      await admin.messaging().send({
        topic: 'alarm', android: { priority: 'high' },
        data: { alert:'true', message: msg, nivel:'severo', titulo: perfilNombre ? `ALERTA ESCOLTA · ${perfilNombre}` : 'ALERTA ESCOLTA' },
      });
      console.log(`🛡️ Alerta escolta enviada para ${uid}`);
      return json({ ok: true });
    } catch(e) { return err(e.message); }
  }

  // ── Get alertas escolta (admin) ──
  if (req.method === 'GET' && req.url === '/get-escort-alerts') {
    try {
      const snap = await db.collection('escolta').where('alertaEnviada','==',true).get();
      const alertas = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      return json({ alertas });
    } catch(e) { return err(e.message); }
  }

  // ── Anti-robo: borrado remoto ──
  if (req.method === 'POST' && req.url === '/remote-wipe') {
    const { uid } = await parseBody(req);
    try {
      await admin.messaging().send({
        topic: `user_${uid}`, android: { priority: 'high' },
        data: { tipo: 'remote_wipe', uid }
      });
      await db.collection('anti_robo').doc(uid).update({ borradoRemoto: true });
      console.log(`🗑️ Borrado remoto enviado a ${uid}`);
      return json({ ok: true });
    } catch(e) { return err(e.message); }
  }

  // ── Google Assistant webhook ──
  // ── Control manual de componente (LED/Relé/Buzzer) ──
  if (req.method === 'POST' && req.url === '/toggle-componente') {
    const { uid, sensorId, compId, estado } = await parseBody(req);
    try {
      await db.collection('sistema').doc(uid)
        .collection('componentesEstado').doc(compId)
        .set({
          activo: !!estado,
          sensorId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      await rtdb.ref(`usuarios/${uid}/sensores/${sensorId}/componentes/${compId}/activo`).set(!!estado);
      return json({ ok: true });
    } catch(e) { return err(e.message); }
  }

  if (req.url === '/assistant') return assistantHandler(req, res, db, admin);

  // ── Endpoints GET para control remoto HomeAlert ──────────────────
  // Uso: https://homealert-server.onrender.com/cmd/armar?uid=UID&key=HOMEALERT2025
  if (req.method === 'GET' && req.url.startsWith('/cmd/')) {
    const url  = new URL(req.url, 'http://localhost');
    const uid  = url.searchParams.get('uid');
    const key  = url.searchParams.get('key');
    const cmd  = url.pathname.replace('/cmd/', '');

    if (key !== 'HOMEALERT2025') {
      res.writeHead(401, {'Content-Type': 'text/plain'});
      return res.end('Unauthorized');
    }
    if (!uid) {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      return res.end('Falta uid');
    }

    try {
      const db = admin.firestore();
      let respuesta = 'OK';

      if (cmd === 'armar') {
        await db.collection('sistema').doc(uid)
          .set({ armado: true }, { merge: true });
        respuesta = 'Sistema armado ✅';
      }
      else if (cmd === 'desarmar') {
        await db.collection('sistema').doc(uid)
          .set({ armado: false }, { merge: true });
        respuesta = 'Sistema desarmado ✅';
      }
      else if (cmd === 'alarma') {
        const nivel = url.searchParams.get('nivel') || 'moderado';
        await db.collection('alerts').doc(uid).set({
          active: true, nivel,
          titulo: nivel === 'severo' ? '🚨 ALERTA SEVERA' : '⚠️ Alerta',
          message: 'Alerta activada por control remoto',
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        await admin.messaging().send({
          topic: `user_${uid}`,
          data: { tipo: 'alarma', nivel, titulo: 'Alerta', message: 'Control remoto' },
          android: { priority: 'high', notification: { channelId: 'homealert_alarm' } }
        });
        respuesta = `Alarma ${nivel} enviada 🚨`;
      }
      else if (cmd === 'cancelar') {
        await db.collection('alerts').doc(uid)
          .set({ active: false }, { merge: true });
        respuesta = 'Alarma cancelada ✅';
      }
      else if (cmd === 'simulador/on') {
        await db.collection('sistema').doc(uid)
          .set({ simuladorPresencia: true }, { merge: true });
        respuesta = 'Simulador activado 💡';
      }
      else if (cmd === 'noche/on') {
        await db.collection('sistema').doc(uid).set({
          modoNoche: true, ignorarGPS: true, armado: true
        }, { merge: true });
        respuesta = 'Modo Noche activado 🌙';
      }
      else if (cmd === 'noche/off') {
        await db.collection('sistema').doc(uid).set({
          modoNoche: false, ignorarGPS: false, armado: false
        }, { merge: true });
        respuesta = 'Modo Noche desactivado ☀️';
      }
      else if (cmd === 'simulador/off') {
        await db.collection('sistema').doc(uid)
          .set({ simuladorPresencia: false }, { merge: true });
        respuesta = 'Simulador desactivado 💡';
      }
      else if (cmd === 'componente/on' || cmd === 'componente/off' || cmd === 'toggle-comp') {
        const compId = url.searchParams.get('compId');
        const sensorId = url.searchParams.get('sensorId') || 'esp32_01';
        const estadoParam = url.searchParams.get('estado');
        if (!compId) {
          res.writeHead(400, {'Content-Type': 'text/plain'});
          return res.end('Falta compId');
        }
        const estado = cmd === 'componente/on'
          ? true
          : cmd === 'componente/off'
            ? false
            : estadoParam === null
              ? true
              : estadoParam === 'true' || estadoParam === '1' || estadoParam === 'on';
        await db.collection('sistema').doc(uid)
          .collection('componentesEstado').doc(compId)
          .set({
            activo: estado,
            estado,
            sensorId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        await rtdb.ref(`usuarios/${uid}/sensores/${sensorId}/componentes/${compId}/activo`).set(estado);
        respuesta = `Componente ${compId} ${estado ? 'encendido' : 'apagado'}`;
      }
      else {
        res.writeHead(404, {'Content-Type': 'text/plain'});
        return res.end('Comando no reconocido');
      }

      console.log(`🏠 Control remoto [${uid.substring(0,8)}...]: ${cmd} → ${respuesta}`);
      res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
      return res.end(respuesta);

    } catch(e) {
      console.error('Error control remoto cmd:', e.message);
      res.writeHead(500, {'Content-Type': 'text/plain'});
      return res.end('Error: ' + e.message);
    }
  }

  res.writeHead(404); res.end('Not found');
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n🚨 HomeAlert Panel → http://localhost:${PORT}`);
  console.log(`👑 Admin: ${ADMIN_EMAIL}`);
  iniciarMonitorHeartbeat();
  iniciarMonitorEventosEsp32();
});


