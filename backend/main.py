import os
import uuid
import json
import asyncio
import io
import time
import shutil
import logging
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, BackgroundTasks, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from PIL import Image
import numpy as np
import cv2
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

import requests

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="JotaTool — Batch Watermark Remover API", version="1.0.0")

# CORS – allow all origins for the Vercel deployment
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Temp storage for uploaded / processed images
# ---------------------------------------------------------------------------
TEMP_DIR = "temp_storage"
os.makedirs(TEMP_DIR, exist_ok=True)
app.mount("/images", StaticFiles(directory=TEMP_DIR), name="images")

# ---------------------------------------------------------------------------
# In-memory batch state
# Structure: { batch_id: { status, current, total, message, files: [...] } }
# ---------------------------------------------------------------------------
batches: Dict[str, Dict[str, Any]] = {}

# ---------------------------------------------------------------------------
# Clipdrop API Key
# ---------------------------------------------------------------------------
CLIPDROP_API_KEY = os.getenv("CLIPDROP_API_KEY")

if CLIPDROP_API_KEY:
    logger.info("Clipdrop API key found. Using Clipdrop for inpainting.")
else:
    logger.warning(
        "CLIPDROP_API_KEY not found in environment variables. "
        "OpenCV fallback will be used for local processing."
    )


# ===================================================================
# Application Startup (Garbage Collection)
# ===================================================================

@app.on_event("startup")
async def startup_event():
    async def cleanup_temp_storage():
        while True:
            try:
                now = time.time()
                for d in os.listdir(TEMP_DIR):
                    path = os.path.join(TEMP_DIR, d)
                    if os.path.isdir(path):
                        # check modification time, if older than 1 hour (3600s), delete
                        if now - os.path.getmtime(path) > 3600:
                            shutil.rmtree(path, ignore_errors=True)
                            logger.info(f"Garbage Collection: Cleaned up old batch directory: {d}")
            except Exception as e:
                logger.error(f"Error in cleanup task: {e}")
            
            # Check every 10 minutes
            await asyncio.sleep(600)

    asyncio.create_task(cleanup_temp_storage())


# ===================================================================
# Image processing helpers
# ===================================================================

def generate_mask(img_shape) -> np.ndarray:
    """Generates a black/white mask for common watermark areas."""
    height, width = img_shape[:2]
    mask = np.zeros((height, width), dtype=np.uint8)

    # Region 1: bottom-right corner (common for real-estate logos)
    cv2.rectangle(
        mask,
        (int(width * 0.60), int(height * 0.80)),
        (int(width * 0.98), int(height * 0.98)),
        255,
        -1,
    )
    # Region 2: center band (diagonal or large watermark text)
    cv2.rectangle(
        mask,
        (int(width * 0.15), int(height * 0.35)),
        (int(width * 0.85), int(height * 0.65)),
        255,
        -1,
    )
    return mask


def run_opencv_fallback(original_path: str, processed_path: str) -> None:
    """Local fallback: uses OpenCV inpainting (INPAINT_TELEA)."""
    logger.info(f"Applying OpenCV fallback for {original_path}")
    img = cv2.imread(original_path)
    if img is None:
        raise ValueError(f"Could not load image: {original_path}")

    mask = generate_mask(img.shape)
    inpainted = cv2.inpaint(img, mask, inpaintRadius=7, flags=cv2.INPAINT_TELEA)
    cv2.imwrite(processed_path, inpainted)


def _call_clipdrop_sync(original_path: str, mask_path: str) -> bytes:
    """Synchronous call to Clipdrop Cleanup API."""
    with open(original_path, 'rb') as img_f, open(mask_path, 'rb') as mask_f:
        r = requests.post(
            'https://clipdrop-api.co/cleanup/v1',
            files={
                'image_file': ('image.jpg', img_f, 'image/jpeg'),
                'mask_file': ('mask.png', mask_f, 'image/png')
            },
            headers={'x-api-key': CLIPDROP_API_KEY}
        )
    
    if r.ok:
        return r.content
    else:
        try:
            err = r.json()
            raise Exception(f"{r.status_code} - {err.get('error', r.text)}")
        except:
            raise Exception(f"HTTP {r.status_code}: {r.text}")


async def process_image_with_clipdrop(original_path: str, processed_path: str) -> None:
    """
    Attempts watermark removal via Clipdrop Cleanup API.
    """
    if not CLIPDROP_API_KEY:
        run_opencv_fallback(original_path, processed_path)
        return

    try:
        # Generate the mask image required by Clipdrop
        img = cv2.imread(original_path)
        if img is None:
            raise ValueError(f"Could not load image: {original_path}")
        
        mask = generate_mask(img.shape)
        mask_path = original_path + "_mask.png"
        cv2.imwrite(mask_path, mask)

        # Call API in executor
        loop = asyncio.get_event_loop()
        image_bytes = await loop.run_in_executor(None, _call_clipdrop_sync, original_path, mask_path)

        with open(processed_path, "wb") as f:
            f.write(image_bytes)
        logger.info(f"Image processed successfully with Clipdrop: {processed_path}")
        
        # Cleanup temp mask
        if os.path.exists(mask_path):
            os.remove(mask_path)

    except Exception as e:
        logger.error(f"Clipdrop API error: {e}")
        # Re-raise to fail the batch in the UI
        raise e


# ===================================================================
# Background batch processor
# ===================================================================

async def background_batch_processor(batch_id: str, files_data: List[Dict[str, str]]) -> None:
    """
    Processes uploaded images sequentially with a 6.5-second delay between
    Gemini calls to respect API rate limits.
    """
    batches[batch_id]["status"] = "processing"
    total_files = len(files_data)

    for i, file_info in enumerate(files_data):
        original_path = file_info["local_original"]
        processed_path = file_info["local_processed"]

        logger.info(f"Batch {batch_id}: Processing file {i + 1} of {total_files} ({file_info['name']})")

        # Update progress
        batches[batch_id]["current"] = i + 1
        batches[batch_id]["message"] = f"Cleaning photo {i + 1} of {total_files}..."

        # Process via Clipdrop or fallback
        try:
            await process_image_with_clipdrop(original_path, processed_path)
        except Exception as e:
            logger.error(f"Batch {batch_id} failed on file {i+1}: {e}")
            batches[batch_id]["status"] = "failed"
            batches[batch_id]["message"] = f"Error en la IA: {str(e)}"
            return

        # Register the processed file
        batches[batch_id]["files"].append({
            "name": file_info["name"],
            "original": f"/images/{batch_id}/{os.path.basename(original_path)}",
            "processed": f"/images/{batch_id}/{os.path.basename(processed_path)}",
        })

        # Rate-limit delay (skip after the last image)
        if i < total_files - 1:
            logger.info(f"Batch {batch_id}: Waiting 6.5s before next file (rate limiting)...")
            await asyncio.sleep(6.5)

    batches[batch_id]["status"] = "completed"
    batches[batch_id]["message"] = "Batch processing completed successfully."
    logger.info(f"Batch {batch_id} completed.")


# ===================================================================
# API endpoints
# ===================================================================

@app.post("/api/upload")
async def upload_batch(background_tasks: BackgroundTasks, files: List[UploadFile] = File(...)):
    """
    Upload up to 25 images, initialise batch state, and queue background processing.
    """
    if len(files) > 25:
        raise HTTPException(status_code=400, detail="Batch exceeds the 25-image limit.")

    if not files:
        raise HTTPException(status_code=400, detail="No files were uploaded.")

    batch_id = str(uuid.uuid4())
    batch_dir = os.path.join(TEMP_DIR, batch_id)
    os.makedirs(batch_dir, exist_ok=True)

    files_data: List[Dict[str, str]] = []

    for i, file in enumerate(files):
        # Validate MIME type
        if not file.content_type or not file.content_type.startswith("image/"):
            raise HTTPException(status_code=400, detail=f"File {file.filename} is not a valid image.")

        file_ext = os.path.splitext(file.filename)[1] or ".png"
        original_name = f"original_{i}{file_ext}"
        processed_name = f"processed_{i}{file_ext}"

        local_original = os.path.join(batch_dir, original_name)
        local_processed = os.path.join(batch_dir, processed_name)

        content = await file.read()
        with open(local_original, "wb") as f:
            f.write(content)

        files_data.append({
            "name": file.filename,
            "local_original": local_original,
            "local_processed": local_processed,
        })

    # Initialise batch record
    batches[batch_id] = {
        "status": "queued",
        "current": 0,
        "total": len(files),
        "message": "Queued for processing...",
        "files": [],
    }

    # Enqueue background processing
    background_tasks.add_task(background_batch_processor, batch_id, files_data)

    return {"batch_id": batch_id, "total": len(files)}


@app.get("/api/progress/{batch_id}")
async def get_progress(batch_id: str):
    """
    Server-Sent Events (SSE) channel for real-time progress updates.
    """
    if batch_id not in batches:
        raise HTTPException(status_code=404, detail="Batch ID not found.")

    async def sse_event_generator():
        while True:
            batch = batches.get(batch_id)
            if not batch:
                break

            data = {
                "status": batch["status"],
                "current": batch["current"],
                "total": batch["total"],
                "message": batch["message"],
                "files": batch["files"],
            }

            yield f"data: {json.dumps(data)}\n\n"

            if batch["status"] in ["completed", "failed"]:
                break

            await asyncio.sleep(0.5)

    return StreamingResponse(sse_event_generator(), media_type="text/event-stream")



# ===================================================================
# Entry point
# ===================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
