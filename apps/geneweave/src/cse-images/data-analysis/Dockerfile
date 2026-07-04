FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/workspace/.mplconfig \
    XDG_CACHE_HOME=/workspace/.cache

RUN python -m pip install --upgrade pip setuptools wheel \
    && python -m pip install \
        altair==5.5.0 \
        matplotlib==3.10.0 \
        numpy==2.2.2 \
        openpyxl==3.1.5 \
        pandas==2.2.3 \
        plotly==6.0.0 \
        polars==1.19.0 \
        pyarrow==19.0.0 \
        scikit-learn==1.6.1 \
        scipy==1.15.1 \
        seaborn==0.13.2 \
        statsmodels==0.14.4 \
        xlsxwriter==3.2.0 \
        xlrd==2.0.1

RUN useradd -m -u 10001 sandbox \
    && mkdir -p /workspace /workspace/output /workspace/.mplconfig /workspace/.cache \
    && chown -R sandbox:sandbox /workspace /home/sandbox

WORKDIR /workspace
USER sandbox

CMD ["python", "-c", "print('data-analysis sandbox ready')"]