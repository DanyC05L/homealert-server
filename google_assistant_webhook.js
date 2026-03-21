/*
  Webhook para Google Assistant via IFTTT — HomeAlert v2.0
  Soporta: Admin (control global) + Usuarios (control individual)

  ══════════════════════════════════════════════════════════
  CONFIGURACIÓN PARA EL ADMIN (control global):
  ══════════════════════════════════════════════════════════
  En IFTTT → Create:
  IF: Google Assistant → "Say a phrase with a text ingredient"
    - Phrase 1: "alarma $"
    - Phrase 2: "activa $"  
    - Phrase 3: "modo $"
    Language: Spanish
  THEN: Webhooks → Make a web request
    URL:          https://homealert-server.onrender.com/assistant
    Method:       POST
    Content Type: application/json
    Body:         {"comando":"{{TextField}}","key":"HOMEALERT2025","uid":"ADMIN"}

  ══════════════════════════════════════════════════════════
  CONFIGURACIÓN PARA CADA USUARIO (control individual):
  ══════════════════════════════════════════════════════════
  Cada usuario crea su propio applet en IFTTT con:
  Body: {"comando":"{{TextField}}","key":"HOMEALERT2025","uid":"UID_DEL_USUARIO"}
  
  El usuario encuentra su UID en la app: Cuenta → su código único
  (el admin puede verlo en el panel web)

  ══════════════════════════════════════════════════════════
  COMANDOS DISPONIBLES (decir en español):
  ══════════════════════════════════════════════════════════
  "activa la seguridad"    → Arma el sistema
  "desactiva la seguridad" → Desarma el sistema  
  "activa la alarma"       → Alarma moderada
  "alarma severa"          → Alarma nivel severo
  "activa el simulador"    → Activa simulador presencia
  "desactiva el simulador" → Desactiva simulador
  "cancela la alarma"      → Cancela alarma activa
*/

const WEBHOOK_KEY = 'HOMEALERT2025'; // Clave compartida para todos
const ADMIN_UID   = 'MZwQOaqtZob1gYQ1e4IOqAzKNo42';

async function assistantHandler(req, res, db, adminSDK) {
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    try {
      const { comando, key, uid } = JSON.parse(body);

      // Verificar clave secreta
      if (key !== WEBHOOK_KEY) {
        console.log('❌ Google Assistant: clave incorrecta');
        res.writeHead(401); return res.end('Unauthorized');
      }

      const cmd = (comando || '').toLowerCase().trim();
      console.log(`🎙️ Google Assistant: "${cmd}" — uid: ${uid || 'admin'}`);

      // Determinar qué UID usar
      // Si uid === 'ADMIN' o no viene → usar admin (acción global)
      // Si uid es un UID específico → actuar sobre ese usuario
      const esAdmin = !uid || uid === 'ADMIN';
      const targetUid = esAdmin ? ADMIN_UID : uid;

      let respuesta = 'Comando no reconocido.';

      // ── ARMAR sistema ──
      if (cmd.includes('activ') && (cmd.includes('seguridad') || cmd.includes('alarma') && !cmd.includes('severa') && !cmd.includes('leve'))) {
        if (esAdmin) {
          // Admin: arma sistema del admin Y envía FCM global
          await db.collection('sistema').doc(ADMIN_UID).set(
            { armado: true, updatedAt: adminSDK.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
          respuesta = 'Sistema de seguridad activado globalmente.';
        } else {
          // Usuario: arma solo su sistema
          await db.collection('sistema').doc(targetUid).set(
            { armado: true, updatedAt: adminSDK.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
          respuesta = 'Tu sistema de seguridad fue activado.';
        }
      }

      // ── DESARMAR sistema ──
      else if ((cmd.includes('desactiv') || cmd.includes('apaga')) && cmd.includes('seguridad')) {
        await db.collection('sistema').doc(targetUid).set(
          { armado: false, updatedAt: adminSDK.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
        respuesta = esAdmin ? 'Sistema desactivado.' : 'Tu sistema fue desactivado.';
      }

      // ── ALARMA SEVERA ──
      else if (cmd.includes('severa') || cmd.includes('emergencia')) {
        const nivel = 'severo';
        const titulo = 'ALERTA SEVERA';
        const mensaje = esAdmin ? '⚠️ Alerta severa activada por administrador' : '⚠️ Alerta severa';
        
        if (esAdmin) {
          // Admin envía a todos
          await db.collection('alerts').doc('alert1').set({
            active: true, nivel, titulo, message: mensaje,
            timestamp: adminSDK.firestore.FieldValue.serverTimestamp()
          });
        } else {
          await db.collection('alerts').doc(targetUid).set({
            active: true, nivel, titulo, message: mensaje,
            timestamp: adminSDK.firestore.FieldValue.serverTimestamp()
          });
        }

        // Enviar FCM
        const topic = esAdmin ? 'alarm' : `user_${targetUid}`;
        await adminSDK.messaging().send({
          topic,
          data: { tipo: 'alarma', nivel, titulo, message: mensaje },
          notification: { title: titulo, body: mensaje },
          android: { priority: 'high', notification: { channelId: 'homealert_alarm' } }
        });
        respuesta = 'Alerta severa enviada.';
      }

      // ── ALARMA MODERADA ──
      else if (cmd.includes('alarma') || cmd.includes('alerta')) {
        const nivel = cmd.includes('leve') ? 'leve' : 'moderado';
        const titulo = nivel === 'leve' ? 'Alerta Leve' : 'Alerta Sísmica';
        const mensaje = esAdmin ? `Alerta ${nivel} activada por administrador` : `Alerta ${nivel}`;

        const topic = esAdmin ? 'alarm' : `user_${targetUid}`;
        await adminSDK.messaging().send({
          topic,
          data: { tipo: 'alarma', nivel, titulo, message: mensaje },
          notification: { title: titulo, body: mensaje },
          android: { priority: 'high', notification: { channelId: 'homealert_alarm' } }
        });
        respuesta = `Alerta ${nivel} enviada.`;
      }

      // ── SIMULADOR ON ──
      else if (cmd.includes('activ') && cmd.includes('simulador')) {
        await db.collection('sistema').doc(targetUid).set(
          { simuladorPresencia: true, updatedAt: adminSDK.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
        respuesta = 'Simulador de presencia activado.';
      }

      // ── SIMULADOR OFF ──
      else if ((cmd.includes('desactiv') || cmd.includes('apaga')) && cmd.includes('simulador')) {
        await db.collection('sistema').doc(targetUid).set(
          { simuladorPresencia: false, updatedAt: adminSDK.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
        respuesta = 'Simulador de presencia desactivado.';
      }

      // ── CANCELAR ALARMA ──
      else if (cmd.includes('cancel') || cmd.includes('para') || cmd.includes('detén')) {
        await db.collection('alerts').doc(esAdmin ? 'alert1' : targetUid).set(
          { active: false }, { merge: true }
        );
        const topic = esAdmin ? 'alarm' : `user_${targetUid}`;
        await adminSDK.messaging().send({
          topic,
          data: { tipo: 'cancelar_alarma' },
          android: { priority: 'high' }
        });
        respuesta = 'Alarma cancelada.';
      }

      console.log(`✅ Respuesta: ${respuesta}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, respuesta }));

    } catch (e) {
      console.error('Error assistant:', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
}

module.exports = assistantHandler;
