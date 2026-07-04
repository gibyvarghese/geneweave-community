FROM python:3.12-slim

# Install symbolic math dependencies
RUN pip install --no-cache-dir \
    sympy==1.13.3 \
    mpmath==1.3.0

# Hardened: no network at runtime (enforced by ImagePolicy networkAllowList: [])
# No setuid binaries, no shell outside /usr/bin/python3
RUN useradd -u 1001 -m -s /usr/sbin/nologin sandbox

WORKDIR /workspace
USER sandbox

# Entrypoint: reads JSON from stdin, writes JSON to stdout
# Tools supply a dispatch script via stdin as the first line
COPY --chown=sandbox:sandbox runner.py /workspace/runner.py

ENTRYPOINT ["python3", "/workspace/runner.py"]
