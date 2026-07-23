FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl unzip \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# The LiteRT wrapper .so ships with an executable-stack ELF marking it does
# not actually need; Cloud Run's kernel (gen1 AND gen2) refuses to load such
# objects ("cannot enable executable stack"). Clear the flag at build time.
RUN apt-get update && apt-get install -y --no-install-recommends patchelf \
    && patchelf --clear-execstack /usr/local/lib/python3.11/site-packages/ai_edge_litert/_pywrap_tensorflow_interpreter_wrapper.so \
    && apt-get purge -y patchelf && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Kaggle ASLFR 1st-place model (Apache-2.0, Christof Henkel; trained on
# Google's FSboard corpus, CC BY 4.0). Baked into the image so the service
# cold-starts ready with no weights-bucket dependency.
RUN mkdir -p /models \
    && curl -fsSL -o /tmp/weights.zip \
        https://github.com/ChristofHenkel/kaggle-asl-fingerspelling-1st-place-solution/releases/download/v0.0.1-alpha/weights.zip \
    && unzip -o -q /tmp/weights.zip 'cfg_2/fold-1/model.tflite' -d /tmp/aslfr \
    && mv /tmp/aslfr/cfg_2/fold-1/model.tflite /models/model.tflite \
    && rm -rf /tmp/weights.zip /tmp/aslfr

WORKDIR /app
COPY inference_args.json /app/inference_args.json
COPY character_to_prediction_index.json /app/character_to_prediction_index.json
COPY decode.py /app/decode.py
COPY main.py /app/main.py

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
