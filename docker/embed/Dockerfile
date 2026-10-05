FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# The model is baked into the image so the container starts without reaching Hugging Face
ENV HF_HOME=/root/.cache/huggingface
ENV SENTENCE_TRANSFORMERS_HOME=/root/.cache/huggingface
# The accelerated transfer hangs the build on some networks; plain HTTPS is reliable
ENV HF_HUB_DISABLE_XET=1
RUN python -c "from sentence_transformers import SentenceTransformer; \
    SentenceTransformer('BAAI/bge-m3', cache_folder='/root/.cache/huggingface')"

COPY app.py /app/app.py

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:5000/health',timeout=5).status==200 else 1)" || exit 1

EXPOSE 5000

# One worker: the model takes about 2 GB of RAM per worker
CMD ["gunicorn", "--workers", "1", "--threads", "4", "--bind", "0.0.0.0:5000", \
     "--timeout", "120", "--access-logfile", "-", "--error-logfile", "-", \
     "app:app"]
