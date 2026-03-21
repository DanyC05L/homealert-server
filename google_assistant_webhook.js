/*
  Webhook para Google Assistant via IFTTT
  
  Configuración en IFTTT:
  1. Ve a https://ifttt.com → Create
  2. IF: Google Assistant → "Say a phrase with a text ingredient"
     Phrase: "activa $" → "activa seguridad", "activa escolta", etc.
  3. THEN: Webhooks → Make a web request
     URL:    http://TU_IP:3000/assistant
     Method: POST
     Content Type: application/json
     Body:   {"comando":"{{TextField}}","key":"TU_CLAVE_SECRETA"}
  
  Comandos disponibles:
  - "armar"     / "activar seguridad"  → Arma el sistema
  - "desarmar"  / "desactivar seguridad" → Desarma
  - "alarma"    / "activar alarma"     → Activa alarma moderada
  - "simulador" / "activar presencia"  → Activa simulador
  - "escolta"   / "modo escolta"       → Activa modo escolta
*/

const WEBHOOK_KEY = 'TU_CLAVE_SECRETA_AQUI'; // ← cambia esto
const ADMIN_UID   = 'TU_ADMIN_UID_AQUI';      // ← UID del admin en Firebase

// Este módulo se integra al server.js existente
// Agrégalo al final del archivo server.js así:
// const assistantHandler = require('./google_assistant_webhook');
// En el servidor: if (req.url === '/assistant') return assistantHandler(req, res, db, admin);

async function assistantHandler(req, res, db, adminSDK) {
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    try {
      const { comando, key } = JSON.parse(body);

      // Verificar clave secreta
      if (key !== WEBHOOK_KEY) {
        res.writeHead(401); return res.end('Unauthorized');
      }

      const cmd = (comando || '').toLowerCase().trim();
      console.log(`🎙️ Google Assistant: "${cmd}"`);

      let respuesta = 'Comando no reconocido.';

      // ── Armar sistema ──
      if (cmd.includes('armar') || cmd.includes('activar seguridad')) {
        await db.collection('sistema').doc(ADMIN_UID).set(
          { armado: true, updatedAt: adminSDK.firestore.FieldValue.serverTimestamp() },
          { merge: true });
        await adminSDK.database().ref('/sistema/armado').set(true);
        respuesta = 'Sistema de seguridad armado.';
        console.log('🔴 Sistema ARMADO via Google Assistant');
      }

      // ── Desarmar sistema ──
      else if (cmd.includes('desarmar') || cmd.includes('desactivar seguridad')) {
        await db.collection('sistema').doc(ADMIN_UID).set(
          { armado: false, updatedAt: adminSDK.firestore.FieldValue.serverTimestamp() },
          { merge: true });
        await adminSDK.database().ref('/sistema/armado').set(false);
        respuesta = 'Sistema de seguridad desarmado.';
        console.log('🟢 Sistema DESARMADO via Google Assistant');
      }

      // ── Activar alarma ──
      else if (cmd.includes('alarma') || cmd.includes('activar alarma')) {
        await db.collection('alerts').doc('alert1').set({
          active: true, message: '🎙️ Alarma activada por Google Assistant',
          nivel: 'moderado', titulo: 'Alerta Sísmica',
          timestamp: adminSDK.firestore.FieldValue.serverTimestamp(),
        });
        await adminSDK.messaging().send({
          topic: 'alarm', android: { priority: 'high' },
          data: { alert:'true', message:'🎙️ Alarma activada por Google Assistant',
                  nivel:'moderado', titulo:'Alerta Sísmica' },
        });
        respuesta = 'Alarma activada en todos los dispositivos.';
        console.log('🚨 Alarma activada via Google Assistant');
      }

      // ── Simulador de presencia ──
      else if (cmd.includes('simulador') || cmd.includes('presencia')) {
        await db.collection('sistema').doc(ADMIN_UID).set(
          { simuladorPresencia: true }, { merge: true });
        await adminSDK.database().ref('/sistema/simuladorPresencia').set(true);
        respuesta = 'Simulador de presencia activado.';
        console.log('💡 Simulador activado via Google Assistant');
      }

      // ── Cancelar alarma ──
      else if (cmd.includes('cancelar') || cmd.includes('detener alarma')) {
        await db.collection('alerts').doc('alert1').update({ active: false });
        await adminSDK.database().ref('/sistema/cancelar_alarma').set(true);
        respuesta = 'Alarma cancelada.';
        console.log('⏹ Alarma cancelada via Google Assistant');
      }

      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: true, respuesta }));

    } catch (e) {
      console.error('❌ Error webhook:', e.message);
      res.writeHead(500); res.end(e.message);
    }
  });
}

module.exports = assistantHandler;
