FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

RUN apt-get update && \
    apt-get install -y python3.11 python3-pip && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV ENGINE_BACKEND=pytorch
EXPOSE 8000

CMD ["python", "-m", "server.main"]
