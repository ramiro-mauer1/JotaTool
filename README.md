# Luxe Clean — Batch Watermark Remover

Un MVP premium y minimalista de nivel portafolio diseñado con estética **Negro y Oro** para eliminar marcas de agua de lotes de imágenes inmobiliarias (hasta 25 archivos). Integra **Next.js (App Router)** en el frontend, **FastAPI** en el backend y la API de **Google Gemini** utilizando el modelo exclusivo `gemini-2.5-flash-image` para inpainting nativo, con transmisiones de progreso en tiempo real mediante **Server-Sent Events (SSE)**.

---

## Estructura del Proyecto

* **`/backend`**: Servidor FastAPI.
  * `main.py`: Maneja la carga de imágenes, cola secuencial asíncrona con control de cuota (Rate Limiting de 6.5s), llamadas al modelo `gemini-2.5-flash-image`, inpainting de fallback local (OpenCV) y SSE para progreso.
  * `requirements.txt`: Dependencias de Python.
* **`/frontend`**: Aplicación Next.js (App Router).
  * `src/app/page.tsx`: Dashboard con Drag & Drop, barra de progreso dorada, comparador interactivo deslizable (clip-path antes/después) y descarga masiva en ZIP.
  * `tailwind.config.ts` y `src/app/globals.css`: Sistema de diseño premium negro y oro con animaciones fluidas.

---

## Guía de Instalación y Levantamiento Local

Sigue los siguientes pasos para levantar ambos servidores en tu computadora:

### Paso 1: Configurar y Levantar el Backend (FastAPI)

1. Abre tu terminal en la carpeta `backend`:
   ```bash
   cd backend
   ```

2. (Recomendado) Crea y activa un entorno virtual de Python:
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   ```

3. Instala las dependencias necesarias:
   ```bash
   pip install -r requirements.txt
   ```

4. Configura tu API Key de Google Gemini en tus variables de entorno (opcional; el backend incluye un fallback inteligente basado en OpenCV para inpainting local si la API key no está disponible):
   ```bash
   export GEMINI_API_KEY="tu-api-key-de-google-ai-studio"
   ```

5. Inicia el servidor de desarrollo de FastAPI con Uvicorn:
   ```bash
   python main.py
   ```
   *El backend estará corriendo en [http://localhost:8000](http://localhost:8000).*

---

### Paso 2: Configurar y Levantar el Frontend (Next.js)

1. Abre una nueva terminal en la carpeta `frontend`:
   ```bash
   cd frontend
   ```

2. Instala las dependencias de Node.js:
   ```bash
   npm install
   ```

3. Inicia el servidor de desarrollo de Next.js:
   ```bash
   npm run dev
   ```
   *El frontend estará disponible en tu navegador en [http://localhost:3000](http://localhost:3000).*

---

## Características de la Aplicación

1. **Configuración de API Key en Caliente**: Puedes ingresar tu API Key de Gemini directamente desde el dashboard en el frontend si deseas usar el procesamiento nativo con `gemini-2.5-flash-image`, o dejarlo vacío para probar la simulación local basada en OpenCV.
2. **Procesamiento Asíncrono Secuencial (6.5s)**: Al presionar "Procesar Lote", las imágenes son encoladas en el backend y se procesan una a una, esperando 6.5s entre llamadas para mantenerse por debajo del límite estricto de ~10 RPM del Free Tier de Google AI Studio, previniendo errores HTTP 429.
3. **SSE en Vivo**: La barra de progreso y los mensajes descriptivos se actualizan al instante gracias al canal unidireccional SSE establecido entre Next.js y FastAPI.
4. **Comparador Deslizable Interactivo (Antes/Después)**: Implementa una barra interactiva que puedes deslizar horizontalmente sobre las imágenes procesadas para ver exactamente cómo se removió la marca de agua.
5. **Descarga Consolidada (.ZIP)**: Un botón destacado te permite descargar todas las imágenes procesadas consolidadas en un archivo `.zip` generado de manera dinámica en la memoria del backend.
