const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const admin  = require('firebase-admin');

// En producciÃ³n (Render): usa variable de entorno FIREBASE_CREDENTIALS
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

// â”€â”€ Monitor de Heartbeat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const estadoSensores = {}; // { uid:sensorId: { ultimoHB, sabotajeEnviado } }

async function iniciarMonitorHeartbeat() {
  console.log('ðŸ’“ Monitor de Heartbeat iniciado...');

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
            console.log(`âœ… Sensor '${sensorId}' restaurado â€” heartbeat recibido`);
            await notificarRestauracion(userId, sensorId, data.nombre || sensorId);
          }
          estadoSensores[key].sabotajeEnviado = false;
          estadoSensores[key].ultimoHB = hbActual;
        }

        const diff = ahora - hbActual;
        if (diff > HEARTBEAT_TIMEOUT && !estadoSensores[key].sabotajeEnviado) {
          console.log(`ðŸš¨ SABOTAJE detectado en sensor '${sensorId}' del usuario '${userId}' â€” Sin heartbeat por ${diff}s`);
          estadoSensores[key].sabotajeEnviado = true;
          await alertarSabotaje(userId, sensorId, data.nombre || sensorId, diff);
        }
      }
    } catch (e) {
      console.error('âŒ Error en monitor heartbeat:', e.message);
    }
  }, 5000);
}

async function alertarSabotaje(userId, sensorId, nombre, segundos) {
  try {
    const mensaje = `âš ï¸ Sensor '${nombre}' desconectado (${segundos}s sin seÃ±al). Posible sabotaje o corte de energÃ­a.`;

    await db.collection('alerts').doc(userId).set({
      active: true, message: mensaje,
      nivel: 'severo', titulo: 'âš ï¸ ALERTA DE SABOTAJE',
      sensor_id: sensorId, timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    await admin.messaging().send({
      topic: `user_${userId}`, android: { priority: 'high' },
      data: { alert: 'true', message: mensaje, nivel: 'severo', titulo: 'âš ï¸ ALERTA DE SABOTAJE' },
    });

    await db.collection('sensores').doc(sensorId).set({
      online: false,
      activo: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`âœ… Alerta de sabotaje enviada para sensor '${sensorId}'`);
  } catch(e) {
    console.error('âŒ Error enviando alerta sabotaje:', e.message);
  }
}

async function notificarRestauracion(userId, sensorId, nombre) {
  try {
    await admin.messaging().send({
      topic: `user_${userId}`, android: { priority: 'high' },
      data: {
        alert: 'true',
        message: `âœ… Sensor '${nombre}' restaurado y en lÃ­nea nuevamente.`,
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
    console.error('âŒ Error notificando restauraciÃ³n:', e.message);
  }
}

// â”€â”€ Firebase Auth REST â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Servidor HTTP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const json = (data, code=200) => { res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(data)); };
  const err  = (msg, code=500) => { res.writeHead(code,{'Content-Type':'text/plain'}); res.end(msg); };

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(302, { Location: '/admin' });
    return res.end();
  }

  // â”€â”€ Panel administrador â”€â”€
  if (req.method === 'GET' && req.url === '/admin') {
    res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
    return res.end(fs.readFileSync(path.join(__dirname,'panel.html')));
  }

  // â”€â”€ Panel usuario â”€â”€
  if (req.method === 'GET' && req.url === '/usuario') {
    res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
    return res.end(fs.readFileSync(path.join(__dirname,'panel_usuario.html')));
  }

  if (req.method === 'GET' && req.url === '/ping') return json({ ok:true });

  // â”€â”€ Estado sensores (para el panel) â”€â”€
  // â”€â”€ Sensores del usuario especÃ­fico â”€â”€
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

  // â”€â”€ Registrar cÃ³digo de usuario para ESP32 â”€â”€
  if (req.method === 'POST' && req.url === '/registrar-codigo-esp32') {
    const { uid, codigo } = await parseBody(req);
    try {
      // Guardar en RTDB: codigoUsuarios/CODIGO â†’ uid
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

  // â”€â”€ Toggle simulador de presencia â”€â”€
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
      console.log(`ðŸ’¡ Simulador de presencia: ${activo ? 'ACTIVADO' : 'DESACTIVADO'}`);
      return json({ ok: true, activo });
    } catch(e) { return err(e.message); }
  }

  // â”€â”€ Login â”€â”€
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
      console.log(`âœ… Login: ${email} (${isAdmin ? 'ADMIN' : 'usuario'})`);
      return json({ ok:true, uid: result.localId, isAdmin, email, codigo });
    } catch(e) {
      const msg = e.message.includes('INVALID_PASSWORD') || e.message.includes('EMAIL_NOT_FOUND')
        ? 'Email o contraseÃ±a incorrectos.' : 'Error al iniciar sesiÃ³n.';
      return json({ ok:false, error: msg }, 401);
    }
  }

  // â”€â”€ Usuarios (solo desde localhost) â”€â”€
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
            console.log(`ðŸ§¹ Usuario huerfano limpiado del panel: ${d.id}`);
            continue;
          }
          throw e;
        }
      }
      return json({ users });
    } catch(e) { return err(e.message); }
  }

  // â”€â”€ Buscar por cÃ³digo â”€â”€
  if (req.method === 'POST' && req.url === '/find-by-code') {
    const { codigo } = await parseBody(req);
    try {
      const snap = await db.collection('users').where('codigo', '==', codigo).limit(1).get();
      if (snap.empty) return json({ found: false });
      const doc = snap.docs[0];
      return json({ found: true, uid: doc.id, email: doc.data().email, codigo });
    } catch(e) { return err(e.message); }
  }

  // â”€â”€ Enviar alarma â”€â”€
  if (req.method === 'POST' && req.url === '/send-alarm') {
    const { message, nivel, titulo, uid, uids } = await parseBody(req);
    const msg  = message || 'ðŸš¨ Â¡ALERTA!';
    const niv  = nivel   || 'moderado';
    const tit  = titulo  || 'Alerta SÃ­smica';
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
    } catch(e) { console.error('âŒ', e.message); return err(e.message); }
  }

  // â”€â”€ Cancelar alarma â”€â”€
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

  // â”€â”€ Toggle usuario (solo desde localhost) â”€â”€
  if (req.method === 'POST' && req.url === '/toggle-user') {
    const { uid, activo } = await parseBody(req);
    try {
      await db.collection('users').doc(uid).update({ activo });
      return json({ ok:true });
    } catch(e) { return err(e.message); }
  }

  // â”€â”€ Guardar URL cÃ¡mara â”€â”€
  if (req.method === 'POST' && req.url === '/save-camera-url') {
    const { uid, url, camaraUrl, camaras } = await parseBody(req);
    try {
      await db.collection('sistema').doc(uid).set({
        camaraUrl: camaraUrl || url || '',
        camaras: Array.isArray(camaras) ? camaras : admin.firestore.FieldValue.delete(),
      }, { merge: true });
      console.log(`ðŸ“¹ URL cÃ¡mara guardada para ${uid}: ${camaraUrl || url || ''}`);
      return json({ ok: true });
    } catch(e) { return err(e.message); }
  }

  // â”€â”€ Get sistema del usuario â”€â”€
  if (req.method === 'GET' && req.url.startsWith('/get-sistema')) {
    const uid = new URL('http://x'+req.url).searchParams.get('uid');
    try {
      const doc = await db.collection('sistema').doc(uid).get();
      return json({ ok:true, ...doc.data() });
    } catch(e) { return err(e.message); }
  }

  // â”€â”€ Toggle sistema usuario â”€â”€
  if (req.method === 'POST' && req.url === '/toggle-sistema') {
    const body = await parseBody(req);
    const { uid, ...rest } = body;
    try {
      await db.collection('sistema').doc(uid).set(
        { ...rest, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true });
      if (typeof rest.armado === 'boolean') {
        await rtdb.ref(`/usuarios/${uid}/sistema/armado`).set(rest.armado);
        console.log(`ðŸ”„ Sistema ${rest.armado?'ARMADO':'DESARMADO'} por usuario ${uid}`);
      }
      return json({ ok:true });
    } catch(e) { return err(e.message); }
  }

  // â”€â”€ Get miembros del hogar â”€â”€
  if (req.method === 'GET' && req.url.startsWith('/get-miembros')) {
    const uid = new URL('http://x'+req.url).searchParams.get('uid');
    try {
      const snap = await db.collection('sistema').doc(uid).collection('miembros').get();
      const miembros = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return json({ ok:true, miembros });
    } catch(e) { return err(e.message); }
  }

  // â”€â”€ Get historial de alarmas del usuario â”€â”€
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

  // â”€â”€ Alerta escolta â”€â”€
  if (req.method === 'POST' && req.url === '/escort-alert') {
    const { uid, message, lat, lng } = await parseBody(req);
    try {
      const mapsUrl = `https://maps.google.com/?q=${lat},${lng}`;
      const msg = message || `âš ï¸ Alerta de ruta no completada. Ãšltima ubicaciÃ³n: ${mapsUrl}`;
      await db.collection('alerts').doc('alert1').set({
        active: true, message: msg, nivel: 'severo',
        titulo: 'ðŸ›¡ï¸ ALERTA ESCOLTA',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      await admin.messaging().send({
        topic: 'alarm', android: { priority: 'high' },
        data: { alert:'true', message: msg, nivel:'severo', titulo:'ðŸ›¡ï¸ ALERTA ESCOLTA' },
      });
      console.log(`ðŸ›¡ï¸ Alerta escolta enviada para ${uid}`);
      return json({ ok: true });
    } catch(e) { return err(e.message); }
  }

  // â”€â”€ Get alertas escolta (admin) â”€â”€
  if (req.method === 'GET' && req.url === '/get-escort-alerts') {
    try {
      const snap = await db.collection('escolta').where('alertaEnviada','==',true).get();
      const alertas = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      return json({ alertas });
    } catch(e) { return err(e.message); }
  }

  // â”€â”€ Anti-robo: borrado remoto â”€â”€
  if (req.method === 'POST' && req.url === '/remote-wipe') {
    const { uid } = await parseBody(req);
    try {
      await admin.messaging().send({
        topic: `user_${uid}`, android: { priority: 'high' },
        data: { tipo: 'remote_wipe', uid }
      });
      await db.collection('anti_robo').doc(uid).update({ borradoRemoto: true });
      console.log(`ðŸ—‘ï¸ Borrado remoto enviado a ${uid}`);
      return json({ ok: true });
    } catch(e) { return err(e.message); }
  }

  // â”€â”€ Google Assistant webhook â”€â”€
  // â”€â”€ Control manual de componente (LED/RelÃ©/Buzzer) â”€â”€
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

  // â”€â”€ Endpoints GET para Google Home Routines â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        respuesta = 'Sistema armado âœ…';
      }
      else if (cmd === 'desarmar') {
        await db.collection('sistema').doc(uid)
          .set({ armado: false }, { merge: true });
        respuesta = 'Sistema desarmado âœ…';
      }
      else if (cmd === 'alarma') {
        const nivel = url.searchParams.get('nivel') || 'moderado';
        await db.collection('alerts').doc(uid).set({
          active: true, nivel,
          titulo: nivel === 'severo' ? 'ðŸš¨ ALERTA SEVERA' : 'âš ï¸ Alerta',
          message: 'Alerta activada por Google Home',
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        await admin.messaging().send({
          topic: `user_${uid}`,
          data: { tipo: 'alarma', nivel, titulo: 'Alerta', message: 'Google Home' },
          android: { priority: 'high', notification: { channelId: 'homealert_alarm' } }
        });
        respuesta = `Alarma ${nivel} enviada ðŸš¨`;
      }
      else if (cmd === 'cancelar') {
        await db.collection('alerts').doc(uid)
          .set({ active: false }, { merge: true });
        respuesta = 'Alarma cancelada âœ…';
      }
      else if (cmd === 'simulador/on') {
        await db.collection('sistema').doc(uid)
          .set({ simuladorPresencia: true }, { merge: true });
        respuesta = 'Simulador activado ðŸ’¡';
      }
      else if (cmd === 'noche/on') {
        await db.collection('sistema').doc(uid).set({
          modoNoche: true, ignorarGPS: true, armado: true
        }, { merge: true });
        respuesta = 'Modo Noche activado ðŸŒ™';
      }
      else if (cmd === 'noche/off') {
        await db.collection('sistema').doc(uid).set({
          modoNoche: false, ignorarGPS: false, armado: false
        }, { merge: true });
        respuesta = 'Modo Noche desactivado â˜€ï¸';
      }
      else if (cmd === 'simulador/off') {
        await db.collection('sistema').doc(uid)
          .set({ simuladorPresencia: false }, { merge: true });
        respuesta = 'Simulador desactivado ðŸ’¡';
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

      console.log(`ðŸ  Google Home [${uid.substring(0,8)}...]: ${cmd} â†’ ${respuesta}`);
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
  console.log(`\nðŸš¨ HomeAlert Panel â†’ http://localhost:${PORT}`);
  console.log(`ðŸ‘‘ Admin: ${ADMIN_EMAIL}`);
  iniciarMonitorHeartbeat();
});


