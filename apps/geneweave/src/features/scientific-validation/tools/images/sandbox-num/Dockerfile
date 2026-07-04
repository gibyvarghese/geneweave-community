FROM python:3.12-slim

# Install numerical/statistical dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    r-base \
    r-cran-metafor \
    build-essential \
    gfortran \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    "setuptools<81" \
    numpy==1.26.4 \
    pandas==2.2.3 \
    scipy==1.14.1 \
    statsmodels==0.14.4 \
    pymc==5.18.2 \
    arviz==0.20.0

RUN useradd -u 1001 -m -s /usr/sbin/nologin sandbox
WORKDIR /workspace
USER sandbox

COPY --chown=sandbox:sandbox runner.py /workspace/runner.py

ENTRYPOINT ["python3", "/workspace/runner.py"]
