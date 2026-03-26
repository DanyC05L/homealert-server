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
const HEARTBEAT_TIMEOUT = 10; // segundos sin heartbeat = sabotaje

// ── Monitor de Heartbeat ────────────────────────────────────────
const estadoSensores = {}; // { sensor_id: { ultimoHB, sabotajeEnviado } }

async function iniciarMonitorHeartbeat() {
  console.log('💓 Monitor de Heartbeat iniciado...');

  // Escuchar cambios en /sensores desde Realtime Database
  rtdb.ref('/sensores').on('value', snapshot => {
    const sensores = snapshot.val();
    if (!sensores) return;

    Object.entries(sensores).forEach(([id, data]) => {
      const hbActual = data.ultimoHeartbeat || 0;

      if (!estadoSensores[id]) {
        estadoSensores[id] = { ultimoHB: hbActual, sabotajeEnviado: false };
      } else {
        // Si recibió nuevo heartbeat, resetear sabotaje
        if (hbActual > estadoSensores[id].ultimoHB) {
          if (estadoSensores[id].sabotajeEnviado) {
            console.log(`✅ Sensor '${id}' restaurado — heartbeat recibido`);
            notificarRestauracion(id, data.nombre || id);
          }
          estadoSensores[id].sabotajeEnviado = false;
          estadoSensores[id].ultimoHB = hbActual;
        }
      }
    });
  });

  // Verificar timeouts cada 5 segundos
  setInterval(async () => {
    const ahora = Math.floor(Date.now() / 1000);
    for (const [id, estado] of Object.entries(estadoSensores)) {
      const diff = ahora - estado.ultimoHB;
      if (diff > HEARTBEAT_TIMEOUT && !estado.sabotajeEnviado) {
        console.log(`🚨 SABOTAJE detectado en sensor '${id}' — Sin heartbeat por ${diff}s`);
        estado.sabotajeEnviado = true;
        await alertarSabotaje(id, diff);
      }
    }
  }, 5000);
}

async function alertarSabotaje(sensorId, segundos) {
  try {
    const mensaje = `⚠️ Sensor '${sensorId}' desconectado (${segundos}s sin señal). Posible sabotaje o corte de energía.`;

    // Actualizar Firestore
    await db.collection('alerts').doc('alert1').set({
      active: true, message: mensaje,
      nivel: 'severo', titulo: '⚠️ ALERTA DE SABOTAJE',
      sensor_id: sensorId, timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Enviar FCM a todos
    await admin.messaging().send({
      topic: 'alarm', android: { priority: 'high' },
      data: { alert: 'true', message: mensaje, nivel: 'severo', titulo: '⚠️ ALERTA DE SABOTAJE' },
    });

    // Marcar sensor como offline en RTDB
    await rtdb.ref(`/sensores/${sensorId}/activo`).set(false);
    console.log(`✅ Alerta de sabotaje enviada para sensor '${sensorId}'`);
  } catch(e) {
    console.error('❌ Error enviando alerta sabotaje:', e.message);
  }
}

async function notificarRestauracion(sensorId, nombre) {
  try {
    await admin.messaging().send({
      topic: 'alarm', android: { priority: 'high' },
      data: {
        alert: 'true',
        message: `✅ Sensor '${nombre}' restaurado y en línea nuevamente.`,
        nivel: 'leve',
        titulo: 'Sensor Restaurado',
      },
    });
    await rtdb.ref(`/sensores/${sensorId}/activo`).set(true);
  } catch(e) {
    console.error('❌ Error notificando restauración:', e.message);
  }
}

// ── Firebase Auth REST ──────────────────────────────────────────
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

// ── Servidor HTTP ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const json = (data, code=200) => { res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(data)); };
  const err  = (msg, code=500) => { res.writeHead(code,{'Content-Type':'text/plain'}); res.end(msg); };

  // Ruta raíz — redirige al panel de usuario (panel admin bloqueado en producción)
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(302, { 'Location': '/usuario' });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/ping') return json({ ok:true });

  // ── Estado sensores (para el panel) ──
  if (req.method === 'GET' && req.url === '/get-sensors') {
    try {
      const snap    = await rtdb.ref('/sensores').get();
      const sensores = snap.val() || {};
      const ahora   = Math.floor(Date.now() / 1000);
      const lista   = Object.entries(sensores).map(([id, d]) => ({
        id, nombre: d.nombre || id, tipo: d.tipo || 'PIR',
        ip: d.ip || '--', activo: d.activo || false,
        ultimoHeartbeat: d.ultimoHeartbeat || 0,
        segundosSinHB: ahora - (d.ultimoHeartbeat || 0),
        online: (ahora - (d.ultimoHeartbeat || 0)) <= HEARTBEAT_TIMEOUT,
      }));
      return json({ sensores: lista });
    } catch(e) { return err(e.message); }
  }

  // ── Toggle simulador de presencia ──
  if (req.method === 'POST' && req.url === '/toggle-simulador') {
    const { activo } = await parseBody(req);
    try {
      await rtdb.ref('/sistema/simuladorPresencia').set(activo);
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
      let codigo = '';
      if (!isAdmin) {
        const doc = await db.collection('users').doc(result.localId).get();
        codigo = doc.data()?.codigo || '';
        if (doc.data()?.activo === false) return json({ ok:false, error:'Cuenta desactivada.' }, 403);
      }
      console.log(`✅ Login: ${email} (${isAdmin ? 'ADMIN' : 'usuario'})`);
      return json({ ok:true, uid: result.localId, isAdmin, email, codigo });
    } catch(e) {
      const msg = e.message.includes('INVALID_PASSWORD') || e.message.includes('EMAIL_NOT_FOUND')
        ? 'Email o contraseña incorrectos.' : 'Error al iniciar sesión.';
      return json({ ok:false, error: msg }, 401);
    }
  }

  // ── Usuarios (solo desde localhost) ──
  if (req.method === 'GET' && req.url === '/get-users') {
    const ip = req.socket.remoteAddress;
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) { res.writeHead(403); return res.end('Forbidden'); }
    try {
      const snap  = await db.collection('users').get();
      const users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
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
    const { message, nivel, titulo, uid, uids } = await parseBody(req);
    const msg  = message || '🚨 ¡ALERTA!';
    const niv  = nivel   || 'moderado';
    const tit  = titulo  || 'Alerta Sísmica';
    const data = { alert:'true', message: msg, nivel: niv, titulo: tit };
    try {
      if (uids && Array.isArray(uids) && uids.length > 0) {
        for (const u of uids) {
          await db.collection('alerts').doc(u).set({
            active:true, message:msg, nivel:niv, titulo:tit,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
          await admin.messaging().send({ topic:`user_${u}`, android:{priority:'high'}, data });
        }
        return json({ ok:true, count: uids.length });
      } else if (uid) {
        await db.collection('alerts').doc(uid).set({
          active:true, message:msg, nivel:niv, titulo:tit,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        const r = await admin.messaging().send({ topic:`user_${uid}`, android:{priority:'high'}, data });
        return json({ ok:true, response: r });
      } else {
        await db.collection('alerts').doc('alert1').set({
          active:true, message:msg, nivel:niv, titulo:tit,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        const r = await admin.messaging().send({ topic:'alarm', android:{priority:'high'}, data });
        return json({ ok:true, response: r });
      }
    } catch(e) { console.error('❌', e.message); return err(e.message); }
  }

  // ── Cancelar alarma ──
  if (req.method === 'POST' && req.url === '/cancel-alarm') {
    try {
      await db.collection('alerts').doc('alert1').update({ active: false });
      await rtdb.ref('/sistema/cancelar_alarma').set(true);
      return json({ ok:true });
    } catch(e) { return err(e.message); }
  }

  // ── Toggle usuario (solo desde localhost) ──
  if (req.method === 'POST' && req.url === '/toggle-user') {
    const ip = req.socket.remoteAddress;
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) { res.writeHead(403); return res.end('Forbidden'); }
    const { uid, activo } = await parseBody(req);
    try {
      await db.collection('users').doc(uid).update({ activo });
      return json({ ok:true });
    } catch(e) { return err(e.message); }
  }

  // ── Guardar URL cámara ──
  if (req.method === 'POST' && req.url === '/save-camera-url') {
    const { uid, url } = await parseBody(req);
    try {
      await db.collection('sistema').doc(uid).set({ camaraUrl: url }, { merge: true });
      console.log(`📹 URL cámara guardada para ${uid}: ${url}`);
      return json({ ok: true });
    } catch(e) { return err(e.message); }
  }

  // ── Panel usuario ──
  if (req.method === 'GET' && req.url === '/usuario') {
    res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
    return res.end(fs.readFileSync(path.join(__dirname,'panel_usuario.html')));
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
    const { uid, armado } = await parseBody(req);
    try {
      await db.collection('sistema').doc(uid).set(
        { armado, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true });
      await rtdb.ref('/sistema/armado').set(armado);
      console.log(`🔄 Sistema ${armado?'ARMADO':'DESARMADO'} por usuario ${uid}`);
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
  if (req.method === 'POST' && req.url === '/escort-alert') {
    const { uid, message, lat, lng } = await parseBody(req);
    try {
      const mapsUrl = `https://maps.google.com/?q=${lat},${lng}`;
      const msg = message || `⚠️ Alerta de ruta no completada. Última ubicación: ${mapsUrl}`;
      await db.collection('alerts').doc('alert1').set({
        active: true, message: msg, nivel: 'severo',
        titulo: '🛡️ ALERTA ESCOLTA',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      await admin.messaging().send({
        topic: 'alarm', android: { priority: 'high' },
        data: { alert:'true', message: msg, nivel:'severo', titulo:'🛡️ ALERTA ESCOLTA' },
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
  if (req.url === '/assistant') return assistantHandler(req, res, db, admin);

  // ── Endpoints GET para Google Home Routines ──────────────────
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
          message: 'Alerta activada por Google Home',
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        await admin.messaging().send({
          topic: `user_${uid}`,
          data: { tipo: 'alarma', nivel, titulo: 'Alerta', message: 'Google Home' },
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
      else {
        res.writeHead(404, {'Content-Type': 'text/plain'});
        return res.end('Comando no reconocido');
      }

      console.log(`🏠 Google Home [${uid.substring(0,8)}...]: ${cmd} → ${respuesta}`);
      res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
      return res.end(respuesta);

    } catch(e) {
      console.error('Error Google Home cmd:', e.message);
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
});
