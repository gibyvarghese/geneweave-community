FROM python:3.12-slim

# Install domain-science dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxrender1 libxext6 libglib2.0-0 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# RDKit (from conda-forge wheels via pip rdkit package)
RUN pip install --no-cache-dir \
    rdkit==2024.3.6 \
    biopython==1.84 \
    networkx==3.4.2 \
    numpy==2.1.3

RUN useradd -u 1001 -m -s /usr/sbin/nologin sandbox
WORKDIR /workspace
USER sandbox

COPY --chown=sandbox:sandbox runner.py /workspace/runner.py

ENTRYPOINT ["python3", "/workspace/runner.py"]
