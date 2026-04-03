# HomeAlert Server

Servidor web y backend ligero para **HomeAlert**, una plataforma de seguridad inteligente para hogares, integrando aplicación móvil, panel web, Firebase, ESP32 y automatización con Google Home.

---

## Descripción

Este repositorio contiene la parte del **servidor web** y el **panel web de usuario** de HomeAlert.

Su función principal es permitir la comunicación entre la aplicación, los sensores ESP32, Firebase y las automatizaciones web, además de ofrecer un panel para que cada usuario pueda gestionar su sistema de seguridad desde el navegador.

---

## Funciones principales

- Panel web de usuario
- Integración con Firebase
- Gestión de sensores ESP32
- Estado del sistema de seguridad
- Control manual de relés, luces y salidas
- Configuración de modo noche
- Integración con Google Home
- Generación de enlaces para automatizaciones
- Visualización de cámaras IP
- Manejo de eventos, alertas y sensores

---

## Archivos principales del proyecto

- `server.js`  
  Servidor principal que expone rutas HTTP, sirve el panel web y maneja la lógica de comunicación con Firebase.

- `panel_usuario.html`  
  Interfaz web para usuarios finales. Permite controlar el sistema, ver sensores, cámaras, sonidos, enlaces y salidas manuales.

- `google_assistant_webhook.js`  
  Archivo relacionado con la integración para comandos desde Google Assistant / Google Home.

- `package.json`  
  Configuración del proyecto Node.js y dependencias necesarias.

- `.gitignore`  
  Exclusión de archivos privados o sensibles del repositorio.

---

## Qué incluye el panel web de usuario

El panel web de usuario permite:

- Ver el estado del sistema
- Activar o desactivar seguridad
- Consultar sensores conectados
- Ver cámaras IP registradas
- Gestionar luces, relés y salidas manuales
- Usar funciones relacionadas con Google Home
- Ver configuraciones del sistema
- Usar tema claro, oscuro o adaptado al sistema

---

## Integración con ESP32

Este servidor trabaja junto a nodos ESP32 para:

- Registrar sensores
- Reportar estado online/offline
- Enviar eventos a Firebase
- Leer configuración del usuario
- Sincronizar componentes como PIR, relés, luces, buzzers y sensores adicionales

---

## Integración con Firebase

HomeAlert usa Firebase como base para manejar:

- Usuarios
- Configuración del sistema
- Sensores
- Eventos
- Alertas
- Historial
- Componentes IoT
- Vinculación por código de usuario

---

## Integración con Google Home

El sistema permite generar enlaces para que el usuario pueda crear rutinas en Google Home y automatizar acciones como:

- Activar seguridad
- Desactivar seguridad
- Activar simulador
- Activar modo noche
- Encender o apagar luces / relés
- Ejecutar comandos personalizados desde rutinas

---

## Requisitos

Antes de ejecutar este proyecto necesitas:

- Node.js instalado
- Cuenta y proyecto de Firebase configurados
- Credenciales necesarias para Firebase
- Dependencias del proyecto instaladas

---

## Instalación

Clona el repositorio:

```bash
git clone <URL_DEL_REPOSITORIO>
cd fcm-test
