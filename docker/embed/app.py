"""Text embedding service: bge-m3, multilingual, 1024 dimensions, CPU only."""

import logging
import os
from typing import List

from flask import Flask, jsonify, request
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.environ.get("EMBED_MODEL", "BAAI/bge-m3")
MAX_BATCH = int(os.environ.get("EMBED_MAX_BATCH", "64"))
MAX_TEXT_CHARS = int(os.environ.get("EMBED_MAX_TEXT_CHARS", "8000"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

logger.info("loading model %s", MODEL_NAME)
model = SentenceTransformer(MODEL_NAME, device="cpu")
EMBED_DIM = model.get_sentence_embedding_dimension()

app = Flask(__name__)


def _validate_text(text) -> tuple[bool, str]:
    """Checks one input text and returns whether it is valid and why not."""
    if not isinstance(text, str):
        return False, "text_not_string"
    if not text.strip():
        return False, "text_empty"
    if len(text) > MAX_TEXT_CHARS:
        return False, f"text_too_long_max_{MAX_TEXT_CHARS}_chars"
    return True, ""


def _embed(texts: List[str]) -> List[List[float]]:
    """Encodes a batch; normalized so cosine equals dot product."""
    vectors = model.encode(
        texts,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    return vectors.tolist()


@app.route("/health", methods=["GET"])
def health():
    """Reports the loaded model and limits."""
    return jsonify({
        "ok": True,
        "model": MODEL_NAME,
        "dim": EMBED_DIM,
        "max_batch": MAX_BATCH,
        "max_text_chars": MAX_TEXT_CHARS,
    }), 200


@app.route("/embed", methods=["POST"])
def embed_batch():
    """Embeds a batch: {"texts": [str]} -> {"vectors": [[float]]}."""
    data = request.get_json(silent=True) or {}
    texts = data.get("texts")

    if not isinstance(texts, list) or len(texts) == 0:
        return jsonify({
            "error": "missing_texts",
            "message": 'Se requiere "texts" como lista no vacía de textos',
        }), 400

    if len(texts) > MAX_BATCH:
        return jsonify({
            "error": "batch_too_large",
            "message": f"Máximo {MAX_BATCH} textos por solicitud, se recibieron {len(texts)}",
        }), 400

    for index, text in enumerate(texts):
        ok, reason = _validate_text(text)
        if not ok:
            return jsonify({
                "error": "invalid_text",
                "message": f"texts[{index}]: {reason}",
                "index": index,
            }), 400

    try:
        vectors = _embed(texts)
    except Exception as error:
        logger.error("embed batch failed: %s", error, exc_info=True)
        return jsonify({"error": "embed_failed", "message": str(error)}), 500

    return jsonify({
        "vectors": vectors,
        "model": MODEL_NAME,
        "dim": EMBED_DIM,
        "count": len(vectors),
    }), 200


@app.route("/embed/query", methods=["POST"])
def embed_query():
    """Embeds one search query: {"text": str} -> {"vector": [float]}."""
    data = request.get_json(silent=True) or {}
    text = data.get("text")

    ok, reason = _validate_text(text)
    if not ok:
        return jsonify({"error": "invalid_text", "message": reason}), 400

    try:
        vector = _embed([text])[0]
    except Exception as error:
        logger.error("embed query failed: %s", error, exc_info=True)
        return jsonify({"error": "embed_failed", "message": str(error)}), 500

    return jsonify({"vector": vector, "model": MODEL_NAME, "dim": EMBED_DIM}), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), threaded=True)
