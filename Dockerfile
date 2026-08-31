FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# LibreOffice 讓雲端環境也能處理 DOC/DOCX；其餘套件支援圖片、PDF 與 GIS 分析。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        fonts-noto-cjk \
        libgl1 \
        libglib2.0-0 \
        libreoffice \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements-cloud.txt /app/backend/requirements-cloud.txt
RUN pip install --upgrade pip \
    && pip install -r /app/backend/requirements-cloud.txt

COPY . /app
WORKDIR /app/backend
RUN mkdir -p uploads

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-10000}"]
