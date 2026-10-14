# Official python image via AWS's public mirror (no Docker Hub pull limits).
FROM public.ecr.aws/docker/library/python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl fontconfig \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
ENV DATA_DIR=/data PYTHONUNBUFFERED=1 PORT=8000
VOLUME ["/data"]
EXPOSE 8000
# $PORT lets platforms like Railway pick the port.
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --timeout-keep-alive 75
