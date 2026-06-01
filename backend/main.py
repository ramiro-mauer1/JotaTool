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
import base64
import time

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
# Clipdrop & HF API Keys
# ---------------------------------------------------------------------------
CLIPDROP_API_KEY = os.getenv("CLIPDROP_API_KEY")
HF_API_TOKEN = os.getenv("HF_API_TOKEN")

if CLIPDROP_API_KEY:
    logger.info("Clipdrop API key found.")
else:
    logger.warning("CLIPDROP_API_KEY not found in environment variables.")

if HF_API_TOKEN:
    logger.info("Hugging Face API token found. OWL-ViT logo detection enabled.")
else:
    logger.warning("HF_API_TOKEN not found. Graphic logo removal will be skipped.")


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

def run_opencv_fallback(original_path: str, processed_path: str) -> None:
    """Local fallback: uses OpenCV inpainting (INPAINT_TELEA)."""
    logger.info(f"Applying OpenCV fallback for {original_path}")
    img = cv2.imread(original_path)
    if img is None:
        raise ValueError(f"Could not load image: {original_path}")

    # Generate a simple block mask for the fallback
    height, width = img.shape[:2]
    mask = np.zeros((height, width), dtype=np.uint8)
    cv2.rectangle(mask, (int(width * 0.60), int(height * 0.80)), (int(width * 0.98), int(height * 0.98)), 255, -1)
    cv2.rectangle(mask, (int(width * 0.15), int(height * 0.35)), (int(width * 0.85), int(height * 0.65)), 255, -1)

    inpainted = cv2.inpaint(img, mask, inpaintRadius=7, flags=cv2.INPAINT_TELEA)
    cv2.imwrite(processed_path, inpainted)


def _call_clipdrop_remove_text(original_path: str) -> bytes:
    """Synchronous call to Clipdrop Remove-Text API."""
    with open(original_path, 'rb') as img_f:
        r = requests.post(
            'https://clipdrop-api.co/remove-text/v1',
            files={'image_file': ('image.jpg', img_f, 'image/jpeg')},
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


def _call_hf_owlvit(image_bytes: bytes) -> list:
    """Synchronous call to Hugging Face OWL-ViT for zero-shot logo detection."""
    if not HF_API_TOKEN:
        return []
        
    API_URL = "https://api-inference.huggingface.co/models/google/owlvit-base-patch32"
    headers = {"Authorization": f"Bearer {HF_API_TOKEN}"}
    b64_image = base64.b64encode(image_bytes).decode('utf-8')
    
    payload = {
        "inputs": b64_image,
        "parameters": {"candidate_labels": ["logo", "watermark", "icon"]}
    }
    
    # Retry mechanism for HF Cold Starts
    for attempt in range(3):
        r = requests.post(API_URL, headers=headers, json=payload)
        if r.ok:
            return r.json()
        elif r.status_code == 503:
            logger.info("HF OWL-ViT model is loading. Waiting 10 seconds...")
            time.sleep(10)
        else:
            logger.error(f"HF API Error: {r.text}")
            return []
    return []


def _call_clipdrop_cleanup(img_path: str, mask_path: str) -> bytes:
    """Synchronous call to Clipdrop Cleanup API for logo removal."""
    with open(img_path, 'rb') as img_f, open(mask_path, 'rb') as mask_f:
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
    Multi-AI Pipeline:
    1. Clipdrop Remove-Text (Erases all text perfectly without mask)
    2. HF OWL-ViT (Detects remaining graphic logos)
    3. Clipdrop Cleanup (Inpaints the exact logo bounding box)
    """
    if not CLIPDROP_API_KEY:
        run_opencv_fallback(original_path, processed_path)
        return

    try:
        loop = asyncio.get_event_loop()
        
        # 1. Remove Text
        logger.info(f"Pipeline Step 1: Remove-Text for {original_path}")
        textless_bytes = await loop.run_in_executor(None, _call_clipdrop_remove_text, original_path)

        # 2. Detect Logo
        logger.info(f"Pipeline Step 2: OWL-ViT Logo Detection")
        boxes = await loop.run_in_executor(None, _call_hf_owlvit, textless_bytes)
        
        found_valid_logo = False
        if boxes and HF_API_TOKEN:
            # Create a mask from bounding boxes
            img_arr = cv2.imdecode(np.frombuffer(textless_bytes, np.uint8), cv2.IMREAD_COLOR)
            height, width = img_arr.shape[:2]
            mask = np.zeros((height, width), dtype=np.uint8)
            
            for item in boxes:
                score = item.get("score", 0)
                if score > 0.05:  # Low threshold to catch faded logos
                    box = item.get("box", {})
                    xmin, ymin, xmax, ymax = box.get("xmin"), box.get("ymin"), box.get("xmax"), box.get("ymax")
                    if None not in (xmin, ymin, xmax, ymax):
                        # Expand box by 15px to cover halo
                        pad = 15
                        x1 = max(0, xmin - pad)
                        y1 = max(0, ymin - pad)
                        x2 = min(width, xmax + pad)
                        y2 = min(height, ymax + pad)
                        
                        # Only mask if it's smaller than 25% of the image (prevents disastrous huge masks)
                        box_area = (x2 - x1) * (y2 - y1)
                        if box_area < (width * height * 0.25):
                            cv2.rectangle(mask, (x1, y1), (x2, y2), 255, -1)
                            found_valid_logo = True
                            logger.info(f"Logo detected at {x1},{y1} to {x2},{y2} (Score: {score:.2f})")

            if found_valid_logo:
                # 3. Cleanup the logo
                logger.info(f"Pipeline Step 3: Cleanup Logo")
                temp_img = processed_path + "_temp.jpg"
                temp_mask = processed_path + "_mask.png"
                
                with open(temp_img, "wb") as f:
                    f.write(textless_bytes)
                cv2.imwrite(temp_mask, mask)
                
                final_bytes = await loop.run_in_executor(None, _call_clipdrop_cleanup, temp_img, temp_mask)
                
                with open(processed_path, "wb") as f:
                    f.write(final_bytes)
                    
                os.remove(temp_img)
                os.remove(temp_mask)
                logger.info(f"Pipeline completed successfully with logo removal: {processed_path}")
                return

        # If no logo was found or HF token missing, just save the textless image
        with open(processed_path, "wb") as f:
            f.write(textless_bytes)
        logger.info(f"Pipeline completed (Text only): {processed_path}")

    except Exception as e:
        logger.error(f"Multi-AI Pipeline error: {e}")
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
