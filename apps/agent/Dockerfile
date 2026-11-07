# syntax=docker/dockerfile:1.10
ARG PYTHON_IMAGE=python:3.12-slim-trixie

FROM ghcr.io/astral-sh/uv:0.13.7 AS uv

FROM ${PYTHON_IMAGE} AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src
COPY pyproject.toml uv.lock README.md ./
COPY vendor ./vendor
RUN cd vendor && sha256sum -c SHA256SUMS
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

FROM build AS test
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-editable
COPY tests ./tests
RUN /opt/venv/bin/ruff check src tests \
    && /opt/venv/bin/ruff format --check src tests \
    && /opt/venv/bin/mypy \
    && /opt/venv/bin/bandit -q -r src \
    && /opt/venv/bin/python -m pytest -p no:cacheprovider

FROM ${PYTHON_IMAGE} AS runtime
# Debian security fixes published after the base image was built.
RUN apt-get update \
 && apt-get -y --no-install-recommends upgrade \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/*
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin agent
COPY --from=build /opt/venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp
USER 10001:10001
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8081/', timeout=4)"]
ENTRYPOINT ["meet-impar-agent"]
CMD ["start"]
