"""
XTTS v2 FastAPI server for Eve.
Wraps Coqui TTS to expose a simple REST API for speech synthesis.

Endpoints:
  GET  /health      → {"status": "ok"}
  GET  /speakers    → {"speakers": [...]}
  POST /tts         → {"text", "speaker_name", "language"} → {"audio_base64": "..."}
"""

import base64
import io
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Loaded once at startup
tts_model = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global tts_model
    logger.info("Loading XTTS v2 model…")
    from TTS.api import TTS
    tts_model = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
    logger.info("XTTS v2 model ready.")
    yield
    tts_model = None


app = FastAPI(title="XTTS Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class TTSRequest(BaseModel):
    text: str
    speaker_name: str = "Claribel Dervla"
    language: str = "en"


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/speakers")
def list_speakers():
    if tts_model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    speakers = tts_model.speakers or []
    return {"speakers": speakers}


@app.post("/tts")
def synthesize(req: TTSRequest):
    if tts_model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text must not be empty")

    buf = io.BytesIO()
    tts_model.tts_to_file(
        text=req.text,
        speaker=req.speaker_name,
        language=req.language,
        file_path=buf,
    )
    buf.seek(0)
    audio_b64 = base64.b64encode(buf.read()).decode("utf-8")
    return {"audio_base64": audio_b64}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8020, reload=False)
